// Included in run_wakeup_tests to reuse its isolated Store and host fixtures.
fn notification_test_receipt(store: &Store, session: &str, key: &str, state: &str) {
    let id = uuid::Uuid::new_v4().to_string();
    let turn = crate::store::StoredChatTurn {
        id: id.clone(),
        session_id: session.into(),
        user_message_id: None,
        assistant_message_id: format!("assistant-{id}"),
        client_turn_id: key.into(),
        request_hash: "original-admission-hash".into(),
        prepared_input: "original notification".into(),
        settings_json: "{}".into(),
        state: state.into(),
        delivery_state: "not_sent".into(),
        attempt_count: 0,
        next_retry_at: None,
        error_kind: None,
        error_message: None,
        recovery_action: None,
        recovered_by_turn_id: None,
        created_at: 1,
        updated_at: 1,
    };
    assert!(matches!(
        store.admit_chat_turn(None, &turn).unwrap(),
        crate::store::ChatTurnAdmission::Inserted
    ));
}

fn notification_test_sql(store: &Store, sql: &str) {
    let tx = store.begin().unwrap();
    tx.execute_batch(sql).unwrap();
    tx.commit().unwrap();
}

async fn notification_test_idle(host: &Arc<ChatHost>, session: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while host.is_busy(session).await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn notification_recovery_stops_at_one_durable_turn_and_preserves_retries() {
    const CHILD: &str = "ORX_TEST_NOTIFICATION_RECOVERY";
    const TEST: &str = "local::chat::run_wakeup_tests::notification_recovery_stops_at_one_durable_turn_and_preserves_retries";
    async fn check() {
        let store = Store::open().unwrap();
        let host = bare_host();
        // No project exists: accidental fresh sends fail before any model launch.
        for state in ["preparing", "completed"] {
            let owner = format!("run-owner-{state}");
            let id = format!("run-{state}");
            session(&store, &owner);
            let mut row = run("done");
            row.id = id.clone();
            store.upsert_run(&row).unwrap();
            store.register_run_wakeup(&id, &owner).unwrap();
            store.claim_run_wakeup(&id, &owner).unwrap().unwrap();
            notification_test_receipt(&store, &owner, &run_notification_id(&id), state);
        }
        notification_test_sql(&store, "UPDATE chat_run_wakeups SET claimed_at=0;
            CREATE TRIGGER fail_run_ack BEFORE UPDATE OF state ON chat_run_wakeups
            WHEN NEW.state='delivered' BEGIN SELECT RAISE(ABORT,'injected run acknowledgement failure'); END;");
        let error = process_run_wakeups(&host, Store::open().unwrap(), None)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected run acknowledgement failure"),
            "{error:#}"
        );
        notification_test_sql(
            &store,
            "DROP TRIGGER fail_run_ack; UPDATE chat_run_wakeups SET claimed_at=0;",
        );
        for _ in 0..2 {
            process_run_wakeups(&host, Store::open().unwrap(), None)
                .await
                .unwrap();
        }
        assert!(store.list_ready_run_wakeups().unwrap().is_empty());
        for state in ["preparing", "completed"] {
            assert_eq!(
                store
                    .register_run_wakeup(&format!("run-{state}"), &format!("run-owner-{state}"))
                    .unwrap(),
                crate::store::RunWakeupRegistration::AlreadyDelivered
            );
        }
        for from in [ChatSpawnState::Pending, ChatSpawnState::Running] {
            let child = format!("child-{}", from.as_str());
            let parent = format!("parent-{}", from.as_str());
            session(&store, &child);
            session(&store, &parent);
            spawn_row(&store, &child, &parent, from);
            if from == ChatSpawnState::Pending {
                notification_test_sql(
                    &store,
                    "UPDATE chat_spawns SET attempts=3 WHERE state='pending';",
                );
            }
            store
                .claim_chat_spawn(&child, from, ChatSpawnState::Waking)
                .unwrap()
                .unwrap();
            notification_test_receipt(
                &store,
                &parent,
                &spawn_notification_id(&child, from),
                "completed",
            );
        }
        notification_test_sql(
            &store,
            "UPDATE chat_spawns SET claimed_at=0 WHERE state='waking';
            CREATE TRIGGER fail_spawn_ack BEFORE UPDATE OF state ON chat_spawns
            WHEN NEW.state='done' AND NEW.session_id='child-running'
            BEGIN SELECT RAISE(ABORT,'injected spawn acknowledgement failure'); END;",
        );
        let error = process_chat_spawns(&host, Store::open().unwrap(), None)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected spawn acknowledgement failure"),
            "{error:#}"
        );
        notification_test_sql(
            &store,
            "DROP TRIGGER fail_spawn_ack;
            UPDATE chat_spawns SET claimed_at=0 WHERE state='waking';
            INSERT INTO chat_messages(id,session_id,role,parts_json,created_at) VALUES
                ('damaged-after-notification','child-running','assistant','invalid-json',1);",
        );
        for _ in 0..2 {
            process_chat_spawns(&host, Store::open().unwrap(), None)
                .await
                .unwrap();
        }
        assert_eq!(
            store.list_chat_spawns(ChatSpawnState::Done).unwrap().len(),
            2
        );

        session(&store, "alerts");
        for id in ["alert-a", "alert-b"] {
            let mut row = unmonitored_run();
            row.id = id.into();
            store.upsert_run(&row).unwrap();
            store.register_run_wakeup(id, "alerts").unwrap();
        }
        // Crash after durable batch preparation but before turn admission.
        let batch = "orx-monitoring-crash-before-admission";
        let tx = store.begin_immediate().unwrap();
        for id in ["alert-a", "alert-b"] {
            assert!(store
                .claim_run_monitoring_delivery(id, "alerts", batch)
                .unwrap());
        }
        tx.commit().unwrap();
        notification_test_sql(&store, "CREATE TRIGGER fail_alert_rearm BEFORE UPDATE OF monitoring_alerted ON chat_run_wakeups
            WHEN NEW.monitoring_alerted=0 BEGIN SELECT RAISE(ABORT,'injected rearm failure'); END;");
        let error = process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("injected rearm failure"),
            "{error:#}"
        );
        notification_test_idle(&host, "alerts").await;
        let rows = store.list_active_run_wakeups().unwrap();
        assert!(rows
            .iter()
            .all(|w| w.monitoring_alerted && w.monitoring_delivery_id.as_deref() == Some(batch)));
        notification_test_sql(&store, "DROP TRIGGER fail_alert_rearm;");
        process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap();
        notification_test_idle(&host, "alerts").await;
        assert!(store
            .list_active_run_wakeups()
            .unwrap()
            .iter()
            .all(|w| !w.monitoring_alerted && w.monitoring_delivery_id.as_deref() == Some(batch)));
        // Admission succeeded, but bookkeeping failed (or the process died here).
        notification_test_receipt(&store, "alerts", batch, "preparing");
        notification_test_sql(&store, "CREATE TRIGGER fail_alert_ack BEFORE UPDATE OF monitoring_delivery_id ON chat_run_wakeups
            WHEN OLD.monitoring_delivery_id IS NOT NULL AND NEW.monitoring_delivery_id IS NULL
            BEGIN SELECT RAISE(ABORT,'injected acknowledgement failure'); END;");
        let error = process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected acknowledgement failure"),
            "{error:#}"
        );
        assert!(store
            .list_active_run_wakeups()
            .unwrap()
            .iter()
            .all(|w| w.monitoring_delivery_id.as_deref() == Some(batch)));
        notification_test_sql(&store, "DROP TRIGGER fail_alert_ack;");
        for _ in 0..2 {
            process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
                .await
                .unwrap();
        }
        assert!(store
            .list_active_run_wakeups()
            .unwrap()
            .iter()
            .all(|w| w.monitoring_alerted && w.monitoring_delivery_id.is_none()));
        // Monitoring recovery and a later outage must create a distinct episode.
        for id in ["alert-a", "alert-b"] {
            let mut row = unmonitored_run();
            row.id = id.into();
            row.backend_json = r#"{"kind":"local"}"#.into();
            store.upsert_run(&row).unwrap();
        }
        process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap();
        assert!(store
            .list_active_run_wakeups()
            .unwrap()
            .iter()
            .all(|w| !w.monitoring_alerted && w.monitoring_delivery_id.is_none()));
        for id in ["alert-a", "alert-b"] {
            let mut row = unmonitored_run();
            row.id = id.into();
            store.upsert_run(&row).unwrap();
        }
        process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap();
        notification_test_idle(&host, "alerts").await;
        let rows = store.list_active_run_wakeups().unwrap();
        let next = rows[0].monitoring_delivery_id.clone().unwrap();
        assert_ne!(next, batch);
        assert!(rows
            .iter()
            .all(|w| w.monitoring_delivery_id.as_deref() == Some(next.as_str())));
        notification_test_receipt(&store, "alerts", &next, "completed");
        process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap();
        let tx = store.begin().unwrap();
        let turns: i64 = tx
            .query_row("SELECT COUNT(*) FROM chat_turns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(turns, 6, "recovery created a duplicate notification turn");
        tx.commit().unwrap();
        assert!(!host.is_busy("alerts").await);
        // Exercise a fresh send too: reject admission, then fail after admission
        // at usage registration, which is before any native harness launch.
        store
            .create_local_project(&crate::local::model::LocalProject {
                id: "p1".into(),
                name: "test".into(),
                slug: "test".into(),
                github_owner: String::new(),
                github_repo: String::new(),
                github_sync_enabled: false,
                baseline_branch: "main".into(),
                repo_path: crate::store::data_dir().to_string_lossy().into_owned(),
                run_command: None,
                paper_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        session(&store, "fresh");
        let fresh_key = "orx-fresh-notification";
        notification_test_sql(
            &store,
            "CREATE TRIGGER reject_notification BEFORE INSERT ON chat_turns
            WHEN NEW.session_id='fresh' BEGIN SELECT RAISE(ABORT,'injected admission failure'); END;
            CREATE TRIGGER prevent_native_launch BEFORE INSERT ON chat_usage_executions
            BEGIN SELECT RAISE(ABORT,'injected pre-launch failure'); END;",
        );
        let guard = TurnGuard::claim_hidden(&host, "fresh").await.unwrap();
        let (_, accepted) = deliver_notification(
            &host,
            Store::open().unwrap(),
            Notification {
                session: "fresh".into(),
                client_turn_id: fresh_key.into(),
                text: "[orx] Test notification".into(),
            },
            guard,
            None,
        )
        .await
        .unwrap();
        assert!(!accepted);
        notification_test_idle(&host, "fresh").await;
        assert!(store
            .get_chat_turn_by_client_id("fresh", fresh_key)
            .unwrap()
            .is_none());
        notification_test_sql(&store, "DROP TRIGGER reject_notification;");
        for text in ["[orx] Test notification", "changed after durable admission"] {
            let guard = TurnGuard::claim_hidden(&host, "fresh").await.unwrap();
            let (_, accepted) = deliver_notification(
                &host,
                Store::open().unwrap(),
                Notification {
                    session: "fresh".into(),
                    client_turn_id: fresh_key.into(),
                    text: text.into(),
                },
                guard,
                None,
            )
            .await
            .unwrap();
            assert!(accepted);
            notification_test_idle(&host, "fresh").await;
        }
        let tx = store.begin().unwrap();
        let turns: i64 = tx
            .query_row("SELECT COUNT(*) FROM chat_turns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(turns, 7);
        let executions: i64 = tx
            .query_row("SELECT COUNT(*) FROM chat_usage_executions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(executions, 0, "test crossed the pre-launch failure barrier");
        tx.commit().unwrap();
        // Legacy rows migrate without inventing old delivery receipts.
        notification_test_sql(
            &store,
            "ALTER TABLE chat_run_wakeups DROP COLUMN monitoring_delivery_id;
            DELETE FROM product_schema_migrations WHERE name='monitoring-delivery-v1';",
        );
        drop(store);
        for _ in 0..2 {
            let store = Store::open().unwrap();
            assert!(store
                .list_active_run_wakeups()
                .unwrap()
                .iter()
                .all(|w| w.monitoring_alerted && w.monitoring_delivery_id.is_none()));
        }
    }
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(check());
        return;
    }
    let root = std::env::temp_dir().join(format!(
        "orx-notification-recovery-{}",
        uuid::Uuid::new_v4()
    ));
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
