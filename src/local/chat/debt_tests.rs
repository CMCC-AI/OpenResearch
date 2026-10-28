use super::checkpoint_tests::checkpoint_fixture;
use super::*;

#[tokio::test(flavor = "current_thread")]
async fn user_stop_hold_fences_idle_admission_without_queue_storage_lock() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    host.hold_queue_cancellation("session");
    // A late dispatch cleanup may remove its flag; the independent Stop hold
    // must still protect admission, restart and migration.
    host.queue_dispatch_cancelled
        .lock()
        .unwrap()
        .remove("session");
    let turns = host.turns.clone().lock_owned().await;
    assert!(
        TurnGuard::claim_locked_with_store(&host, "session", turns, || {
            panic!("Stop must reject admission before opening storage")
        })
        .await
        .is_none()
    );
    assert!(host.queue_storage_busy());
    assert!(!host.stop_admitting_if_idle().await);
    host.release_queue_cancellation_if_idle("session");
    let root = dir.clone();
    let turns = host.turns.clone().lock_owned().await;
    let (mut guard, turns) =
        TurnGuard::claim_locked_with_store(&host, "session", turns, move || Store::open_at(root))
            .await
            .unwrap();
    drop(turns);
    guard.release().await;
    assert!(!store.chat_turn_leased("session").unwrap());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn user_stop_aborts_before_queue_database_and_cleanup_waits() {
    const CHILD: &str = "ORX_TEST_STOP_EARLY_ABORT";
    const TEST: &str =
        "local::chat::debt_tests::user_stop_aborts_before_queue_database_and_cleanup_waits";
    if let Ok(case) = std::env::var(CHILD) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                struct Aborted(Option<tokio::sync::oneshot::Sender<()>>);
                impl Drop for Aborted {
                    fn drop(&mut self) {
                        if let Some(done) = self.0.take() {
                            let _ = done.send(());
                        }
                    }
                }
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
                let (aborted, observed) = tokio::sync::oneshot::channel();
                let (started, ready) = tokio::sync::oneshot::channel();
                let task = tokio::spawn(async move {
                    let _aborted = Aborted(Some(aborted));
                    started.send(()).unwrap();
                    std::future::pending::<()>().await;
                });
                ready.await.unwrap();
                host.turns.lock().await.insert(
                    "session".into(),
                    TurnState::Active(ActiveTurn {
                        handle: task,
                        message_id: "assistant".into(),
                        turn_id: "turn".into(),
                        native: NativeInterruptTarget::new("codex", None),
                    }),
                );
                let cleanup = if matches!(case.as_str(), "cleanup" | "overlap") {
                    Some(host.cleanup_lock("session").lock_owned().await)
                } else {
                    None
                };
                let writer = if matches!(case.as_str(), "queue" | "database") {
                    Some(store.begin_immediate().unwrap())
                } else {
                    None
                };
                let (release, wait) = std::sync::mpsc::channel();
                let queue_worker = if case == "queue" {
                    let (started, ready) = tokio::sync::oneshot::channel();
                    let queue_host = host.clone();
                    let worker = tokio::spawn(crate::local::blocking::run(move || {
                        let _queue = queue_host.queue_persistence.lock().unwrap();
                        started.send(()).unwrap();
                        wait.recv_timeout(Duration::from_secs(10)).unwrap();
                    }));
                    ready.await.unwrap();
                    Some(worker)
                } else {
                    None
                };
                let stop_host = host.clone();
                let stop =
                    tokio::spawn(async move { stop_host.interrupt_by_user("session").await });
                tokio::time::timeout(Duration::from_secs(1), observed)
                    .await
                    .expect("running task must abort before storage is released")
                    .unwrap();
                assert!(matches!(
                    host.turns.lock().await.get("session"),
                    Some(TurnState::Cancelling)
                ));
                assert!(host.queue_cancellation_pending("session"));
                assert!(host.queue_storage_busy());
                assert!(!host.stop_admitting_if_idle().await);
                assert!(TurnGuard::claim(&host, "session", None).await.is_none());
                assert!(!stop.is_finished());
                if writer.is_some() {
                    assert_eq!(store.list_queued_chat_messages().unwrap().len(), 1);
                }
                if case == "overlap" {
                    // The first native turn is already fenced; a second Stop can
                    // finish its clear, but cannot release the first Stop's hold.
                    let second_host = host.clone();
                    tokio::time::timeout(Duration::from_secs(3), async move {
                        second_host.interrupt_by_user("session").await
                    })
                    .await
                    .unwrap()
                    .unwrap();
                    assert_eq!(host.queue_cancellation_held.lock().unwrap()["session"], 1);
                    assert!(host.queue_cancellation_pending("session"));
                    assert!(!stop.is_finished());
                }
                drop(writer);
                if let Some(worker) = queue_worker {
                    release.send(()).unwrap();
                    worker.await.unwrap().unwrap();
                }
                drop(cleanup);
                tokio::time::timeout(Duration::from_secs(5), stop)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(!host.is_busy("session").await);
                assert!(!host.queue_cancellation_pending("session"));
                assert!(host.queue_cancellation_held.lock().unwrap().is_empty());
                assert!(store.list_queued_chat_messages().unwrap().is_empty());
                assert!(host.queued_items("session").is_empty());
                assert!(!store.chat_turn_leased("session").unwrap());
                assert_eq!(
                    store
                        .get_chat_turn("session", "turn")
                        .unwrap()
                        .unwrap()
                        .state,
                    "interrupted"
                );
            });
        return;
    }
    for case in ["queue", "database", "cleanup", "overlap"] {
        let (dir, store, ctx) = checkpoint_fixture();
        super::checkpoint_tests::seed_stop_queue(&store, &ctx.host);
        assert!(store.claim_chat_turn("session", "stop-token").unwrap());
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

async fn await_live_lease(store: &Store, session: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !store.chat_turn_leased(session).unwrap() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

fn expire_lease(store: &Store, session: &str) {
    let tx = store.begin().unwrap();
    tx.execute(
        "UPDATE chat_turn_leases SET heartbeat_at = 0 WHERE chat_session_id = ?1",
        [session],
    )
    .unwrap();
    tx.commit().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn lease_heartbeat_database_contention_reports_error_then_recovers() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    assert!(store.claim_chat_turn("session", "token").unwrap());
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "token".into());
    expire_lease(&store, "session");
    let opened = Store::open_at(dir.clone()).unwrap();
    let writer = store.begin_immediate().unwrap();
    let result = host
        .renew_turn_leases_with_store(host.pause_turn_heartbeats().await, move || Ok(opened))
        .await;
    assert!(
        result.is_err(),
        "a busy database is an error, not ownership loss"
    );
    assert_eq!(
        host.durable_turns
            .lock()
            .unwrap()
            .get("session")
            .map(String::as_str),
        Some("token")
    );
    assert!(host.turn_lease_gate.clone().try_lock_owned().is_ok());
    drop(writer);
    let root = dir.clone();
    let (guard, lost) = host
        .renew_turn_leases_with_store(host.pause_turn_heartbeats().await, move || {
            Store::open_at(root)
        })
        .await
        .unwrap();
    assert!(lost.is_empty());
    assert!(store.chat_turn_leased("session").unwrap());
    assert!(!store.claim_chat_turn("session", "competitor").unwrap());
    drop(guard);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn lease_heartbeat_continues_during_slow_scan_and_waiting_migration() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    assert!(store.claim_chat_turn("session", "token").unwrap());
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "token".into());
    let scan_gate = Arc::new(Mutex::new(()));
    let guard = Arc::new(scan_gate.clone().lock_owned().await);
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let scanned = Store::open_at(dir.clone()).unwrap();
    let scan = tokio::spawn(spawn_store_stage(scanned, Some(guard), move |_| {
        started.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(10)).unwrap();
        Ok(())
    }));
    ready.await.unwrap();
    let moving_gate = scan_gate.clone();
    let moving_host = host.clone();
    let migration = tokio::spawn(async move {
        let scan = moving_gate.lock_owned().await;
        let leases = moving_host.pause_turn_heartbeats().await;
        (scan, leases)
    });
    let root = dir.clone();
    let heartbeat = tokio::spawn(
        host.clone()
            .watch_turn_leases_with_store(Duration::from_millis(5), move || {
                Store::open_at(root.clone())
            }),
    );
    for _ in 0..2 {
        expire_lease(&store, "session");
        await_live_lease(&store, "session").await;
        assert!(!store.claim_chat_turn("session", "competitor").unwrap());
        assert!(!migration.is_finished());
    }
    release.send(()).unwrap();
    drop(scan.await.unwrap().unwrap());
    let guards = migration.await.unwrap();
    heartbeat.abort();
    assert!(heartbeat.await.unwrap_err().is_cancelled());
    drop(guards);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn lease_heartbeat_migration_pauses_storage_and_cancelled_worker_keeps_gate() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    assert!(store.claim_chat_turn("session", "token").unwrap());
    host.durable_turns
        .lock()
        .unwrap()
        .insert("session".into(), "token".into());
    let migration = host.pause_turn_heartbeats().await;
    let (started, ready) = tokio::sync::oneshot::channel();
    let started = Arc::new(std::sync::Mutex::new(Some(started)));
    let (release, wait) = std::sync::mpsc::channel();
    let wait = Arc::new(std::sync::Mutex::new(wait));
    let root = dir.clone();
    let heartbeat = tokio::spawn(host.clone().watch_turn_leases_with_store(
        Duration::from_millis(5),
        move || {
            if let Some(started) = started.lock().unwrap().take() {
                started.send(()).unwrap();
                wait.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
            }
            Store::open_at(root.clone())
        },
    ));
    let mut ready = ready;
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut ready)
        .await
        .is_err());
    drop(migration);
    ready.await.unwrap();
    heartbeat.abort();
    assert!(heartbeat.await.unwrap_err().is_cancelled());
    assert!(host.turn_lease_gate.clone().try_lock_owned().is_err());
    release.send(()).unwrap();
    let done = tokio::time::timeout(Duration::from_secs(3), host.pause_turn_heartbeats())
        .await
        .unwrap();
    assert!(store.chat_turn_leased("session").unwrap());
    drop(done);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn lease_heartbeat_slow_ownership_loss_cleanup_does_not_delay_live_sessions() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut other = store.get_chat_session("session").unwrap().unwrap();
    other.id = "other".into();
    store.create_chat_session(&other).unwrap();
    assert!(store.claim_chat_turn("session", "new-owner").unwrap());
    assert!(store.claim_chat_turn("other", "live-token").unwrap());
    host.durable_turns.lock().unwrap().extend([
        ("session".into(), "old-owner".into()),
        ("other".into(), "live-token".into()),
    ]);
    let cleanup = host.cleanup_lock("session").lock_owned().await;
    let root = dir.clone();
    let heartbeat = tokio::spawn(
        host.clone()
            .watch_turn_leases_with_store(Duration::from_millis(5), move || {
                Store::open_at(root.clone())
            }),
    );
    for _ in 0..2 {
        expire_lease(&store, "other");
        await_live_lease(&store, "other").await;
        assert!(store.renew_chat_turn("session", "new-owner").unwrap());
        assert!(!store.claim_chat_turn("other", "competitor").unwrap());
    }
    heartbeat.abort();
    assert!(heartbeat.await.unwrap_err().is_cancelled());
    host.durable_turns.lock().unwrap().clear();
    drop(cleanup);
    // Let the token-scoped cancellation finish without touching global data.
    let done = host.cleanup_lock("session").lock_owned().await;
    drop(done);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn spawn_storage_stage_keeps_scheduler_available_and_gate_owned_after_cancel() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let gate = Arc::new(Mutex::new(()));
    let owned = Arc::new(gate.clone().lock_owned().await);
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let stage = tokio::spawn(spawn_store_stage(store, Some(owned), move |s| {
        started.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        s.set_chat_session_title("session", "persisted after cancel", "user")
    }));
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert!(host.busy_sessions().await.is_empty());
    assert!(gate.try_lock().is_err());
    stage.abort();
    assert!(matches!(stage.await, Err(error) if error.is_cancelled()));
    assert!(gate.try_lock().is_err());
    release.send(()).unwrap();
    let _done = tokio::time::timeout(Duration::from_secs(3), gate.lock())
        .await
        .unwrap();
    assert_eq!(
        Store::open_at(dir.clone())
            .unwrap()
            .get_chat_session("session")
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("persisted after cancel")
    );
    drop(ctx);
    drop(host);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_dispatch_does_not_block_scheduler_on_persistence_mutex() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let dispatch = {
        let _mutation = host.queue_persistence.lock().unwrap();
        QueueDispatchGuard::begin_locked(host.clone(), "session", "item")
    };
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker_host = host.clone();
    let worker = tokio::spawn(crate::local::blocking::run(move || {
        let _mutation = worker_host.queue_persistence.lock().unwrap();
        started.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
    }));
    ready.await.unwrap();
    drop(dispatch);
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert!(!host.is_busy("other").await);
    assert!(host
        .queue_dispatch_in_flight
        .lock()
        .unwrap()
        .contains_key("session"));
    release.send(()).unwrap();
    worker.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while host
            .queue_dispatch_in_flight
            .lock()
            .unwrap()
            .contains_key("session")
        {
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

#[tokio::test(flavor = "current_thread")]
async fn stop_winning_before_busy_storage_prevents_late_requeue() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    super::checkpoint_tests::seed_stop_queue(&store, &host);
    let mut item = host.queued.lock().unwrap()["session"][0].clone();
    item.id = "late-item".into();
    item.client_turn_id = "late-client".into();
    let cleanup = host.cleanup_lock("session").lock_owned().await;
    let submission = host.submission_lock("session").lock_owned().await;
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
                item,
                turns,
                Some((cleanup, Some(submission))),
                move || {
                    started.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                    Ok(())
                },
            )
            .await
    });
    ready.await.unwrap();
    let stop_host = host.clone();
    let root = dir.clone();
    crate::local::blocking::run(move || {
        stop_host.clear_queue_inner_with_store("session", true, || Store::open_at(root))
    })
    .await
    .unwrap()
    .unwrap();
    assert!(host.cleanup_lock("session").try_lock_owned().is_err());
    assert!(!host.interrupt("other").await.unwrap());
    release.send(()).unwrap();
    assert!(worker.await.unwrap().is_err());
    assert!(store.list_queued_chat_messages().unwrap().is_empty());
    assert!(host.queued_items("session").is_empty());
    host.release_queue_cancellation_if_idle("session");
    host.turns.lock().await.remove("session");
    drop(ctx);
    drop(host);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
