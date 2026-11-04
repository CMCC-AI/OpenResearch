//! Browser-facing research views and human decisions. Agent CLI has no approve verb.
use super::*;

/// Only an already-approved immutable snapshot is downloadable; GET never
/// prepares new evidence or changes human confirmation state.
pub(super) async fn package(Path(id): Path<String>) -> std::result::Result<Response, ApiError> {
    let (file, snapshot) = blocking_task(move || {
        Store::open()?
            .research_download_package(&id)
            .map_err(bad_request)
    })
    .await??;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!(
            "attachment; filename=\"research-{}.zip\"",
            &snapshot.scope_hash[..16]
        )
        .parse()
        .map_err(bad_request)?,
    );
    headers.insert(header::CONTENT_LENGTH, snapshot.archive.bytes.into());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(
        "x-content-sha256",
        snapshot.archive.sha256.parse().map_err(bad_request)?,
    );
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    Ok((headers, axum::body::Body::from_stream(stream)).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NewResearch {
    pub mode: String,
    pub objective: String,
}

pub(super) async fn session(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let busy = state.chat.busy_sessions().await;
    blocking_api(move || {
        let store = Store::open()?;
        let study = store.research_for_session(&id)?;
        let runs = study
            .as_ref()
            .map(|s| store.research_runs(s))
            .transpose()?
            .unwrap_or_default();
        let runs: Vec<_> = runs.iter().map(ApiRun::from).collect();
        let metrics = study
            .as_ref()
            .map(|study| store.research_metrics(study, &busy, crate::store::now_ms()))
            .transpose()?;
        let view = study
            .as_ref()
            .map(|study| store.research_study_view(study))
            .transpose()?;
        Ok(Json(json!({"study":view,"runs":runs,"metrics":metrics})))
    })
    .await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DecisionReq {
    scope_hash: String,
    approved: bool,
    #[serde(default)]
    reason: String,
}

fn browser_decision(headers: &HeaderMap) -> std::result::Result<(), ApiError> {
    // Defense against cross-site submissions and accidental use by CLI agents.
    // Local processes sharing the user's OS account are not a security sandbox.
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    // Public HTTP dashboards do not receive Fetch Metadata headers. Their
    // browser POSTs still carry Origin; compare it to Host as for the terminal.
    let trusted = match site {
        Some("same-origin") => true,
        None => same_origin(headers),
        _ => false,
    };
    if !trusted {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "请在本地工作台确认研究决策".into(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EndReq {
    version: u32,
}

pub(super) async fn end(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<EndReq>,
) -> ApiResult {
    browser_decision(&headers)?;
    reject_if_stopping(&state)?;
    reject_if_moving(&state)?;
    // Keep the actual worker protected if the browser disconnects while waiting.
    tokio::spawn(async move {
        let gate = state.data_dir_gate.clone().lock_owned().await;
        reject_if_stopping(&state)?;
        reject_if_moving(&state)?;
        let busy = state.chat.busy_sessions().await;
        blocking_api(move || {
            let _gate = gate;
            Store::open()?
                .research_end(&id, req.version, &busy)
                .map_err(bad_request)?;
            Ok(Json(json!({"ok":true})))
        })
        .await
    })
    .await
    .map_err(|error| ApiError::from(anyhow!("research end task failed: {error}")))?
}

pub(super) async fn decide(
    State(state): State<AppState>,
    Path((id, decision)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<DecisionReq>,
) -> ApiResult {
    browser_decision(&headers)?;
    reject_if_stopping(&state)?;
    reject_if_moving(&state)?;
    if req.reason.len() > 8000 {
        return Err(bad_request("决策说明过长"));
    }
    // Complete persistence and resumption even when the browser disconnects.
    tokio::spawn(apply_decision(state, id, decision, req))
        .await
        .map_err(|error| ApiError::from(anyhow!("research decision task failed: {error}")))?
}

// Return the gate with the prepared wake-up so ending or moving data cannot
// interleave between the durable decision and chat admission. The blocking
// worker owns it even if its async waiter is cancelled.
async fn prepare_decision(
    lifecycle_gate: tokio::sync::OwnedMutexGuard<()>,
    id: String,
    decision: String,
    req: DecisionReq,
    open_store: impl FnOnce() -> Result<Store> + Send + 'static,
) -> std::result::Result<(tokio::sync::OwnedMutexGuard<()>, String, Option<String>), ApiError> {
    blocking_task(move || {
        let store = open_store()?;
        store
            .research_decide(&id, &decision, &req.scope_hash, req.approved, req.reason)
            .map_err(bad_request)?;
        let dispatched = if req.approved {
            crate::commands::research_dispatch::auto_dispatch_sync(&store, &id)
                .map_err(bad_request)?
        } else {
            Vec::new()
        };
        let study = store.research_study(&id)?;
        let gate = study
            .decisions
            .iter()
            .find(|d| d.id == decision)
            .ok_or_else(|| not_found("decision"))?
            .gate
            .clone();
        let version = study.plan().map_or(0, |p| p.version);
        let delivery = crate::local::research::delivery_gate(study.workflow_mode());
        let has_pending_gate = study
            .decisions
            .iter()
            .any(|d| d.version == version && d.status == "pending");
        let has_running_task = study
            .plan()
            .is_ok_and(|p| p.tasks.iter().any(|t| t.state == "running"));
        let prompt = if !req.approved {
            Some(format!(
                "研究闸门 {gate} 已被用户拒绝。请读取当前状态与用户反馈意见，调整方案或仅重做受影响的任务（已完成且产物未变动的任务会自动保留进度，请勿无故重置全部任务）。"
            ))
        } else if gate == delivery || !dispatched.is_empty() || has_pending_gate || has_running_task
        {
            None
        } else {
            Some(format!(
                "研究闸门 {gate} 已由用户批准。前置已完成任务已保留，请立即为下一环节实验任务执行 `orx research prepare-run` 绑定运行契约，或推进剩余未完成步骤；严禁重新调用 `orx research plan` 重置已有进度。"
            ))
        };
        Ok::<_, ApiError>((lifecycle_gate, study.session_id, prompt))
    }).await?
}

async fn apply_decision(
    state: AppState,
    id: String,
    decision: String,
    req: DecisionReq,
) -> ApiResult {
    let gate = state.data_dir_gate.clone().lock_owned().await;
    reject_if_stopping(&state)?;
    reject_if_moving(&state)?;
    let client_turn_id = format!("research-decision-{decision}");
    let (_gate, session, wakeup_prompt) =
        prepare_decision(gate, id, decision, req, Store::open).await?;
    let resume_error = if let Some(prompt) = wakeup_prompt {
        state
            .chat
            .send_message(
                &session,
                prompt,
                local::chat::TurnOverrides::default(),
                vec![],
                vec![],
                Some(client_turn_id),
            )
            .await
            .err()
            .map(|e| e.to_string())
    } else {
        None
    };
    // The decision is durable even if the harness cannot resume. Report the error to the UI.
    Ok(Json(json!({"ok":true,"resumeError":resume_error})))
}
#[cfg(test)]
mod tests {
    use super::*;
    include!("research_package_tests.rs");

    fn decision_fixture() -> (std::path::PathBuf, Store, String, String, DecisionReq) {
        let root = std::env::temp_dir().join(format!("orx-decision-gate-{}", uuid::Uuid::new_v4()));
        let store = Store::open_at(root.clone()).unwrap();
        store
            .create_local_project(&local::model::LocalProject {
                id: "project".into(),
                name: "test".into(),
                slug: "test".into(),
                github_owner: String::new(),
                github_repo: String::new(),
                github_sync_enabled: false,
                baseline_branch: "main".into(),
                repo_path: root.to_string_lossy().into_owned(),
                run_command: None,
                paper_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        let tx = store.begin().unwrap();
        tx.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('lead','project','codex',1,1)", []).unwrap();
        tx.commit().unwrap();
        let study = store.research_create("lead", "team", "test").unwrap();
        store
            .research_set_plan(
                &study.id,
                serde_json::from_value(json!({
                    "summary":"one experiment", "tasks":[{"id":"experiment",
                    "role":"as-experiment-operator", "brief":"run experiment",
                    "dependsOn":[], "outputs":["result.md"]},
                    {"id":"review", "role":"as-independent-reviewer", "brief":"review",
                    "dependsOn":["experiment"], "outputs":["review.md"]},
                    {"id":"audit", "role":"as-quality-citation-auditor", "brief":"audit",
                    "dependsOn":["review"], "outputs":["audit.md"]}]
                }))
                .unwrap(),
            )
            .unwrap();
        let study = store.research_study(&study.id).unwrap();
        let decision = study.decisions.iter().find(|d| d.gate == "G1").unwrap();
        let request = DecisionReq {
            scope_hash: decision.scope_hash.clone(),
            approved: false,
            reason: "revise".into(),
        };
        (root, store, study.id, decision.id.clone(), request)
    }

    #[tokio::test]
    async fn decision_wakeup_keeps_end_excluded_until_durable_chat_admission() {
        for approved in [false, true] {
            let (root, store, study_id, decision_id, mut request) = decision_fixture();
            request.approved = approved;
            let gate = Arc::new(tokio::sync::Mutex::new(()));
            let (guard, session, prompt) = prepare_decision(
                gate.clone().lock_owned().await,
                study_id.clone(),
                decision_id,
                request,
                move || Ok(store),
            )
            .await
            .unwrap();
            assert!(prompt.is_some());
            assert_eq!(session, "lead");
            let store = Store::open_at(root.clone()).unwrap();
            assert_eq!(
                store.research_study(&study_id).unwrap().decisions[0].status,
                if approved { "approved" } else { "rejected" }
            );
            // Pause at the real persistence/admission boundary. End takes this same gate.
            assert!(
                gate.try_lock().is_err(),
                "end overtook a prepared automatic wake-up"
            );
            store
                .insert_queued_chat_message(&crate::store::StoredQueuedChatMessage {
                    id: "wake".into(),
                    session_id: session,
                    client_turn_id: "decision".into(),
                    request_hash: "hash".into(),
                    payload_json: "{}".into(),
                    created_at: 1,
                })
                .unwrap();
            drop(guard);
            let _end_guard = gate.try_lock().unwrap();
            assert!(store.research_end(&study_id, 1, &[]).is_err());
            assert_eq!(store.research_study(&study_id).unwrap().status, "active");
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn invalid_decision_releases_gate_without_a_wakeup() {
        let (root, store, study_id, decision_id, mut request) = decision_fixture();
        request.scope_hash = "stale".into();
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        assert!(prepare_decision(
            gate.clone().lock_owned().await,
            study_id.clone(),
            decision_id,
            request,
            move || Ok(store)
        )
        .await
        .is_err());
        let _guard = gate.try_lock().unwrap();
        let store = Store::open_at(root.clone()).unwrap();
        assert_eq!(
            store.research_study(&study_id).unwrap().decisions[0].status,
            "pending"
        );
        store.research_end(&study_id, 1, &[]).unwrap();
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancelled_decision_waiter_leaves_running_worker_protected() {
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let guard = gate.clone().lock_owned().await;
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let task = tokio::spawn(prepare_decision(
            guard,
            "study".into(),
            "decision".into(),
            DecisionReq {
                scope_hash: "hash".into(),
                approved: false,
                reason: String::new(),
            },
            move || {
                let _ = entered.send(());
                wait.recv_timeout(Duration::from_secs(5))?;
                Err(anyhow!("injected store open failure"))
            },
        ));
        tokio::time::timeout(Duration::from_secs(5), ready)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(
            gate.try_lock().is_err(),
            "cancelled waiter released its running worker's gate"
        );
        release.send(()).unwrap();
        let _guard = tokio::time::timeout(Duration::from_secs(5), gate.lock())
            .await
            .unwrap();
    }

    #[test]
    fn research_decisions_require_same_origin_browser_metadata() {
        let mut headers = HeaderMap::new();
        assert!(browser_decision(&headers).is_err());
        for site in ["cross-site", "same-site", "none"] {
            headers.insert("sec-fetch-site", site.parse().unwrap());
            assert!(browser_decision(&headers).is_err());
        }
        headers.insert("sec-fetch-site", "same-origin".parse().unwrap());
        assert!(browser_decision(&headers).is_ok());
    }

    #[test]
    fn research_controls_accept_same_origin_http_without_fetch_metadata() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "61.136.101.179:20281".parse().unwrap());
        headers.insert(
            header::ORIGIN,
            "http://61.136.101.179:20281".parse().unwrap(),
        );
        assert!(browser_decision(&headers).is_ok());
        headers.insert(
            header::ORIGIN,
            "https://61.136.101.179:20281".parse().unwrap(),
        );
        assert!(browser_decision(&headers).is_ok());
        for origin in ["null", "http://example.com", "http://61.136.101.179:20282"] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(browser_decision(&headers).is_err());
        }
        headers.insert(
            header::ORIGIN,
            "http://61.136.101.179:20281".parse().unwrap(),
        );
        headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(browser_decision(&headers).is_err());
        headers.remove("sec-fetch-site");
        headers.remove(header::HOST);
        assert!(browser_decision(&headers).is_err());
    }

    #[test]
    fn research_decision_input_does_not_accept_agent_supplied_identity() {
        let input = serde_json::json!({"scopeHash":"abc","approved":true,"reason":"accepted"});
        assert!(serde_json::from_value::<DecisionReq>(input.clone()).is_ok());
        let mut forged = input;
        forged["approver"] = serde_json::json!("another-user");
        assert!(serde_json::from_value::<DecisionReq>(forged).is_err());
    }

    #[test]
    fn research_end_requires_an_explicit_plan_version_and_no_extra_controls() {
        assert!(serde_json::from_value::<EndReq>(json!({"version":0})).is_ok());
        for value in [
            json!({}),
            json!({"version":-1}),
            json!({"version":1,"cancelRuns":true}),
            json!({"version":1,"approver":"agent"}),
        ] {
            assert!(serde_json::from_value::<EndReq>(value).is_err());
        }
    }
}
