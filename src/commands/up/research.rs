//! Browser-facing research views and human decisions. Agent CLI has no approve verb.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NewResearch {
    pub mode: String,
    pub objective: String,
}

pub(super) async fn session(Path(id): Path<String>) -> ApiResult {
    let store = Store::open()?;
    let study = store.research_for_session(&id)?;
    let runs = study
        .as_ref()
        .map(|s| store.research_runs(s))
        .transpose()?
        .unwrap_or_default();
    let runs: Vec<_> = runs.iter().map(ApiRun::from).collect();
    Ok(Json(json!({"study":study,"runs":runs})))
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
    if site != Some("same-origin") {
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
    let (session, gate) = {
        let store = Store::open()?;
        store
            .research_decide(&id, &decision, &req.scope_hash, req.approved, req.reason)
            .map_err(bad_request)?;
        let study = store.research_study(&id)?;
        let gate = study
            .decisions
            .iter()
            .find(|d| d.id == decision)
            .ok_or_else(|| not_found("decision"))?
            .gate
            .clone();
        (study.session_id, gate)
    };
    let result=state.chat.send_message(&session,format!("研究闸门 {gate} 已由用户{}。请读取 orx research status，仅推进当前获批且依赖就绪的任务。",if req.approved {"批准"}else{"拒绝"}),local::chat::TurnOverrides::default(),vec![],vec![],Some(format!("research-decision-{decision}"))).await;
    // The decision is durable even if the harness cannot resume. The UI exposes retry.
    Ok(Json(
        json!({"ok":true,"resumeError":result.err().map(|e|e.to_string())}),
    ))
}
#[derive(Deserialize)]
pub(super) struct ExportQuery {
    #[serde(default)]
    approved: bool,
}
pub(super) async fn export(
    Path(id): Path<String>,
    Query(query): Query<ExportQuery>,
) -> std::result::Result<Response, ApiError> {
    let bytes = tokio::task::spawn_blocking(move || {
        let store = Store::open()?;
        let study = store.research_study(&id)?;
        local::research::export_package(&store, &study, query.approved)
    })
    .await
    .map_err(|e| bad_request(e.to_string()))?
    .map_err(bad_request)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (
                header::CONTENT_DISPOSITION,
                if query.approved {
                    "attachment; filename=research-package-approved.zip"
                } else {
                    "attachment; filename=research-package-draft.zip"
                },
            ),
        ],
        bytes,
    )
        .into_response())
}
pub(super) async fn stop(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    browser_decision(&headers)?;
    reject_if_moving(&state)?;
    let sessions = {
        let store = Store::open()?;
        store.research_update(&id, |study| {
            study.status = "stopped".into();
            let mut sessions = vec![study.session_id.clone()];
            for plan in &mut study.plans {
                for task in &mut plan.tasks {
                    if let Some(session) = &task.session_id {
                        sessions.push(session.clone());
                    }
                    if matches!(task.state.as_str(), "pending" | "running") {
                        task.state = "cancelled".into();
                    }
                    for run in &task.run_ids {
                        if store
                            .get_run(run)?
                            .is_some_and(|r| !local::is_terminal(&r.status))
                        {
                            store.request_cancel(run, "dashboard:research-stop")?;
                        }
                    }
                }
            }
            Ok(sessions)
        })?
    };
    for session in sessions {
        let _ = state.chat.interrupt_by_user(&session).await;
    }
    Ok(Json(json!({"ok":true})))
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
    fn research_decision_input_does_not_accept_agent_supplied_identity() {
        let input = serde_json::json!({"scopeHash":"abc","approved":true,"reason":"accepted"});
        assert!(serde_json::from_value::<DecisionReq>(input.clone()).is_ok());
        let mut forged = input;
        forged["approver"] = serde_json::json!("another-user");
        assert!(serde_json::from_value::<DecisionReq>(forged).is_err());
    }
}
