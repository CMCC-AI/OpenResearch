use super::*;

fn session_query(scope: Option<&str>) -> SessionsQuery {
    SessionsQuery {
        project_id: None,
        scope: scope.map(str::to_string),
        archived: None,
        before_updated_at: None,
        before_id: None,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn session_reads_do_not_block_the_async_worker() {
    let dir = std::env::temp_dir().join(format!("orx-read-worker-{}", uuid::Uuid::new_v4()));
    let root = dir.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let read = read_chat_sessions(session_query(Some("all")), move || {
        let _ = started.send(());
        // A synchronous read on the only async worker would time out here:
        // its heartbeat cannot run until this closure returns.
        wait.recv_timeout(Duration::from_secs(2))
            .map_err(|error| anyhow!("async worker did not release storage: {error}"))?;
        Store::open_at(root)
    });
    let heartbeat = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(read, heartbeat);
    assert!(result.unwrap().0.is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn session_reads_preserve_scope_and_sidebar_pagination() {
    let dir = std::env::temp_dir().join(format!("orx-read-scopes-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let tx = store.begin().unwrap();
    for i in 0..51 {
        tx.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,archived) VALUES(?1,'p','opencode',100,100,?2)", rusqlite::params![format!("s{i:03}"), i == 0]).unwrap();
    }
    tx.execute_batch("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('outside','q','opencode',100,100);
        INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,side_parent_session_id) VALUES('side','p','opencode',100,100,'s001');").unwrap();
    tx.commit().unwrap();
    drop(store);
    let read = |q| {
        let root = dir.clone();
        read_chat_sessions(q, move || Store::open_at(root))
    };
    assert_eq!(read(session_query(Some("all"))).await.unwrap().0.len(), 52);
    let mut q = session_query(Some("all"));
    q.project_id = Some("p".into());
    let (project, next) = read(q).await.unwrap();
    assert_eq!(project.len(), 52);
    assert!(project.iter().all(|s| s.project_id == "p"));
    assert!(next.is_none());
    let mut q = session_query(Some("sidebar"));
    q.archived = Some(false);
    let (first, next) = read(q).await.unwrap();
    assert_eq!(first.len(), 50);
    let next = next.unwrap();
    let mut q = session_query(Some("sidebar"));
    q.archived = Some(false);
    q.before_updated_at = next["updatedAt"].as_i64();
    q.before_id = next["id"].as_str().map(str::to_string);
    let (last, next) = read(q).await.unwrap();
    assert_eq!(
        last.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["outside"]
    );
    assert!(next.is_none());
    assert_eq!(
        read(session_query(None)).await.unwrap_err().0,
        StatusCode::BAD_REQUEST
    );
    let mut q = session_query(Some("sidebar"));
    q.before_updated_at = Some(100);
    assert_eq!(read(q).await.unwrap_err().0, StatusCode::BAD_REQUEST);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn slow_sync_work_leaves_async_timers_responsive() {
    let work = blocking_task(|| std::thread::sleep(Duration::from_millis(150)));
    let heartbeat = async {
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let (_, heartbeat) = tokio::join!(
        work,
        tokio::time::timeout(Duration::from_millis(80), heartbeat)
    );
    assert!(heartbeat.is_ok());
}

#[test]
fn new_chat_uses_saved_preferences_and_normalizes_model_settings() {
    let preferences = crate::store::StoredUiState {
        onboarding_completed: true,
        tour_completed: true,
        workspace: None,
        preferred_autonomy: Some(Autonomy::Copilot),
        preferred_agent: Some(StoredAgentSelection {
            harness: "codex".into(),
            model: Some("custom-model".into()),
            reasoning_level: Some("ultra".into()),
            permission_mode: Some("full-access".into()),
            service_tier: Some("priority".into()),
        }),
    };
    let catalog = json!({"harnesses": [{
        "id": "codex", "agentReady": true,
        "models": [], "options": {"reasoningLevels": [{"id": "default"}, {"id": "high"}]}
    }]});
    let req = new_chat_settings("project".into(), preferences, &catalog).unwrap();
    assert_eq!(req.harness.as_deref(), Some("codex"));
    assert_eq!(req.model.as_deref(), Some("custom-model"));
    assert_eq!(req.reasoning_level.as_deref(), Some("default"));
    assert!(req.service_tier.is_none());
    assert_eq!(req.permission_mode.as_deref(), Some("full-access"));
    assert_eq!(req.autonomy, Some(Autonomy::Copilot));
    assert!(!req.plan_mode);
}

#[test]
fn new_chat_falls_back_only_when_no_preference_exists() {
    let mut preferences = crate::store::StoredUiState {
        onboarding_completed: false,
        tour_completed: false,
        workspace: None,
        preferred_autonomy: None,
        preferred_agent: None,
    };
    let catalog = json!({"harnesses": [{"id":"claude-code", "agentReady":true,
        "models":[{"id":"opus"}], "options":{"defaultPermissionMode":"plan", "reasoningLevels":[{"id":"default"}]}}]});
    let req = new_chat_settings("project".into(), preferences.clone(), &catalog).unwrap();
    assert_eq!(req.harness.as_deref(), Some("claude-code"));
    assert_eq!(req.model.as_deref(), Some("opus"));
    assert_eq!(req.permission_mode.as_deref(), Some("plan"));
    assert_eq!(req.autonomy, Some(Autonomy::Agentic));
    preferences.preferred_agent = Some(StoredAgentSelection {
        harness: "claude-code".into(),
        model: Some("custom-claude-model".into()),
        service_tier: None,
        permission_mode: Some("plan".into()),
        reasoning_level: Some("default".into()),
    });
    let req = new_chat_settings("project".into(), preferences.clone(), &catalog).unwrap();
    assert_eq!(req.harness.as_deref(), Some("claude-code"));
    assert_eq!(req.model.as_deref(), Some("custom-claude-model"));
    let unavailable = json!({"harnesses": [{"id":"claude-code", "agentReady":false}, {"id":"codex", "agentReady":true}]});
    assert!(new_chat_settings("project".into(), preferences.clone(), &unavailable).is_err());
    preferences.preferred_agent = Some(StoredAgentSelection {
        harness: "codex".into(),
        model: Some("gpt-6-sol".into()),
        service_tier: None,
        permission_mode: None,
        reasoning_level: None,
    });
    assert!(new_chat_settings("project".into(), preferences, &catalog).is_err());
}

#[tokio::test]
async fn empty_local_error_reports_the_http_status() {
    for (status, body, expected) in [
        (StatusCode::BAD_GATEWAY, "", "HTTP 502 Bad Gateway"),
        (StatusCode::NOT_FOUND, "", "HTTP 404 Not Found"),
        (
            StatusCode::BAD_REQUEST,
            r#"{"error":""}"#,
            "HTTP 400 Bad Request",
        ),
    ] {
        let response = axum::http::Response::builder()
            .status(status)
            .body(body.to_string())
            .unwrap();
        let error = decode_local_response::<Value>(response.into(), "start the run")
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("orx up could not start the run: {expected}")
        );
    }
}

#[test]
fn successful_recheck_clears_stale_claude_warning() {
    let host = local::claude::ClaudeHost::new();
    let ready = local::harness::claude::parse_auth_status(
        Some(0),
        br#"{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}"#,
        local::harness::claude::auth_barrier_sequence(),
    );
    host.observe_auth_probe(&ready);
    let failed = local::harness::claude::parse_auth_status(
        Some(2),
        b"bad status",
        local::harness::claude::auth_barrier_sequence(),
    );
    host.observe_auth_probe(&failed);
    let mut payload =
        json!({"harnesses": [{"id": "claude-code", "authState": "ready", "agentReady": true}]});
    overlay_claude_auth(&mut payload, &host.auth_snapshot());
    assert_eq!(payload["harnesses"][0]["authCheckFailed"], true);
    assert!(payload["harnesses"][0]["agentNote"]
        .as_str()
        .unwrap()
        .contains("Could not re-check"));

    let recovered = local::harness::claude::parse_auth_status(
        Some(0),
        br#"{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}"#,
        local::harness::claude::auth_barrier_sequence(),
    );
    host.observe_auth_probe(&recovered);
    overlay_claude_auth(&mut payload, &host.auth_snapshot());
    assert_eq!(payload["harnesses"][0]["authCheckFailed"], false);
    assert!(payload["harnesses"][0].get("agentNote").is_none());
}

#[test]
fn send_model_distinguishes_cli_default_from_no_override() {
    let omitted: SendChatReq = serde_json::from_value(json!({ "text": "hello" })).unwrap();
    let default: SendChatReq =
        serde_json::from_value(json!({ "text": "hello", "model": null })).unwrap();
    assert_eq!(omitted.model, None);
    assert_eq!(default.model, Some(None));
}

#[test]
fn literature_query_bounds_support_single_character_and_unicode() {
    assert!(validate_literature_query("", 0).is_ok());
    assert!(validate_literature_query("脑", 18).is_ok());
    assert!(validate_literature_query(&"脑".repeat(500), 10000).is_ok());
    assert!(validate_literature_query(&"脑".repeat(501), 0).is_err());
    assert!(validate_literature_query("", 10001).is_err());
}

#[test]
fn literature_paginated_contract_preserves_abstract_and_ignores_viewer_state() {
    let page: DeepLiteraturePage = serde_json::from_value(json!({
        "papers": [{"id":"2401.00001", "title":"Evidence", "abstract":"Source text",
            "authors":[{"name":"Researcher","slug":"researcher"}]}],
        "total": 27, "hasMore": true, "viewerStates": {}, "authenticated": false
    }))
    .unwrap();
    assert_eq!(page.total, 27);
    assert!(page.has_more);
    assert_eq!(page.papers[0].abstract_text, "Source text");
    assert_eq!(page.papers[0].authors[0].name, "Researcher");
    assert!(serde_json::from_value::<DeepLiteraturePage>(json!({"papers":[]})).is_err());
}

#[test]
fn deep_literature_origins_accept_http_and_https() {
    for origin in ["http://127.0.0.1:3000", "https://literature.example.com"] {
        let parsed = deep_literature_origin(origin, "test").map_err(|error| error.1);
        assert_eq!(parsed.unwrap().origin().ascii_serialization(), origin);
    }
}

#[test]
fn deep_literature_origins_reject_unsafe_or_ambiguous_urls() {
    for origin in [
        "file:///tmp/papers",
        "https://user:secret@literature.example.com",
        "https://literature.example.com/api",
        "https://literature.example.com?tenant=other",
    ] {
        assert!(
            deep_literature_origin(origin, "test").is_err(),
            "accepted {origin}"
        );
    }
}

#[test]
fn harness_payload_predicates_read_the_wire_shape() {
    let provisional = json!({
        "harnesses": [
            {"id": "claude-code", "agentReady": false, "catalogPending": true},
            {"id": "codex", "agentReady": false},
        ]
    });
    assert!(payload_is_provisional(&provisional));
    assert!(claude_entry_pending(&provisional));
    assert!(!payload_has_ready_claude(&provisional));

    let filled = json!({
        "harnesses": [
            {"id": "claude-code", "agentReady": true},
            {"id": "codex", "agentReady": false},
        ]
    });
    assert!(!payload_is_provisional(&filled));
    assert!(!claude_entry_pending(&filled));
    assert!(payload_has_ready_claude(&filled));

    // `catalogPending` is skip-serialized when false — its absence must
    // read as settled, not pending.
    let no_claude = json!({ "harnesses": [{"id": "codex", "agentReady": false}] });
    assert!(!payload_is_provisional(&no_claude));
    assert!(!claude_entry_pending(&no_claude));
}

#[tokio::test]
async fn closed_dashboard_releases_idle_chat_receiver() {
    let (sender, receiver) = tokio::sync::broadcast::channel(1);
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        forward_chat_events(receiver, tx),
    )
    .await
    .unwrap();
    assert_eq!(sender.receiver_count(), 0);
}

#[tokio::test]
async fn a_streaming_response_stays_active_until_its_body_is_sent() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let release = gate.clone();
    let app = Router::new()
        .route(
            "/file",
            get(move || async move {
                axum::body::Body::from_stream(futures::stream::once(async move {
                    gate.notified().await;
                    Ok::<_, Infallible>("done")
                }))
            }),
        )
        .layer(middleware::from_fn(track_active));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/file", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });

    let response = crate::net::loopback_client()
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap();
    assert_eq!(ACTIVE.load(Ordering::SeqCst), 1);
    release.notify_one();
    assert_eq!(response.text().await.unwrap(), "done");
    for _ in 0..100 {
        if ACTIVE.load(Ordering::SeqCst) == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("a sent response body stayed active");
}

#[tokio::test]
async fn lagged_chat_stream_requests_resync_and_continues() {
    use axum::response::IntoResponse;
    let (sender, receiver) = tokio::sync::broadcast::channel(1);
    sender.send(("chat.busy", json!({"busy": true}))).unwrap();
    sender.send(("chat.busy", json!({"busy": false}))).unwrap();
    drop(sender);
    let (tx, mut rx) = mpsc::channel(4);
    forward_chat_events(receiver, tx).await;
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(Ok::<_, Infallible>(event));
    }
    let response = Sse::new(futures::stream::iter(events)).into_response();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = std::str::from_utf8(&bytes).unwrap();
    assert!(body.starts_with("event: resync.required\ndata: {}\n\n"));
    assert!(body.contains("event: chat.busy\ndata: {\"busy\":false}"));
}

#[tokio::test]
async fn workspace_requests_validate_metadata_and_allow_independent_preferences() {
    let preferences: SetUiStateReq = serde_json::from_value(json!({"tourCompleted":true})).unwrap();
    assert!(preferences.workspace.is_none());
    let workspace: SetUiStateReq = serde_json::from_value(json!({"workspace":{
        "lastLocation":"/projects/project/tasks/new", "railOpen":true,
        "panelWidth":500, "experimentsView":"tree"
    }}))
    .unwrap();
    assert!(workspace.preferred_agent.is_none());
    workspace.workspace.unwrap().validate().unwrap();
    assert!(serde_json::from_value::<SetUiStateReq>(json!({"workspace":{
        "lastLocation":null, "railOpen":true, "panelWidth":500,
        "experimentsView":"grid"
    }}))
    .is_err());
    let invalid: GlobalWorkspaceState = serde_json::from_value(json!({
        "lastLocation":"/projects/project", "railOpen":true,
        "panelWidth":500, "experimentsView":"tree"
    }))
    .unwrap();
    assert!(invalid.validate().is_err());
    let result = set_ui_state(Json(SetUiStateReq {
        tour_completed: Some(true),
        preferred_agent: None,
        workspace: Some(invalid),
        preferred_autonomy: None,
    }))
    .await;
    assert_eq!(result.err().unwrap().0, StatusCode::BAD_REQUEST);
    let unsupported: WorkspaceState = serde_json::from_value(json!({
        "version":2, "lastLocation":null, "tasks":{}
    }))
    .unwrap();
    let result = set_project_ui_state(Path("project".into()), Json(unsupported)).await;
    assert_eq!(result.err().unwrap().0, StatusCode::BAD_REQUEST);
}

#[test]
fn ssh_workspace_blocks_local_machine_actions_but_keeps_config_editing() {
    for path in [
        "/api/project-path/pick",
        "/api/update",
        "/api/update/apply",
        "/api/update/restart",
        "/api/settings/data-dir",
        "/api/settings/data-dir/move",
        "/api/settings/openresearch/login",
        "/api/settings/openresearch/ssh-key",
        "/api/settings/commands/run",
        "/api/remote/sessions",
        "/api/projects/p1/file/open",
        "/api/projects/p1/file/reveal",
    ] {
        assert!(remote_route_forbidden(path), "{path}");
    }
    assert!(!remote_route_forbidden("/api/settings/ssh/config"));
    assert!(!remote_route_forbidden("/api/settings/ssh/master"));
    assert!(!remote_route_forbidden("/api/settings/ssh/preflight"));
    assert!(!remote_route_forbidden("/api/settings/ssh/connect"));
    assert!(!remote_route_forbidden("/api/projects/p1/file"));
}

#[test]
fn remote_callback_token_is_limited_to_runs_and_the_spawn_preflight() {
    assert!(is_remote_callback_route(&Method::POST, "/api/runs"));
    assert!(is_remote_callback_route(
        &Method::POST,
        "/api/runs/run-1/cancel"
    ));
    assert!(!is_remote_callback_route(&Method::GET, "/api/runs"));
    assert!(!is_remote_callback_route(
        &Method::POST,
        "/api/runs/run-1/extra/cancel"
    ));
    assert!(!is_remote_callback_route(
        &Method::POST,
        "/api/chat/sessions/s1/message"
    ));
    assert!(is_remote_callback_route(
        &Method::GET,
        "/api/harnesses/codex/snapshot"
    ));
    assert!(!is_remote_callback_route(
        &Method::POST,
        "/api/harnesses/codex/snapshot"
    ));
    assert!(!is_remote_callback_route(&Method::GET, "/api/harnesses"));
    assert!(!is_remote_callback_route(
        &Method::GET,
        "/api/harnesses/setup/commands"
    ));
}

#[test]
fn ssh_terminal_requires_the_dashboard_origin() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, "127.0.0.1:4791".parse().unwrap());
    headers.insert(header::ORIGIN, "http://127.0.0.1:4791".parse().unwrap());
    assert!(same_origin(&headers));

    headers.insert(header::ORIGIN, "https://example.com".parse().unwrap());
    assert!(!same_origin(&headers));
    headers.remove(header::ORIGIN);
    assert!(!same_origin(&headers));
}

#[test]
fn ssh_terminal_resize_message_deserializes() {
    let input: SshTerminalInput =
        serde_json::from_str(r#"{"type":"resize","cols":120,"rows":40}"#).unwrap();
    let SshTerminalInput::Resize { cols, rows } = input;
    assert_eq!((cols, rows), (120, 40));
}

#[cfg(windows)]
#[tokio::test]
async fn windows_ssh_master_status_is_not_a_disconnection() {
    let response = ssh_master_status(Query(SshPreflightReq {
        host: "unused-host".into(),
        container: None,
    }))
    .await
    .unwrap_or_else(|error| panic!("{}", error.1));
    assert!(response.0["running"].is_null());
}

#[test]
fn ssh_connection_failure_is_a_persistable_preflight_result() {
    let test = ssh_connect_failure("cluster", "authentication failed".into());
    assert_eq!(test.host, "cluster");
    assert!(!test.reachable);
    assert!(!test.tools_found);
    assert_eq!(test.error.as_deref(), Some("authentication failed"));
    assert!(test.tested_at > 0);
}

/// ConPTY waits on its cursor query until answered, and closing it waits on that.
#[tokio::test]
async fn closing_a_pty_whose_client_left_returns_promptly() {
    let (program, args) = if cfg!(windows) {
        ("cmd", vec!["/c".into(), "echo ready & pause".into()])
    } else {
        ("sh", vec!["-c".into(), "echo ready; read _".into()])
    };
    let PtySession {
        master,
        input,
        mut events,
        kill,
    } = start_pty(program, args).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(10), events.recv()).await;
    assert!(matches!(first, Ok(Some(PtyEvent::Output(_)))));

    // The order `relay_pty` tears down in when its socket closes.
    let _ = kill.send(());
    drop((events, input));
    let (dropped, done) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        drop(master);
        let _ = dropped.send(());
    });
    done.recv_timeout(Duration::from_secs(10))
        .expect("closing the PTY blocked its caller");
}

#[cfg(unix)]
#[tokio::test]
async fn pty_relays_input_output_resize_exit_and_cancel() {
    let mut session = start_pty(
        "sh",
        vec![
            "-c".into(),
            "read value; printf 'reply:%s\\n' \"$value\"".into(),
        ],
    )
    .unwrap();
    session
        .master
        .resize(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    session.input.send(b"hello\n".to_vec()).unwrap();

    let mut output = Vec::new();
    let mut exit = None;
    // Exit and the last output come from different threads; the channel closes after both.
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = session.events.recv().await {
            match event {
                PtyEvent::Output(bytes) => output.extend(bytes),
                PtyEvent::Exit(status) => exit = Some(status),
                PtyEvent::Eof => {}
            }
        }
    })
    .await
    .expect("PTY did not exit");
    let status = exit
        .expect("PTY ended without an exit status")
        .unwrap_or_else(|error| panic!("PTY wait failed: {error}"));
    assert!(status.success());
    assert!(String::from_utf8_lossy(&output).contains("reply:hello"));

    let mut cancelled = start_pty("sh", vec!["-c".into(), "trap '' HUP; sleep 30".into()]).unwrap();
    cancelled.kill.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = cancelled.events.recv().await {
            if matches!(event, PtyEvent::Exit(_)) {
                return;
            }
        }
        panic!("cancelled PTY ended without an exit event");
    })
    .await
    .expect("cancelled PTY did not exit");
}

#[test]
fn client_resizes_update_the_tracked_size_only_when_valid() {
    let mut size = DEFAULT_PTY_SIZE;
    assert!(apply_resize(
        &mut size,
        r#"{"type":"resize","cols":111,"rows":33}"#
    ));
    assert_eq!((size.cols, size.rows), (111, 33));
    assert!(!apply_resize(
        &mut size,
        r#"{"type":"resize","cols":0,"rows":9}"#
    ));
    assert!(!apply_resize(&mut size, "not json"));
    assert_eq!((size.cols, size.rows), (111, 33));
}

#[test]
fn settings_commands_are_an_exact_allowlist() {
    assert_eq!(
        settings_command("gh auth login"),
        Some(&["gh", "auth", "login"][..])
    );
    assert_eq!(settings_command("gh auth login; rm -rf ~"), None);
    assert_eq!(settings_command("gh"), None);
}

#[tokio::test]
async fn project_path_status_reports_an_unborn_repository_as_importable() {
    let path =
        std::env::temp_dir().join(format!("orx-project-path-status-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    let status = std::process::Command::new("git")
        .current_dir(&path)
        .args(["init", "-q", "-b", "main"])
        .status()
        .unwrap();
    assert!(status.success());

    let response = project_path_status(Query(ProjectPathStatusQ {
        path: Some(path.to_string_lossy().into_owned()),
    }))
    .await;
    let Json(body) = match response {
        Ok(body) => body,
        Err(error) => panic!("unexpected path status error: {}", error.1),
    };

    assert_eq!(body["gitState"], "unborn");
    assert_eq!(body["initialized"], true);
    let _ = std::fs::remove_dir_all(path);
}

#[test]
fn plan_never_becomes_the_preferred_mode_for_new_sessions() {
    assert_eq!(
        preferred_permission_mode("claude-code", Some("plan".into())).as_deref(),
        Some("auto")
    );
    assert_eq!(
        preferred_permission_mode("codex", Some("plan".into())).as_deref(),
        Some("approve-for-me")
    );
    assert_eq!(
        preferred_permission_mode("opencode", Some("plan".into())).as_deref(),
        Some("default")
    );
}

fn expect_profile(
    result: std::result::Result<crate::telemetry::ResearchProfile, ApiError>,
) -> crate::telemetry::ResearchProfile {
    match result {
        Ok(profile) => profile,
        Err(error) => panic!("unexpected profile error: {}", error.1),
    }
}

#[test]
fn research_profile_requires_an_area_and_other_description() {
    let missing_area = normalize_research_profile(vec![], None, None, vec![]).unwrap_err();
    assert_eq!(missing_area.1, "choose at least one research area");

    let missing_other =
        normalize_research_profile(vec!["Other".into()], Some("   ".into()), None, vec![])
            .unwrap_err();
    assert_eq!(
        missing_other.1,
        "describe your research area when choosing Other"
    );
}

#[test]
fn research_profile_preserves_disclosed_free_text() {
    let profile = expect_profile(normalize_research_profile(
        vec!["AI/ML".into(), "Other".into()],
        Some("  AI for theorem proving  ".into()),
        Some("  I study RL.\nSecond line.  ".into()),
        vec![crate::telemetry::ProfilePaper {
            paper_id: "1706.03762".into(),
            title: Some("Attention Is All You Need".into()),
        }],
    ));

    assert_eq!(
        profile.other_area.as_deref(),
        Some("  AI for theorem proving  ")
    );
    assert_eq!(
        profile.background.as_deref(),
        Some("  I study RL.\nSecond line.  ")
    );
    assert_eq!(
        profile.papers[0].title.as_deref(),
        Some("Attention Is All You Need")
    );
}

#[test]
fn legacy_profile_update_preserves_saved_research_areas() {
    let current = crate::telemetry::ResearchProfile {
        research_areas: vec!["Physics".into(), "Other".into()],
        other_area: Some("Quantum information".into()),
        ..crate::telemetry::ResearchProfile::default()
    };
    let updated = expect_profile(profile_settings_update(
        SetProfileReq {
            research_areas: vec![],
            other_area: None,
            background: Some("Updated background".into()),
            papers: vec![],
        },
        current,
    ));

    assert_eq!(updated.research_areas, vec!["Physics", "Other"]);
    assert_eq!(updated.other_area.as_deref(), Some("Quantum information"));
    assert_eq!(updated.background.as_deref(), Some("Updated background"));
}

#[test]
fn api_run_exposes_cancel_intent() {
    let run = StoredRun {
        id: "run-1".into(),
        experiment_id: "experiment-1".into(),
        project_id: "project-1".into(),
        status: "running".into(),
        backend_json: "{}".into(),
        command: String::new(),
        created_at: 1,
        updated_at: 2,
        ended_at: None,
        exit_code: None,
        commit_sha: None,
        result_markdown: None,
        cancel_requested: true,
        cancel_reason: None,
        chat_session_id: None,
    };

    let value = serde_json::to_value(ApiRun::from(&run)).unwrap();
    assert_eq!(value["cancelRequested"], true);
}

#[test]
fn compute_settings_registers_tinker_without_exposing_its_key() {
    let settings = compute_settings_json(SshReadiness::NoUsableKey { pub_path: None });
    let tinker = settings["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["id"] == "tinker")
        .unwrap();
    assert!(tinker["configured"].is_boolean());
    assert!(tinker.get("key").is_none());
    assert!(tinker.get("apiKey").is_none());
}

#[test]
fn create_run_request_preserves_forwarded_slurm_resources_and_attribution() {
    let args = crate::ExpRunArgs {
        invocation_context: None,
        telemetry_suppressed: true,
        forwarded: false,
        exp_id: "experiment-1".into(),
        disk: None,
        provider: None,
        backend: Some("slurm".into()),
        flavor: None,
        org: None,
        host: None,
        container: None,
        no_container: false,
        manifest: None,
        image: None,
        timeout: None,
        cpus: Some(8),
        mem: Some("64G".into()),
        force: true,
        chat_session_id: Some("session-1".into()),
        agent_origin: None,
    };
    let request = CreateRunReq::from_run_args(&args).unwrap();

    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(value["callerConfigDir"], json!(absolute_config_dir()));
    assert_eq!(value["experimentId"], "experiment-1");
    assert_eq!(value["cpus"], 8);
    assert_eq!(value["mem"], "64G");
    assert_eq!(value["chatSessionId"], "session-1");
    assert_eq!(value["force"], true);
    let forwarded = serde_json::from_value::<CreateRunReq>(value)
        .unwrap()
        .into_run_args();
    assert_eq!(forwarded.cpus, Some(8));
    assert_eq!(forwarded.mem.as_deref(), Some("64G"));
    assert_eq!(forwarded.chat_session_id.as_deref(), Some("session-1"));
    assert!(forwarded.force);
}

#[test]
fn require_caller_config_dir_rejects_a_different_dir() {
    let root = std::env::temp_dir().join(format!("orx-caller-config-{}", uuid::Uuid::new_v4()));
    let own = root.join("up/openresearch");
    let caller = root.join("agent/openresearch");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::create_dir_all(&caller).unwrap();

    assert!(require_caller_config_dir(None, &own).is_ok());
    assert!(require_caller_config_dir(Some(&own), &own).is_ok());
    let fresh = root.join("fresh/openresearch");
    assert!(require_caller_config_dir(Some(&fresh), &fresh).is_ok());
    assert!(require_caller_config_dir(Some(&own.join("../openresearch")), &own).is_ok());
    let error = require_caller_config_dir(Some(&caller), &own)
        .unwrap_err()
        .to_string();
    assert!(error.contains(&caller.display().to_string()));
    assert!(error.contains(&own.display().to_string()));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_json_exposes_artifacts_dir_with_legacy_alias() {
    let project = local::model::LocalProject {
        id: "p1".into(),
        name: "Demo".into(),
        slug: "demo".into(),
        github_owner: "o".into(),
        github_repo: "r".into(),
        github_sync_enabled: true,
        baseline_branch: "main".into(),
        repo_path: "/tmp/r".into(),
        run_command: None,
        paper_id: None,
        created_at: 0,
        updated_at: 0,
    };
    let json =
        project_json_with_artifacts_dir(&project, "/tmp/openresearch-test/files/demo".to_string());
    assert_eq!(json["artifactsDir"], json["filesDir"]);
    assert!(json["artifactsDir"]
        .as_str()
        .unwrap()
        .ends_with("files/demo"));
}

#[test]
fn project_file_text_never_lossily_decodes_binary_bytes() {
    let (content, binary) = decode_project_file_text(b"plain text\n".to_vec(), false);
    assert_eq!(content, "plain text\n");
    assert!(!binary);

    for bytes in [b"header\0payload".to_vec(), vec![0x89, b'P', b'N', b'G']] {
        let (content, binary) = decode_project_file_text(bytes, false);
        assert!(content.is_empty());
        assert!(binary);
    }

    let mut split_utf8 = b"prefix".to_vec();
    split_utf8.push(0xe2);
    let (content, binary) = decode_project_file_text(split_utf8, true);
    assert_eq!(content, "prefix");
    assert!(!binary);
}

#[test]
fn project_file_versions_track_exact_bytes() {
    let first = file_version(b"same-size-a");
    let second = file_version(b"same-size-b");
    assert_ne!(first, second);

    let path = std::env::temp_dir().join(format!("orx-file-version-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, b"same-size-a").unwrap();
    assert_eq!(
        file_version_on_disk(&path)
            .map_err(|error| error.1)
            .unwrap(),
        first
    );
    std::fs::write(&path, b"same-size-b").unwrap();
    assert_eq!(
        file_version_on_disk(&path)
            .map_err(|error| error.1)
            .unwrap(),
        second
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn project_file_paths_reject_traversal() {
    assert_eq!(
        validated_project_file_path("./figures/chart.png")
            .map_err(|error| error.1)
            .unwrap()
            .0,
        "figures/chart.png"
    );
    for path in ["", "../secret", "/etc/passwd", "figures/../secret"] {
        assert!(
            validated_project_file_path(path).is_err(),
            "accepted {path:?}"
        );
    }
}

#[test]
fn local_file_actions_rename_duplicate_and_delete() {
    let root = std::env::temp_dir().join(format!("orx-file-actions-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("reports")).unwrap();
    std::fs::write(root.join("reports/result.md"), "result").unwrap();

    let renamed = manage_local_file(
        &root,
        "reports/result.md",
        FileAction::Rename,
        Some("summary.md"),
        true,
    )
    .map_err(|error| error.1)
    .unwrap();
    assert_eq!(renamed, "reports/summary.md");

    let duplicated = manage_local_file(&root, &renamed, FileAction::Duplicate, None, true)
        .map_err(|error| error.1)
        .unwrap();
    assert_eq!(duplicated, "reports/summary copy.md");
    assert_eq!(
        std::fs::read_to_string(root.join(&duplicated)).unwrap(),
        "result"
    );

    manage_local_file(&root, &duplicated, FileAction::Delete, None, true)
        .map_err(|error| error.1)
        .unwrap();
    assert!(!root.join(duplicated).exists());
    assert!(manage_local_file(
        &root,
        &renamed,
        FileAction::Rename,
        Some("../escape.md"),
        true,
    )
    .is_err());
    std::fs::create_dir(root.join(".git")).unwrap();
    std::fs::write(root.join(".git/config"), "private").unwrap();
    assert!(manage_local_file(&root, ".git/config", FileAction::Delete, None, true,).is_err());
    #[cfg(unix)]
    {
        let outside =
            std::env::temp_dir().join(format!("orx-file-actions-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("jump")).unwrap();
        std::os::unix::fs::symlink(root.join(&renamed), outside.join("back")).unwrap();
        assert!(manage_local_file(&root, "jump/back", FileAction::Delete, None, true,).is_err());
        assert!(outside.join("back").exists());
        std::os::unix::fs::symlink(root.join(&renamed), root.join("reports/summary-link")).unwrap();
        assert!(manage_local_file(
            &root,
            &renamed,
            FileAction::Rename,
            Some("summary-link"),
            true,
        )
        .is_err());
        assert!(root.join(&renamed).exists());
        assert!(std::fs::symlink_metadata(root.join("reports/summary-link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(manage_local_file(
            &root,
            "reports/summary-link",
            FileAction::Duplicate,
            None,
            true,
        )
        .is_err());
        std::os::unix::fs::symlink(root.join(".git"), root.join("git-link")).unwrap();
        assert!(
            manage_local_file(&root, "git-link/config", FileAction::Delete, None, true,).is_err()
        );
        let _ = std::fs::remove_dir_all(outside);
    }
    let case_renamed = manage_local_file(
        &root,
        &renamed,
        FileAction::Rename,
        Some("SUMMARY.md"),
        true,
    )
    .map_err(|error| error.1)
    .unwrap();
    assert_eq!(case_renamed, "reports/SUMMARY.md");
    assert!(root.join(case_renamed).exists());
    assert!(std::fs::read_dir(root.join("reports"))
        .unwrap()
        .any(|entry| entry.unwrap().file_name() == "SUMMARY.md"));
    let _ = std::fs::remove_dir_all(root);
}

// ApiError has no Debug, so `.unwrap()` on the Err path won't compile; drop
// the error to its message string to make the Result assertion-friendly.
fn abs_path(path: &str) -> std::result::Result<(String, std::path::PathBuf), String> {
    validated_absolute_file_path(path).map_err(|error| error.1)
}

#[test]
fn absolute_file_paths_require_an_absolute_path() {
    #[cfg(windows)]
    let absolute = r"C:\Windows\System32\drivers\etc\hosts";
    #[cfg(not(windows))]
    let absolute = "/etc/hosts";

    assert_eq!(
        abs_path(&format!("  {absolute}  ")),
        Ok((absolute.to_string(), std::path::PathBuf::from(absolute))),
    );
    for path in ["", "   ", "relative/path", "../secret", &"/x".repeat(3000)] {
        assert!(abs_path(path).is_err(), "accepted {path:?}");
    }
}

#[test]
fn absolute_file_paths_expand_a_leading_tilde() {
    let home = dirs::home_dir().expect("home dir");
    // `~/x` and bare `~` resolve under home; the display stays as typed.
    assert_eq!(
        abs_path("~/.ssh/config"),
        Ok(("~/.ssh/config".to_string(), home.join(".ssh/config"))),
    );
    assert_eq!(abs_path("~").map(|(_, p)| p), Ok(home));
    // `~otheruser` isn't expanded, so it stays relative and is rejected.
    assert!(abs_path("~otheruser/x").is_err());
}

fn no_key(path: Option<&str>) -> SshReadiness {
    SshReadiness::NoUsableKey {
        pub_path: path.map(str::to_string),
    }
}

/// The row used to hardcode `~/.ssh/id_ed25519.pub`, which is wrong on any
/// machine whose key is named something else.
#[test]
fn names_the_key_file_we_actually_found() {
    let s = openresearch_summary(true, &no_key(Some("~/.ssh/work_ed25519.pub")));
    assert!(s.contains("orx ssh-key add ~/.ssh/work_ed25519.pub"));
    assert!(!s.contains("id_ed25519"), "no guessed default");
}

/// Nothing on disk to register, so `ssh-key add` alone would fail.
#[test]
fn tells_you_to_generate_one_when_there_is_no_key() {
    let s = openresearch_summary(true, &no_key(None));
    assert!(s.contains("ssh-keygen"));
}

#[test]
fn signed_out_beats_every_key_state() {
    assert!(openresearch_summary(false, &SshReadiness::Ready).contains("orx login"));
    assert!(openresearch_summary(false, &no_key(None)).contains("orx login"));
}

#[test]
fn unverified_says_why_it_could_not_check() {
    let s = openresearch_summary(
        true,
        &SshReadiness::Unverified {
            reason: "timed out".to_string(),
        },
    );
    assert!(s.contains("timed out"), "surfaces the cause: {s}");
}
