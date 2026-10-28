use super::*;
use crate::store::StoredChatSession;

fn session(id: &str) -> StoredChatSession {
    StoredChatSession {
        id: id.into(),
        project_id: "project".into(),
        harness: "claude-code".into(),
        native_session_id: None,
        title: None,
        title_source: None,
        model: None,
        service_tier: None,
        permission_mode: None,
        plan_mode: false,
        plan_reset_pending: false,
        reasoning_level: None,
        archived: false,
        context_usage_json: None,
        bootstrap_context: None,
        goal: None,
        autonomy: None,
        active_leaf_id: None,
        parent_session_id: None,
        side_parent_session_id: None,
        side_parent_leaf_id: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn submission_http_binds_receipts_to_session_and_request() {
    const CHILD: &str = "ORX_TEST_SUBMISSION_HTTP";
    const TEST: &str =
        "commands::up::submission_tests::submission_http_binds_receipts_to_session_and_request";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let store = Store::open().unwrap();
            store.create_local_project(&crate::local::model::LocalProject {
                id: "project".into(), name: "receipt".into(), slug: "receipt".into(),
                github_owner: String::new(), github_repo: String::new(), github_sync_enabled: false,
                baseline_branch: "main".into(), repo_path: crate::store::data_dir().to_string_lossy().into_owned(),
                run_command: None, paper_id: None, created_at: 1, updated_at: 1,
            }).unwrap();
            for id in ["one", "two", "orphan"] {
                let mut row = session(id);
                if id == "orphan" { row.project_id = "absent".into(); }
                store.create_chat_session(&row).unwrap();
            }
            store.insert_queued_chat_message(&crate::store::StoredQueuedChatMessage {
                id: "queue".into(), session_id: "one".into(), client_turn_id: "client".into(),
                request_hash: "secret-hash".into(), payload_json: "private material body".into(), created_at: 1,
            }).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let app = Router::new().route("/api/chat/sessions/{id}/submissions/{clientId}", get(chat_submission));
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
            let client = crate::net::loopback_client().build().unwrap();
            for (session_id, request_id, expected) in [("one", "client", true), ("one", "other", false), ("two", "client", false)] {
                let response = client.get(format!("http://{address}/api/chat/sessions/{session_id}/submissions/{request_id}")).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let value: Value = response.json().await.unwrap();
                assert_eq!(value["sessionId"], session_id);
                assert_eq!(value["clientTurnId"], request_id);
                if expected { assert_eq!(value["submission"], json!({"kind":"queued","id":"queue"})); }
                else { assert!(value["submission"].is_null()); }
                assert!(!value.to_string().contains("private material"));
                assert!(!value.to_string().contains("secret-hash"));
            }
            for id in ["missing", "orphan"] {
                let response = client.get(format!("http://{address}/api/chat/sessions/{id}/submissions/client")).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
            }
            let response = client.get(format!("http://{address}/api/chat/sessions/one/submissions/{}", "x".repeat(257))).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            server.abort();
            let _ = server.await;
        });
        return;
    }
    let root = std::env::temp_dir().join(format!("orx-submission-http-{}", uuid::Uuid::new_v4()));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env(CHILD, "1")
        .env("ORX_DATA_DIR", &root)
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(root);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
