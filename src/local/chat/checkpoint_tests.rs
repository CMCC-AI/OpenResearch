use super::*;

pub(super) fn seed_stop_queue(store: &Store, host: &ChatHost) {
    let item = busy_metadata_message();
    store
        .insert_queued_chat_message(&StoredQueuedChatMessage {
            id: item.id.clone(),
            session_id: "session".into(),
            client_turn_id: item.client_turn_id.clone(),
            request_hash: item.request_hash.clone(),
            payload_json: serde_json::to_string(&item).unwrap(),
            created_at: 3,
        })
        .unwrap();
    host.queued
        .lock()
        .unwrap()
        .insert("session".into(), VecDeque::from([item]));
}

#[test]
fn user_stop_owned_settlement_handles_active_reservation_and_storage_failures() {
    const CHILD: &str = "ORX_TEST_USER_STOP_SETTLEMENT";
    const TEST: &str = "local::chat::checkpoint_tests::user_stop_owned_settlement_handles_active_reservation_and_storage_failures";
    if let Ok(case) = std::env::var(CHILD) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let store = Store::open().unwrap();
                let host = Arc::new(ChatHost::new(
                    Arc::new(crate::local::opencode::AgentHost::new(None)),
                    Arc::new(crate::local::codex::CodexHost::new()),
                    Arc::new(crate::local::claude::ClaudeHost::new()),
                ));
                host.durable_turns
                    .lock()
                    .unwrap()
                    .insert("session".into(), "stop-token".into());
                host.turns.lock().await.insert(
                    "session".into(),
                    TurnState::Reserved {
                        turn_id: Some("turn".into()),
                        reservation_id: "stop-reservation".into(),
                    },
                );
                let (started, ready) = tokio::sync::oneshot::channel();
                let (release, wait) = std::sync::mpsc::channel();
                let mut clear_signal = None;
                let mut marker_signal = None;
                if case == "cancel-clear" {
                    clear_signal = Some((started, wait));
                } else {
                    marker_signal = Some((started, wait));
                }
                let clear_case = case.clone();
                let marker_case = case.clone();
                let worker_host = host.clone();
                let worker = tokio::spawn(async move {
                    worker_host
                        .interrupt_by_user_with_store(
                            "session",
                            move || {
                                if let Some((started, wait)) = clear_signal {
                                    let _ = started.send(());
                                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                                }
                                if clear_case == "clear-error" {
                                    return Err(anyhow!("injected clear failure"));
                                }
                                Store::open()
                            },
                            move || {
                                if marker_case == "cancel-marker" {
                                    let (started, wait) = marker_signal.unwrap();
                                    let _ = started.send(());
                                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                                }
                                if marker_case == "marker-error" {
                                    return Err(anyhow!("injected marker failure"));
                                }
                                Store::open()
                            },
                        )
                        .await
                });
                if case.starts_with("cancel-") {
                    ready.await.unwrap();
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    worker.abort();
                    assert!(worker.await.unwrap_err().is_cancelled());
                    release.send(()).unwrap();
                    tokio::time::timeout(Duration::from_secs(3), async {
                        loop {
                            let session = store.get_chat_session("session").unwrap().unwrap();
                            let marked = session
                                .active_leaf_id
                                .as_deref()
                                .and_then(|id| store.get_chat_message(id).unwrap())
                                .is_some_and(|row| row.parts_json.contains("interrupted"));
                            if marked {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(2)).await;
                        }
                    })
                    .await
                    .unwrap();
                } else {
                    assert_eq!(worker.await.unwrap().is_err(), case == "clear-error");
                }
                assert!(!host.is_busy("session").await);
                assert!(!store.chat_turn_leased("session").unwrap());
                assert_eq!(
                    store
                        .get_chat_turn("session", "turn")
                        .unwrap()
                        .unwrap()
                        .state,
                    "interrupted"
                );
                assert!(host.queue_cancellation_held.lock().unwrap().is_empty());
                assert!(!host
                    .queue_dispatch_cancelled
                    .lock()
                    .unwrap()
                    .contains("session"));
                assert_eq!(
                    store.list_queued_chat_messages().unwrap().len(),
                    usize::from(case == "clear-error")
                );
                let rows = store.list_chat_messages("session").unwrap();
                assert_eq!(
                    rows.iter()
                        .filter(|row| row.parts_json.contains("interrupted"))
                        .count(),
                    usize::from(case != "marker-error")
                );
            });
        return;
    }
    for case in [
        "cancel-clear",
        "cancel-marker",
        "clear-error",
        "marker-error",
    ] {
        let (dir, store, ctx) = checkpoint_fixture();
        seed_stop_queue(&store, &ctx.host);
        assert!(store.claim_chat_turn("session", "stop-token", &[]).unwrap());
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, case)
            .env("ORX_DATA_DIR", &dir)
            .output()
            .unwrap();
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
        assert!(
            output.status.success(),
            "{case}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn user_stop_clear_survives_cancelled_waiter_without_blocking_scheduler() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    seed_stop_queue(&store, &host);
    let mut events = host.subscribe();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        worker_host
            .interrupt_by_user_with_store(
                "session",
                move || {
                    let _ = started.send(());
                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                    Store::open_at(root)
                },
                || panic!("idle Stop must not persist a marker"),
            )
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert!(host.busy_sessions().await.is_empty());
    assert_eq!(host.queue_cancellation_held.lock().unwrap()["session"], 1);
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if !host
                .queue_dispatch_cancelled
                .lock()
                .unwrap()
                .contains("session")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert!(host.queue_cancellation_held.lock().unwrap().is_empty());
    assert!(host.queued_items("session").is_empty());
    assert!(store.list_queued_chat_messages().unwrap().is_empty());
    let (name, _) = events.try_recv().unwrap();
    assert_eq!(name, "chat.queued");
    assert!(events.try_recv().is_err());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn user_stop_clear_failure_and_overlapping_holds_preserve_cancellation() {
    for fail_open in [true, false] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        seed_stop_queue(&store, &host);
        let mut events = host.subscribe();
        let root = dir.clone();
        assert!(host
            .clear_queue_inner_with_store("session", true, move || {
                if fail_open {
                    return Err(anyhow!("injected Stop open failure"));
                }
                let opened = Store::open_at(root)?;
                let tx = opened.begin()?;
                tx.execute_batch("CREATE TEMP TABLE chat_queued_messages(invalid INTEGER)")?;
                tx.commit()?;
                Ok(opened)
            })
            .is_err());
        assert_eq!(host.queued_items("session").len(), 1);
        assert_eq!(store.list_queued_chat_messages().unwrap().len(), 1);
        assert!(events.try_recv().is_err());
        host.clear_queue_inner_with_store("session", true, || Store::open_at(dir.clone()))
            .unwrap();
        assert_eq!(host.queue_cancellation_held.lock().unwrap()["session"], 2);
        // A plain clear must not undo another Stop's cancellation hold.
        host.clear_queue_inner_with_store("session", false, || Store::open_at(dir.clone()))
            .unwrap();
        host.release_queue_cancellation_if_idle("session");
        assert_eq!(host.queue_cancellation_held.lock().unwrap()["session"], 1);
        let mut dispatch = QueueDispatchGuard::begin_locked(host.clone(), "session", "old-item");
        dispatch.finish_locked(true);
        assert!(host
            .queue_dispatch_cancelled
            .lock()
            .unwrap()
            .contains("session"));
        host.release_queue_cancellation_if_idle("session");
        assert!(!host
            .queue_dispatch_cancelled
            .lock()
            .unwrap()
            .contains("session"));
        assert!(host.queue_cancellation_held.lock().unwrap().is_empty());
        assert!(store.list_queued_chat_messages().unwrap().is_empty());
        let (name, _) = events.try_recv().unwrap();
        assert_eq!(name, "chat.queued");
        assert!(events.try_recv().is_err());
        drop(dispatch);
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn user_stop_marker_survives_cancel_and_broadcasts_only_persisted_branch() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let parent = store
        .get_chat_session("session")
        .unwrap()
        .unwrap()
        .active_leaf_id;
    let mut events = host.subscribe();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let marker_host = host.clone();
    let worker = tokio::spawn(crate::local::blocking::run(move || {
        marker_host.record_user_interruption_with_store("session", 7, move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        })
    }));
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert!(host.busy_sessions().await.is_empty());
    assert!(events.try_recv().is_err());
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    let (name, payload) = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(name, "chat.message");
    let row = store
        .get_chat_message(payload["message"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(row.parent_id, parent);
    assert_eq!(row.created_at, 7);
    assert!(row.parts_json.contains("interrupted"));
    for fail_open in [true, false] {
        assert!(host
            .record_user_interruption_with_store("session", 8, || {
                if fail_open {
                    return Err(anyhow!("injected marker open failure"));
                }
                let opened = Store::open_at(dir.clone())?;
                let tx = opened.begin()?;
                tx.execute_batch("CREATE TEMP TABLE chat_messages(invalid INTEGER)")?;
                tx.commit()?;
                Ok(opened)
            })
            .is_err());
        assert!(events.try_recv().is_err());
    }
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn admission_claim_wait_keeps_scheduler_and_token_map_available() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut other = store.get_chat_session("session").unwrap().unwrap();
    other.id = "other-session".into();
    store.create_chat_session(&other).unwrap();
    let turns = host.turns.clone().lock_owned().await;
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let claim = TurnGuard::claim_locked_with_store(&host, "session", turns, move || {
        let _ = started.send(());
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        Store::open_at(root)
    });
    let heartbeat = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert!(host.durable_turns.try_lock().is_ok());
        assert!(host.turns.try_lock().is_ok());
        assert!(!host.is_busy("other-session").await);
        assert!(!host.interrupt("other-session").await.unwrap());
        let other_turns = host.turns.clone().lock_owned().await;
        let root = dir.clone();
        let (mut other, other_turns) =
            TurnGuard::claim_locked_with_store(&host, "other-session", other_turns, move || {
                Store::open_at(root)
            })
            .await
            .unwrap();
        drop(other_turns);
        other.release().await;
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(claim, heartbeat);
    let (mut guard, turns) = result.unwrap();
    assert!(matches!(
        turns.get("session"),
        Some(TurnState::Reserved { .. })
    ));
    assert!(store.chat_turn_leased("session").unwrap());
    drop(turns);
    assert!(TurnGuard::claim(&host, "session", None).await.is_none());
    guard.release().await;
    assert!(!store.chat_turn_leased("session").unwrap());
    assert!(host.turns.lock().await.is_empty());
    drop(guard);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn admission_claim_cancelled_waiter_releases_worker_owned_lease() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut events = host.subscribe();
    let turns = host.turns.clone().lock_owned().await;
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        TurnGuard::claim_locked_with_store(&worker_host, "session", turns, move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        })
        .await
    });
    ready.await.unwrap();
    worker.abort();
    assert!(matches!(worker.await, Err(error) if error.is_cancelled()));
    assert!(host.turns.try_lock().is_ok());
    assert!(host.is_busy("session").await);
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        let (name, payload) = events.recv().await.unwrap();
        assert_eq!(name, "chat.busy");
        assert_eq!(payload["busy"], false);
    })
    .await
    .unwrap();
    assert!(!store.chat_turn_leased("session").unwrap());
    assert!(host.durable_turns.lock().unwrap().is_empty());
    assert!(host.turns.lock().await.is_empty());
    assert!(events.try_recv().is_err());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn admission_claim_release_does_not_hold_turn_map_during_sql_wait() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let turns = host.turns.clone().lock_owned().await;
    let root = dir.clone();
    let (mut guard, turns) =
        TurnGuard::claim_locked_with_store(&host, "session", turns, move || Store::open_at(root))
            .await
            .unwrap();
    drop(turns);
    let tx = store.begin().unwrap();
    tx.execute(
        "UPDATE chat_turn_leases SET heartbeat_at = heartbeat_at",
        [],
    )
    .unwrap();
    let mut events = host.subscribe();
    let release = tokio::spawn(async move { guard.release().await });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if matches!(
                host.turns.lock().await.get("session"),
                Some(TurnState::Releasing { .. })
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(host.turns.try_lock().is_ok());
    assert!(events.try_recv().is_err());
    tx.commit().unwrap();
    release.await.unwrap();
    assert!(!store.chat_turn_leased("session").unwrap());
    assert!(host.turns.lock().await.is_empty());
    let (name, payload) = events.try_recv().unwrap();
    assert_eq!(name, "chat.busy");
    assert_eq!(payload["busy"], false);
    assert!(events.try_recv().is_err());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn admission_claim_failures_leave_no_reservation_or_local_token() {
    for mode in ["open-error", "sql-error", "foreign-lease", "restarting"] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        if mode == "foreign-lease" {
            assert!(store.claim_chat_turn("session", "foreign", &[]).unwrap());
        }
        if mode == "restarting" {
            host.restarting
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let root = dir.clone();
        let mut events = host.subscribe();
        let turns = host.turns.clone().lock_owned().await;
        assert!(
            TurnGuard::claim_locked_with_store(&host, "session", turns, move || {
                assert_ne!(mode, "restarting", "restarting must not open storage");
                if mode == "open-error" {
                    return Err(anyhow!("injected admission open failure"));
                }
                let opened = Store::open_at(root)?;
                if mode == "sql-error" {
                    let tx = opened.begin()?;
                    tx.execute_batch("CREATE TEMP TABLE chat_turn_leases(invalid INTEGER)")?;
                    tx.commit()?;
                }
                Ok(opened)
            })
            .await
            .is_none()
        );
        assert!(host.turns.lock().await.is_empty());
        assert!(host.durable_turns.lock().unwrap().is_empty());
        assert_eq!(
            store.chat_turn_leased("session").unwrap(),
            mode == "foreign-lease"
        );
        if mode == "foreign-lease" {
            assert!(store.renew_chat_turn("session", "foreign").unwrap());
        }
        assert!(events.try_recv().is_err());
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn lease_heartbeat_idle_skips_storage_and_retains_directory_gate() {
    let (dir, store, ctx) = checkpoint_fixture();
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    let (guard, lost) = ctx
        .host
        .renew_turn_leases_with_store(gate.clone().lock_owned().await, || {
            panic!("idle heartbeat must not open storage")
        })
        .await
        .unwrap();
    assert!(lost.is_empty());
    assert!(gate.try_lock().is_err());
    drop(guard);
    assert!(gate.try_lock().is_ok());
    drop(store);
    drop(ctx);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn lease_heartbeat_worker_retains_gate_after_waiter_cancellation() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    assert!(store.claim_chat_turn("session", "token", &[]).unwrap());
    // Database initialization is fixture setup, not part of observing
    // when cancellation releases the heartbeat's directory gate.
    let worker_store = Store::open_at(dir.clone()).unwrap();
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "token".into());
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    let guard = gate.clone().lock_owned().await;
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        worker_host
            .renew_turn_leases_with_store(guard, move || {
                let _ = started.send(());
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(worker_store)
            })
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert!(host.busy_sessions().await.is_empty());
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    assert!(gate.try_lock().is_err());
    release.send(()).unwrap();
    let guard = tokio::time::timeout(Duration::from_secs(3), gate.lock())
        .await
        .unwrap();
    assert!(store.chat_turn_leased("session").unwrap());
    drop(guard);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn lease_heartbeat_stale_result_cannot_interrupt_replacement_turn() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    assert!(store.claim_chat_turn("session", "old-token", &[]).unwrap());
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "old-token".into());
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    let guard = gate.clone().lock_owned().await;
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let renew = host.renew_turn_leases_with_store(guard, move || {
        let _ = started.send(());
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        Store::open_at(root)
    });
    let replace = async {
        ready.await.unwrap();
        store.release_chat_turn("session", "old-token").unwrap();
        assert!(store.claim_chat_turn("session", "new-token", &[]).unwrap());
        let mut turns = host.turns.lock().await;
        host.durable_turns
            .lock()
            .unwrap()
            .insert("session".into(), "new-token".into());
        turns.insert(
            "session".into(),
            TurnState::Reserved {
                turn_id: None,
                reservation_id: "successor".into(),
            },
        );
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(renew, replace);
    let (guard, lost) = result.unwrap();
    assert_eq!(lost, vec![("session".into(), "old-token".into())]);
    let mut events = host.subscribe();
    assert!(!host
        .interrupt_with_lease(&lost[0].0, Some(&lost[0].1))
        .await
        .unwrap());
    assert!(matches!(host.turns.lock().await.get("session"),
        Some(TurnState::Reserved { reservation_id, .. }) if reservation_id == "successor"));
    assert!(store.renew_chat_turn("session", "new-token").unwrap());
    assert!(events.try_recv().is_err());
    drop(guard);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lease_heartbeat_storage_errors_do_not_report_ownership_loss() {
    for mode in ["live", "open-error", "sql-error"] {
        let (dir, store, ctx) = checkpoint_fixture();
        assert!(store.claim_chat_turn("session", "token", &[]).unwrap());
        if mode == "live" {
            let tx = store.begin().unwrap();
            tx.execute("UPDATE chat_turn_leases SET heartbeat_at = 0", [])
                .unwrap();
            tx.commit().unwrap();
            assert!(!store.chat_turn_leased("session").unwrap());
        }
        ctx.host
            .durable_turns
            .lock()
            .unwrap()
            .insert("session".into(), "token".into());
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let root = dir.clone();
        let result = ctx
            .host
            .renew_turn_leases_with_store(gate.clone().lock_owned().await, move || {
                if mode == "open-error" {
                    return Err(anyhow!("injected heartbeat open failure"));
                }
                let opened = Store::open_at(root)?;
                if mode == "sql-error" {
                    let tx = opened.begin()?;
                    tx.execute_batch("CREATE TEMP TABLE chat_turn_leases(invalid INTEGER)")?;
                    tx.commit()?;
                }
                Ok(opened)
            })
            .await;
        if mode != "live" {
            assert!(result.is_err());
        } else {
            let (guard, lost) = result.unwrap();
            assert!(lost.is_empty());
            assert!(gate.try_lock().is_err());
            drop(guard);
        }
        assert!(gate.try_lock().is_ok());
        assert!(store.chat_turn_leased("session").unwrap());
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn lease_reconciliation_retains_directory_gate_after_waiter_cancellation() {
    for live_lease in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        assert!(store
            .claim_chat_turn("session", "lease-token", &[])
            .unwrap());
        if !live_lease {
            let tx = store.begin().unwrap();
            tx.execute(
                "UPDATE chat_turn_leases SET heartbeat_at = 0 WHERE chat_session_id = 'session'",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let mut events = host.subscribe();
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let data_dir_guard = gate.clone().lock_owned().await;
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let root = dir.clone();
        let worker_host = host.clone();
        let worker = tokio::spawn(async move {
            worker_host
                .reconcile_expired_turn_leases_with_store(data_dir_guard, move || {
                    let _ = started.send(());
                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                    Store::open_at(root)
                })
                .await
        });
        ready.await.unwrap();
        // This timer and the host's ordinary state lock must remain usable
        // while the synchronous recovery worker is deliberately stalled.
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert!(host.busy_sessions().await.is_empty());
        assert!(gate.try_lock().is_err());
        worker.abort();
        assert!(matches!(worker.await, Err(error) if error.is_cancelled()));
        assert!(gate.try_lock().is_err());
        release.send(()).unwrap();
        let recovered_gate = tokio::time::timeout(Duration::from_secs(3), gate.lock())
            .await
            .unwrap();
        let turn = store.get_chat_turn("session", "turn").unwrap().unwrap();
        if live_lease {
            assert_eq!(turn.state, "running");
            assert!(store.chat_turn_leased("session").unwrap());
            assert!(events.try_recv().is_err());
        } else {
            assert_eq!(turn.state, "failed");
            assert!(!store.chat_turn_leased("session").unwrap());
            assert_eq!(turn.recovery_action.as_deref(), Some("continue"));
            let message = store.get_chat_message("assistant").unwrap().unwrap();
            assert!(message.parts_json.contains("turn-recovery"));
            let (name, _) = events.try_recv().unwrap();
            assert_eq!(name, "chat.message");
            assert!(events.try_recv().is_err());
        }
        drop(recovered_gate);
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn lease_reconciliation_errors_release_directory_gate_without_changing_turn() {
    for fail_open in [true, false] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let mut events = host.subscribe();
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let data_dir_guard = gate.clone().lock_owned().await;
        let root = dir.clone();
        let result = host
            .reconcile_expired_turn_leases_with_store(data_dir_guard, move || {
                if fail_open {
                    return Err(anyhow!("injected recovery open failure"));
                }
                let broken = Store::open_at(root)?;
                let tx = broken.begin()?;
                tx.execute_batch("CREATE TEMP TABLE chat_turns(invalid INTEGER)")?;
                tx.commit()?;
                Ok(broken)
            })
            .await;
        assert!(result.is_err());
        assert!(gate.try_lock().is_ok());
        assert_eq!(
            store
                .get_chat_turn("session", "turn")
                .unwrap()
                .unwrap()
                .state,
            "running"
        );
        assert!(store.get_chat_message("assistant").unwrap().is_none());
        assert!(events.try_recv().is_err());
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn busy_queue_worker_finishes_publication_after_waiter_cancel_and_unlocks_on_error() {
    for fail in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let idle_refs = Arc::strong_count(&host);
        let mut events = host.events.subscribe();
        let mut turns = host.turns.clone().lock_owned().await;
        turns.insert("session".into(), TurnState::Draining);
        let opened = Store::open_at(dir.clone()).unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker_host = host.clone();
        let worker = tokio::spawn(async move {
            worker_host
                .persist_busy_submission(
                    "session".into(),
                    opened,
                    busy_metadata_message(),
                    turns,
                    None,
                    move || {
                        let _ = started.send(());
                        wait.recv_timeout(Duration::from_secs(3)).unwrap();
                        if fail {
                            Err(anyhow!("injected enqueue failure"))
                        } else {
                            Ok(())
                        }
                    },
                )
                .await
        });
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(host.turns.try_lock().is_ok());
        worker.abort();
        assert!(matches!(worker.await, Err(e) if e.is_cancelled()));
        assert!(
            host.turns.try_lock().is_ok(),
            "other sessions must not wait for this worker"
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while Arc::strong_count(&host) > idle_refs {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut turns = tokio::time::timeout(Duration::from_secs(3), host.turns.lock())
            .await
            .unwrap();
        assert_eq!(host.queued_count(), usize::from(!fail));
        assert_eq!(
            store
                .list_queued_chat_messages_for_session("session")
                .unwrap()
                .len(),
            usize::from(!fail)
        );
        turns.remove("session");
        drop(turns);
        if !fail {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if events.recv().await.unwrap().0 == "chat.session" {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            while Arc::strong_count(&host) > idle_refs {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(ctx);
        drop(host);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn dispatch_setup_reuses_refresh_connection() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    let opened = Store::open_at(dir.clone()).unwrap();
    let tx = opened.begin().unwrap();
    tx.execute_batch(
        "CREATE TEMP TABLE dispatch_marker(value INTEGER); INSERT INTO dispatch_marker VALUES(42);",
    )
    .unwrap();
    tx.commit().unwrap();
    guard.store = Some(Box::new(opened));
    let setup = load_turn_submission_with_store(
        "session".into(),
        "new-dispatch".into(),
        TurnAdmission::Preclaimed(guard),
        || panic!("reuse refresh connection"),
    )
    .await
    .unwrap();
    let marker: i64 = setup
        .store
        .begin()
        .unwrap()
        .query_row("SELECT value FROM dispatch_marker", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marker, 42);
    assert!(setup.existing.is_none());
    drop(setup);
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.turns.lock().await.contains_key("session") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

fn busy_metadata_message() -> QueuedMessage {
    QueuedMessage {
        id: "metadata-queue".into(),
        client_turn_id: "metadata-client".into(),
        request_hash: "metadata-hash".into(),
        text: "queued text".into(),
        transcript_text: None,
        overrides: TurnOverrides {
            plan_mode: Some(true),
            permission_mode: Some("manual".into()),
            model: Some("custom/model".into()),
            ..Default::default()
        },
        images: Vec::new(),
        annotations: Vec::new(),
        dispatch_attempts: 0,
        dispatch_error: None,
        next_retry_at: None,
    }
}

#[test]
fn busy_queue_settings_commit_with_payload_and_roll_back_on_insert_failure() {
    for reject in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        if reject {
            let tx = store.begin().unwrap();
            tx.execute_batch("CREATE TRIGGER reject_queue BEFORE INSERT ON chat_queued_messages BEGIN SELECT RAISE(ABORT,'injected queue failure'); END;").unwrap();
            tx.commit().unwrap();
        }
        let mut plans =
            HashMap::from([("session".into(), (7, false)), ("other".into(), (3, true))]);
        let mut permissions = HashMap::from([("session".into(), (9, "old-permission".into()))]);
        let old_plans = plans.clone();
        let old_permissions = permissions.clone();
        let result = persist_busy_queue_with_revisions(
            &store,
            "session",
            busy_metadata_message(),
            &mut plans,
            &mut permissions,
        );
        if reject {
            assert_eq!(plans, old_plans);
            assert_eq!(permissions, old_permissions);
        } else {
            assert!(plans["session"].1);
            assert_eq!(permissions["session"].1, "manual");
        }
        assert_eq!(plans["other"], (3, true));
        let saved = store.get_chat_session("session").unwrap().unwrap();
        let tx = store.begin().unwrap();
        let count: i64 = tx
            .query_row("SELECT count(*) FROM chat_queued_messages", [], |r| {
                r.get(0)
            })
            .unwrap();
        if reject {
            assert!(result.is_err());
            assert!(!saved.plan_mode);
            assert!(saved.permission_mode.is_none());
            assert_eq!(count, 0);
        } else {
            let message = result.unwrap();
            assert!(saved.plan_mode);
            assert_eq!(saved.permission_mode.as_deref(), Some("manual"));
            assert_eq!(count, 1);
            let payload: String = tx
                .query_row("SELECT payload_json FROM chat_queued_messages", [], |r| {
                    r.get(0)
                })
                .unwrap();
            let payload: QueuedMessage = serde_json::from_str(&payload).unwrap();
            assert!(payload.overrides.plan_mode.is_none());
            assert!(payload.overrides.permission_mode.is_none());
            assert_eq!(payload.overrides.model, message.overrides.model);
            assert_eq!(payload.text, "queued text");
            assert_eq!(payload.client_turn_id, "metadata-client");
        }
        drop(tx);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn queued_plan_dispatch_skips_completed_replays_and_preserves_legacy_overrides() {
    const CHILD: &str = "ORX_TEST_QUEUE_PLAN_DISPATCH";
    if let Ok(case) = std::env::var(CHILD) {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let store = Store::open().unwrap();
            let host = Arc::new(ChatHost::new(
                Arc::new(AgentHost::new(None)),
                Arc::new(crate::local::codex::CodexHost::new()),
                Arc::new(crate::local::claude::ClaudeHost::new()),
            ));
            host.turns
                .lock()
                .await
                .insert("session".into(), TurnState::Draining);
            host.drain_queue("session").await;
            tokio::time::timeout(Duration::from_secs(3), async {
                while host.turns.lock().await.contains_key("session") {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let session = store.get_chat_session("session").unwrap().unwrap();
            assert_eq!(session.plan_mode, case == "legacy", "{case}");
            assert_eq!(
                session.plan_reset_pending,
                case == "exit" && session.harness == "codex",
                "{case}"
            );
            let writes: i64 = store
                .begin()
                .unwrap()
                .query_row("SELECT count(*) FROM plan_write_audit", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(
                writes,
                i64::from(matches!(case.as_str(), "legacy" | "exit")),
                "{case}"
            );
            if case == "replay" {
                assert!(host.queued_items("session").is_empty());
                assert!(store
                    .list_queued_chat_messages_for_session("session")
                    .unwrap()
                    .is_empty());
                assert_eq!(
                    store
                        .get_chat_turn_by_client_id("session", "plan-client")
                        .unwrap()
                        .unwrap()
                        .id,
                    "existing-plan-turn"
                );
            } else {
                let queued = host.queued.lock().unwrap();
                let item = &queued["session"][0];
                assert!(item
                    .dispatch_error
                    .as_deref()
                    .unwrap()
                    .contains("injected plan admission failure"));
                assert!(queued_delivery_exhausted(item));
                assert!(store
                    .get_chat_turn_by_client_id("session", "plan-client")
                    .unwrap()
                    .is_none());
            }
        });
        return;
    }
    for (harness, case) in ["codex", "opencode"]
        .into_iter()
        .flat_map(|harness| ["replay", "unchanged", "legacy", "exit"].map(|case| (harness, case)))
    {
        let (dir, store, ctx) = checkpoint_fixture();
        store.create_local_project(&ctx.project).unwrap();
        store
            .set_chat_session_plan_state("session", case == "exit", false)
            .unwrap();
        let tx = store.begin().unwrap();
        tx.execute(
            "UPDATE chat_sessions SET harness = ?1 WHERE id = 'session'",
            [harness],
        )
        .unwrap();
        tx.execute_batch("CREATE TABLE plan_write_audit(mode INTEGER, reset_pending INTEGER);
            CREATE TRIGGER audit_plan_update AFTER UPDATE OF plan_mode, plan_reset_pending ON chat_sessions
            BEGIN INSERT INTO plan_write_audit VALUES(NEW.plan_mode, NEW.plan_reset_pending); END;
            CREATE TRIGGER reject_plan_turn BEFORE INSERT ON chat_turns WHEN NEW.client_turn_id='plan-client' AND NEW.id != 'existing-plan-turn'
            BEGIN SELECT RAISE(ABORT,'injected plan admission failure'); END;").unwrap();
        tx.commit().unwrap();
        let mut message = busy_metadata_message();
        message.client_turn_id = "plan-client".into();
        message.overrides = TurnOverrides {
            plan_mode: Some(matches!(case, "replay" | "legacy")),
            ..Default::default()
        };
        if case == "replay" {
            let mut existing = store.get_chat_turn("session", "turn").unwrap().unwrap();
            existing.id = "existing-plan-turn".into();
            existing.client_turn_id = message.client_turn_id.clone();
            existing.request_hash = message.request_hash.clone();
            existing.assistant_message_id = "existing-plan-assistant".into();
            existing.state = "completed".into();
            store.admit_chat_turn(None, &existing).unwrap();
        }
        // Exercise exactly one failed admission, with no scheduled model retry.
        message.dispatch_attempts = crate::local::harness::ORX_MAX_ATTEMPTS - 1;
        store
            .insert_queued_chat_message(&StoredQueuedChatMessage {
                id: message.id.clone(),
                session_id: "session".into(),
                client_turn_id: message.client_turn_id.clone(),
                request_hash: message.request_hash.clone(),
                payload_json: serde_json::to_string(&message).unwrap(),
                created_at: 3,
            })
            .unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local::chat::checkpoint_tests::queued_plan_dispatch_skips_completed_replays_and_preserves_legacy_overrides", "--nocapture"])
            .env(CHILD,case).env("ORX_DATA_DIR",&dir).output().unwrap();
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
        assert!(
            output.status.success(),
            "{harness}/{case}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn metadata_phase_preserves_sticky_settings_archive_and_title_on_admission_failure() {
    const CHILD: &str = "ORX_TEST_SEND_METADATA";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let store = Store::open().unwrap();
            let host = Arc::new(ChatHost::new(
                Arc::new(AgentHost::new(None)),
                Arc::new(crate::local::codex::CodexHost::new()),
                Arc::new(crate::local::claude::ClaudeHost::new()),
            ));
            let guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
            let result = host
                .send_message_showing(
                    "session",
                    SendTurnRequest {
                        messages: vec![AnnotatedText {
                            text: "A new title\nBody".into(),
                            annotations: vec![],
                        }],
                        prepared_input: Some("Prepared context".into()),
                        replace_settings: false,
                        transcript: TranscriptDisplay {
                            text: None,
                            annotations: None,
                            record_user_message: true,
                        },
                        overrides: TurnOverrides {
                            model: Some("custom/model".into()),
                            ..Default::default()
                        },
                        images: TurnAttachments::Uploaded(vec![]),
                        admission: TurnAdmission::Preclaimed(guard),
                        client_turn_id: Some("metadata-client".into()),
                        request_hash: Some("metadata-hash".into()),
                    },
                )
                .await;
            assert!(
                matches!(result,Err(e) if e.to_string().contains("injected admission failure"))
            );
            tokio::time::timeout(Duration::from_secs(3), async {
                while host.turns.lock().await.contains_key("session") {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let session = store.get_chat_session("session").unwrap().unwrap();
            assert_eq!(session.model.as_deref(), Some("custom/model"));
            assert!(!session.archived);
            assert_eq!(session.title.as_deref(), Some("A new title"));
            assert!(store
                .get_chat_turn_by_client_id("session", "metadata-client")
                .unwrap()
                .is_none());
        });
        return;
    }
    let (dir, store, ctx) = checkpoint_fixture();
    store.create_local_project(&ctx.project).unwrap();
    store.set_chat_session_archived("session", true).unwrap();
    let tx = store.begin().unwrap();
    tx.execute_batch("CREATE TRIGGER reject_metadata_turn BEFORE INSERT ON chat_turns WHEN NEW.client_turn_id='metadata-client' BEGIN SELECT RAISE(ABORT,'injected admission failure'); END;").unwrap();
    tx.commit().unwrap();
    let output=std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact","local::chat::checkpoint_tests::metadata_phase_preserves_sticky_settings_archive_and_title_on_admission_failure","--nocapture"])
        .env(CHILD,"1").env("ORX_DATA_DIR",&dir).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

fn execution_outcome(store: &Store, id: &str) -> Option<String> {
    store
        .begin()
        .unwrap()
        .query_row(
            "SELECT outcome FROM chat_usage_executions WHERE execution_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_usage_registration_closes_only_its_execution_even_after_slot_replacement() {
    for replace in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let idle_refs = Arc::strong_count(&host);
        store
            .begin_usage_execution("other-exec", "turn", "opencode")
            .unwrap();
        let guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
        let opened = Store::open_at(dir.clone()).unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker_host = host.clone();
        let worker = tokio::spawn(async move {
            worker_host
                .prepare_launch_usage(
                    guard,
                    "launch-exec".into(),
                    "turn".into(),
                    "opencode".into(),
                    move || {
                        let _ = started.send(());
                        wait.recv_timeout(Duration::from_secs(3)).unwrap();
                        Ok(opened)
                    },
                )
                .await
        });
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(host.cleanup_lock("session").try_lock_owned().is_err());
        assert!(
            matches!(host.turns.lock().await.get("session"), Some(TurnState::Reserved { turn_id: Some(id), .. }) if id == "turn")
        );
        worker.abort();
        assert!(matches!(worker.await, Err(e) if e.is_cancelled()));
        assert!(host.turns.lock().await.contains_key("session"));
        if replace {
            host.turns.lock().await.insert(
                "session".into(),
                TurnState::Reserved {
                    reservation_id: "successor".into(),
                    turn_id: None,
                },
            );
        }
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while Arc::strong_count(&host) > idle_refs {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            execution_outcome(&store, "launch-exec").as_deref(),
            Some("cancelled")
        );
        assert!(execution_outcome(&store, "other-exec").is_none());
        assert_eq!(
            store
                .get_chat_turn("session", "turn")
                .unwrap()
                .unwrap()
                .state,
            if replace { "running" } else { "interrupted" }
        );
        if replace {
            assert!(
                matches!(host.turns.lock().await.get("session"), Some(TurnState::Reserved { reservation_id, .. }) if reservation_id == "successor")
            );
            host.turns.lock().await.remove("session");
        }
        drop(ctx);
        drop(host);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn usage_registration_reuses_connection_and_handoff_preserves_open_execution() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    guard.store = Some(Box::new(Store::open_at(dir.clone()).unwrap()));
    let guard = host
        .prepare_launch_usage(
            guard,
            "launch-exec".into(),
            "turn".into(),
            "opencode".into(),
            || panic!("reuse existing connection"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(guard.unstarted_usage.as_deref(), Some("launch-exec"));
    guard.defuse();
    assert!(execution_outcome(&store, "launch-exec").is_none());
    let tx = store.begin().unwrap();
    tx.execute("INSERT INTO chat_usage_samples(execution_id,sample_id,harness,usage_json) VALUES('launch-exec','fixture','opencode','{}')", []).unwrap();
    tx.commit().unwrap();
    store
        .cancel_unstarted_usage_execution("launch-exec")
        .unwrap();
    assert!(
        execution_outcome(&store, "launch-exec").is_none(),
        "never cancel an execution with samples using the unstarted path"
    );
    host.turns.lock().await.remove("session");
    let guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    host.turns
        .lock()
        .await
        .insert("session".into(), TurnState::Cancelling);
    assert!(host
        .prepare_launch_usage(
            guard,
            "stale".into(),
            "turn".into(),
            "opencode".into(),
            || panic!("stale reservation must not open storage")
        )
        .await
        .unwrap()
        .is_none());
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn failed_usage_registration_releases_slot_and_interrupts_admitted_turn() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    let opened = Store::open_at(dir.clone()).unwrap();
    let tx = opened.begin().unwrap();
    tx.execute("DROP TABLE chat_usage_executions", []).unwrap();
    tx.commit().unwrap();
    guard.store = Some(Box::new(opened));
    let result = host
        .prepare_launch_usage(
            guard,
            "failed-exec".into(),
            "turn".into(),
            "opencode".into(),
            || panic!("reuse failed connection"),
        )
        .await;
    assert!(result.is_err());
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.turns.lock().await.contains_key("session") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn startup_progress_holds_cleanup_until_worker_finishes_and_rejects_stale_owner() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let task = tokio::spawn(std::future::pending());
    host.turns.lock().await.insert(
        "session".into(),
        TurnState::Active(ActiveTurn {
            native: NativeInterruptTarget::default(),
            handle: task,
            message_id: "assistant".into(),
            turn_id: "turn".into(),
        }),
    );
    assert!(!host
        .start_turn_progress(
            "session".into(),
            "stale".into(),
            "turn".into(),
            "not_sent".into(),
            || panic!("stale message must not open store")
        )
        .await
        .unwrap());
    let opened = Store::open_at(dir.clone()).unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        worker_host
            .start_turn_progress(
                "session".into(),
                "assistant".into(),
                "turn".into(),
                "not_sent".into(),
                move || {
                    let _ = started.send(());
                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                    Ok(opened)
                },
            )
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(host.cleanup_lock("session").try_lock_owned().is_err());
    worker.abort();
    assert!(matches!(worker.await, Err(e) if e.is_cancelled()));
    release.send(()).unwrap();
    let cleanup = host.cleanup_lock("session").lock_owned().await;
    store.interrupt_chat_turn("turn").unwrap();
    host.turns
        .lock()
        .await
        .insert("session".into(), TurnState::Cancelling);
    drop(cleanup);
    assert!(!host
        .start_turn_progress(
            "session".into(),
            "assistant".into(),
            "turn".into(),
            "not_sent".into(),
            || panic!("stopped turn must not restart")
        )
        .await
        .unwrap());
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_reserved_phase_retains_cleanup_and_settles_only_admitted_turns() {
    for admitted in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
        guard.store = Some(Box::new(Store::open_at(dir.clone()).unwrap()));
        guard.admitted_turn = admitted.then(|| "turn".into());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker_host = host.clone();
        let worker = tokio::spawn(async move {
            worker_host
                .reserved_store_phase(guard, move |store| {
                    let _ = started.send(());
                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                    store.touch_chat_session("session")?;
                    store.get_chat_session("session")
                })
                .await
        });
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(host.turns.lock().await.contains_key("session"));
        worker.abort();
        assert!(matches!(worker.await, Err(e) if e.is_cancelled()));
        assert!(host.cleanup_lock("session").try_lock_owned().is_err());
        assert!(host.turns.lock().await.contains_key("session"));
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while host.turns.lock().await.contains_key("session") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            store
                .get_chat_turn("session", "turn")
                .unwrap()
                .unwrap()
                .state,
            if admitted { "interrupted" } else { "running" }
        );
        assert!(
            store
                .get_chat_session("session")
                .unwrap()
                .unwrap()
                .updated_at
                > 1
        );
        drop(ctx);
        drop(host);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn reserved_phase_rejects_stale_slots_and_preserves_error_cleanup() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    guard.store = Some(Box::new(Store::open_at(dir.clone()).unwrap()));
    host.turns
        .lock()
        .await
        .insert("session".into(), TurnState::Cancelling);
    let result = host
        .reserved_store_phase(guard, |_| -> Result<()> {
            panic!("stale phase must not access storage")
        })
        .await
        .unwrap();
    assert!(result.is_none());
    assert!(matches!(
        host.turns.lock().await.get("session"),
        Some(TurnState::Cancelling)
    ));
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    guard.store = Some(Box::new(Store::open_at(dir.clone()).unwrap()));
    guard.admitted_turn = Some("turn".into());
    let result = host
        .reserved_store_phase(guard, |_| -> Result<()> {
            Err(anyhow!("injected snapshot failure"))
        })
        .await;
    assert!(matches!(result, Err(e) if e.to_string() == "injected snapshot failure"));
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.turns.lock().await.contains_key("session") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_submission_setup_retains_worker_reservation_and_preserves_successor() {
    for replace_reservation in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let idle_host_refs = Arc::strong_count(&host);
        let guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let root = dir.clone();
        let worker = tokio::spawn(load_turn_submission_with_store(
            "session".into(),
            "client".into(),
            TurnAdmission::Preclaimed(guard),
            move || {
                let _ = started.send(());
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
                Store::open_at(root)
            },
        ));
        ready.await.unwrap();
        // On a single-thread runtime the timer and turns lock must advance
        // while opening storage is blocked on the real worker thread.
        tokio::time::timeout(Duration::from_millis(500), async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            assert!(host.turns.lock().await.contains_key("session"));
        })
        .await
        .unwrap();
        worker.abort();
        assert!(matches!(worker.await, Err(error) if error.is_cancelled()));
        assert!(host.turns.lock().await.contains_key("session"));
        let successor = replace_reservation.then(|| "successor".to_string());
        if let Some(id) = &successor {
            host.turns.lock().await.insert(
                "session".into(),
                TurnState::Reserved {
                    turn_id: None,
                    reservation_id: id.clone(),
                },
            );
        }
        let cleanup = host.cleanup_lock("session").lock_owned().await;
        release.send(()).unwrap();
        drop(cleanup);
        tokio::time::timeout(Duration::from_secs(3), async {
            while Arc::strong_count(&host) > idle_host_refs {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if let Some(id) = successor {
            // The worker and detached guard cleanup have both finished.
            assert!(
                matches!(host.turns.lock().await.get("session"), Some(TurnState::Reserved { reservation_id, .. }) if reservation_id == &id)
            );
            host.turns.lock().await.remove("session");
        } else {
            tokio::time::timeout(Duration::from_secs(3), async {
                while host.turns.lock().await.contains_key("session") {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
        assert_eq!(
            store
                .get_chat_turn("session", "turn")
                .unwrap()
                .unwrap()
                .state,
            "running"
        );
        drop(ctx);
        drop(host);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn submission_setup_reuses_connection_and_preserves_client_lookup() {
    let (dir, store, ctx) = checkpoint_fixture();
    let opened = Store::open_at(dir.clone()).unwrap();
    let tx = opened.begin_immediate().unwrap();
    tx.execute_batch(
        "CREATE TEMP TABLE setup_connection_marker(value INTEGER); INSERT INTO setup_connection_marker VALUES(42);"
    ).unwrap();
    tx.commit().unwrap();
    let result = load_turn_submission_with_store(
        "session".into(),
        "client".into(),
        TurnAdmission::QueueIfBusy,
        move || Ok(opened),
    )
    .await
    .unwrap();
    assert_eq!(result.session.id, "session");
    let existing = result.existing.as_ref().unwrap();
    assert_eq!(existing.id, "turn");
    assert_eq!(
        existing.request_hash,
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .request_hash
    );
    assert!(matches!(result.admission, TurnAdmission::QueueIfBusy));
    let value: i64 = result
        .store
        .begin_immediate()
        .unwrap()
        .query_row("SELECT value FROM setup_connection_marker", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        value, 42,
        "continue with the exact connection opened by setup"
    );
    let root = dir.clone();
    let fresh = load_turn_submission_with_store(
        "session".into(),
        "new-client".into(),
        TurnAdmission::RejectIfBusy,
        move || Store::open_at(root),
    )
    .await
    .unwrap();
    assert!(fresh.existing.is_none());
    assert!(matches!(fresh.admission, TurnAdmission::RejectIfBusy));
    drop(fresh);
    drop(result);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn submission_setup_errors_release_preclaimed_slots_without_mutating_turns() {
    for missing_session in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let session_id = if missing_session {
            "missing"
        } else {
            "session"
        };
        let guard = TurnGuard::reserve(&host, session_id, &mut *host.turns.lock().await);
        let root = dir.clone();
        let result = load_turn_submission_with_store(
            session_id.into(),
            "client".into(),
            TurnAdmission::Preclaimed(guard),
            move || {
                if missing_session {
                    Store::open_at(root)
                } else {
                    Err(anyhow!("injected open failure"))
                }
            },
        )
        .await;
        let Err(error) = result else {
            panic!("setup unexpectedly succeeded")
        };
        assert_eq!(
            error.to_string(),
            if missing_session {
                "chat session not found"
            } else {
                "injected open failure"
            }
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while host.turns.lock().await.contains_key(session_id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            store
                .get_chat_turn("session", "turn")
                .unwrap()
                .unwrap()
                .state,
            "running"
        );
        drop(ctx);
        drop(host);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn admission_turn(store: &Store) -> StoredChatTurn {
    let mut turn = store.get_chat_turn("session", "turn").unwrap().unwrap();
    turn.id = "next-turn".into();
    turn.client_turn_id = "next-client".into();
    turn.assistant_message_id = "next-assistant".into();
    turn.user_message_id = None;
    turn.state = "preparing".into();
    turn
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_admission_waiter_keeps_slot_until_write_and_cleanup_finish() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let opened = Store::open_at(dir.clone()).unwrap();
    let turn = admission_turn(&store);
    let guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    let tx = store.begin_immediate().unwrap();
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        worker_host
            .admit_turn_with_store(guard, opened, None, turn, None)
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(host.turns.lock().await.get("session"), Some(TurnState::Reserved { turn_id: Some(id), .. }) if id == "next-turn") { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(!worker.is_finished());
    assert!(host.cleanup_lock("session").try_lock_owned().is_err());
    worker.abort();
    assert!(matches!(worker.await, Err(error) if error.is_cancelled()));
    assert!(host.turns.lock().await.contains_key("session"));
    tx.commit().unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.turns.lock().await.contains_key("session") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store
            .get_chat_turn("session", "next-turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn admission_preserves_idempotency_conflicts_and_replacement_slots() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    for conflict in [false, true] {
        let guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
        let mut turn = store.get_chat_turn("session", "turn").unwrap().unwrap();
        if conflict {
            turn.request_hash = "different".into();
        }
        let (admission, mut guard) = host
            .admit_turn_with_store(
                guard,
                Store::open_at(dir.clone()).unwrap(),
                None,
                turn,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            (&admission, conflict),
            (ChatTurnAdmission::Existing(_), false) | (ChatTurnAdmission::Conflict, true)
        ));
        guard.release().await;
        assert_eq!(
            store
                .get_chat_turn("session", "turn")
                .unwrap()
                .unwrap()
                .state,
            "running"
        );
    }
    let old = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    let mut new = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    assert!(host
        .admit_turn_with_store(
            old,
            Store::open_at(dir.clone()).unwrap(),
            None,
            admission_turn(&store),
            None
        )
        .await
        .unwrap()
        .is_none());
    tokio::task::yield_now().await;
    assert!(
        matches!(host.turns.lock().await.get("session"), Some(TurnState::Reserved { reservation_id, .. }) if reservation_id == &new.reservation_id)
    );
    assert!(store
        .get_chat_turn("session", "next-turn")
        .unwrap()
        .is_none());
    new.release().await;
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn stop_persists_state_and_message_without_blocking_scheduler() {
    let (dir, store, ctx) = checkpoint_fixture();
    let mut parts = ctx.assistant.parts.clone();
    parts.push(WirePart::tool("turn-retry", "retry", "running", None));
    store
        .upsert_chat_message(&StoredChatMessage {
            id: "assistant".into(),
            session_id: "session".into(),
            role: "assistant".into(),
            parts_json: serde_json::to_string(&parts).unwrap(),
            created_at: 2,
            completed_at: None,
            parent_id: Some("user".into()),
            base_native_session_id: Some("base".into()),
            result_native_session_id: Some("result".into()),
        })
        .unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let stop = persist_interruption_with_store(
        ctx.host.clone(),
        "session",
        Some("turn".into()),
        Some("assistant".into()),
        move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        },
    );
    let heartbeat = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        release.send(()).unwrap();
    };
    let (message, ()) = tokio::join!(stop, heartbeat);
    let message = message.unwrap().unwrap();
    assert!(message.completed_at.is_some());
    assert!(!message.parts.iter().any(|p| p.id == "turn-retry"));
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    let stopped = store.get_chat_message("assistant").unwrap().unwrap();
    assert_eq!(stopped.result_native_session_id.as_deref(), Some("result"));
    assert_eq!(stopped.base_native_session_id.as_deref(), Some("base"));
    assert!(store
        .checkpoint_chat_message("turn", &stopped)
        .unwrap()
        .is_none());
    let root = dir.clone();
    assert!(persist_interruption_with_store(
        ctx.host.clone(),
        "foreign",
        None,
        Some("assistant".into()),
        move || Store::open_at(root)
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        store
            .get_chat_message("assistant")
            .unwrap()
            .unwrap()
            .completed_at,
        stopped.completed_at
    );
    assert!(
        persist_interruption_with_store(ctx.host.clone(), "session", None, None, || panic!(
            "no durable work must not open storage"
        ))
        .await
        .unwrap()
        .is_none()
    );
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn stop_snapshot_serializes_with_resolved_prompt_answers() {
    let (dir, store, ctx) = checkpoint_fixture();
    let prompt = WirePrompt {
        kind: "question".into(),
        native_id: Some("question".into()),
        ..Default::default()
    };
    let mut stored = StoredChatMessage {
        id: "assistant".into(),
        session_id: "session".into(),
        role: "assistant".into(),
        parts_json: serde_json::to_string(&vec![WirePart::prompt("question", prompt.clone())])
            .unwrap(),
        created_at: 2,
        completed_at: None,
        parent_id: Some("user".into()),
        base_native_session_id: None,
        result_native_session_id: None,
    };
    store.upsert_chat_message(&stored).unwrap();
    let guard = ctx.host.msg_write.lock().unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let root = dir.clone();
    let stop = persist_interruption_with_store(
        ctx.host.clone(),
        "session",
        Some("turn".into()),
        Some("assistant".into()),
        move || {
            let opened = Store::open_at(root)?;
            let _ = started.send(());
            Ok(opened)
        },
    );
    let answer = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        let answered = WirePrompt {
            resolved: true,
            approved: Some(true),
            answers: vec!["keep".into()],
            ..prompt
        };
        stored.parts_json =
            serde_json::to_string(&vec![WirePart::prompt("question", answered)]).unwrap();
        store.upsert_chat_message(&stored).unwrap();
        drop(guard);
    };
    let (message, ()) = tokio::join!(stop, answer);
    assert_eq!(
        message.unwrap().unwrap().parts[0]
            .prompt
            .as_ref()
            .unwrap()
            .answers,
        ["keep"]
    );
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn reserved_stop_and_storage_failure_preserve_retryable_state() {
    let (dir, store, ctx) = checkpoint_fixture();
    assert!(persist_interruption_with_store(
        ctx.host.clone(),
        "session",
        Some("turn".into()),
        None,
        || Err(anyhow!("injected open failure"))
    )
    .await
    .is_err());
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "running"
    );
    let root = dir.clone();
    assert!(persist_interruption_with_store(
        ctx.host.clone(),
        "session",
        Some("turn".into()),
        None,
        move || { Store::open_at(root) }
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn interruption_usage_keeps_slot_and_other_turn_accounting_untouched() {
    let (dir, store, ctx) = checkpoint_fixture();
    let (_, other_store, other_ctx) = checkpoint_fixture_at(dir.clone(), "-other");
    store
        .begin_usage_execution("settlement-exec", "turn", "opencode")
        .unwrap();
    store
        .begin_usage_execution("other-exec", "turn-other", "opencode")
        .unwrap();
    store.interrupt_chat_turn("turn").unwrap();
    ctx.host
        .turns
        .lock()
        .await
        .insert("session".into(), TurnState::Cancelling);
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let close = finalize_interrupted_usage_with_store("turn", move || {
        let _ = started.send(());
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        Store::open_at(root)
    });
    let heartbeat = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert!(matches!(
            ctx.host.turns.lock().await.get("session"),
            Some(TurnState::Cancelling)
        ));
        assert!(usage_outcome(&store).is_none());
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(close, heartbeat);
    result.unwrap();
    assert_eq!(usage_outcome(&store).as_deref(), Some("cancelled"));
    let other: Option<String> = store
        .begin()
        .unwrap()
        .query_row(
            "SELECT outcome FROM chat_usage_executions WHERE execution_id='other-exec'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(other.is_none());
    assert!(matches!(
        ctx.host.turns.lock().await.get("session"),
        Some(TurnState::Cancelling)
    ));
    let root = dir.clone();
    finalize_interrupted_usage_with_store("turn", move || Store::open_at(root))
        .await
        .unwrap();
    assert_eq!(usage_outcome(&store).as_deref(), Some("cancelled"));
    drop(ctx);
    drop(other_ctx);
    drop(store);
    drop(other_store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn interruption_usage_failure_can_be_retried_without_changing_turn_state() {
    let (dir, store, ctx) = checkpoint_fixture();
    store
        .begin_usage_execution("settlement-exec", "turn", "opencode")
        .unwrap();
    store.interrupt_chat_turn("turn").unwrap();
    assert!(
        finalize_interrupted_usage_with_store("turn", || Err(anyhow!(
            "injected usage open failure"
        )))
        .await
        .is_err()
    );
    assert!(usage_outcome(&store).is_none());
    let root = dir.clone();
    finalize_interrupted_usage_with_store("turn", move || Store::open_at(root))
        .await
        .unwrap();
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    assert_eq!(usage_outcome(&store).as_deref(), Some("cancelled"));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "local admission and interruption storage profile; no model execution"]
fn turn_boundary_store_profile_benchmark() {
    let (dir, store, ctx) = checkpoint_fixture();
    let mut samples = [Vec::new(), Vec::new(), Vec::new()];
    for i in 0..30 {
        let mut turn = store.get_chat_turn("session", "turn").unwrap().unwrap();
        turn.id = format!("profile-turn-{i}");
        turn.client_turn_id = format!("profile-client-{i}");
        turn.assistant_message_id = format!("profile-message-{i}");
        turn.user_message_id = None;
        turn.prepared_input = "x".repeat(32768);
        let start = std::time::Instant::now();
        let opened = Store::open_at(dir.clone()).unwrap();
        let after_open = start.elapsed().as_nanos();
        assert!(matches!(
            opened.admit_chat_turn(None, &turn).unwrap(),
            ChatTurnAdmission::Inserted
        ));
        samples[0].push((after_open, start.elapsed().as_nanos()));
        drop(opened);
        let start = std::time::Instant::now();
        let opened = Store::open_at(dir.clone()).unwrap();
        let after_open = start.elapsed().as_nanos();
        assert!(opened.get_chat_session("session").unwrap().is_some());
        samples[1].push((after_open, start.elapsed().as_nanos()));
        opened
            .begin_usage_execution(&format!("profile-exec-{i}"), &turn.id, "opencode")
            .unwrap();
        opened.interrupt_chat_turn(&turn.id).unwrap();
        drop(opened);
        let start = std::time::Instant::now();
        let opened = Store::open_at(dir.clone()).unwrap();
        let after_open = start.elapsed().as_nanos();
        opened.finalize_turn_usage(&turn.id, "cancelled").unwrap();
        samples[2].push((after_open, start.elapsed().as_nanos()));
        drop(opened);
    }
    for (name, group) in [
        "admission-no-user",
        "interruption-snapshot",
        "interruption-usage",
    ]
    .into_iter()
    .zip(samples)
    {
        let open_mean = group.iter().map(|s| s.0).sum::<u128>() / group.len() as u128;
        let total_mean = group.iter().map(|s| s.1).sum::<u128>() / group.len() as u128;
        let mut totals: Vec<_> = group.iter().map(|s| s.1).collect();
        totals.sort();
        eprintln!("turn_boundary phase={name} iterations=30 open_mean_ns={open_mean} operation_mean_ns={} total_mean_ns={total_mean} total_p95_ns={}", total_mean - open_mean, totals[28]);
    }
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn target_pointer_cleanup_preserves_replacement_and_accepts_missing_file() {
    let dir = std::env::temp_dir().join(format!("orx-pointer-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let pointer = dir.join("session.current");
    let old = dir.join("old.events");
    let new = dir.join("new.events");
    std::fs::write(&pointer, new.to_string_lossy().as_bytes()).unwrap();
    remove_target_pointer_if_matches_at(&pointer, &old);
    assert_eq!(
        std::fs::read_to_string(&pointer).unwrap(),
        new.to_string_lossy()
    );
    remove_target_pointer_if_matches_at(&pointer, &new);
    assert!(!pointer.exists());
    remove_target_pointer_if_matches_at(&pointer, &new);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "local target cleanup profile; isolated temporary files"]
fn target_cleanup_profile_benchmark() {
    let dir = std::env::temp_dir().join(format!("orx-target-profile-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let pointer = dir.join("session.current");
    let events = dir.join("message.events");
    let mut samples = Vec::new();
    for _ in 0..200 {
        std::fs::write(&events, b"test").unwrap();
        std::fs::write(&pointer, events.to_string_lossy().as_bytes()).unwrap();
        let start = std::time::Instant::now();
        std::fs::remove_file(&events).unwrap();
        remove_target_pointer_if_matches_at(&pointer, &events);
        samples.push(start.elapsed().as_nanos());
        assert!(!pointer.exists());
    }
    samples.sort();
    eprintln!(
        "target_cleanup iterations=200 mean_ns={} p95_ns={} max_ns={}",
        samples.iter().sum::<u128>() / 200,
        samples[189],
        samples[199]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn partial_question_answers_require_storage_and_survive_turn_flushes() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    let prompt = WirePrompt {
        kind: "question".into(),
        native_id: Some("batch".into()),
        ..Default::default()
    };
    ctx.assistant.parts = vec![WirePart::prompt("part", prompt)];
    store
        .upsert_chat_message(&StoredChatMessage {
            id: "assistant".into(),
            session_id: "session".into(),
            role: "assistant".into(),
            parts_json: serde_json::to_string(&ctx.assistant.parts).unwrap(),
            created_at: 2,
            completed_at: None,
            parent_id: None,
            base_native_session_id: None,
            result_native_session_id: None,
        })
        .unwrap();
    let answer = || PromptAnswer {
        session_id: "session".into(),
        prompt_id: "part".into(),
        approve: true,
        resume_mode: None,
        answers: vec![],
        note: Some("Persisted free text".into()),
        annotations: vec![],
    };
    assert!(persist_partial_prompt_answer_with_store(
        ctx.host.clone(),
        "assistant".into(),
        answer(),
        || Err(anyhow!("injected open failure"))
    )
    .await
    .is_err());
    let tx = store.begin().unwrap();
    tx.execute_batch("CREATE TRIGGER reject_answer BEFORE UPDATE OF parts_json ON chat_messages BEGIN SELECT RAISE(ABORT,'injected answer write failure'); END;").unwrap();
    tx.commit().unwrap();
    let root = dir.clone();
    assert!(persist_partial_prompt_answer_with_store(
        ctx.host.clone(),
        "assistant".into(),
        answer(),
        move || Store::open_at(root)
    )
    .await
    .is_err());
    let tx = store.begin().unwrap();
    tx.execute_batch("DROP TRIGGER reject_answer;").unwrap();
    tx.commit().unwrap();
    let before = stored_to_wire(&store.get_chat_message("assistant").unwrap().unwrap());
    assert!(!before.parts[0].prompt.as_ref().unwrap().resolved);
    let root = dir.clone();
    let saved = persist_partial_prompt_answer_with_store(
        ctx.host.clone(),
        "assistant".into(),
        answer(),
        move || Store::open_at(root),
    )
    .await
    .unwrap();
    assert_eq!(
        saved.parts[0].prompt.as_ref().unwrap().note.as_deref(),
        Some("Persisted free text")
    );
    let root = dir.clone();
    ctx.flush_async_kind(true, false, move || Store::open_at(root))
        .await
        .unwrap();
    let saved = stored_to_wire(&store.get_chat_message("assistant").unwrap().unwrap());
    assert!(saved.parts[0].prompt.as_ref().unwrap().resolved);
    assert_eq!(
        saved.parts[0].prompt.as_ref().unwrap().note.as_deref(),
        Some("Persisted free text")
    );
    let root = dir.clone();
    assert!(persist_partial_prompt_answer_with_store(
        ctx.host.clone(),
        "assistant".into(),
        answer(),
        move || Store::open_at(root)
    )
    .await
    .is_err());
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

pub(super) fn checkpoint_fixture() -> (PathBuf, Store, TurnCtx) {
    let dir = std::env::temp_dir().join(format!("orx-checkpoint-{}", uuid::Uuid::new_v4()));
    checkpoint_fixture_at(dir, "")
}

fn checkpoint_fixture_at(dir: PathBuf, suffix: &str) -> (PathBuf, Store, TurnCtx) {
    let store = Store::open_at(dir.clone()).unwrap();
    let session = StoredChatSession {
        id: format!("session{suffix}"),
        project_id: "project".into(),
        harness: "codex".into(),
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
    };
    store.create_chat_session(&session).unwrap();
    store
        .upsert_chat_message_on_branch(&StoredChatMessage {
            id: format!("user{suffix}"),
            session_id: session.id.clone(),
            role: "user".into(),
            parts_json: "[]".into(),
            created_at: 1,
            completed_at: Some(1),
            parent_id: None,
            base_native_session_id: None,
            result_native_session_id: None,
        })
        .unwrap();
    let project = LocalProject {
        id: "project".into(),
        name: "project".into(),
        slug: "project".into(),
        github_owner: String::new(),
        github_repo: String::new(),
        github_sync_enabled: false,
        baseline_branch: "main".into(),
        repo_path: dir.to_string_lossy().into_owned(),
        run_command: None,
        paper_id: None,
        created_at: 1,
        updated_at: 1,
    };
    let turn = StoredChatTurn {
        id: format!("turn{suffix}"),
        session_id: session.id.clone(),
        user_message_id: Some(format!("user{suffix}")),
        assistant_message_id: format!("assistant{suffix}"),
        client_turn_id: "client".into(),
        request_hash: String::new(),
        prepared_input: String::new(),
        settings_json: "{}".into(),
        state: "running".into(),
        delivery_state: "sent".into(),
        attempt_count: 0,
        next_retry_at: None,
        error_kind: None,
        error_message: None,
        recovery_action: None,
        recovered_by_turn_id: None,
        created_at: 1,
        updated_at: 1,
    };
    let host = Arc::new(ChatHost::new(
        Arc::new(AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));
    store.admit_chat_turn(None, &turn).unwrap();
    let ctx = turn_ctx_from_stored(
        host,
        &session,
        project,
        &turn,
        WireMessage {
            id: format!("assistant{suffix}"),
            role: "assistant".into(),
            parts: vec![WirePart::text("part", "first")],
            created_at: 2,
            completed_at: None,
            parent_id: None,
        },
    );
    (dir, store, ctx)
}

#[tokio::test]
async fn finish_metadata_preserves_normal_compaction_and_interruption_updates() {
    for mode in ["normal", "compaction", "interruption"] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        store
            .create_chat_spawn(&crate::store::ChatSpawn {
                session_id: "session".into(),
                parent_session_id: "parent".into(),
                prompt: "test".into(),
                wake_parent: true,
                attempts: 0,
                finished_at: None,
            })
            .unwrap();
        let message_id = if mode == "interruption" {
            host.turns
                .lock()
                .await
                .insert("session".into(), TurnState::Cancelling);
            None
        } else {
            host.turns.lock().await.insert(
                "session".into(),
                TurnState::Active(ActiveTurn {
                    native: NativeInterruptTarget::default(),
                    handle: tokio::spawn(std::future::pending()),
                    message_id: "assistant".into(),
                    turn_id: if mode == "compaction" {
                        "compact_assistant"
                    } else {
                        "turn"
                    }
                    .into(),
                }),
            );
            Some("assistant")
        };
        let opened = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = opened.clone();
        let root = dir.clone();
        let session = host
            .finish_session_metadata_with_store("session", message_id, move || {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Store::open_at(root)
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(opened.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(session.updated_at > 1);
        assert_eq!(
            session.updated_at,
            store
                .get_chat_session("session")
                .unwrap()
                .unwrap()
                .updated_at
        );
        assert!(store
            .get_chat_spawn("session")
            .unwrap()
            .unwrap()
            .finished_at
            .is_some());
        if let Some(TurnState::Active(active)) = host.turns.lock().await.remove("session") {
            active.handle.abort();
        }
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn finish_metadata_rechecks_ownership_after_waiting_for_cleanup_gate() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let gate = host.cleanup_lock("session").lock_owned().await;
    host.turns.lock().await.insert(
        "session".into(),
        TurnState::Active(ActiveTurn {
            native: NativeInterruptTarget::default(),
            handle: tokio::spawn(std::future::pending()),
            message_id: "old-assistant".into(),
            turn_id: "old-turn".into(),
        }),
    );
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        worker_host
            .finish_session_metadata_with_store("session", Some("old-assistant"), || {
                panic!("a stale turn must not open storage")
            })
            .await
    });
    tokio::task::yield_now().await;
    if let Some(TurnState::Active(active)) = host
        .turns
        .lock()
        .await
        .insert("session".into(), TurnState::Cancelling)
    {
        active.handle.abort();
    }
    drop(gate);
    assert!(worker.await.unwrap().unwrap().is_none());
    assert_eq!(
        store
            .get_chat_session("session")
            .unwrap()
            .unwrap()
            .updated_at,
        1
    );
    let root = dir.clone();
    assert!(host
        .finish_session_metadata_with_store("session", None, move || Store::open_at(root))
        .await
        .unwrap()
        .is_some());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn finish_metadata_cancelled_waiter_keeps_successors_fenced_until_write_ends() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    host.turns
        .lock()
        .await
        .insert("session".into(), TurnState::Cancelling);
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        worker_host
            .finish_session_metadata_with_store("session", None, move || {
                let _ = started.send(());
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
                Store::open_at(root)
            })
            .await
    });
    ready.await.unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    let interrupt_host = host.clone();
    let interrupt = tokio::spawn(async move { interrupt_host.interrupt("session").await });
    tokio::time::sleep(Duration::from_millis(2)).await;
    // Repeating an interruption no longer waits on storage. The existing
    // Cancelling slot and actual worker's gate still exclude successors.
    assert!(!interrupt.await.unwrap().unwrap());
    assert!(host.cleanup_lock("session").try_lock_owned().is_err());
    assert!(host.turns.lock().await.contains_key("session"));
    let turns = host.turns.clone().lock_owned().await;
    assert!(
        TurnGuard::claim_locked_with_store(&host, "session", turns, || {
            panic!("cancelled metadata worker must fence successor storage")
        })
        .await
        .is_none()
    );
    assert!(!host.interrupt("other-session").await.unwrap());
    release.send(()).unwrap();
    let done = tokio::time::timeout(
        Duration::from_secs(3),
        host.cleanup_lock("session").lock_owned(),
    )
    .await
    .unwrap();
    drop(done);
    assert!(
        store
            .get_chat_session("session")
            .unwrap()
            .unwrap()
            .updated_at
            > 1
    );
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn finish_metadata_open_failure_releases_gate_and_allows_explicit_retry() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    host.turns
        .lock()
        .await
        .insert("session".into(), TurnState::Cancelling);
    assert!(host
        .finish_session_metadata_with_store("session", None, || Err(anyhow!(
            "injected metadata open failure"
        )))
        .await
        .is_err());
    assert!(host.cleanup_lock("session").try_lock_owned().is_ok());
    assert_eq!(
        store
            .get_chat_session("session")
            .unwrap()
            .unwrap()
            .updated_at,
        1
    );
    let root = dir.clone();
    assert!(host
        .finish_session_metadata_with_store("session", None, move || Store::open_at(root))
        .await
        .unwrap()
        .is_some());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn finished_lease_release_keeps_scheduler_and_other_sessions_available() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut events = host.subscribe();
    assert!(store.claim_chat_turn("session", "old-token", &[]).unwrap());
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "old-token".into());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let worker = {
        let mut turns = host.turns.lock().await;
        host.release_finished_turn_with_store(&mut turns, "session", None, move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        })
    };
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert!(host.busy_sessions().await.contains(&"session".into()));
    assert!(store.chat_turn_leased("session").unwrap());
    assert!(!host.interrupt("session").await.unwrap());
    host.drain_queue("session").await;
    {
        let mut turns = host.turns.lock().await;
        assert!(matches!(
            turns.get("session"),
            Some(TurnState::Releasing { .. })
        ));
        turns.insert(
            "other".into(),
            TurnState::Reserved {
                turn_id: None,
                reservation_id: uuid::Uuid::new_v4().to_string(),
            },
        );
    }
    release.send(()).unwrap();
    worker.await.unwrap();
    assert!(!host.turns.lock().await.contains_key("session"));
    assert!(host.turns.lock().await.contains_key("other"));
    assert!(!store.chat_turn_leased("session").unwrap());
    let (name, event) = events.try_recv().unwrap();
    assert_eq!(name, "chat.busy");
    assert_eq!(event["busy"], false);
    assert!(events.try_recv().is_err());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_stalled_process_keeps_its_own_turns_when_it_expires_stale_leases() {
    let (dir, store, ctx) = checkpoint_fixture();
    for id in ["working", "other"] {
        let mut s = store.get_chat_session("session").unwrap().unwrap();
        s.id = id.into();
        store.create_chat_session(&s).unwrap();
    }
    let host = ctx.host.clone();
    let turns = host.turns.clone().lock_owned().await;
    let root = dir.clone();
    let (mut working, turns) =
        TurnGuard::claim_locked_with_store(&host, "working", turns, move || Store::open_at(root))
            .await
            .unwrap();
    drop(turns);

    let stall = || {
        let tx = store.begin().unwrap();
        tx.execute(
            "UPDATE chat_turn_leases SET heartbeat_at = ?1",
            [now_ms() - crate::store::CHAT_TURN_LEASE_TTL_MS - 1],
        )
        .unwrap();
        tx.commit().unwrap();
    };

    stall();
    let turns = host.turns.clone().lock_owned().await;
    let root = dir.clone();
    let (mut other, turns) =
        TurnGuard::claim_locked_with_store(&host, "other", turns, move || Store::open_at(root))
            .await
            .unwrap();
    drop(turns);
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    let root = dir.clone();
    let (_, lost) = host
        .renew_turn_leases_with_store(gate.clone().lock_owned().await, move || {
            Store::open_at(root)
        })
        .await
        .unwrap();
    assert!(lost.is_empty());

    stall();
    let root = dir.clone();
    host.reconcile_expired_turn_leases_with_store(gate.clone().lock_owned().await, move || {
        Store::open_at(root)
    })
    .await
    .unwrap();
    let root = dir.clone();
    let (_, lost) = host
        .renew_turn_leases_with_store(gate.clone().lock_owned().await, move || {
            Store::open_at(root)
        })
        .await
        .unwrap();
    assert!(lost.is_empty());

    stall();
    assert!(!store
        .claim_data_dir_move("move", &host.held_turn_leases())
        .unwrap());
    let root = dir.clone();
    let (_, lost) = host
        .renew_turn_leases_with_store(gate.clone().lock_owned().await, move || {
            Store::open_at(root)
        })
        .await
        .unwrap();
    assert!(lost.is_empty());
    working.release().await;
    other.release().await;
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn finished_lease_release_cannot_clear_a_replacement_slot_or_token() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut events = host.subscribe();
    assert!(store.claim_chat_turn("session", "old-token", &[]).unwrap());
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "old-token".into());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let worker = {
        let mut turns = host.turns.lock().await;
        host.release_finished_turn_with_store(&mut turns, "session", None, move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        })
    };
    ready.await.unwrap();
    store.release_chat_turn("session", "old-token").unwrap();
    assert!(store.claim_chat_turn("session", "new-token", &[]).unwrap());
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "new-token".into());
    host.turns.lock().await.insert(
        "session".into(),
        TurnState::Reserved {
            turn_id: None,
            reservation_id: uuid::Uuid::new_v4().to_string(),
        },
    );
    release.send(()).unwrap();
    worker.await.unwrap();
    assert!(matches!(
        host.turns.lock().await.get("session"),
        Some(TurnState::Reserved { .. })
    ));
    assert_eq!(
        host.durable_turns
            .lock()
            .unwrap()
            .get("session")
            .map(String::as_str),
        Some("new-token")
    );
    assert!(store.renew_chat_turn("session", "new-token").unwrap());
    assert!(events.try_recv().is_err());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn finished_lease_release_survives_cancelled_waiter_and_open_failure() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    // A compaction may not own a durable lease; avoid an unnecessary open.
    let worker = {
        let mut turns = host.turns.lock().await;
        host.release_finished_turn_with_store(&mut turns, "session", None, || {
            panic!("a missing lease must not open storage")
        })
    };
    worker.await.unwrap();
    assert!(!host.turns.lock().await.contains_key("session"));
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "old-token".into());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = {
        let mut turns = host.turns.lock().await;
        host.release_finished_turn_with_store(&mut turns, "session", None, move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Err(anyhow!("injected lease open failure"))
        })
    };
    let waiter = tokio::spawn(async move {
        let _ = worker.await;
    });
    ready.await.unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.turns.lock().await.contains_key("session") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!host.durable_turns.lock().unwrap().contains_key("session"));
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn context_usage_requires_matching_final_message_and_preserves_session_order() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    ctx.save_context_usage_with_store(|| panic!("missing usage must not open storage"))
        .await
        .unwrap();
    ctx.context_usage = Some(ContextUsage {
        used_tokens: 200,
        context_window: Some(1000),
    });
    ctx.save_context_usage_with_store(|| panic!("unfinished message must not open storage"))
        .await
        .unwrap();
    assert!(store.complete_chat_turn("turn").unwrap());
    ctx.assistant.completed_at = Some(9);
    let root = dir.clone();
    ctx.flush_final_async_with_store(move || Store::open_at(root))
        .await
        .unwrap();
    store
        .set_chat_session_context_usage("session", "{\"usedTokens\":100}")
        .unwrap();
    let updated = store
        .get_chat_session("session")
        .unwrap()
        .unwrap()
        .updated_at;
    assert!(ctx
        .save_context_usage_with_store(|| Err(anyhow!("injected usage open failure")))
        .await
        .is_err());
    let root = dir.clone();
    assert!(ctx
        .save_context_usage_with_store(move || Store::open_at(root))
        .await
        .unwrap());
    let session = store.get_chat_session("session").unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<ContextUsage>(&session.context_usage_json.unwrap()).unwrap(),
        ctx.context_usage.clone().unwrap()
    );
    assert_eq!(session.updated_at, updated);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn delayed_usage_cannot_replace_new_branch_stop_or_retry() {
    for scenario in ["branch", "stop", "stop-state", "retry", "recovered"] {
        let (dir, store, mut ctx) = checkpoint_fixture();
        assert!(store
            .fail_chat_turn("turn", "not_sent", "test", "failure", Some("retry"))
            .unwrap());
        ctx.assistant.completed_at = Some(9);
        let root = dir.clone();
        ctx.flush_final_async_with_store(move || Store::open_at(root))
            .await
            .unwrap();
        store
            .set_chat_session_context_usage("session", "{\"usedTokens\":100}")
            .unwrap();
        ctx.context_usage = Some(ContextUsage {
            used_tokens: 200,
            context_window: None,
        });
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let root = dir.clone();
        let save = ctx.save_context_usage_with_store(move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        });
        let change = async {
            ready.await.unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
            match scenario {
                "branch" => {
                    let mut next = store.get_chat_message("assistant").unwrap().unwrap();
                    next.id = "next-user".into();
                    next.role = "user".into();
                    next.created_at = 10;
                    next.completed_at = Some(10);
                    store.upsert_chat_message_on_branch(&next).unwrap();
                }
                "stop" => {
                    store.interrupt_chat_turn("turn").unwrap();
                    let mut stopped = store.get_chat_message("assistant").unwrap().unwrap();
                    stopped.completed_at = Some(8);
                    store.upsert_chat_message(&stopped).unwrap();
                }
                "retry" => {
                    assert!(store.reset_chat_turn_for_retry("turn", 123).unwrap());
                }
                "stop-state" => {
                    store.interrupt_chat_turn("turn").unwrap();
                }
                "recovered" => {
                    store.mark_chat_turn_recovered("turn", "next-turn").unwrap();
                }
                _ => unreachable!(),
            }
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(save, change);
        assert!(!result.unwrap());
        assert_eq!(
            store
                .get_chat_session("session")
                .unwrap()
                .unwrap()
                .context_usage_json
                .as_deref(),
            Some("{\"usedTokens\":100}")
        );
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn dispatch_refresh_failure_preserves_queue_without_immediate_redrain() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    host.park_steer_with_store(
        "session",
        SteerMessage {
            submission: None,
            text: "pending".into(),
            display: "pending".into(),
        },
        &store,
    )
    .unwrap();
    let mut events = host.subscribe();
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    let broken = Store::open_at(dir.clone()).unwrap();
    // Shadow only this connection's queue table, leaving durable data intact.
    let tx = broken.begin().unwrap();
    tx.execute_batch("CREATE TEMP TABLE chat_queued_messages(invalid INTEGER)")
        .unwrap();
    tx.commit().unwrap();
    guard.store = Some(Box::new(broken));
    assert!(host.refresh_queue_for_dispatch(guard).await.is_err());
    let (name, event) = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(name, "chat.busy");
    assert_eq!(event["busy"], false);
    assert!(!host.turns.lock().await.contains_key("session"));
    assert_eq!(host.queued_items("session").len(), 1);
    assert_eq!(
        store
            .list_queued_chat_messages_for_session("session")
            .unwrap()
            .len(),
        1
    );
    assert!(!host
        .queue_dispatch_suppressed
        .lock()
        .unwrap()
        .contains("session"));

    // A later reconciliation can refresh the unchanged item and restores
    // normal queue handoff after the transient read failure is gone.
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    guard.store = Some(Box::new(Store::open_at(dir.clone()).unwrap()));
    let mut guard = host
        .refresh_queue_for_dispatch(guard)
        .await
        .unwrap()
        .unwrap();
    assert!(guard.drain_queued_on_release);
    assert_eq!(host.queued_items("session")[0]["text"], "pending");
    host.queue_dispatch_cancelled
        .lock()
        .unwrap()
        .insert("session".into());
    guard.release().await;
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_dispatch_refresh_does_not_redrain_cached_queue() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    host.park_steer_with_store(
        "session",
        SteerMessage {
            submission: None,
            text: "pending".into(),
            display: "pending".into(),
        },
        &store,
    )
    .unwrap();
    let mut events = host.subscribe();
    let cleanup = host.cleanup_lock("session").lock_owned().await;
    let mut guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    guard.store = Some(Box::new(Store::open_at(dir.clone()).unwrap()));
    let worker_host = host.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let _ = started.send(());
        worker_host.refresh_queue_for_dispatch(guard).await
    });
    ready.await.unwrap();
    worker.abort();
    assert!(matches!(worker.await, Err(error) if error.is_cancelled()));
    assert!(host.turns.lock().await.contains_key("session"));
    drop(cleanup);
    let (name, event) = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(name, "chat.busy");
    assert_eq!(event["busy"], false);
    assert!(!host.turns.lock().await.contains_key("session"));
    assert_eq!(host.queued_items("session").len(), 1);
    assert_eq!(
        store
            .list_queued_chat_messages_for_session("session")
            .unwrap()
            .len(),
        1
    );
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn queue_refresh_keeps_worker_responsive_and_filters_in_flight_item() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    for text in ["first", "second"] {
        host.park_steer_with_store(
            "session",
            SteerMessage {
                submission: None,
                text: text.into(),
                display: text.into(),
            },
            &store,
        )
        .unwrap();
    }
    let first_id = host.queued.lock().unwrap()["session"][0].id.clone();
    host.queue_dispatch_in_flight
        .lock()
        .unwrap()
        .insert("session".into(), first_id);
    host.queued.lock().unwrap().remove("session");
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let refresh = host.refresh_persisted_queue_async_with_store("session", move || {
        let _ = started.send(());
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        Store::open_at(root)
    });
    let heartbeat = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(refresh, heartbeat);
    result.unwrap();
    assert_eq!(host.queued_items("session").len(), 1);
    assert_eq!(host.queued_items("session")[0]["text"], "second");
    host.queue_dispatch_cancelled
        .lock()
        .unwrap()
        .insert("session".into());
    let opened = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = opened.clone();
    let root = dir.clone();
    assert!(host
        .refresh_persisted_queue_async_with_store("session", move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Store::open_at(root)
        })
        .await
        .is_err());
    assert_eq!(opened.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(host.queued_items("session")[0]["text"], "second");
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn queue_refresh_serializes_with_concurrent_enqueue() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    host.park_steer_with_store(
        "session",
        SteerMessage {
            submission: None,
            text: "first".into(),
            display: "first".into(),
        },
        &store,
    )
    .unwrap();
    host.queued.lock().unwrap().remove("session");
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let refresh = host.refresh_persisted_queue_async_with_store("session", move || {
        let _ = started.send(());
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        Store::open_at(root)
    });
    let other_host = host.clone();
    let other_root = dir.clone();
    let enqueue = async {
        ready.await.unwrap();
        let (competing, queued) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(crate::local::blocking::run(move || {
            let store = Store::open_at(other_root).unwrap();
            let _ = competing.send(());
            other_host.park_steer_with_store(
                "session",
                SteerMessage {
                    submission: None,
                    text: "second".into(),
                    display: "second".into(),
                },
                &store,
            )
        }));
        queued.await.unwrap();
        release.send(()).unwrap();
        worker.await.unwrap().unwrap().unwrap();
    };
    let (result, ()) = tokio::join!(refresh, enqueue);
    result.unwrap();
    let items = host.queued_items("session");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["text"], "first");
    assert_eq!(items[1]["text"], "second");
    assert_eq!(
        store
            .list_queued_chat_messages_for_session("session")
            .unwrap()
            .len(),
        2
    );
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

fn usage_outcome(store: &Store) -> Option<String> {
    store
        .begin()
        .unwrap()
        .query_row(
            "SELECT outcome FROM chat_usage_executions WHERE execution_id='settlement-exec'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn settlement_keeps_async_worker_responsive_and_reuses_one_store() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for failed in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        store
            .begin_usage_execution("settlement-exec", "turn", "opencode")
            .unwrap();
        let settlement = if failed {
            TurnSettlement::Failed {
                delivery: DeliveryState::Accepted,
                kind: "test_failure".into(),
                message: "failure".into(),
                recovery_action: "continue",
            }
        } else {
            TurnSettlement::Completed
        };
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let opened = Arc::new(AtomicUsize::new(0));
        let counter = opened.clone();
        let root = dir.clone();
        let job = settle_turn_with_store("turn", settlement, move || {
            counter.fetch_add(1, Ordering::SeqCst);
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(2))
                .map_err(|e| anyhow!("settlement blocked async heartbeat: {e}"))?;
            Store::open_at(root)
        });
        let heartbeat = async {
            ready.await.unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(job, heartbeat);
        assert!(result.unwrap());
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        let turn = store.get_chat_turn("session", "turn").unwrap().unwrap();
        assert_eq!(turn.state, if failed { "failed" } else { "completed" });
        assert_eq!(
            usage_outcome(&store).as_deref(),
            Some(if failed { "failed" } else { "done" })
        );
        if failed {
            assert_eq!(turn.error_kind.as_deref(), Some("test_failure"));
            assert_eq!(turn.recovery_action.as_deref(), Some("continue"));
        }
        // A losing duplicate transition must not change accounting.
        let root = dir.clone();
        assert!(!settle_turn_with_store(
            "turn",
            TurnSettlement::Completed,
            move || Store::open_at(root)
        )
        .await
        .unwrap());
        assert_eq!(
            usage_outcome(&store).as_deref(),
            Some(if failed { "failed" } else { "done" })
        );
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn queued_settlement_cannot_replace_interrupted_state_or_accounting() {
    let (dir, store, ctx) = checkpoint_fixture();
    store
        .begin_usage_execution("settlement-exec", "turn", "opencode")
        .unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let job = settle_turn_with_store("turn", TurnSettlement::Completed, move || {
        let _ = started.send(());
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        Store::open_at(root)
    });
    let stop = async {
        ready.await.unwrap();
        store.interrupt_chat_turn("turn").unwrap();
        store.finalize_turn_usage("turn", "cancelled").unwrap();
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(job, stop);
    assert!(!result.unwrap());
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "interrupted"
    );
    assert_eq!(usage_outcome(&store).as_deref(), Some("cancelled"));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn settlement_errors_preserve_transition_and_existing_usage_recovery() {
    let (dir, store, ctx) = checkpoint_fixture();
    store
        .begin_usage_execution("settlement-exec", "turn", "opencode")
        .unwrap();
    assert!(
        settle_turn_with_store("turn", TurnSettlement::Completed, || Err(anyhow!(
            "injected open failure"
        )))
        .await
        .is_err()
    );
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "running"
    );
    assert!(usage_outcome(&store).is_none());
    let tx = store.begin().unwrap();
    tx.execute_batch("CREATE TRIGGER reject_settlement_usage BEFORE UPDATE ON chat_usage_executions BEGIN SELECT RAISE(FAIL, 'injected accounting failure'); END;").unwrap();
    tx.commit().unwrap();
    let root = dir.clone();
    assert!(
        settle_turn_with_store("turn", TurnSettlement::Completed, move || Store::open_at(
            root
        ))
        .await
        .unwrap()
    );
    assert_eq!(
        store
            .get_chat_turn("session", "turn")
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
    assert!(usage_outcome(&store).is_none());
    let tx = store.begin().unwrap();
    tx.execute_batch("DROP TRIGGER reject_settlement_usage")
        .unwrap();
    tx.commit().unwrap();
    store.recover_terminal_usage().unwrap();
    assert_eq!(usage_outcome(&store).as_deref(), Some("done"));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn final_flush_is_off_worker_and_preserves_completed_or_failed_snapshot() {
    for failed in [false, true] {
        let (dir, store, mut ctx) = checkpoint_fixture();
        ctx.flush_with_store(true, || Store::open_at(dir.clone()))
            .unwrap();
        if failed {
            assert!(store
                .fail_chat_turn("turn", "sent", "test_failure", "failure", Some("retry"))
                .unwrap());
        } else {
            assert!(store.complete_chat_turn("turn").unwrap());
        }
        ctx.assistant.parts[0].text = Some("final tail".into());
        ctx.assistant.completed_at = Some(9);
        ctx.native_session_id = Some("native-result".into());
        let acknowledged = ctx.last_persisted_snapshot.clone();
        assert!(ctx
            .flush_final_async_with_store(|| Err(anyhow!("injected final write failure")))
            .await
            .is_err());
        assert_eq!(ctx.last_persisted_snapshot, acknowledged);
        assert!(store
            .get_chat_message("assistant")
            .unwrap()
            .unwrap()
            .parts_json
            .contains("first"));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let root = dir.clone();
        let write = ctx.flush_final_async_with_store(move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(2))
                .map_err(|e| anyhow!("final writer blocked async heartbeat: {e}"))?;
            Store::open_at(root)
        });
        let heartbeat = async {
            ready.await.unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(write, heartbeat);
        result.unwrap();
        let saved = store.get_chat_message("assistant").unwrap().unwrap();
        assert!(saved.parts_json.contains("final tail"));
        assert_eq!(saved.completed_at, Some(9));
        assert_eq!(saved.parent_id.as_deref(), Some("user"));
        assert_eq!(
            saved.result_native_session_id.as_deref(),
            Some("native-result")
        );
        // A late duplicate final cannot replace an already final message.
        ctx.assistant.parts[0].text = Some("late overwrite".into());
        let root = dir.clone();
        ctx.flush_final_async_with_store(move || Store::open_at(root))
            .await
            .unwrap();
        assert_eq!(
            store
                .get_chat_message("assistant")
                .unwrap()
                .unwrap()
                .parts_json,
            saved.parts_json
        );
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn abandoned_final_worker_cannot_overwrite_stop_even_after_completion_won() {
    for completed_first in [false, true] {
        let (dir, store, mut ctx) = checkpoint_fixture();
        ctx.flush_with_store(true, || Store::open_at(dir.clone()))
            .unwrap();
        if completed_first {
            assert!(store.complete_chat_turn("turn").unwrap());
        }
        ctx.assistant.parts[0].text = Some("abandoned final".into());
        ctx.assistant.completed_at = Some(9);
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let root = dir.clone();
        let mut write = Box::pin(ctx.flush_final_async_with_store(move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        }));
        tokio::select! {
            _ = ready => {},
            result = &mut write => panic!("final worker ended before release: {result:?}"),
        }
        drop(write);
        store.interrupt_chat_turn("turn").unwrap();
        let mut stopped = store.get_chat_message("assistant").unwrap().unwrap();
        stopped.parts_json =
            serde_json::to_string(&vec![WirePart::text("part", "stopped content")]).unwrap();
        stopped.completed_at = Some(8);
        store.upsert_chat_message(&stopped).unwrap();
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while Arc::strong_count(&ctx.host) > 1 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        let saved = store.get_chat_message("assistant").unwrap().unwrap();
        assert_eq!(saved.parts_json, stopped.parts_json);
        assert_eq!(saved.completed_at, Some(8));
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn final_flush_adopts_prompt_echo_and_rejects_stale_incarnation() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    ctx.assistant.parts[0].prompt = Some(
        serde_json::from_value(json!({"kind":"permission","resolved":true,"approved":true}))
            .unwrap(),
    );
    ctx.flush_with_store(true, || Store::open_at(dir.clone()))
        .unwrap();
    ctx.assistant.parts[0].prompt =
        Some(serde_json::from_value(json!({"kind":"permission"})).unwrap());
    assert!(store.complete_chat_turn("turn").unwrap());
    ctx.assistant.completed_at = Some(9);
    let root = dir.clone();
    ctx.flush_final_async_with_store(move || Store::open_at(root))
        .await
        .unwrap();
    let saved = stored_to_wire(&store.get_chat_message("assistant").unwrap().unwrap());
    assert!(saved.parts[0].prompt.as_ref().unwrap().resolved);
    assert_eq!(saved.parts[0].prompt.as_ref().unwrap().approved, Some(true));
    let mut stale = store.get_chat_message("assistant").unwrap().unwrap();
    stale.created_at = 123;
    assert!(store.finish_chat_message("turn", &stale).unwrap().is_none());
    stale.completed_at = None;
    assert!(store.finish_chat_message("turn", &stale).is_err());
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn immediate_flush_waits_off_worker_for_real_sqlite_writer_lock() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    let writer = rusqlite::Connection::open(dir.join("orx.db")).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let root = dir.clone();
    let write = ctx.flush_async_with_store(true, move || {
        let _ = started.send(());
        Store::open_at(root)
    });
    let release = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        writer.execute_batch("ROLLBACK").unwrap();
    };
    let (result, ()) = tokio::join!(write, release);
    result.unwrap();
    assert_eq!(ctx.assistant.parent_id.as_deref(), Some("user"));
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("first"));
    // Force progress/card writes even inside the normal broadcast throttle.
    ctx.assistant.parts[0].text = Some("immediate progress".into());
    ctx.last_flush = Instant::now();
    ctx.last_persist = Instant::now();
    let root = dir.clone();
    ctx.flush_async_with_store(true, move || Store::open_at(root))
        .await
        .unwrap();
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("immediate progress"));
    drop(writer);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn shared_sessions_keep_independent_branches_and_prompt_echoes() {
    let dir = std::env::temp_dir().join(format!("orx-shared-prompts-{}", uuid::Uuid::new_v4()));
    let (_, store, mut first) = checkpoint_fixture_at(dir.clone(), "-first");
    let (_, other, mut second) = checkpoint_fixture_at(dir.clone(), "-second");
    for ctx in [&mut first, &mut second] {
        ctx.assistant.parts[0].prompt = Some(
            serde_json::from_value(json!({"kind":"permission","resolved":true,"approved":true}))
                .unwrap(),
        );
        ctx.flush_with_store(true, || Store::open_at(dir.clone()))
            .unwrap();
        ctx.assistant.parts[0].prompt =
            Some(serde_json::from_value(json!({"kind":"permission"})).unwrap());
    }
    first.assistant.parts[0].text = Some("first progress".into());
    second.assistant.parts[0].text = Some("second progress".into());
    let root1 = dir.clone();
    let root2 = dir.clone();
    let (a, b) = tokio::join!(
        first.flush_async_with_store(true, move || Store::open_at(root1)),
        second.flush_async_with_store(true, move || Store::open_at(root2)),
    );
    a.unwrap();
    b.unwrap();
    for (ctx, expected, parent) in [
        (&first, "first progress", "user-first"),
        (&second, "second progress", "user-second"),
    ] {
        let saved = stored_to_wire(&store.get_chat_message(&ctx.assistant.id).unwrap().unwrap());
        assert_eq!(saved.parts[0].text.as_deref(), Some(expected));
        assert_eq!(saved.parent_id.as_deref(), Some(parent));
        let prompt = saved.parts[0].prompt.as_ref().unwrap();
        assert!(prompt.resolved);
        assert_eq!(prompt.approved, Some(true));
    }
    drop(first);
    drop(second);
    drop(store);
    drop(other);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn event_flush_preserves_cadence_tail_and_final_order() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    let mut events = ctx.host.subscribe();
    let root = dir.clone();
    ctx.maybe_flush_async_with_store(move || Store::open_at(root))
        .await
        .unwrap();
    assert_eq!(ctx.assistant.parent_id.as_deref(), Some("user"));
    let (_, first) = events.try_recv().unwrap();
    assert_eq!(first["message"]["parts"][0]["text"], "first");
    ctx.assistant.parts[0].text = Some("latest delta".into());
    // The first checkpoint uses real SQLite. Subsequent cadence checks use
    // its completion as a fixed origin, even if the test thread is delayed.
    let clock = ctx.last_persist;
    ctx.last_flush = clock;
    ctx.maybe_flush_async_at(clock + FLUSH_INTERVAL - Duration::from_nanos(1), || {
        panic!("75ms throttle must not open storage")
    })
    .await
    .unwrap();
    assert!(events.try_recv().is_err());
    ctx.maybe_flush_async_at(clock + FLUSH_INTERVAL, || {
        panic!("broadcast-only delta must not open storage")
    })
    .await
    .unwrap();
    let (_, delta) = events.try_recv().unwrap();
    assert_eq!(delta["message"]["parts"][0]["text"], "latest delta");
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("first"));
    let acknowledged = ctx.last_persisted_snapshot.clone();
    assert!(ctx
        .maybe_flush_async_at(clock + CHECKPOINT_INTERVAL, || Err(anyhow!(
            "injected event write failure"
        )))
        .await
        .is_err());
    assert_eq!(ctx.last_persisted_snapshot, acknowledged);
    let root = dir.clone();
    ctx.checkpoint_async_with_store(move || Store::open_at(root))
        .await
        .unwrap();
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("latest delta"));
    assert!(store.complete_chat_turn("turn").unwrap());
    ctx.assistant.parts[0].text = Some("final answer".into());
    ctx.assistant.completed_at = Some(9);
    ctx.flush_with_store(true, || Store::open_at(dir.clone()))
        .unwrap();
    let saved = store.get_chat_message("assistant").unwrap().unwrap();
    assert!(saved.parts_json.contains("final answer"));
    assert_eq!(saved.completed_at, Some(9));
    assert_eq!(saved.parent_id.as_deref(), Some("user"));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn event_flush_keeps_prompt_echo_without_waiting_for_checkpoint() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    ctx.assistant.parts[0].prompt = Some(
        serde_json::from_value(json!({"kind":"permission", "resolved":true, "approved":true}))
            .unwrap(),
    );
    ctx.flush_with_store(true, || Store::open_at(dir.clone()))
        .unwrap();
    ctx.assistant.parts[0].prompt =
        Some(serde_json::from_value(json!({"kind":"permission"})).unwrap());
    ctx.last_flush = Instant::now() - FLUSH_INTERVAL;
    let root = dir.clone();
    ctx.maybe_flush_async_with_store(move || Store::open_at(root))
        .await
        .unwrap();
    let saved = stored_to_wire(&store.get_chat_message("assistant").unwrap().unwrap());
    assert!(saved.parts[0].prompt.as_ref().unwrap().resolved);
    assert_eq!(saved.parts[0].prompt.as_ref().unwrap().approved, Some(true));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "synthetic concurrent storage benchmark; run explicitly with --ignored --nocapture"]
async fn event_storage_contention_benchmark() {
    storage_contention_benchmark(false).await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "shared SQLite storage benchmark; run explicitly with --ignored --nocapture"]
async fn shared_sqlite_contention_benchmark() {
    storage_contention_benchmark(true).await;
}

async fn storage_contention_benchmark(shared: bool) {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    const CONCURRENT: usize = 16;
    fn percentile(values: &mut [f64], p: f64) -> f64 {
        values.sort_by(f64::total_cmp);
        values[((values.len() as f64 * p).ceil() as usize)
            .saturating_sub(1)
            .min(values.len() - 1)]
    }
    for round in 0..3 {
        for offload in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let shared_dir =
                std::env::temp_dir().join(format!("orx-shared-bench-{}", uuid::Uuid::new_v4()));
            let fixtures: Vec<_> = (0..CONCURRENT)
                .map(|i| {
                    let (dir, store, mut ctx) = if shared {
                        checkpoint_fixture_at(shared_dir.clone(), &format!("-{i}"))
                    } else {
                        checkpoint_fixture()
                    };
                    ctx.assistant.parts[0].text = Some("x".repeat(65536));
                    drop(store);
                    (dir, ctx)
                })
                .collect();
            let gate = Arc::new(tokio::sync::Barrier::new(CONCURRENT + 1));
            let done = Arc::new(AtomicBool::new(false));
            let heartbeat_done = done.clone();
            let (ready, heartbeat_ready) = tokio::sync::oneshot::channel();
            let heartbeat = tokio::spawn(async move {
                let step = Duration::from_millis(5);
                let mut next = tokio::time::Instant::now() + step;
                let mut delays = Vec::new();
                let _ = ready.send(());
                loop {
                    tokio::time::sleep_until(next).await;
                    let observed = tokio::time::Instant::now();
                    while next <= observed {
                        delays.push((observed - next).as_secs_f64() * 1000.0);
                        next += step;
                    }
                    if heartbeat_done.load(Ordering::SeqCst) {
                        break;
                    }
                }
                delays
            });
            heartbeat_ready.await.unwrap();
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let started = Instant::now();
            let mut workers = tokio::task::JoinSet::new();
            for (dir, mut ctx) in fixtures {
                let gate = gate.clone();
                let active = active.clone();
                let peak = peak.clone();
                workers.spawn(async move {
                    gate.wait().await;
                    let root = dir.clone();
                    let requested = Instant::now();
                    let (phase_tx, phase_rx) = tokio::sync::oneshot::channel();
                    let open = move || {
                        let opened_at = Instant::now();
                        let queue_ms = requested.elapsed().as_secs_f64() * 1000.0;
                        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(n, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(20));
                        let result = Store::open_at(root);
                        active.fetch_sub(1, Ordering::SeqCst);
                        let _ =
                            phase_tx.send((queue_ms, opened_at.elapsed().as_secs_f64() * 1000.0));
                        result
                    };
                    let result = if offload {
                        ctx.maybe_flush_async_with_store(open).await
                    } else {
                        ctx.flush_with_store(false, open)
                    };
                    let (queue_ms, open_ms) = phase_rx.await.unwrap();
                    (
                        dir,
                        ctx,
                        started.elapsed().as_secs_f64() * 1000.0,
                        queue_ms,
                        open_ms,
                        result.err(),
                        requested.elapsed().as_secs_f64() * 1000.0,
                    )
                });
            }
            gate.wait().await;
            let mut completed = Vec::new();
            while let Some(result) = workers.join_next().await {
                completed.push(result.unwrap());
            }
            let total_ms = started.elapsed().as_secs_f64() * 1000.0;
            done.store(true, Ordering::SeqCst);
            let mut delays = heartbeat.await.unwrap();
            let mut latencies: Vec<_> =
                completed.iter().map(|(_, _, ms, _, _, _, _)| *ms).collect();
            let errors = completed.iter().filter(|item| item.5.is_some()).count();
            let mut queues: Vec<_> = completed.iter().map(|item| item.3).collect();
            let mut opens: Vec<_> = completed.iter().map(|item| item.4).collect();
            let mut writes: Vec<_> = completed
                .iter()
                .map(|item| item.6 - item.3 - item.4)
                .collect();
            eprintln!("event_storage shared={} round={} mode={} concurrent={} text_bytes=65536 injected_open_ms=20 total_ms={total_ms:.3} completion_p50_ms={:.3} completion_p95_ms={:.3} completion_p99_ms={:.3} heartbeat_samples={} heartbeat_p50_ms={:.3} heartbeat_p95_ms={:.3} heartbeat_p99_ms={:.3} peak_open={} errors={} queue_p95_ms={:.3} open_p95_ms={:.3} post_open_p95_ms={:.3}", shared, round, if offload {"bounded_async"} else {"synchronous"}, CONCURRENT, percentile(&mut latencies,0.50),percentile(&mut latencies,0.95),percentile(&mut latencies,0.99),delays.len(),percentile(&mut delays,0.50),percentile(&mut delays,0.95),percentile(&mut delays,0.99),peak.load(Ordering::SeqCst), errors, percentile(&mut queues,0.95),percentile(&mut opens,0.95),percentile(&mut writes,0.95));
            for (dir, ctx, _, _, _, error, _) in completed {
                assert!(error.is_none(), "shared storage write failed: {error:?}");
                let store = Store::open_at(dir.clone()).unwrap();
                let saved =
                    stored_to_wire(&store.get_chat_message(&ctx.assistant.id).unwrap().unwrap());
                assert_eq!(saved.parts[0].text.as_ref().unwrap().len(), 65536);
                assert_eq!(
                    saved.parent_id,
                    Some(ctx.session_id.replace("session", "user"))
                );
                drop(store);
                drop(ctx);
                if !shared {
                    std::fs::remove_dir_all(dir).unwrap();
                }
            }
            if shared {
                std::fs::remove_dir_all(shared_dir).unwrap();
            }
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn async_checkpoint_leaves_worker_responsive_and_retries_without_redundant_writes() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let checkpoint = ctx.checkpoint_async_with_store(move || {
        let _ = started.send(());
        wait.recv_timeout(Duration::from_secs(2))
            .map_err(|e| anyhow!("heartbeat blocked: {e}"))?;
        Store::open_at(root)
    });
    let heartbeat = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(checkpoint, heartbeat);
    result.unwrap();
    assert_eq!(ctx.assistant.parent_id.as_deref(), Some("user"));
    ctx.checkpoint_async_with_store(|| panic!("clean snapshot must not open storage"))
        .await
        .unwrap();
    ctx.assistant.parts[0].text = Some("retry tail".into());
    let acknowledged = ctx.last_persisted_snapshot.clone();
    assert!(ctx
        .checkpoint_async_with_store(|| Err(anyhow!("injected write failure")))
        .await
        .is_err());
    assert_eq!(ctx.last_persisted_snapshot, acknowledged);
    let root = dir.clone();
    ctx.checkpoint_async_with_store(move || Store::open_at(root))
        .await
        .unwrap();
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("retry tail"));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_checkpoint_cannot_overwrite_terminal_message() {
    for interrupted in [true, false] {
        let (dir, store, mut ctx) = checkpoint_fixture();
        ctx.flush_with_store(true, || Store::open_at(dir.clone()))
            .unwrap();
        ctx.assistant.parts[0].text = Some("stale queued snapshot".into());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let root = dir.clone();
        let mut checkpoint = Box::pin(ctx.checkpoint_async_with_store(move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Store::open_at(root)
        }));
        tokio::select! {
            _ = ready => {},
            result = &mut checkpoint => panic!("checkpoint finished before release: {result:?}"),
        }
        drop(checkpoint); // the already-started blocking closure remains alive
        if interrupted {
            store.interrupt_chat_turn("turn").unwrap();
        } else {
            assert!(store.complete_chat_turn("turn").unwrap());
        }
        ctx.assistant.parts[0].text = Some("terminal content".into());
        ctx.assistant.completed_at = Some(3);
        ctx.flush_with_store(true, || Store::open_at(dir.clone()))
            .unwrap();
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while Arc::strong_count(&ctx.host) > 1 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        let saved = store.get_chat_message("assistant").unwrap().unwrap();
        assert!(saved.parts_json.contains("terminal content"));
        assert!(!saved.parts_json.contains("stale queued snapshot"));
        assert_eq!(saved.completed_at, Some(3));
        assert_eq!(saved.parent_id.as_deref(), Some("user"));
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn checkpoint_fences_wrong_identity_and_completed_message() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    ctx.flush_with_store(true, || Store::open_at(dir.clone()))
        .unwrap();
    let mut candidate = store.get_chat_message("assistant").unwrap().unwrap();
    candidate.parts_json = "[]".into();
    assert!(store
        .checkpoint_chat_message("wrong-turn", &candidate)
        .unwrap()
        .is_none());
    candidate.session_id = "wrong-session".into();
    assert!(store
        .checkpoint_chat_message("turn", &candidate)
        .unwrap()
        .is_none());
    candidate.session_id = "session".into();
    candidate.created_at = 999; // stale incarnation after a retry
    assert!(store
        .checkpoint_chat_message("turn", &candidate)
        .unwrap()
        .is_none());
    candidate.created_at = 2;
    ctx.assistant.completed_at = Some(3);
    ctx.flush_with_store(true, || Store::open_at(dir.clone()))
        .unwrap();
    assert!(store
        .checkpoint_chat_message("turn", &candidate)
        .unwrap()
        .is_none());
    let saved = store.get_chat_message("assistant").unwrap().unwrap();
    assert!(saved.parts_json.contains("first"));
    assert_eq!(saved.completed_at, Some(3));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn async_checkpoint_keeps_resolved_prompt_echo() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    ctx.assistant.parts[0].prompt = Some(
        serde_json::from_value(json!({"kind":"permission", "resolved":true, "approved":true}))
            .unwrap(),
    );
    ctx.flush_with_store(true, || Store::open_at(dir.clone()))
        .unwrap();
    ctx.assistant.parts[0].prompt =
        Some(serde_json::from_value(json!({"kind":"permission"})).unwrap());
    let root = dir.clone();
    ctx.checkpoint_async_with_store(move || Store::open_at(root))
        .await
        .unwrap();
    let saved = stored_to_wire(&store.get_chat_message("assistant").unwrap().unwrap());
    let prompt = saved.parts[0].prompt.as_ref().unwrap();
    assert!(prompt.resolved);
    assert_eq!(prompt.approved, Some(true));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn streaming_checkpoints_keep_branch_parent_and_force_final_and_prompt_writes() {
    let (dir, store, mut ctx) = checkpoint_fixture();
    let mut events = ctx.host.subscribe();
    let open = || Store::open_at(dir.clone());
    ctx.flush_with_store(false, open).unwrap();
    assert_eq!(ctx.assistant.parent_id.as_deref(), Some("user"));
    let (_, initial) = events.try_recv().unwrap();
    assert_eq!(initial["message"]["parentId"], "user");
    ctx.assistant.parts[0].text = Some("streamed".into());
    ctx.flush_with_store(false, || {
        panic!("a mid-checkpoint broadcast must not open the store")
    })
    .unwrap();
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("first"));
    let (_, streamed) = events.try_recv().unwrap();
    assert_eq!(streamed["message"]["parentId"], "user");
    // No harness event follows this delta. Its independent timer still
    // checkpoints it, and a failed attempt must remain retryable.
    let mut timer = TurnCtx::checkpoint_timer();
    tokio::time::timeout(Duration::from_secs(3), timer.tick())
        .await
        .unwrap();
    assert!(ctx
        .checkpoint_with_store(|| Err(anyhow!("injected storage failure")))
        .is_err());
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("first"));
    ctx.checkpoint_with_store(open).unwrap();
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("streamed"));
    ctx.checkpoint_with_store(|| panic!("clean checkpoint must not write again"))
        .unwrap();
    // Exercise a real SQLite write failure as well as the injected open
    // failure above. A competing writer must not acknowledge the dirty
    // snapshot; once its transaction ends the same checkpoint can retry.
    ctx.assistant.parts[0].text = Some("streamed after writer contention".into());
    let acknowledged = ctx.last_persisted_snapshot.clone();
    let writer = rusqlite::Connection::open(dir.join("orx.db")).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let write_error = ctx.checkpoint_with_store(open).unwrap_err();
    assert!(
        write_error.to_string().contains("locked"),
        "{write_error:#}"
    );
    assert_eq!(ctx.last_persisted_snapshot, acknowledged);
    assert!(!store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("writer contention"));
    writer.execute_batch("ROLLBACK").unwrap();
    drop(writer);
    ctx.checkpoint_with_store(open).unwrap();
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("writer contention"));
    ctx.assistant.completed_at = Some(3);
    ctx.flush_with_store(true, open).unwrap();
    let final_message = store.get_chat_message("assistant").unwrap().unwrap();
    assert_eq!(final_message.completed_at, Some(3));
    assert!(final_message.parts_json.contains("streamed"));
    ctx.assistant.parts[0].prompt =
        Some(serde_json::from_value(json!({"kind":"permission"})).unwrap());
    ctx.flush_with_store(false, open).unwrap();
    assert!(store
        .get_chat_message("assistant")
        .unwrap()
        .unwrap()
        .parts_json
        .contains("permission"));
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
