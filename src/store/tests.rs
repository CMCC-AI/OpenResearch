use super::*;

#[test]
fn wal_setup_honors_the_lock_timeout() {
    let dir = std::env::temp_dir().join(format!("orx-wal-timeout-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let locked = Connection::open(dir.join("orx.db")).unwrap();
    locked
        .execute_batch(
            "CREATE TABLE preserved (value TEXT);
             INSERT INTO preserved VALUES ('kept');
             BEGIN;
             SELECT * FROM preserved;",
        )
        .unwrap();

    for timeout in [Duration::ZERO, Duration::from_millis(50)] {
        let start = std::time::Instant::now();
        let error = Store::open_at_with_move_lock(dir.clone(), dir.join(".lock"), timeout)
            .err()
            .expect("the reader blocks the journal mode change");
        let elapsed = start.elapsed();
        assert_eq!(
            error
                .downcast_ref::<rusqlite::Error>()
                .unwrap()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        assert!(elapsed >= timeout, "{elapsed:?}");
        assert!(elapsed < timeout + Duration::from_secs(1), "{elapsed:?}");
    }

    locked.execute_batch("ROLLBACK").unwrap();
    let store = Store::open_at(dir.clone()).unwrap();
    let mode: String = store
        .conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    drop(store);
    drop(locked);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn concurrent_opens_apply_the_schema_without_partial_state() {
    let dir = std::env::temp_dir().join(format!("orx-schema-concurrent-{}", uuid::Uuid::new_v4()));
    let ready = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    ready.wait();
                    let store = Store::open_at(dir.clone()).unwrap();
                    assert!(!store.ui_state().unwrap().onboarding_completed);
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    });
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "synthetic Store open profile; run explicitly with --ignored --nocapture"]
fn store_open_profile_benchmark() {
    let dir = std::env::temp_dir().join(format!("orx-open-profile-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let tx = store.begin().unwrap();
    for i in 0..1000 {
        tx.execute("INSERT INTO chat_sessions(id,project_id,harness,permission_mode,created_at,updated_at) VALUES(?1,'project','opencode','default',1,1)", [format!("session-{i}")]).unwrap();
    }
    tx.commit().unwrap();
    drop(store);
    let mut totals = std::collections::BTreeMap::<&str, f64>::new();
    for _ in 0..30 {
        let mut previous = std::time::Instant::now();
        let store = Store::open_profiled(
            dir.clone(),
            dir.join(".orx-data-dir-move.lock"),
            BUSY_TIMEOUT,
            |name| {
                let now = std::time::Instant::now();
                *totals.entry(name).or_default() += (now - previous).as_secs_f64() * 1000.0;
                previous = now;
            },
        )
        .unwrap();
        assert_eq!(
            store
                .conn
                .query_row("SELECT COUNT(*) FROM chat_sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1000
        );
    }
    eprintln!("store_open_profile rounds=30 sessions=1000 phase_total_ms={totals:?}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_lock_keeps_legacy_inode() {
    let config_dir = std::env::temp_dir().join(format!("orx-lock-{}", uuid::Uuid::new_v4()));
    let lock = open_lifecycle_lock_in(&config_dir).unwrap();
    let legacy = config_dir.join("orx.lifecycle.lock");
    let path = lifecycle_lock_path_in(&config_dir);
    assert!(same_file::is_same_file(legacy, &path).unwrap());
    assert!(path.parent().unwrap().is_dir());
    assert!(!config_dir
        .join("credentials.json")
        .starts_with(path.parent().unwrap()));
    drop(lock);
    std::fs::remove_dir_all(config_dir).unwrap();
}

#[test]
fn lifecycle_lock_rejects_replaced_entry() {
    let config_dir = std::env::temp_dir().join(format!("orx-lock-{}", uuid::Uuid::new_v4()));
    let lock = open_lifecycle_lock_in(&config_dir).unwrap();
    let path = lifecycle_lock_path_in(&config_dir);
    drop(lock);
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, "replacement").unwrap();
    assert!(open_lifecycle_lock_in(&config_dir).is_err());
    std::fs::remove_dir_all(config_dir).unwrap();
}

#[test]
fn lifecycle_lock_uses_legacy_when_dedicated_dir_cannot_be_created() {
    let config_dir = std::env::temp_dir().join(format!("orx-lock-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(config_dir.join("locks"), "not a directory").unwrap();
    assert!(open_lifecycle_lock_in(&config_dir).is_ok());
    std::fs::remove_dir_all(config_dir).unwrap();
}

#[test]
fn human_bytes_scales() {
    assert_eq!(human_bytes(512), "512 B");
    assert_eq!(human_bytes(2048), "2.0 KB");
    assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
}

#[test]
fn legacy_ssh_tool_failures_require_a_fresh_check() {
    let dir = std::env::temp_dir().join(format!(
        "orx-store-legacy-ssh-tests-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open(dir.join("orx.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE ssh_host_tests (
             host TEXT PRIMARY KEY,
             reachable INTEGER NOT NULL,
             git_found INTEGER NOT NULL,
             tools_found INTEGER NOT NULL DEFAULT 0,
             error TEXT,
             tested_at INTEGER NOT NULL
         );
         INSERT INTO ssh_host_tests VALUES ('legacy-tools', 1, 0, 0, NULL, 1);
         INSERT INTO ssh_host_tests VALUES ('legacy-connect', 0, 0, 0, 'timed out', 2);",
    )
    .unwrap();
    drop(conn);

    let store = Store::open_at(dir.clone()).unwrap();
    let tests = store.list_ssh_host_tests().unwrap();
    assert_eq!(tests.len(), 1);
    assert_eq!(tests[0].host, "legacy-connect");

    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn workspace_state_roundtrips_without_touching_project_activity_or_preferences() {
    let dir = std::env::temp_dir().join(format!("orx-workspace-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    for id in ["first", "second"] {
        store
            .create_local_project(&LocalProject {
                id: id.into(),
                name: id.into(),
                slug: id.into(),
                github_owner: String::new(),
                github_repo: String::new(),
                github_sync_enabled: false,
                baseline_branch: "main".into(),
                repo_path: dir.join(id).to_string_lossy().into_owned(),
                run_command: None,
                paper_id: None,
                created_at: 1,
                updated_at: 2,
            })
            .unwrap();
    }
    let value = serde_json::json!({
        "version": 1,
        "lastLocation": "/projects/first/tasks/new",
        "lastTaskId": null,
        "tasks": {"new": {
            "tabs": [
                {"kind":"home", "view":"files"},
                {"kind":"experiment", "experimentId":"experiment", "view":"terminal", "runId":"run"},
                {"kind":"file", "path":"paper.tex", "source":"repo", "sessionId":"session", "ref":"main", "line":12},
                {"kind":"code", "experimentId":"experiment", "branch":"main", "view":"changes"},
                {"kind":"plan", "sessionId":"session", "promptId":"prompt"},
                {"kind":"subagent", "sessionId":"session", "spawnPartId":"part"}
            ],
            "active":{"kind":"home", "view":"files"}, "previewKey":"file:paper.tex",
            "history":["home", "file:paper.tex"], "expanded":{"files":["src"]},
            "scroll":{"file:paper.tex":{"top":23.5,"left":2.0}}, "sourceModes":{"file:paper.tex":true},
            "filesView":"changes", "scope":"agent", "panelMax":true,
            "treeViewport":{"x":-24.0,"y":18.0,"zoom":1.4}
        }}
    });
    let workspace: WorkspaceState = serde_json::from_value(value.clone()).unwrap();
    assert!(store.project_workspace_state("first").unwrap().is_none());
    assert!(store
        .set_project_workspace_state("first", &workspace)
        .unwrap());
    assert!(!store
        .set_project_workspace_state("missing", &workspace)
        .unwrap());
    assert!(store.project_workspace_state("second").unwrap().is_none());
    assert_eq!(
        store
            .get_local_project("first")
            .unwrap()
            .unwrap()
            .updated_at,
        2
    );
    let preferences = store.ui_state().unwrap();
    let global: GlobalWorkspaceState = serde_json::from_value(serde_json::json!({
        "lastLocation":"/projects/first/settings/storage", "railOpen":false,
        "panelWidth":620, "experimentsView":"table"
    }))
    .unwrap();
    store.set_global_workspace_state(&global).unwrap();
    assert_eq!(
        store.ui_state().unwrap().preferred_agent,
        preferences.preferred_agent
    );
    assert_eq!(
        store.ui_state().unwrap().onboarding_completed,
        preferences.onboarding_completed
    );
    store.set_tour_completed(true).unwrap();
    store.set_onboarding_completed(true).unwrap();
    store
        .set_preferred_agent(&StoredAgentSelection {
            harness: "codex".into(),
            model: None,
            service_tier: None,
            permission_mode: None,
            reasoning_level: None,
        })
        .unwrap();
    assert_eq!(store.ui_state().unwrap().workspace, Some(global.clone()));
    drop(store);
    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(store.project_workspace_state("first").unwrap()).unwrap(),
        value
    );
    assert_eq!(store.ui_state().unwrap().workspace, Some(global));
    for corrupt in [
        "not json",
        "{\"version\":2,\"lastLocation\":null,\"tasks\":{}}",
    ] {
        store
            .conn
            .execute(
                "UPDATE local_projects SET workspace_state_json = ?1 WHERE id = 'first'",
                params![corrupt],
            )
            .unwrap();
        assert!(store.project_workspace_state("first").unwrap().is_none());
    }
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn ui_state_roundtrips_functional_preferences() {
    let dir = std::env::temp_dir().join(format!("orx-store-ui-state-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(
        store.ui_state().unwrap(),
        StoredUiState {
            onboarding_completed: false,
            tour_completed: false,
            preferred_agent: None,
            workspace: None,
            preferred_autonomy: None,
            opencode_review_model: None,
        }
    );

    let selection = StoredAgentSelection {
        harness: "codex".into(),
        model: Some("gpt-5.6".into()),
        service_tier: Some("priority".into()),
        permission_mode: Some("plan".into()),
        reasoning_level: Some("high".into()),
    };
    store.set_onboarding_completed(true).unwrap();
    store.set_tour_completed(true).unwrap();
    store.set_preferred_agent(&selection).unwrap();
    store.set_preferred_autonomy(Autonomy::Copilot).unwrap();
    store
        .set_opencode_review_model(Some("openai/gpt-6-mini"))
        .unwrap();

    assert_eq!(
        store.ui_state().unwrap(),
        StoredUiState {
            onboarding_completed: true,
            tour_completed: true,
            preferred_agent: Some(selection),
            workspace: None,
            preferred_autonomy: Some(Autonomy::Copilot),
            opencode_review_model: Some("openai/gpt-6-mini".into()),
        }
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn ui_state_singleton_seeds_existing_projects_and_latest_session() {
    let dir = std::env::temp_dir().join(format!("orx-store-ui-migrate-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_local_project(&LocalProject {
            id: "project".into(),
            name: "Project".into(),
            slug: "project".into(),
            github_owner: String::new(),
            github_repo: String::new(),
            github_sync_enabled: false,
            baseline_branch: "main".into(),
            repo_path: dir.join("project").to_string_lossy().into_owned(),
            run_command: None,
            paper_id: None,
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();
    let mut older = chat_session_fixture("older");
    older.harness = "codex".into();
    store.create_chat_session(&older).unwrap();
    let mut session = chat_session_fixture("latest");
    session.harness = "claude-code".into();
    session.model = Some("model".into());
    session.permission_mode = Some("plan".into());
    session.updated_at = 2;
    store.create_chat_session(&session).unwrap();
    store.conn.execute("DELETE FROM ui_state", []).unwrap();
    drop(store);

    let migrated = Store::open_at(dir.clone()).unwrap().ui_state().unwrap();
    assert!(migrated.onboarding_completed);
    assert!(migrated.tour_completed);
    let preferred = migrated.preferred_agent.unwrap();
    assert_eq!(preferred.harness, "claude-code");
    assert_eq!(preferred.permission_mode.as_deref(), Some("auto"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn chat_session_context_usage_roundtrips() {
    let dir = std::env::temp_dir().join(format!("orx-store-ctxusage-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    // Fresh session: no usage yet.
    assert!(store
        .get_chat_session("chat_1")
        .unwrap()
        .unwrap()
        .context_usage_json
        .is_none());
    // Set, then read it back verbatim.
    let json = r#"{"usedTokens":27564,"contextWindow":200000}"#;
    store
        .set_chat_session_context_usage("chat_1", json)
        .unwrap();
    assert_eq!(
        store
            .get_chat_session("chat_1")
            .unwrap()
            .unwrap()
            .context_usage_json
            .as_deref(),
        Some(json)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn clean_permission_normalization_does_not_require_writer_lock() {
    let dir = std::env::temp_dir().join(format!("orx-permission-read-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = chat_session_fixture("clean");
    session.harness = "opencode".into();
    session.permission_mode = Some("auto-approve".into());
    store.create_chat_session(&session).unwrap();
    store.set_busy_timeout(Duration::ZERO).unwrap();
    let writer = Connection::open(dir.join("orx.db")).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    normalize_permission_modes(&store.conn).unwrap();
    assert_eq!(
        store
            .get_chat_session("clean")
            .unwrap()
            .unwrap()
            .permission_mode
            .as_deref(),
        Some("auto-approve")
    );
    writer.execute_batch("ROLLBACK").unwrap();
    drop(writer);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn permission_normalization_rolls_back_and_reports_failed_updates() {
    let dir =
        std::env::temp_dir().join(format!("orx-permission-rollback-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = chat_session_fixture("legacy");
    session.harness = "codex".into();
    session.permission_mode = Some("plan".into());
    store.create_chat_session(&session).unwrap();
    store
        .conn
        .execute_batch(
            "UPDATE ui_state SET preferred_harness='codex', preferred_permission_mode='plan';
         CREATE TEMP TRIGGER fail_permission_normalization
         BEFORE UPDATE OF preferred_permission_mode ON ui_state
         BEGIN SELECT RAISE(ABORT, 'injected permission migration failure'); END;",
        )
        .unwrap();

    let error = normalize_permission_modes(&store.conn).unwrap_err();
    assert!(error
        .to_string()
        .contains("injected permission migration failure"));
    let unchanged = store.get_chat_session("legacy").unwrap().unwrap();
    assert_eq!(unchanged.permission_mode.as_deref(), Some("plan"));
    assert!(!unchanged.plan_mode);
    let preference: String = store
        .conn
        .query_row(
            "SELECT preferred_permission_mode FROM ui_state WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preference, "plan");
    assert!(store.conn.is_autocommit());

    store
        .conn
        .execute_batch("DROP TRIGGER fail_permission_normalization")
        .unwrap();
    normalize_permission_modes(&store.conn).unwrap();
    let migrated = store.get_chat_session("legacy").unwrap().unwrap();
    assert_eq!(migrated.permission_mode.as_deref(), Some("ask"));
    assert!(migrated.plan_mode);
    assert_eq!(
        store
            .ui_state()
            .unwrap()
            .preferred_agent
            .unwrap()
            .permission_mode
            .as_deref(),
        Some("ask")
    );
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn warm_open_rechecks_new_legacy_permissions_and_preserves_null_preferences() {
    let dir = std::env::temp_dir().join(format!("orx-permission-recheck-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .conn
        .execute(
            "UPDATE ui_state SET preferred_harness='claude-code', preferred_permission_mode=NULL",
            [],
        )
        .unwrap();
    normalize_permission_modes(&store.conn).unwrap();
    let mode: Option<String> = store
        .conn
        .query_row(
            "SELECT preferred_permission_mode FROM ui_state",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(mode.is_none());
    drop(store);
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = chat_session_fixture("imported");
    session.harness = "opencode".into();
    session.permission_mode = Some("plan".into());
    session.reasoning_level = Some("high".into());
    store.create_chat_session(&session).unwrap();
    store
        .conn
        .execute(
            "UPDATE ui_state SET preferred_harness='claude-code', preferred_permission_mode='plan'",
            [],
        )
        .unwrap();
    drop(store);
    let store = Store::open_at(dir.clone()).unwrap();
    let imported = store.get_chat_session("imported").unwrap().unwrap();
    assert_eq!(imported.permission_mode.as_deref(), Some("auto-approve"));
    assert!(imported.plan_mode);
    assert_eq!(imported.reasoning_level.as_deref(), Some("high"));
    assert_eq!(
        store
            .ui_state()
            .unwrap()
            .preferred_agent
            .unwrap()
            .permission_mode
            .as_deref(),
        Some("auto")
    );
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn permission_and_plan_migration_preserves_each_harness_native_contract() {
    let dir = std::env::temp_dir().join(format!("orx-store-plan-migrate-{}", uuid::Uuid::new_v4()));
    {
        let store = Store::open_at(dir.clone()).unwrap();
        for (id, harness, mode) in [
            ("claude_manual", "claude-code", "ask"),
            ("claude_edits", "claude-code", "accept-edits"),
            ("claude_plan", "claude-code", "plan"),
            ("codex_plan", "codex", "plan"),
            ("codex_auto", "codex", "auto"),
            ("codex_bypass", "codex", "bypass"),
            ("codex_invalid", "codex", "retired-mode"),
            ("open_plan", "opencode", "plan"),
            ("open_default", "opencode", "default"),
            ("open_ask", "opencode", "ask"),
            ("open_manual", "opencode", "manual"),
            ("open_auto", "opencode", "auto"),
            ("open_bypass", "opencode", "bypass"),
            ("open_invalid", "opencode", "retired-mode"),
        ] {
            let mut session = chat_session_fixture(id);
            session.harness = harness.into();
            session.permission_mode = Some(mode.into());
            store.create_chat_session(&session).unwrap();
        }
    }
    let store = Store::open_at(dir.clone()).unwrap();
    let state = |id: &str| {
        let session = store.get_chat_session(id).unwrap().unwrap();
        (session.permission_mode.unwrap(), session.plan_mode)
    };
    assert_eq!(state("claude_manual"), ("manual".into(), false));
    assert_eq!(state("claude_edits"), ("acceptEdits".into(), false));
    assert_eq!(state("claude_plan"), ("plan".into(), false));
    assert_eq!(state("codex_plan"), ("ask".into(), true));
    assert_eq!(state("codex_auto"), ("approve-for-me".into(), false));
    assert_eq!(state("codex_bypass"), ("full-access".into(), false));
    assert_eq!(state("codex_invalid"), ("approve-for-me".into(), false));
    assert_eq!(state("open_plan"), ("auto-approve".into(), true));
    assert_eq!(state("open_default"), ("auto-approve".into(), false));
    assert_eq!(state("open_ask"), ("auto-approve".into(), false));
    assert_eq!(state("open_manual"), ("manual".into(), false));
    assert_eq!(state("open_auto"), ("auto".into(), false));
    assert_eq!(state("open_bypass"), ("auto-approve".into(), false));
    assert_eq!(state("open_invalid"), ("auto-approve".into(), false));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn codex_plan_reset_marker_roundtrips_and_clears() {
    let dir = std::env::temp_dir().join(format!("orx-store-plan-reset-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = chat_session_fixture("codex");
    session.harness = "codex".into();
    session.permission_mode = Some("approve-for-me".into());
    store.create_chat_session(&session).unwrap();
    store
        .set_chat_session_plan_state("codex", false, true)
        .unwrap();
    assert!(
        store
            .get_chat_session("codex")
            .unwrap()
            .unwrap()
            .plan_reset_pending
    );
    store.clear_chat_session_plan_reset("codex").unwrap();
    assert!(
        !store
            .get_chat_session("codex")
            .unwrap()
            .unwrap()
            .plan_reset_pending
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn chat_message_existence_tracks_persisted_messages() {
    let dir = std::env::temp_dir().join(format!("orx-store-messages-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    assert!(!store.has_chat_messages("chat_1").unwrap());

    store
        .upsert_chat_message(&StoredChatMessage {
            id: "msg_1".into(),
            session_id: "chat_1".into(),
            role: "user".into(),
            parts_json: "[]".into(),
            created_at: 1,
            completed_at: None,
            parent_id: None,
            base_native_session_id: None,
            result_native_session_id: None,
        })
        .unwrap();
    assert!(store.has_chat_messages("chat_1").unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

pub(super) fn chat_turn_fixture(id: &str, client_turn_id: &str) -> StoredChatTurn {
    StoredChatTurn {
        id: id.into(),
        session_id: "chat_1".into(),
        user_message_id: Some(format!("msg_{id}")),
        assistant_message_id: format!("assistant_{id}"),
        client_turn_id: client_turn_id.into(),
        request_hash: "hash-a".into(),
        prepared_input: "prepared".into(),
        settings_json: "{}".into(),
        state: "preparing".into(),
        delivery_state: "not_sent".into(),
        attempt_count: 0,
        next_retry_at: None,
        error_kind: None,
        error_message: None,
        recovery_action: None,
        recovered_by_turn_id: None,
        created_at: 2,
        updated_at: 2,
    }
}

#[test]
fn submission_receipts_follow_queue_promotion_and_remain_session_scoped() {
    let dir = std::env::temp_dir().join(format!("orx-submission-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    for session in ["chat_1", "chat_2"] {
        store
            .create_chat_session(&chat_session_fixture(session))
            .unwrap();
    }
    assert!(store
        .chat_submission_by_client_id("chat_1", "client")
        .unwrap()
        .is_none());
    for (id, session) in [("queue-1", "chat_1"), ("queue-2", "chat_2")] {
        store
            .insert_queued_chat_message(&StoredQueuedChatMessage {
                id: id.into(),
                session_id: session.into(),
                client_turn_id: "client".into(),
                request_hash: "hash".into(),
                payload_json: "not parsed by receipt lookup".into(),
                created_at: 1,
            })
            .unwrap();
    }
    assert_eq!(
        store
            .chat_submission_by_client_id("chat_1", "client")
            .unwrap(),
        Some(("queued".into(), "queue-1".into()))
    );
    assert_eq!(
        store
            .chat_submission_by_client_id("chat_2", "client")
            .unwrap(),
        Some(("queued".into(), "queue-2".into()))
    );
    assert!(store
        .chat_submission_by_client_id("chat_1", "other-client")
        .unwrap()
        .is_none());
    store
        .admit_chat_turn(None, &chat_turn_fixture("turn", "client"))
        .unwrap();
    assert_eq!(
        store
            .chat_submission_by_client_id("chat_1", "client")
            .unwrap(),
        Some(("turn".into(), "turn".into()))
    );
    store.delete_queued_chat_message("queue-1").unwrap();
    drop(store);
    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(
        store
            .chat_submission_by_client_id("chat_1", "client")
            .unwrap(),
        Some(("turn".into(), "turn".into()))
    );
    assert_eq!(
        store
            .chat_submission_by_client_id("chat_2", "client")
            .unwrap(),
        Some(("queued".into(), "queue-2".into()))
    );
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn named_model_history_is_scoped_to_the_native_thread() {
    let dir = std::env::temp_dir().join(format!("orx-store-model-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let mut turn = chat_turn_fixture("one", "client-1");
    turn.settings_json = r#"{"model":"gpt-6-astra-canary-invalid"}"#.into();
    store.admit_chat_turn(None, &turn).unwrap();
    store
        .upsert_chat_message(&StoredChatMessage {
            id: turn.assistant_message_id,
            session_id: "chat_1".into(),
            role: "assistant".into(),
            parts_json: "[]".into(),
            created_at: 2,
            completed_at: None,
            parent_id: None,
            base_native_session_id: None,
            result_native_session_id: Some("old-thread".into()),
        })
        .unwrap();
    assert!(store
        .chat_native_thread_has_named_model("chat_1", "old-thread")
        .unwrap());
    assert!(!store
        .chat_native_thread_has_named_model("chat_1", "fresh-thread")
        .unwrap());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn chat_turn_admission_is_atomic_and_idempotent() {
    let dir = std::env::temp_dir().join(format!("orx-store-turns-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let turn = chat_turn_fixture("one", "client-1");
    let user = StoredChatMessage {
        id: turn.user_message_id.clone().unwrap(),
        session_id: "chat_1".into(),
        role: "user".into(),
        parts_json: "[]".into(),
        created_at: 2,
        completed_at: None,
        parent_id: None,
        base_native_session_id: None,
        result_native_session_id: None,
    };
    assert_eq!(
        store.admit_chat_turn(Some(&user), &turn).unwrap(),
        ChatTurnAdmission::Inserted
    );
    assert!(matches!(
        store.admit_chat_turn(Some(&user), &turn).unwrap(),
        ChatTurnAdmission::Existing(existing) if existing.id == turn.id
    ));
    assert_eq!(store.list_chat_messages("chat_1").unwrap().len(), 1);
    assert_eq!(
        store
            .get_chat_session("chat_1")
            .unwrap()
            .unwrap()
            .active_leaf_id
            .as_deref(),
        Some(user.id.as_str())
    );

    let mut conflict = turn.clone();
    conflict.id = "two".into();
    conflict.request_hash = "hash-b".into();
    assert_eq!(
        store.admit_chat_turn(None, &conflict).unwrap(),
        ChatTurnAdmission::Conflict
    );
    assert_eq!(
        store
            .get_chat_turn_by_client_id("chat_1", "client-1")
            .unwrap()
            .unwrap()
            .id,
        "one"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unfinished_turns_reconcile_by_delivery_certainty() {
    let dir = std::env::temp_dir().join(format!("orx-store-reconcile-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let retry = chat_turn_fixture("retry", "client-retry");
    store.admit_chat_turn(None, &retry).unwrap();
    let mut keep_going = chat_turn_fixture("continue", "client-continue");
    keep_going.delivery_state = "unknown".into();
    keep_going.state = "running".into();
    store.admit_chat_turn(None, &keep_going).unwrap();

    let reconciled = store.reconcile_unfinished_chat_turns().unwrap();
    assert_eq!(reconciled.len(), 2);
    assert_eq!(
        store
            .get_chat_turn("chat_1", "retry")
            .unwrap()
            .unwrap()
            .recovery_action
            .as_deref(),
        Some("retry")
    );
    assert_eq!(
        store
            .get_chat_turn("chat_1", "continue")
            .unwrap()
            .unwrap()
            .recovery_action
            .as_deref(),
        Some("continue")
    );
    assert!(store
        .mark_chat_turn_recovered("continue", "recovery-turn")
        .unwrap());
    let reconciled_again = store.reconcile_unfinished_chat_turns().unwrap();
    assert!(reconciled_again.iter().all(|turn| turn.id != "continue"));
    store.delete_chat_session("chat_1").unwrap();
    assert!(store.get_chat_turn("chat_1", "retry").unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unfinished_turn_reconciliation_respects_live_leases() {
    let dir = std::env::temp_dir().join(format!("orx-store-live-turn-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let mut turn = chat_turn_fixture("running", "client-running");
    turn.state = "running".into();
    store.admit_chat_turn(None, &turn).unwrap();
    assert!(store.claim_chat_turn("chat_1", "owner", &[]).unwrap());

    assert!(store.reconcile_unfinished_chat_turns().unwrap().is_empty());
    assert_eq!(
        store
            .get_chat_turn("chat_1", "running")
            .unwrap()
            .unwrap()
            .state,
        "running"
    );

    store
        .conn
        .execute(
            "UPDATE chat_turn_leases SET heartbeat_at = ?1 WHERE chat_session_id = 'chat_1'",
            params![now_ms() - CHAT_TURN_LEASE_TTL_MS - 1],
        )
        .unwrap();
    assert!(store
        .reconcile_expired_unfinished_chat_turns(&["owner".into()])
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .reconcile_expired_unfinished_chat_turns(&[])
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .reconcile_expired_unfinished_chat_turns(&[])
        .unwrap()
        .is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn chat_completion_time_survives_reload_and_partial_updates() {
    let dir = std::env::temp_dir().join(format!("orx-chat-time-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let mut message = StoredChatMessage {
        id: "answer".into(),
        session_id: "chat_1".into(),
        role: "assistant".into(),
        parts_json: "[]".into(),
        created_at: 1000,
        completed_at: Some(165000),
        parent_id: None,
        base_native_session_id: None,
        result_native_session_id: None,
    };
    store.upsert_chat_message(&message).unwrap();
    message.completed_at = None;
    store.upsert_chat_message(&message).unwrap();
    drop(store);
    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(
        store
            .get_chat_message("answer")
            .unwrap()
            .unwrap()
            .completed_at,
        Some(165000)
    );
    assert_eq!(
        store.list_chat_messages("chat_1").unwrap()[0].completed_at,
        Some(165000)
    );
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn migration_chains_a_legacy_transcript_into_one_branch() {
    let dir = std::env::temp_dir().join(format!("orx-store-tree-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    for (i, (id, role)) in [("m1", "user"), ("m2", "assistant"), ("m3", "user")]
        .into_iter()
        .enumerate()
    {
        store
            .upsert_chat_message(&StoredChatMessage {
                id: id.into(),
                session_id: "chat_1".into(),
                role: role.into(),
                parts_json: "[]".into(),
                created_at: i as i64,
                completed_at: None,
                parent_id: None,
                base_native_session_id: None,
                result_native_session_id: None,
            })
            .unwrap();
    }
    // Rewind the marker so reopening replays the backfill against rows that
    // look exactly like a pre-fork database: every parent NULL.
    store.conn.pragma_update(None, "user_version", 0).unwrap();
    store
        .conn
        .execute(
            "UPDATE chat_sessions SET active_leaf_id = NULL, native_session_id = 'sess-abc'",
            [],
        )
        .unwrap();
    drop(store);

    let store = Store::open_at(dir.clone()).unwrap();
    let parents = store
        .list_chat_messages("chat_1")
        .unwrap()
        .into_iter()
        .map(|m| (m.id, m.parent_id))
        .collect::<Vec<_>>();
    assert_eq!(
        parents,
        vec![
            ("m1".to_string(), None),
            ("m2".to_string(), Some("m1".into())),
            ("m3".to_string(), Some("m2".into())),
        ]
    );
    // The session resumes where it left off, not at the start.
    let session = store.get_chat_session("chat_1").unwrap().unwrap();
    assert_eq!(session.active_leaf_id.as_deref(), Some("m3"));
    // The newest message inherits the live harness id, so paging back to a
    // pre-upgrade branch resumes that conversation instead of starting over.
    let tip = store.get_chat_message("m3").unwrap().unwrap();
    assert_eq!(tip.result_native_session_id.as_deref(), Some("sess-abc"));
    assert_eq!(
        store
            .get_chat_message("m1")
            .unwrap()
            .unwrap()
            .result_native_session_id,
        None
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn retry_reuses_the_turn_without_duplicating_the_user_message() {
    let dir = std::env::temp_dir().join(format!("orx-store-retry-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let turn = chat_turn_fixture("turn_1", "client_1");
    let user = StoredChatMessage {
        id: turn.user_message_id.clone().unwrap(),
        session_id: "chat_1".into(),
        role: "user".into(),
        parts_json: "[]".into(),
        created_at: 1,
        completed_at: None,
        parent_id: None,
        base_native_session_id: None,
        result_native_session_id: None,
    };
    store.admit_chat_turn(Some(&user), &turn).unwrap();
    assert!(store
        .fail_chat_turn("turn_1", "not_sent", "setup", "failed", Some("retry"))
        .unwrap());
    store
        .upsert_chat_message(&StoredChatMessage {
            id: turn.assistant_message_id.clone(),
            role: "assistant".into(),
            completed_at: Some(2000),
            ..user.clone()
        })
        .unwrap();
    assert!(store.reset_chat_turn_for_retry("turn_1", 3000).unwrap());
    assert_eq!(
        store
            .get_chat_message(&turn.assistant_message_id)
            .unwrap()
            .unwrap()
            .completed_at,
        None
    );
    assert_eq!(
        store
            .get_chat_message(&turn.assistant_message_id)
            .unwrap()
            .unwrap()
            .created_at,
        3000
    );
    assert_eq!(store.list_chat_messages("chat_1").unwrap().len(), 2);
    assert_eq!(
        store
            .get_chat_turn("chat_1", "turn_1")
            .unwrap()
            .unwrap()
            .state,
        "preparing"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn explicit_interrupt_clears_a_racing_terminal_recovery() {
    let dir = std::env::temp_dir().join(format!(
        "orx-store-interrupt-recovery-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let turn = chat_turn_fixture("turn_1", "client_1");
    store.admit_chat_turn(None, &turn).unwrap();
    assert!(store
        .fail_chat_turn("turn_1", "not_sent", "setup", "failed", Some("retry"))
        .unwrap());

    store.interrupt_chat_turn("turn_1").unwrap();

    let interrupted = store.get_chat_turn("chat_1", "turn_1").unwrap().unwrap();
    assert_eq!(interrupted.state, "interrupted");
    assert!(interrupted.recovery_action.is_none());
    assert!(!store.reset_chat_turn_for_retry("turn_1", 3000).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn continue_recovery_claim_and_message_cleanup_are_idempotent() {
    let dir = std::env::temp_dir().join(format!("orx-store-continue-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let mut turn = chat_turn_fixture("turn_1", "client_1");
    turn.state = "failed".into();
    turn.delivery_state = "unknown".into();
    turn.recovery_action = Some("continue".into());
    store.admit_chat_turn(None, &turn).unwrap();
    let assistant = StoredChatMessage {
        id: turn.assistant_message_id.clone(),
        session_id: "chat_1".into(),
        role: "assistant".into(),
        parts_json: "[]".into(),
        created_at: 1,
        completed_at: None,
        parent_id: None,
        base_native_session_id: None,
        result_native_session_id: None,
    };
    assert!(store
        .mark_chat_turn_recovered_with_message("turn_1", "recovery_1", &assistant)
        .unwrap());
    assert!(!store
        .mark_chat_turn_recovered_with_message("turn_1", "recovery_2", &assistant)
        .unwrap());
    let recovered = store.get_chat_turn("chat_1", "turn_1").unwrap().unwrap();
    assert_eq!(
        recovered.recovered_by_turn_id.as_deref(),
        Some("recovery_1")
    );
    assert!(recovered.recovery_action.is_none());
    assert_eq!(
        store
            .get_chat_message(&assistant.id)
            .unwrap()
            .unwrap()
            .parts_json,
        "[]"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn synthetic_recovery_message_stays_on_the_failed_turn_branch() {
    let dir = std::env::temp_dir().join(format!(
        "orx-store-recovery-branch-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let mut turn = chat_turn_fixture("turn_1", "client_1");
    turn.state = "failed".into();
    turn.recovery_action = Some("retry".into());
    let user = StoredChatMessage {
        id: turn.user_message_id.clone().unwrap(),
        session_id: "chat_1".into(),
        role: "user".into(),
        parts_json: "[]".into(),
        created_at: 1,
        completed_at: None,
        parent_id: None,
        base_native_session_id: Some("native_1".into()),
        result_native_session_id: None,
    };
    store.admit_chat_turn(Some(&user), &turn).unwrap();
    let recovery = StoredChatMessage {
        id: turn.assistant_message_id.clone(),
        session_id: "chat_1".into(),
        role: "assistant".into(),
        parts_json: "[]".into(),
        created_at: 2,
        completed_at: None,
        parent_id: Some(user.id.clone()),
        base_native_session_id: Some("native_1".into()),
        result_native_session_id: None,
    };
    assert!(store
        .upsert_chat_recovery_message_if_actionable(&turn.id, &recovery)
        .unwrap());
    assert_eq!(
        store
            .get_chat_message(&recovery.id)
            .unwrap()
            .unwrap()
            .parent_id
            .as_deref(),
        Some(user.id.as_str())
    );
    assert_eq!(
        store
            .get_chat_session("chat_1")
            .unwrap()
            .unwrap()
            .active_leaf_id
            .as_deref(),
        Some(recovery.id.as_str())
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn recovery_settings_replace_nullable_axes_atomically() {
    let dir = std::env::temp_dir().join(format!("orx-store-settings-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = chat_session_fixture("chat_1");
    session.model = Some("old-model".into());
    session.service_tier = Some("priority".into());
    session.permission_mode = Some("ask".into());
    session.reasoning_level = Some("high".into());
    store.create_chat_session(&session).unwrap();

    store
        .set_chat_session_recovery_settings(
            "chat_1",
            None,
            Some("default"),
            None,
            Some((true, false)),
            Some("low"),
        )
        .unwrap();
    let recovered = store.get_chat_session("chat_1").unwrap().unwrap();
    assert!(recovered.model.is_none());
    assert_eq!(recovered.service_tier.as_deref(), Some("default"));
    assert!(recovered.permission_mode.is_none());
    assert!(recovered.plan_mode);
    assert_eq!(recovered.reasoning_level.as_deref(), Some("low"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn queued_chat_messages_survive_reopen_and_delete_with_session() {
    let dir = std::env::temp_dir().join(format!("orx-store-queue-{}", uuid::Uuid::new_v4()));
    {
        let store = Store::open_at(dir.clone()).unwrap();
        store
            .create_chat_session(&chat_session_fixture("chat_1"))
            .unwrap();
        store
            .insert_queued_chat_message(&StoredQueuedChatMessage {
                id: "queue-1".into(),
                session_id: "chat_1".into(),
                client_turn_id: "client-1".into(),
                request_hash: "hash-1".into(),
                payload_json: "{\"text\":\"hello\"}".into(),
                created_at: 1,
            })
            .unwrap();
        store
            .insert_queued_chat_message(&StoredQueuedChatMessage {
                id: "queue-2".into(),
                session_id: "chat_1".into(),
                client_turn_id: "client-2".into(),
                request_hash: "hash-2".into(),
                payload_json: "{\"text\":\"world\"}".into(),
                created_at: 1,
            })
            .unwrap();
    }
    let store = Store::open_at(dir.clone()).unwrap();
    let queued = store.list_queued_chat_messages().unwrap();
    assert_eq!(
        queued
            .iter()
            .map(|message| message.client_turn_id.as_str())
            .collect::<Vec<_>>(),
        ["client-1", "client-2"]
    );
    store.delete_chat_session("chat_1").unwrap();
    assert!(store.list_queued_chat_messages().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_branched_message_keeps_its_parent_across_streaming_rewrites() {
    let dir = std::env::temp_dir().join(format!("orx-store-branch-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let message = |id: &str, role: &str, parts: &str| StoredChatMessage {
        id: id.into(),
        session_id: "chat_1".into(),
        role: role.into(),
        parts_json: parts.into(),
        created_at: 0,
        completed_at: None,
        parent_id: None,
        base_native_session_id: None,
        result_native_session_id: None,
    };
    assert_eq!(
        store
            .upsert_chat_message_on_branch(&message("m1", "user", "[]"))
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .upsert_chat_message_on_branch(&message("m2", "assistant", "[1]"))
            .unwrap(),
        Some("m1".to_string())
    );
    // A later flush of the same message refreshes its parts without
    // re-parenting it or advancing the branch past itself.
    assert_eq!(
        store
            .upsert_chat_message_on_branch(&message("m2", "assistant", "[1,2]"))
            .unwrap(),
        Some("m1".to_string())
    );
    let stored = store.get_chat_message("m2").unwrap().unwrap();
    assert_eq!(stored.parts_json, "[1,2]");
    assert_eq!(stored.parent_id.as_deref(), Some("m1"));
    assert_eq!(
        store
            .get_chat_session("chat_1")
            .unwrap()
            .unwrap()
            .active_leaf_id
            .as_deref(),
        Some("m2")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

pub(super) fn chat_session_fixture(id: &str) -> StoredChatSession {
    StoredChatSession {
        id: id.into(),
        project_id: "proj_1".into(),
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

fn chat_spawn_fixture(session_id: &str, parent: &str) -> ChatSpawn {
    ChatSpawn {
        session_id: session_id.into(),
        parent_session_id: parent.into(),
        prompt: "Sweep the literature for LoRA rank ablations".into(),
        wake_parent: true,
        attempts: 0,
        finished_at: None,
    }
}

#[test]
fn legacy_spawns_migrate_only_unadmitted_opening_messages() {
    let dir = std::env::temp_dir().join(format!("orx-spawn-migration-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .conn
        .execute("DELETE FROM product_migrations", [])
        .unwrap();
    for (id, state) in [
        ("pending", "pending"),
        ("brief", "starting"),
        ("admitted", "starting"),
        ("running", "running"),
        ("waking", "waking"),
        ("done", "done"),
    ] {
        store
            .create_chat_session(&chat_session_fixture(id))
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO chat_spawns (session_id, parent_session_id, prompt, requested_at, state) VALUES (?1, 'parent', 'Opening task', 1, ?2)",
                params![id, state],
            )
            .unwrap();
    }
    let parts =
        serde_json::to_string(&[crate::local::chat::WirePart::text("part", "Opening task")])
            .unwrap();
    store.conn.execute("INSERT INTO chat_messages (id, session_id, role, parts_json, created_at) VALUES ('brief-user', 'brief', 'user', ?1, 1)", params![parts]).unwrap();
    store.conn.execute("INSERT INTO chat_turns (id, session_id, assistant_message_id, client_turn_id, request_hash, prepared_input, settings_json, state, delivery_state, created_at, updated_at) VALUES ('turn', 'admitted', 'assistant', 'ct', 'hash', 'task', '{}', 'interrupted', 'accepted', 1, 1)", []).unwrap();
    drop(store);
    let store = Store::open_at(dir.clone()).unwrap();
    let queued = store.list_queued_chat_messages().unwrap();
    assert_eq!(queued.len(), 2);
    let brief = queued.iter().find(|m| m.session_id == "brief").unwrap();
    assert_eq!(brief.client_turn_id, "legacy_spawn_brief");
    let payload: serde_json::Value = serde_json::from_str(&brief.payload_json).unwrap();
    assert_eq!(payload["transcriptText"], "");
    assert_eq!(store.list_chat_messages("brief").unwrap().len(), 1);
    assert_eq!(store.list_all_chat_sessions().unwrap().len(), 6);
    let exists: bool = store
        .conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'chat_spawns')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        exists,
        "product expert scheduler and rollback retain the schema"
    );
    assert!(store
        .list_chat_spawns(ChatSpawnState::Pending)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list_chat_spawns(ChatSpawnState::Done).unwrap().len(),
        6
    );
    drop(store);
    assert_eq!(
        Store::open_at(dir.clone())
            .unwrap()
            .list_queued_chat_messages()
            .unwrap()
            .len(),
        2
    );
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn independent_chat_upgrade_preserves_expert_dispatch_and_is_idempotent() {
    let dir = std::env::temp_dir().join(format!("orx-expert-upgrade-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .conn
        .execute("DELETE FROM product_migrations", [])
        .unwrap();
    for state in ["pending", "starting", "running", "waking", "done"] {
        let mut session = chat_session_fixture(state);
        session.parent_session_id = Some("lead".into());
        store.create_chat_session(&session).unwrap();
        store
            .create_chat_spawn(&chat_spawn_fixture(state, "lead"))
            .unwrap();
        store.conn.execute("UPDATE chat_spawns SET state=?2, claim_token='token', claimed_at=7, attempts=2, finished_at=9 WHERE session_id=?1", params![state, state]).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO research_sessions VALUES (?1, 'study', ?1, 1)",
                [state],
            )
            .unwrap();
    }
    let snapshot = |store: &Store| -> Vec<(String, String, String, i64, i64, i64)> {
        store.conn.prepare("SELECT session_id,state,claim_token,claimed_at,attempts,finished_at FROM chat_spawns ORDER BY session_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap()
            .collect::<std::result::Result<Vec<_>,_>>().unwrap()
    };
    let before = snapshot(&store);
    drop(store);
    for _ in 0..2 {
        let store = Store::open_at(dir.clone()).unwrap();
        assert_eq!(snapshot(&store), before);
        assert!(store.list_queued_chat_messages().unwrap().is_empty());
        assert_eq!(
            store
                .get_chat_session("pending")
                .unwrap()
                .unwrap()
                .parent_session_id
                .as_deref(),
            Some("lead")
        );
        assert_eq!(
            store
                .conn
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn independent_chat_upgrade_refuses_a_live_legacy_helper_atomically() {
    let dir = std::env::temp_dir().join(format!("orx-live-upgrade-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .conn
        .execute("DELETE FROM product_migrations", [])
        .unwrap();
    store
        .create_chat_session(&chat_session_fixture("pending"))
        .unwrap();
    store
        .create_chat_spawn(&chat_spawn_fixture("pending", "lead"))
        .unwrap();
    assert!(store.claim_chat_turn("pending", "live", &[]).unwrap());
    assert!(migrate_chat_spawns(&store.conn)
        .unwrap_err()
        .to_string()
        .contains("Stop the older"));
    assert!(store.list_queued_chat_messages().unwrap().is_empty());
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Pending)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM product_migrations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    store.release_chat_turn("pending", "live").unwrap();
    migrate_chat_spawns(&store.conn).unwrap();
    assert_eq!(store.list_queued_chat_messages().unwrap().len(), 1);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn chat_session_autonomy_roundtrips() {
    let dir = std::env::temp_dir().join(format!("orx-store-autonomy-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = chat_session_fixture("chat_a");
    session.autonomy = Some("copilot".into());
    store.create_chat_session(&session).unwrap();
    let autonomy = |store: &Store| store.get_chat_session("chat_a").unwrap().unwrap().autonomy;
    assert_eq!(autonomy(&store).as_deref(), Some("copilot"));
    store
        .set_chat_session_autonomy("chat_a", Autonomy::Agentic)
        .unwrap();
    assert_eq!(autonomy(&store).as_deref(), Some("agentic"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn spawned_sessions_record_their_parent() {
    let dir = std::env::temp_dir().join(format!("orx-store-spawnrow-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();

    store
        .create_chat_session(&chat_session_fixture("chat_parent"))
        .unwrap();
    let mut child = chat_session_fixture("chat_child");
    child.parent_session_id = Some("chat_parent".into());
    store.create_chat_session(&child).unwrap();

    assert!(store
        .get_chat_session("chat_parent")
        .unwrap()
        .unwrap()
        .parent_session_id
        .is_none());
    assert_eq!(
        store
            .get_chat_session("chat_child")
            .unwrap()
            .unwrap()
            .parent_session_id
            .as_deref(),
        Some("chat_parent")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn side_chats_stay_out_of_history_and_share_their_parents_worktree() {
    let dir = std::env::temp_dir().join(format!("orx-store-sidechat-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_parent"))
        .unwrap();
    let mut side = chat_session_fixture("chat_side");
    side.side_parent_session_id = Some("chat_parent".into());
    store.create_chat_session(&side).unwrap();

    let all: Vec<String> = store
        .list_all_chat_sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(all, ["chat_parent"]);
    assert_eq!(store.side_chats_of("chat_parent").unwrap(), ["chat_side"]);
    assert_eq!(
        store.chat_worktree_owner("chat_side").unwrap(),
        "chat_parent"
    );
    assert_eq!(store.chat_worktree_owner("chat_gone").unwrap(), "chat_gone");
    assert!(store.delete_chat_session("chat_parent").is_err());
    assert!(store.get_chat_session("chat_parent").unwrap().is_some());
    store.delete_chat_session("chat_side").unwrap();
    store.delete_chat_session("chat_parent").unwrap();

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_resume_picker_sees_every_project_newest_first() {
    let dir = std::env::temp_dir().join(format!("orx-store-allchats-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();

    for (id, project, updated_at) in [
        ("chat_old", "proj_1", 10),
        ("chat_other_project", "proj_2", 30),
        ("chat_middle", "proj_1", 20),
    ] {
        let mut session = chat_session_fixture(id);
        session.project_id = project.into();
        session.updated_at = updated_at;
        store.create_chat_session(&session).unwrap();
    }

    let all = store.list_all_chat_sessions().unwrap();
    assert_eq!(
        all.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        vec!["chat_other_project", "chat_middle", "chat_old"]
    );
    assert_eq!(
        store.list_chat_sessions_by_project("proj_1").unwrap().len(),
        2
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn sidebar_pages_across_projects_with_ties_and_archive_filter() {
    let dir = std::env::temp_dir().join(format!("orx-store-sidebar-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    for n in 0..65 {
        let mut session = chat_session_fixture(&format!("chat_{n:03}"));
        session.project_id = format!("proj_{}", n % 3);
        session.updated_at = 10;
        session.archived = n >= 60;
        store.create_chat_session(&session).unwrap();
    }
    let mut side = chat_session_fixture("side");
    side.side_parent_session_id = Some("chat_000".into());
    side.updated_at = 20;
    store.create_chat_session(&side).unwrap();
    // Helpers stay available to the DAG but cannot crowd main chats out of a page.
    for n in 0..70 {
        let mut helper = chat_session_fixture(&format!("expert_{n:03}"));
        helper.parent_session_id = Some("chat_000".into());
        helper.updated_at = 30;
        helper.archived = n % 2 == 0;
        store.create_chat_session(&helper).unwrap();
    }
    assert!(store.get_chat_session("expert_000").unwrap().is_some());
    let first = store.list_sidebar_chat_sessions(Some(false), None).unwrap();
    assert_eq!(first.len(), 51);
    assert_eq!(first[0].id, "chat_059");
    let cursor = &first[49];
    let second = store
        .list_sidebar_chat_sessions(Some(false), Some((cursor.updated_at, &cursor.id)))
        .unwrap();
    assert_eq!(second.len(), 10);
    assert_eq!(second[0].id, "chat_009");
    assert_eq!(second.last().unwrap().id, "chat_000");
    assert_eq!(
        store
            .list_sidebar_chat_sessions(Some(true), None)
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        store.list_sidebar_chat_sessions(None, None).unwrap()[0].id,
        "chat_064"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_one_claimant_advances_a_spawn() {
    let dir = std::env::temp_dir().join(format!("orx-store-spawnclaim-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_child"))
        .unwrap();
    store
        .create_chat_spawn(&chat_spawn_fixture("chat_child", "chat_parent"))
        .unwrap();

    let pending = store.list_chat_spawns(ChatSpawnState::Pending).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].parent_session_id, "chat_parent");
    assert!(pending[0].wake_parent);

    let token = store
        .claim_chat_spawn(
            "chat_child",
            ChatSpawnState::Pending,
            ChatSpawnState::Starting,
        )
        .unwrap()
        .expect("first claim wins");
    assert!(store
        .claim_chat_spawn(
            "chat_child",
            ChatSpawnState::Pending,
            ChatSpawnState::Starting
        )
        .unwrap()
        .is_none());
    // A settle under the wrong token must not move the row.
    assert!(!store
        .settle_chat_spawn("chat_child", "not-the-token", ChatSpawnState::Running)
        .unwrap());
    assert!(store
        .settle_chat_spawn("chat_child", &token, ChatSpawnState::Running)
        .unwrap());
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Running)
            .unwrap()
            .len(),
        1
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn expired_spawn_wakeups_restore_their_original_delivery_path() {
    for original in [ChatSpawnState::Pending, ChatSpawnState::Running] {
        let dir = std::env::temp_dir().join(format!("orx-spawn-origin-{}", uuid::Uuid::new_v4()));
        let first = Store::open_at(dir.clone()).unwrap();
        first
            .create_chat_session(&chat_session_fixture("child"))
            .unwrap();
        first
            .create_chat_spawn(&chat_spawn_fixture("child", "parent"))
            .unwrap();
        if original == ChatSpawnState::Running {
            let token = first
                .claim_chat_spawn("child", ChatSpawnState::Pending, ChatSpawnState::Starting)
                .unwrap()
                .unwrap();
            assert!(first.settle_chat_spawn("child", &token, original).unwrap());
        }
        first
            .conn
            .execute(
                "UPDATE chat_spawns SET attempts=3 WHERE session_id='child'",
                [],
            )
            .unwrap();
        let old = first
            .claim_chat_spawn("child", original, ChatSpawnState::Waking)
            .unwrap()
            .unwrap();
        first
            .conn
            .execute(
                "UPDATE chat_spawns SET claimed_at=0 WHERE session_id='child'",
                [],
            )
            .unwrap();
        drop(first);
        // Recovery must preserve the path even after the claiming process is gone.
        let second = Store::open_at(dir.clone()).unwrap();
        second.prune_chat_spawns().unwrap();
        assert_eq!(
            second.list_chat_spawns(original).unwrap().len(),
            1,
            "wake-up recovery lost {original:?} origin"
        );
        assert_eq!(second.get_chat_spawn("child").unwrap().unwrap().attempts, 3);
        assert!(!second
            .settle_chat_spawn("child", &old, ChatSpawnState::Done)
            .unwrap());
        let current = second
            .claim_chat_spawn("child", original, ChatSpawnState::Waking)
            .unwrap()
            .unwrap();
        assert!(second
            .settle_chat_spawn("child", &current, original)
            .unwrap());
        let origin: Option<String> = second
            .conn
            .query_row(
                "SELECT claim_from_state FROM chat_spawns WHERE session_id='child'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(origin.is_none());
        let current = second
            .claim_chat_spawn("child", original, ChatSpawnState::Waking)
            .unwrap()
            .unwrap();
        assert!(second
            .settle_chat_spawn("child", &current, ChatSpawnState::Done)
            .unwrap());
        let origin: Option<String> = second
            .conn
            .query_row(
                "SELECT claim_from_state FROM chat_spawns WHERE session_id='child'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(origin.is_none());
        assert_eq!(second.get_chat_spawn("child").unwrap().unwrap().attempts, 3);
        drop(second);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn spawn_claim_origin_migrates_old_rows_without_guessing_their_source() {
    let dir = std::env::temp_dir().join(format!(
        "orx-spawn-origin-migration-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("child"))
        .unwrap();
    store
        .create_chat_spawn(&chat_spawn_fixture("child", "parent"))
        .unwrap();
    // Recreate a pre-origin row and remove only the new migration's marker.
    store.conn.execute_batch("ALTER TABLE chat_spawns DROP COLUMN claim_from_state;
        DELETE FROM product_schema_migrations WHERE name='spawn-claim-origin-v1';
        UPDATE chat_spawns SET state='waking', claim_token='legacy-token', claimed_at=0, attempts=3;").unwrap();
    drop(store);
    for _ in 0..2 {
        let store = Store::open_at(dir.clone()).unwrap();
        let (origin, attempts, token): (Option<String>, i64, String) = store.conn.query_row(
            "SELECT claim_from_state, attempts, claim_token FROM chat_spawns WHERE session_id='child'", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert!(origin.is_none());
        assert_eq!(attempts, 3);
        assert_eq!(token, "legacy-token");
        assert_eq!(
            store
                .list_chat_spawns(ChatSpawnState::Waking)
                .unwrap()
                .len(),
            1
        );
        let applied: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM product_schema_migrations WHERE name='spawn-claim-origin-v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(applied, 1);
    }
    let store = Store::open_at(dir.clone()).unwrap();
    store.prune_chat_spawns().unwrap();
    // Historical claims have no reliable origin: preserve their existing fallback.
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Running)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(store.get_chat_spawn("child").unwrap().unwrap().attempts, 3);
    assert!(!store
        .settle_chat_spawn("child", "legacy-token", ChatSpawnState::Done)
        .unwrap());
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn claim_pruning_keeps_live_spawn_targets_and_recovers_abandoned_work() {
    for phase in [ChatSpawnState::Starting, ChatSpawnState::Waking] {
        for lease in ["target", "other", "expired", "absent"] {
            let dir =
                std::env::temp_dir().join(format!("orx-spawn-prune-live-{}", uuid::Uuid::new_v4()));
            let first = Store::open_at(dir.clone()).unwrap();
            for id in ["child", "parent"] {
                first
                    .create_chat_session(&chat_session_fixture(id))
                    .unwrap();
            }
            first
                .create_chat_spawn(&chat_spawn_fixture("child", "parent"))
                .unwrap();
            let start = first
                .claim_chat_spawn("child", ChatSpawnState::Pending, ChatSpawnState::Starting)
                .unwrap()
                .unwrap();
            let token = if phase == ChatSpawnState::Waking {
                assert!(first
                    .settle_chat_spawn("child", &start, ChatSpawnState::Running)
                    .unwrap());
                first
                    .claim_chat_spawn("child", ChatSpawnState::Running, phase)
                    .unwrap()
                    .unwrap()
            } else {
                start
            };
            first
                .conn
                .execute(
                    "UPDATE chat_spawns SET claimed_at=0 WHERE session_id='child'",
                    [],
                )
                .unwrap();
            let second = Store::open_at(dir.clone()).unwrap();
            let (target, unrelated) = if phase == ChatSpawnState::Starting {
                ("child", "parent")
            } else {
                ("parent", "child")
            };
            let lease_session = if lease == "other" { unrelated } else { target };
            if lease != "absent" {
                assert!(second
                    .claim_chat_turn(lease_session, "turn-owner", &[])
                    .unwrap());
                if lease == "expired" {
                    second
                        .conn
                        .execute(
                            "UPDATE chat_turn_leases SET heartbeat_at=0 WHERE chat_session_id=?1",
                            [lease_session],
                        )
                        .unwrap();
                }
            }
            second.prune_chat_spawns().unwrap();
            if lease == "target" {
                let (state, claim, attempts): (String, Option<String>, i64) = second.conn.query_row(
                    "SELECT state,claim_token,attempts FROM chat_spawns WHERE session_id='child'", [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
                assert_eq!(state, phase.as_str(), "live target reclaimed in {phase:?}");
                assert_eq!(claim.as_deref(), Some(token.as_str()));
                assert_eq!(attempts, 0);
                first.release_chat_turn(target, "turn-owner").unwrap();
                second.prune_chat_spawns().unwrap();
            }
            let recovered = if phase == ChatSpawnState::Starting {
                ChatSpawnState::Pending
            } else {
                ChatSpawnState::Running
            };
            assert_eq!(
                first.list_chat_spawns(recovered).unwrap().len(),
                1,
                "{phase:?}/{lease}"
            );
            assert_eq!(
                first.get_chat_spawn("child").unwrap().unwrap().attempts,
                i64::from(phase == ChatSpawnState::Starting)
            );
            assert!(!first
                .settle_chat_spawn("child", &token, ChatSpawnState::Done)
                .unwrap());
            let current = second
                .claim_chat_spawn("child", recovered, phase)
                .unwrap()
                .unwrap();
            assert!(second
                .settle_chat_spawn("child", &current, ChatSpawnState::Running)
                .unwrap());
            drop(second);
            drop(first);
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}

#[test]
fn claim_pruning_keeps_live_run_wakeup_targets_and_recovers_abandoned_work() {
    for lease in ["target", "other", "expired", "absent"] {
        let dir = std::env::temp_dir().join(format!("orx-run-prune-live-{}", uuid::Uuid::new_v4()));
        let first = Store::open_at(dir.clone()).unwrap();
        for id in ["owner", "other"] {
            first
                .create_chat_session(&chat_session_fixture(id))
                .unwrap();
        }
        first
            .upsert_run(&run_fixture("run_done", "done", Some("owner")))
            .unwrap();
        first.register_run_wakeup("run_done", "owner").unwrap();
        let token = first
            .claim_run_wakeup("run_done", "owner")
            .unwrap()
            .unwrap();
        first
            .conn
            .execute(
                "UPDATE chat_run_wakeups SET claimed_at=0 WHERE run_id='run_done'",
                [],
            )
            .unwrap();
        let second = Store::open_at(dir.clone()).unwrap();
        let lease_session = if lease == "other" { "other" } else { "owner" };
        if lease != "absent" {
            assert!(second
                .claim_chat_turn(lease_session, "turn-owner", &[])
                .unwrap());
            if lease == "expired" {
                second
                    .conn
                    .execute(
                        "UPDATE chat_turn_leases SET heartbeat_at=0 WHERE chat_session_id=?1",
                        [lease_session],
                    )
                    .unwrap();
            }
        }
        second.prune_run_wakeups().unwrap();
        if lease == "target" {
            assert_eq!(
                second.list_ready_run_wakeups().unwrap()[0].state,
                "claimed",
                "live run wake-up was reclaimed"
            );
            assert!(first
                .renew_run_wakeup_claim("run_done", "owner", &token)
                .unwrap());
            // Keep the age expired after proving token ownership, then release the turn.
            first
                .conn
                .execute(
                    "UPDATE chat_run_wakeups SET claimed_at=0 WHERE run_id='run_done'",
                    [],
                )
                .unwrap();
            first.release_chat_turn("owner", "turn-owner").unwrap();
            second.prune_run_wakeups().unwrap();
        }
        assert_eq!(
            first.list_ready_run_wakeups().unwrap()[0].state,
            "pending",
            "{lease}"
        );
        assert!(!first
            .mark_run_wakeup_delivered("run_done", "owner", &token)
            .unwrap());
        let current = second
            .claim_run_wakeup("run_done", "owner")
            .unwrap()
            .unwrap();
        assert!(second
            .mark_run_wakeup_delivered("run_done", "owner", &current)
            .unwrap());
        drop(second);
        drop(first);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn pruning_reclaims_stale_spawns_and_drops_deleted_sessions() {
    let dir = std::env::temp_dir().join(format!("orx-store-spawnprune-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    for id in ["chat_stuck", "chat_gone"] {
        store
            .create_chat_session(&chat_session_fixture(id))
            .unwrap();
        store
            .create_chat_spawn(&chat_spawn_fixture(id, "chat_parent"))
            .unwrap();
    }

    // A watcher that claimed the start and then died.
    store
        .claim_chat_spawn(
            "chat_stuck",
            ChatSpawnState::Pending,
            ChatSpawnState::Starting,
        )
        .unwrap()
        .unwrap();
    store
        .conn
        .execute(
            "UPDATE chat_spawns SET claimed_at = ?1 WHERE session_id = 'chat_stuck'",
            params![now_ms() - CHAT_SPAWN_CLAIM_TTL_MS - 1],
        )
        .unwrap();
    // A session removed WITHOUT its spawn row (the `delete_local_project`
    // path) is what prune's orphan sweep is actually for.
    store
        .conn
        .execute("DELETE FROM chat_sessions WHERE id = 'chat_gone'", [])
        .unwrap();

    store.prune_chat_spawns().unwrap();
    let pending = store.list_chat_spawns(ChatSpawnState::Pending).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].session_id, "chat_stuck");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn title_source_roundtrips_and_defaults_to_none() {
    let dir = std::env::temp_dir().join(format!("orx-store-titlesrc-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();

    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let fresh = store.get_chat_session("chat_1").unwrap().unwrap();
    assert!(fresh.title.is_none());
    assert!(fresh.title_source.is_none());

    store
        .set_chat_session_title("chat_1", "First line…", "fallback")
        .unwrap();
    let after = store.get_chat_session("chat_1").unwrap().unwrap();
    assert_eq!(after.title.as_deref(), Some("First line…"));
    assert_eq!(after.title_source.as_deref(), Some("fallback"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn title_if_placeholder_respects_provenance() {
    let dir = std::env::temp_dir().join(format!("orx-store-titleph-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    for id in ["untitled", "fallback", "renamed", "legacy"] {
        store
            .create_chat_session(&chat_session_fixture(id))
            .unwrap();
    }

    // No title at all (a harness-native title arriving before any user
    // message) → filled.
    assert!(store
        .set_chat_session_title_if_placeholder("untitled", "Generated one")
        .unwrap());
    assert_eq!(
        store
            .get_chat_session("untitled")
            .unwrap()
            .unwrap()
            .title_source
            .as_deref(),
        Some("generated")
    );
    // Already generated → never re-titled.
    assert!(!store
        .set_chat_session_title_if_placeholder("untitled", "Generated two")
        .unwrap());
    assert_eq!(
        store
            .get_chat_session("untitled")
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Generated one")
    );
    // ...but an explicit Rename still overrides it.
    store
        .set_chat_session_title("untitled", "My name", "user")
        .unwrap();
    let renamed = store.get_chat_session("untitled").unwrap().unwrap();
    assert_eq!(renamed.title.as_deref(), Some("My name"));
    assert_eq!(renamed.title_source.as_deref(), Some("user"));

    // The first-line placeholder → replaced.
    store
        .set_chat_session_title("fallback", "Hey can you look at…", "fallback")
        .unwrap();
    assert!(store
        .set_chat_session_title_if_placeholder("fallback", "Review the parser")
        .unwrap());
    assert_eq!(
        store
            .get_chat_session("fallback")
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Review the parser")
    );

    // A user Rename → never clobbered, whichever order the race resolves in.
    store
        .set_chat_session_title("renamed", "Mine", "user")
        .unwrap();
    assert!(!store
        .set_chat_session_title_if_placeholder("renamed", "Generated")
        .unwrap());
    assert_eq!(
        store
            .get_chat_session("renamed")
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Mine")
    );

    // Legacy row: a title with no recorded source is "unknown, don't touch".
    store
        .conn
        .execute(
            "UPDATE chat_sessions SET title = 'Old title' WHERE id = 'legacy'",
            [],
        )
        .unwrap();
    assert!(!store
        .set_chat_session_title_if_placeholder("legacy", "Generated")
        .unwrap());
    assert_eq!(
        store
            .get_chat_session("legacy")
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Old title")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

fn run_fixture(id: &str, status: &str, chat_session_id: Option<&str>) -> StoredRun {
    StoredRun {
        id: id.into(),
        experiment_id: "exp_1".into(),
        project_id: "proj_1".into(),
        status: status.into(),
        backend_json: "{}".into(),
        command: "echo hi".into(),
        created_at: 1,
        updated_at: 1,
        ended_at: None,
        exit_code: None,
        commit_sha: None,
        result_markdown: None,
        cancel_requested: false,
        cancel_reason: None,
        chat_session_id: chat_session_id.map(str::to_string),
    }
}

/// Every (from, to) pair, checked against the lifecycle diagram on
/// [`RunStatus`] rather than the implementation, so this fails if
/// `can_transition_to` and the documented state machine ever drift apart.
#[test]
fn run_status_transition_table_matches_the_documented_lifecycle() {
    use RunStatus::*;
    let legal: &[(RunStatus, RunStatus)] = &[
        (Starting, Starting),
        (Starting, Running),
        (Starting, Done),
        (Starting, Failed),
        (Starting, Cancelled),
        (Running, Running),
        (Running, Done),
        (Running, Failed),
        (Running, Cancelled),
    ];
    for from in RunStatus::ALL {
        for to in RunStatus::ALL {
            let expected = legal.contains(&(from, to));
            assert_eq!(
                from.can_transition_to(to),
                expected,
                "{from} -> {to} should be {}",
                if expected { "legal" } else { "illegal" }
            );
        }
    }
}

#[test]
fn status_writers_enforce_every_transition_and_preserve_terminal_outcomes() {
    let dir = std::env::temp_dir().join(format!("orx-store-transitions-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    for from in RunStatus::ALL {
        for to in RunStatus::ALL {
            for upsert in [false, true] {
                let id = format!("{from}-{to}-{upsert}");
                let mut original = run_fixture(&id, from.as_str(), Some("owner"));
                original.result_markdown = Some("original result".into());
                original.ended_at = from.is_terminal().then_some(10);
                original.exit_code = from.is_terminal().then_some(0);
                original.cancel_requested = true;
                store.upsert_run(&original).unwrap();
                let before = store.get_run(&id).unwrap().unwrap();
                let expected = from == RunStatus::Starting
                    || (from == RunStatus::Running && to != RunStatus::Starting);
                if upsert {
                    let mut incoming = run_fixture(&id, to.as_str(), None);
                    incoming.backend_json = "{\"job_id\":\"late-handle\"}".into();
                    incoming.ended_at = Some(20);
                    incoming.exit_code = Some(1);
                    incoming.result_markdown = Some("new result".into());
                    store.upsert_run(&incoming).unwrap();
                } else {
                    assert_eq!(
                        store.update_status(&id, to, Some(20), Some(1)).unwrap(),
                        expected,
                    );
                }
                let after = store.get_run(&id).unwrap().unwrap();
                assert_eq!(
                    after.status,
                    if expected { to } else { from }.as_str(),
                    "{id}"
                );
                assert_eq!(after.chat_session_id, before.chat_session_id);
                assert!(after.cancel_requested);
                if expected {
                    assert_eq!(after.ended_at, Some(20));
                    assert_eq!(after.exit_code, Some(1));
                } else {
                    assert_eq!(after.ended_at, before.ended_at);
                    assert_eq!(after.exit_code, before.exit_code);
                    assert_eq!(after.updated_at, before.updated_at);
                    assert_eq!(after.result_markdown, before.result_markdown);
                }
                if upsert {
                    assert!(after.backend_json.contains("late-handle"));
                    if expected {
                        assert_eq!(after.result_markdown.as_deref(), Some("new result"));
                    }
                }
            }
        }
    }
    assert!(store
        .upsert_run(&run_fixture("invalid", "unknown", None))
        .is_err());
    assert!(store.get_run("invalid").unwrap().is_none());
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn run_status_is_terminal_matches_the_three_absorbing_states() {
    for status in RunStatus::ALL {
        assert_eq!(
            status.is_terminal(),
            matches!(
                status,
                RunStatus::Done | RunStatus::Failed | RunStatus::Cancelled
            )
        );
    }
}

#[test]
fn run_status_as_str_round_trips_through_parse() {
    for status in RunStatus::ALL {
        assert_eq!(RunStatus::parse(status.as_str()), Some(status));
    }
    assert_eq!(RunStatus::parse("not-a-real-status"), None);
    assert!(!is_terminal_status("not-a-real-status"));
}

/// Test scenario from the state-machine design doc: "duplicate completion
/// callbacks". The second write must be silently rejected rather than
/// erroring or re-stamping `ended_at`/`exit_code`.
#[test]
fn duplicate_terminal_writes_are_idempotent_no_ops() {
    let dir = std::env::temp_dir().join(format!("orx-store-dup-term-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .upsert_run(&run_fixture("run_1", "running", None))
        .unwrap();

    assert!(store
        .update_status("run_1", RunStatus::Done, Some(100), Some(0))
        .unwrap());
    let first = store.get_run("run_1").unwrap().unwrap();
    assert_eq!(first.status, "done");
    assert_eq!(first.ended_at, Some(100));
    assert_eq!(first.exit_code, Some(0));

    // A second, later completion callback for the same run (e.g. a
    // retried webhook, or a stale poll landing after a fresher one) must
    // not be applied, and must not disturb the first write's timestamp
    // or exit code.
    assert!(!store
        .update_status("run_1", RunStatus::Done, Some(200), Some(1))
        .unwrap());
    let second = store.get_run("run_1").unwrap().unwrap();
    assert_eq!(second.status, "done");
    assert_eq!(
        second.ended_at,
        Some(100),
        "ended_at must not be re-stamped"
    );
    assert_eq!(
        second.exit_code,
        Some(0),
        "exit_code must not be overwritten"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Test scenario: "completion arriving after cancellation" — once a run
/// has been recorded as cancelled, a late success/failure report from the
/// backend must not resurrect it.
#[test]
fn completion_after_cancellation_is_rejected() {
    let dir = std::env::temp_dir().join(format!("orx-store-cancel-race-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .upsert_run(&run_fixture("run_1", "running", None))
        .unwrap();

    assert!(store
        .update_status("run_1", RunStatus::Cancelled, Some(100), None)
        .unwrap());
    assert!(!store
        .update_status("run_1", RunStatus::Done, Some(200), Some(0))
        .unwrap());

    let run = store.get_run("run_1").unwrap().unwrap();
    assert_eq!(run.status, "cancelled");
    assert_eq!(run.ended_at, Some(100));
    assert_eq!(run.exit_code, None);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Test scenario: "invalid backward transitions" — a backend cannot
/// regress an already-`running` job back to `starting`.
#[test]
fn running_cannot_regress_to_starting() {
    let dir = std::env::temp_dir().join(format!("orx-store-backward-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .upsert_run(&run_fixture("run_1", "running", None))
        .unwrap();

    assert!(!store
        .update_status("run_1", RunStatus::Starting, None, None)
        .unwrap());
    assert_eq!(store.get_run("run_1").unwrap().unwrap().status, "running");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Test scenarios: "cancel while preparing" and "cancel while running" —
/// both non-terminal states can move directly to `cancelled`.
#[test]
fn cancel_is_legal_from_either_non_terminal_state() {
    let dir = std::env::temp_dir().join(format!("orx-store-cancel-both-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .upsert_run(&run_fixture("run_starting", "starting", None))
        .unwrap();
    store
        .upsert_run(&run_fixture("run_running", "running", None))
        .unwrap();

    assert!(store
        .update_status("run_starting", RunStatus::Cancelled, Some(1), None)
        .unwrap());
    assert!(store
        .update_status("run_running", RunStatus::Cancelled, Some(1), None)
        .unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

/// Test scenario: "retry after a partially completed run" — a run that
/// failed can be re-launched under a fresh run id (retries are new rows,
/// never a resurrection of the old one), and the old terminal row is left
/// untouched by anything trying to touch it afterward.
#[test]
fn retry_after_failure_is_a_new_row_not_a_resurrection() {
    let dir = std::env::temp_dir().join(format!("orx-store-retry-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .upsert_run(&run_fixture("run_1", "running", None))
        .unwrap();
    assert!(store
        .update_status("run_1", RunStatus::Failed, Some(1), Some(1))
        .unwrap());

    // The retry is a distinct run id; the failed row is untouched.
    store
        .upsert_run(&run_fixture("run_1_retry", "starting", None))
        .unwrap();
    assert!(store
        .update_status("run_1_retry", RunStatus::Running, None, None)
        .unwrap());

    assert_eq!(store.get_run("run_1").unwrap().unwrap().status, "failed");
    assert_eq!(
        store.get_run("run_1_retry").unwrap().unwrap().status,
        "running"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Test scenario: "concurrent status updates" / "agent wake while a run
/// is finishing" — many independent connections (as separate supervisor
/// processes would be) race to finalize the same run with different
/// terminal outcomes. Exactly one write must win, and the row must land
/// on a real terminal state rather than a torn/partial one.
#[test]
fn concurrent_terminal_writes_from_separate_connections_settle_on_exactly_one_outcome() {
    let dir = std::env::temp_dir().join(format!("orx-store-concurrent-{}", uuid::Uuid::new_v4()));
    // Open once first so schema creation isn't itself racing below.
    let setup = Store::open_at(dir.clone()).unwrap();
    setup
        .upsert_run(&run_fixture("run_1", "running", None))
        .unwrap();
    drop(setup);

    let outcomes = [RunStatus::Done, RunStatus::Failed, RunStatus::Cancelled];
    let handles: Vec<_> = outcomes
        .into_iter()
        .map(|outcome| {
            let dir = dir.clone();
            std::thread::spawn(move || {
                // Each thread is its own connection, like independent
                // supervisor processes sharing one SQLite file (WAL +
                // busy_timeout, set in `open_at_with_move_lock`).
                let store = Store::open_at(dir).unwrap();
                store
                    .update_status("run_1", outcome, Some(1), None)
                    .unwrap()
            })
        })
        .collect();
    let applied: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();

    assert_eq!(
        applied.iter().filter(|ok| **ok).count(),
        1,
        "exactly one racing writer should win: {applied:?}"
    );
    let final_status = Store::open_at(dir.clone())
        .unwrap()
        .get_run("run_1")
        .unwrap()
        .unwrap()
        .status;
    assert!(
        RunStatus::parse(&final_status).is_some_and(RunStatus::is_terminal),
        "run must settle on a real terminal state, got {final_status:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn run_chat_session_id_roundtrips() {
    let dir = std::env::temp_dir().join(format!("orx-store-runsess-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();

    store
        .upsert_run(&run_fixture("run_owned", "starting", Some("chat_A")))
        .unwrap();
    store
        .upsert_run(&run_fixture("run_orphan", "starting", None))
        .unwrap();

    assert_eq!(
        store.get_run("run_owned").unwrap().unwrap().chat_session_id,
        Some("chat_A".to_string())
    );
    assert_eq!(
        store
            .get_run("run_orphan")
            .unwrap()
            .unwrap()
            .chat_session_id,
        None
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn run_wakeups_are_idempotent_ready_only_at_success_or_failure_and_pruned() {
    let dir = std::env::temp_dir().join(format!("orx-store-wake-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_A"))
        .unwrap();
    for (id, status) in [
        ("run_active", "running"),
        ("run_done", "done"),
        ("run_failed", "failed"),
        ("run_cancelled", "cancelled"),
    ] {
        store
            .upsert_run(&run_fixture(id, status, Some("chat_A")))
            .unwrap();
        assert_eq!(
            store.register_run_wakeup(id, "chat_A").unwrap(),
            RunWakeupRegistration::Scheduled
        );
        assert_eq!(
            store.register_run_wakeup(id, "chat_A").unwrap(),
            RunWakeupRegistration::AlreadyPending
        );
    }
    store.register_run_wakeup("missing_run", "chat_A").unwrap();
    store
        .register_run_wakeup("run_done", "missing_chat")
        .unwrap();

    store.prune_run_wakeups().unwrap();
    let ready = store.list_ready_run_wakeups().unwrap();
    assert_eq!(
        ready
            .iter()
            .map(|wakeup| wakeup.run.id.as_str())
            .collect::<Vec<_>>(),
        ["run_done", "run_failed"]
    );

    assert!(store
        .update_status("run_active", RunStatus::Done, Some(2), Some(0))
        .unwrap());
    assert_eq!(store.list_ready_run_wakeups().unwrap().len(), 3);
    let token = store
        .claim_run_wakeup("run_done", "chat_A")
        .unwrap()
        .unwrap();
    assert!(store
        .claim_run_wakeup("run_done", "chat_A")
        .unwrap()
        .is_none());
    assert!(store
        .list_ready_run_wakeups()
        .unwrap()
        .iter()
        .any(|wakeup| wakeup.run.id == "run_done" && wakeup.state == "claimed"));
    store
        .release_run_wakeup("run_done", "chat_A", &token)
        .unwrap();
    assert!(store
        .list_ready_run_wakeups()
        .unwrap()
        .iter()
        .any(|wakeup| wakeup.run.id == "run_done"));
    let token = store
        .claim_run_wakeup("run_done", "chat_A")
        .unwrap()
        .unwrap();
    assert!(store
        .mark_run_wakeup_delivered("run_done", "chat_A", &token)
        .unwrap());
    assert_eq!(
        store.register_run_wakeup("run_done", "chat_A").unwrap(),
        RunWakeupRegistration::AlreadyDelivered
    );
    assert!(store
        .list_ready_run_wakeups()
        .unwrap()
        .iter()
        .all(|wakeup| wakeup.run.id != "run_done"));

    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn monitoring_alert_claims_once_and_keeps_the_terminal_wakeup() {
    let dir = std::env::temp_dir().join(format!("orx-store-alert-{}", uuid::Uuid::new_v4()));
    let first = Store::open_at(dir.clone()).unwrap();
    first
        .create_chat_session(&chat_session_fixture("chat_A"))
        .unwrap();
    for (id, status) in [("run_live", "starting"), ("run_done", "done")] {
        first
            .upsert_run(&run_fixture(id, status, Some("chat_A")))
            .unwrap();
        first.register_run_wakeup(id, "chat_A").unwrap();
    }
    let second = Store::open_at(dir.clone()).unwrap();

    let active = first.list_active_run_wakeups().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].run.id, "run_live");
    assert!(!active[0].monitoring_alerted);
    assert!(first
        .set_run_wakeup_monitoring_alerted("run_live", "chat_A", true)
        .unwrap());
    assert!(!second
        .set_run_wakeup_monitoring_alerted("run_live", "chat_A", true)
        .unwrap());
    assert!(second.list_active_run_wakeups().unwrap()[0].monitoring_alerted);

    assert!(second
        .set_run_wakeup_monitoring_alerted("run_live", "chat_A", false)
        .unwrap());
    assert!(!first
        .set_run_wakeup_monitoring_alerted("run_live", "chat_A", false)
        .unwrap());

    first
        .set_run_wakeup_monitoring_alerted("run_live", "chat_A", true)
        .unwrap();
    assert!(first
        .update_status("run_live", RunStatus::Done, Some(2), Some(0))
        .unwrap());
    assert!(first.list_active_run_wakeups().unwrap().is_empty());
    assert!(first
        .list_ready_run_wakeups()
        .unwrap()
        .iter()
        .any(|wakeup| wakeup.run.id == "run_live" && wakeup.state == "pending"));
    first
        .claim_run_wakeup("run_live", "chat_A")
        .unwrap()
        .unwrap();
    assert!(!first
        .set_run_wakeup_monitoring_alerted("run_live", "chat_A", false)
        .unwrap());

    drop(second);
    drop(first);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn run_wakeup_claim_is_atomic_across_store_connections_and_recoverable() {
    let dir = std::env::temp_dir().join(format!("orx-store-claim-{}", uuid::Uuid::new_v4()));
    let first = Store::open_at(dir.clone()).unwrap();
    first
        .create_chat_session(&chat_session_fixture("chat_A"))
        .unwrap();
    first
        .upsert_run(&run_fixture("run_done", "done", Some("chat_A")))
        .unwrap();
    first.register_run_wakeup("run_done", "chat_A").unwrap();
    let second = Store::open_at(dir.clone()).unwrap();

    let stale_token = first
        .claim_run_wakeup("run_done", "chat_A")
        .unwrap()
        .unwrap();
    assert!(second
        .claim_run_wakeup("run_done", "chat_A")
        .unwrap()
        .is_none());
    first
        .conn
        .execute(
            "UPDATE chat_run_wakeups SET claimed_at = 0 WHERE run_id = 'run_done'",
            [],
        )
        .unwrap();
    second.prune_run_wakeups().unwrap();
    let current_token = second
        .claim_run_wakeup("run_done", "chat_A")
        .unwrap()
        .unwrap();
    first
        .release_run_wakeup("run_done", "chat_A", &stale_token)
        .unwrap();
    assert!(!first
        .mark_run_wakeup_delivered("run_done", "chat_A", &stale_token)
        .unwrap());
    assert!(second
        .renew_run_wakeup_claim("run_done", "chat_A", &current_token)
        .unwrap());
    second
        .release_run_wakeup("run_done", "chat_A", &current_token)
        .unwrap();
    assert!(first
        .claim_run_wakeup("run_done", "chat_A")
        .unwrap()
        .is_some());

    drop(second);
    drop(first);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn ready_run_wakeups_are_ordered_by_terminal_time() {
    let dir = std::env::temp_dir().join(format!("orx-store-order-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_A"))
        .unwrap();
    for (id, ended_at) in [("run_late", 20), ("run_early", 10)] {
        let mut run = run_fixture(id, "done", Some("chat_A"));
        run.ended_at = Some(ended_at);
        store.upsert_run(&run).unwrap();
        store.register_run_wakeup(id, "chat_A").unwrap();
    }

    assert_eq!(
        store
            .list_ready_run_wakeups()
            .unwrap()
            .iter()
            .map(|wakeup| wakeup.run.id.as_str())
            .collect::<Vec<_>>(),
        ["run_early", "run_late"]
    );

    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn chat_turn_lease_is_cross_process_and_token_scoped() {
    let dir = std::env::temp_dir().join(format!("orx-store-turn-{}", uuid::Uuid::new_v4()));
    let first = Store::open_at(dir.clone()).unwrap();
    first
        .create_chat_session(&chat_session_fixture("chat_A"))
        .unwrap();
    let second = Store::open_at(dir.clone()).unwrap();

    assert!(first.claim_chat_turn("chat_A", "token_A", &[]).unwrap());
    assert!(!second.claim_chat_turn("chat_A", "token_B", &[]).unwrap());
    assert!(!second.renew_chat_turn("chat_A", "token_B").unwrap());
    assert!(!second.claim_data_dir_move("move_A", &[]).unwrap());
    second.release_chat_turn("chat_A", "token_B").unwrap();
    assert!(!second.claim_chat_turn("chat_A", "token_B", &[]).unwrap());
    first.release_chat_turn("chat_A", "token_A").unwrap();
    let move_lock = first.acquire_data_dir_move_lock().unwrap();
    assert!(first.claim_data_dir_move("move_A", &[]).unwrap());
    assert!(!second.claim_chat_turn("chat_A", "token_B", &[]).unwrap());
    second.release_data_dir_move("move_B").unwrap();
    assert!(!second.claim_chat_turn("chat_A", "token_B", &[]).unwrap());
    drop(move_lock);
    assert!(second.claim_chat_turn("chat_A", "token_B", &[]).unwrap());

    drop(second);
    drop(first);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn active_run_listing_excludes_terminal_history() {
    let dir = std::env::temp_dir().join(format!("orx-store-active-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .upsert_run(&run_fixture("run_starting", "starting", None))
        .unwrap();
    store
        .upsert_run(&run_fixture("run_running", "running", None))
        .unwrap();
    store
        .upsert_run(&run_fixture("run_done", "done", None))
        .unwrap();

    let mut ids: Vec<_> = store
        .list_active_runs()
        .unwrap()
        .into_iter()
        .map(|run| run.id)
        .collect();
    ids.sort();
    assert_eq!(ids, ["run_running", "run_starting"]);

    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn run_ownership_is_immutable_across_upserts() {
    let dir = std::env::temp_dir().join(format!("orx-store-runimmut-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();

    // Created by chat_A.
    store
        .upsert_run(&run_fixture("run_1", "starting", Some("chat_A")))
        .unwrap();
    // A later status upsert that carries a *different* (or absent) session
    // must NOT rewrite the owner — ownership is immutable.
    store
        .upsert_run(&run_fixture("run_1", "failed", Some("chat_B")))
        .unwrap();
    store
        .upsert_run(&run_fixture("run_1", "done", None))
        .unwrap();

    let run = store.get_run("run_1").unwrap().unwrap();
    assert_eq!(
        run.status, "failed",
        "terminal outcome survives later upserts"
    );
    assert_eq!(
        run.chat_session_id,
        Some("chat_A".to_string()),
        "the launching session is never overwritten by a later upsert"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

fn experiment_fixture(id: &str, chat_session_id: Option<&str>) -> LocalExperiment {
    LocalExperiment {
        id: id.into(),
        project_id: "proj_1".into(),
        parent_experiment_id: None,
        slug: format!("exp-{id}"),
        branch_name: format!("orx/exp-{id}"),
        title: None,
        description: None,
        run_command: "echo hi".into(),
        agent_status: "idle".into(),
        created_at: 1,
        updated_at: 1,
        chat_session_id: chat_session_id.map(str::to_string),
        archived: false,
    }
}

#[test]
fn project_activity_summaries_aggregate_lifetime_work() {
    let dir = std::env::temp_dir().join(format!(
        "orx-store-project-activity-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_local_project(&LocalProject {
            id: "proj_1".into(),
            name: "Project".into(),
            slug: "project".into(),
            github_owner: String::new(),
            github_repo: String::new(),
            github_sync_enabled: false,
            baseline_branch: "main".into(),
            repo_path: dir.join("project").to_string_lossy().into_owned(),
            run_command: None,
            paper_id: None,
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();

    let mut archived = chat_session_fixture("archived");
    archived.archived = true;
    store.create_chat_session(&archived).unwrap();
    store
        .create_chat_session(&chat_session_fixture("current"))
        .unwrap();
    for (id, role, created_at) in [
        ("user", "user", 10),
        ("assistant", "assistant", 20),
        ("system", "system", 30),
    ] {
        store
            .upsert_chat_message(&StoredChatMessage {
                id: id.into(),
                session_id: "current".into(),
                role: role.into(),
                parts_json: "[]".into(),
                created_at,
                completed_at: None,
                parent_id: None,
                base_native_session_id: None,
                result_native_session_id: None,
            })
            .unwrap();
    }

    store
        .create_local_experiment(&experiment_fixture("exp_1", None))
        .unwrap();
    store
        .create_local_experiment(&experiment_fixture("exp_2", None))
        .unwrap();
    for (id, experiment_id, status) in [
        ("run_1", "exp_1", "starting"),
        ("run_2", "exp_2", "running"),
        ("run_done", "exp_1", "done"),
        ("run_orphan", "missing", "running"),
    ] {
        let mut run = run_fixture(id, status, None);
        run.experiment_id = experiment_id.into();
        store.upsert_run(&run).unwrap();
    }

    let summaries = store.list_project_activity_summaries().unwrap();
    assert_eq!(summaries.len(), 1);
    let summary = &summaries[0];
    assert_eq!(summary.project_id, "proj_1");
    assert_eq!(summary.total_agents, 2);
    assert_eq!(summary.running_experiments, 2);
    assert_eq!(summary.total_experiments, 2);
    assert_eq!(summary.last_message_at, Some(20));
    assert_eq!(summary.last_activity_at, 30);
    assert_eq!(store.list_chat_session_project_ids().unwrap().len(), 2);

    for (table, timestamp) in [
        ("local_projects", 40),
        ("chat_sessions", 50),
        ("local_experiments", 60),
        ("runs", 70),
    ] {
        store
            .conn
            .execute(&format!("UPDATE {table} SET updated_at = ?1"), [timestamp])
            .unwrap();
        assert_eq!(
            store.list_project_activity_summaries().unwrap()[0].last_activity_at,
            timestamp
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn experiment_chat_session_id_roundtrips() {
    let dir = std::env::temp_dir().join(format!("orx-store-expsess-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();

    store
        .create_local_experiment(&experiment_fixture("exp_owned", Some("chat_x")))
        .unwrap();
    store
        .create_local_experiment(&experiment_fixture("exp_orphan", None))
        .unwrap();

    assert_eq!(
        store
            .get_local_experiment("exp_owned")
            .unwrap()
            .unwrap()
            .chat_session_id,
        Some("chat_x".to_string())
    );
    assert_eq!(
        store
            .get_local_experiment("exp_orphan")
            .unwrap()
            .unwrap()
            .chat_session_id,
        None
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn experiment_ownership_is_immutable_across_updates() {
    let dir = std::env::temp_dir().join(format!("orx-store-expimm-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();

    store
        .create_local_experiment(&experiment_fixture("exp_owned", Some("chat_x")))
        .unwrap();

    // A later full-row update must not rewrite the owning session.
    let mut updated = experiment_fixture("exp_owned", None);
    updated.title = Some("renamed".into());
    updated.parent_experiment_id = Some("stale-parent".into());
    store.update_local_experiment(&updated).unwrap();

    let stored = store.get_local_experiment("exp_owned").unwrap().unwrap();
    assert_eq!(stored.title.as_deref(), Some("renamed"), "title updates");
    assert_eq!(
        stored.chat_session_id,
        Some("chat_x".to_string()),
        "the creating session is never overwritten by a later update"
    );
    assert_eq!(stored.parent_experiment_id, None, "only a move re-parents");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_read_only_store_counts_runs_while_a_writer_holds_the_lock() {
    let dir = crate::local::git::TemporaryDirectory::new("orx-read-only-store").unwrap();
    let writer = Store::open_at(dir.path().to_path_buf()).unwrap();
    writer.conn.execute_batch("BEGIN IMMEDIATE").unwrap();

    let started = std::time::Instant::now();
    let reader = Store::open_read_only(dir.path().to_path_buf()).unwrap();
    assert_eq!(reader.count_active_runs().unwrap(), 0);
    assert!(started.elapsed() < BUSY_TIMEOUT);
}
