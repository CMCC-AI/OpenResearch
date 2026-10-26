use super::checkpoint_tests::{checkpoint_fixture, seed_stop_queue};
use super::*;

fn popped_fixture(store: &Store, host: &Arc<ChatHost>) -> (QueuedMessage, QueueDispatchGuard) {
    // The shared fixture constructs a host that may restore the default
    // queue. Keep only synthetic items before exercising background resume.
    host.queued.lock().unwrap().clear();
    seed_stop_queue(store, host);
    let item = host
        .queued
        .lock()
        .unwrap()
        .remove("session")
        .unwrap()
        .pop_front()
        .unwrap();
    host.queue_dispatch_suppressed
        .lock()
        .unwrap()
        .insert("session".into());
    let dispatch = QueueDispatchGuard::begin_locked(host.clone(), "session", &item.id);
    (item, dispatch)
}

#[tokio::test(flavor = "current_thread")]
async fn success_settlement_survives_cancelled_waiter_and_slow_storage() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let (item, dispatch) = popped_fixture(&store, &host);
    assert!(host.queue_storage_busy());
    assert!(
        !host.stop_admitting_if_idle().await,
        "in-flight settlement is not idle"
    );
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        let mut started = Some(started);
        worker_host
            .settle_queue_dispatch_with_store(
                "session",
                item,
                dispatch,
                Ok(TurnSubmission::Existing("turn".into())),
                move || {
                    if let Some(started) = started.take() {
                        let _ = started.send(());
                        wait.recv_timeout(Duration::from_secs(3)).unwrap();
                    }
                    Store::open_at(root.clone())
                },
            )
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert!(host.busy_sessions().await.is_empty());
    assert!(host.queue_storage_busy());
    assert!(
        !host.stop_admitting_if_idle().await,
        "running SQLite settlement is not idle"
    );
    assert!(!host.restarting.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(store.list_queued_chat_messages().unwrap().len(), 1);
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !store.list_queued_chat_messages().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert!(host.queued_items("session").is_empty());
    assert!(host.queue_dispatch_in_flight.lock().unwrap().is_empty());
    assert!(!host
        .queue_dispatch_suppressed
        .lock()
        .unwrap()
        .contains("session"));
    tokio::time::timeout(Duration::from_secs(3), async {
        while !host.stop_admitting_if_idle().await {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert!(!host.queue_storage_busy());
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn not_started_settlement_restores_persisted_item_or_defers_failed_refresh() {
    for fail_open in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let (item, dispatch) = popped_fixture(&store, &host);
        // A synthetic owner prevents the restored item's ordinary background
        // drain from opening the user's default Store in this isolated test.
        host.turns.lock().await.insert(
            "session".into(),
            TurnState::Reserved {
                turn_id: None,
                reservation_id: "test-owner".into(),
            },
        );
        let item_id = item.id.clone();
        let root = dir.clone();
        host.settle_queue_dispatch_with_store(
            "session",
            item,
            dispatch,
            Ok(TurnSubmission::NotStarted),
            move || {
                if fail_open {
                    Err(anyhow!("injected refresh failure"))
                } else {
                    Store::open_at(root.clone())
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(store.list_queued_chat_messages().unwrap().len(), 1);
        let queued = host.queued_items("session");
        assert_eq!(queued.len(), usize::from(!fail_open));
        if !fail_open {
            assert_eq!(queued[0]["id"], item_id);
        }
        assert!(host.queue_dispatch_in_flight.lock().unwrap().is_empty());
        assert!(!host
            .queue_dispatch_suppressed
            .lock()
            .unwrap()
            .contains("session"));
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn failed_settlement_preserves_retry_payload_and_best_effort_storage_boundary() {
    for mode in ["saved", "open-error", "sql-error"] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let (mut item, dispatch) = popped_fixture(&store, &host);
        item.dispatch_attempts = crate::local::harness::ORX_MAX_RETRIES;
        let old_attempts = item.dispatch_attempts;
        let client_id = item.client_turn_id.clone();
        let root = dir.clone();
        host.settle_queue_dispatch_with_store(
            "session",
            item,
            dispatch,
            Err(anyhow!("injected dispatch failure")),
            move || {
                if mode == "open-error" {
                    return Err(anyhow!("injected open failure"));
                }
                let opened = Store::open_at(root.clone())?;
                if mode == "sql-error" {
                    let tx = opened.begin()?;
                    tx.execute_batch("CREATE TEMP TABLE chat_queued_messages(invalid INTEGER)")?;
                    tx.commit()?;
                }
                Ok(opened)
            },
        )
        .await
        .unwrap();
        let queued = host.queued.lock().unwrap();
        let retried = &queued["session"][0];
        assert_eq!(retried.dispatch_attempts, old_attempts + 1);
        assert_eq!(retried.client_turn_id, client_id);
        assert_eq!(
            retried.dispatch_error.as_deref(),
            Some("injected dispatch failure")
        );
        assert!(queued_delivery_exhausted(retried));
        let rows = store.list_queued_chat_messages().unwrap();
        assert_eq!(rows.len(), 1);
        let saved: QueuedMessage = serde_json::from_str(&rows[0].payload_json).unwrap();
        assert_eq!(
            saved.dispatch_attempts,
            if mode == "saved" { old_attempts + 1 } else { 0 }
        );
        assert!(host.queue_dispatch_in_flight.lock().unwrap().is_empty());
        assert!(host
            .queue_dispatch_suppressed
            .lock()
            .unwrap()
            .contains("session"));
        drop(queued);
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn cancelled_or_deleted_dispatch_never_requeues_or_reopens_storage() {
    for deleting in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let (item, dispatch) = popped_fixture(&store, &host);
        if deleting {
            host.deleting_sessions
                .lock()
                .unwrap()
                .insert("session".into());
            store
                .delete_queued_chat_messages_for_session("session")
                .unwrap();
        } else {
            host.clear_queue_inner_with_store("session", true, || Store::open_at(dir.clone()))
                .unwrap();
        }
        host.settle_queue_dispatch_with_store(
            "session",
            item,
            dispatch,
            Err(anyhow!("late dispatch failure")),
            || panic!("cancelled dispatch must not open storage"),
        )
        .await
        .unwrap();
        assert!(host.queued_items("session").is_empty());
        assert!(store.list_queued_chat_messages().unwrap().is_empty());
        assert!(host.queue_dispatch_in_flight.lock().unwrap().is_empty());
        if !deleting {
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
        }
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn failed_settlement_keeps_global_suppression_map_readable_during_sql_setup() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let (mut item, dispatch) = popped_fixture(&store, &host);
    item.dispatch_attempts = crate::local::harness::ORX_MAX_RETRIES;
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let mut started = Some(started);
    let settlement = host.settle_queue_dispatch_with_store(
        "session",
        item,
        dispatch,
        Err(anyhow!("injected dispatch failure")),
        move || {
            if let Some(started) = started.take() {
                let _ = started.send(());
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
            }
            Store::open_at(root.clone())
        },
    );
    let observer = async {
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        {
            let suppressed = host
                .queue_dispatch_suppressed
                .try_lock()
                .expect("global suppression map must not span SQLite");
            assert!(suppressed.contains("session"));
        }
        assert!(host.busy_sessions().await.is_empty());
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(settlement, observer);
    result.unwrap();
    assert!(host
        .queue_dispatch_suppressed
        .lock()
        .unwrap()
        .contains("session"));
    assert_eq!(host.queued_items("session").len(), 1);
    drop(host);
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
