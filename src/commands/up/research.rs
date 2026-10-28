//! Browser-facing research views and human decisions. Agent CLI has no approve verb.
use super::*;

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
        Ok(Json(json!({"study":study,"runs":runs,"metrics":metrics})))
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
    let (session, wakeup_prompt) = blocking_task(move || {
        let _gate = gate;
        let store = Store::open()?;
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
        Ok::<_, ApiError>((study.session_id, prompt))
    }).await??;
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
}
