use super::checkpoint_tests::{checkpoint_fixture, seed_stop_queue};
use super::*;

fn seed(store: &Store, host: &Arc<ChatHost>) -> QueuedMessage {
    host.queued.lock().unwrap().clear();
    seed_stop_queue(store, host);
    host.queued.lock().unwrap()["session"][0].clone()
}

async fn wait_worker(host: &Arc<ChatHost>, idle_refs: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while Arc::strong_count(host) > idle_refs {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn busy_enqueue_sql_wait_keeps_queue_readers_available_after_waiter_cancel() {
    for reject in [false, true] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let mut item = seed(&store, &host);
        item.id = "new-item".into();
        item.client_turn_id = "new-client".into();
        let idle_refs = Arc::strong_count(&host);
        let mut events = host.subscribe();
        let mut turns = host.turns.clone().lock_owned().await;
        turns.insert("session".into(), TurnState::Draining);
        let opened = Store::open_at(dir.clone()).unwrap();
        if reject {
            let tx = opened.begin().unwrap();
            tx.execute_batch("CREATE TEMP TRIGGER reject_queue BEFORE INSERT ON main.chat_queued_messages BEGIN SELECT RAISE(FAIL, 'injected enqueue failure'); END;").unwrap();
            tx.commit().unwrap();
        }
        let tx = store.begin().unwrap();
        tx.execute(
            "UPDATE chat_sessions SET title=title WHERE id='session'",
            [],
        )
        .unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let worker_host = host.clone();
        let worker = tokio::spawn(async move {
            worker_host
                .persist_busy_submission("session".into(), opened, item, turns, None, move || {
                    let _ = started.send(());
                    Ok(())
                })
                .await
        });
        ready.await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(host.queue_persistence.try_lock().is_err());
        assert!(
            host.turns.try_lock().is_ok(),
            "other sessions do not wait for SQL"
        );
        assert!(!host.is_busy("other").await);
        assert!(!host.interrupt("other").await.unwrap());
        assert!(host.plan_changes.session("other").try_lock_owned().is_ok());
        assert!(host
            .permission_changes
            .session("other")
            .try_lock_owned()
            .is_ok());
        assert!(
            host.queued.try_lock().is_ok(),
            "queue readers must not span SQLite"
        );
        assert_eq!(host.queued_items("session").len(), 1);
        assert!(host.queued_items("other").is_empty());
        assert!(events.try_recv().is_err());
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        tx.commit().unwrap();
        wait_worker(&host, idle_refs).await;
        let count = 1 + usize::from(!reject);
        assert_eq!(host.queued_items("session").len(), count);
        assert_eq!(
            store
                .list_queued_chat_messages_for_session("session")
                .unwrap()
                .len(),
            count
        );
        if reject {
            assert!(host
                .plan_changes
                .session("session")
                .lock_owned()
                .await
                .is_empty());
            assert!(host
                .permission_changes
                .session("session")
                .lock_owned()
                .await
                .is_empty());
            assert!(events.try_recv().is_err());
        } else {
            assert_eq!(events.try_recv().unwrap().0, "chat.queued");
            assert_eq!(events.try_recv().unwrap().0, "chat.session");
        }
        drop(host);
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_and_retry_sql_wait_keep_last_committed_queue_readable() {
    for retry in [false, true] {
        for reject in [false, true] {
            let (dir, store, ctx) = checkpoint_fixture();
            let host = ctx.host.clone();
            let mut item = seed(&store, &host);
            item.dispatch_attempts = crate::local::harness::ORX_MAX_RETRIES + 1;
            item.dispatch_error = Some("exhausted".into());
            store
                .update_queued_chat_message(&item.id, &serde_json::to_string(&item).unwrap())
                .unwrap();
            host.queued.lock().unwrap().get_mut("session").unwrap()[0] = item.clone();
            host.queue_dispatch_suppressed
                .lock()
                .unwrap()
                .insert("session".into());
            host.turns.lock().await.insert(
                "session".into(),
                TurnState::Reserved {
                    turn_id: None,
                    reservation_id: "test-owner".into(),
                },
            );
            let idle_refs = Arc::strong_count(&host);
            let mut events = host.subscribe();
            let opened = Store::open_at(dir.clone()).unwrap();
            if reject {
                let tx = opened.begin().unwrap();
                tx.execute_batch(if retry {
                    "CREATE TEMP TRIGGER reject_queue BEFORE UPDATE ON main.chat_queued_messages BEGIN SELECT RAISE(FAIL, 'injected retry failure'); END;"
                } else {
                    "CREATE TEMP TRIGGER reject_queue BEFORE DELETE ON main.chat_queued_messages BEGIN SELECT RAISE(FAIL, 'injected cancel failure'); END;"
                }).unwrap();
                tx.commit().unwrap();
            }
            let tx = store.begin().unwrap();
            tx.execute(
                "UPDATE chat_sessions SET title=title WHERE id='session'",
                [],
            )
            .unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let worker_host = host.clone();
            let item_id = item.id.clone();
            let worker = tokio::spawn(crate::local::blocking::run(move || {
                let open = move || {
                    let _ = started.send(());
                    Ok(opened)
                };
                if retry {
                    worker_host.retry_queued_with_store("session", &item_id, open)
                } else {
                    worker_host.cancel_queued_with_store("session", &item_id, open)
                }
            }));
            ready.await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(host.queue_persistence.try_lock().is_err());
            assert!(host.queued.try_lock().is_ok());
            assert_eq!(host.queued_items("session").len(), 1);
            assert_eq!(host.queued_count(), 1);
            assert!(host.queued_items("other").is_empty());
            assert!(events.try_recv().is_err());
            worker.abort();
            assert!(worker.await.unwrap_err().is_cancelled());
            tx.commit().unwrap();
            wait_worker(&host, idle_refs).await;
            let rows = store
                .list_queued_chat_messages_for_session("session")
                .unwrap();
            let queued = host.queued.lock().unwrap();
            if reject {
                assert_eq!(queued["session"][0].dispatch_error, item.dispatch_error);
                assert_eq!(rows[0].payload_json, serde_json::to_string(&item).unwrap());
                assert!(host
                    .queue_dispatch_suppressed
                    .lock()
                    .unwrap()
                    .contains("session"));
                assert!(events.try_recv().is_err());
            } else if retry {
                let head = &queued["session"][0];
                assert_eq!(head.id, item.id);
                assert_eq!(head.client_turn_id, item.client_turn_id);
                assert_eq!(head.dispatch_attempts, 0);
                assert!(head.dispatch_error.is_none());
                assert_eq!(rows[0].payload_json, serde_json::to_string(head).unwrap());
                assert!(!host
                    .queue_dispatch_suppressed
                    .lock()
                    .unwrap()
                    .contains("session"));
                assert_eq!(events.try_recv().unwrap().0, "chat.queued");
            } else {
                assert!(!queued.contains_key("session"));
                assert!(rows.is_empty());
                assert!(!host
                    .queue_dispatch_suppressed
                    .lock()
                    .unwrap()
                    .contains("session"));
                assert_eq!(events.try_recv().unwrap().0, "chat.queued");
            }
            drop(queued);
            drop(host);
            drop(ctx);
            drop(store);
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}

#[tokio::test]
async fn queue_operations_preserve_head_and_blocked_retry_rules() {
    let (dir, store, ctx) = checkpoint_fixture();
    let host = ctx.host.clone();
    let mut item = seed(&store, &host);
    assert!(!host
        .retry_queued_with_store("session", &item.id, || Store::open_at(dir.clone()))
        .unwrap());
    assert!(!host
        .cancel_queued_with_store("session", "missing", || Store::open_at(dir.clone()))
        .unwrap());
    item.id = "second".into();
    item.client_turn_id = "second-client".into();
    item.dispatch_error = Some("exhausted".into());
    store
        .insert_queued_chat_message(&StoredQueuedChatMessage {
            id: item.id.clone(),
            session_id: "session".into(),
            client_turn_id: item.client_turn_id.clone(),
            request_hash: item.request_hash.clone(),
            payload_json: serde_json::to_string(&item).unwrap(),
            created_at: 4,
        })
        .unwrap();
    host.queued
        .lock()
        .unwrap()
        .get_mut("session")
        .unwrap()
        .push_back(item.clone());
    assert!(!host
        .retry_queued_with_store("session", &item.id, || Store::open_at(dir.clone()))
        .unwrap());
    for cancelled in [false, true] {
        if cancelled {
            host.queue_dispatch_cancelled
                .lock()
                .unwrap()
                .insert("session".into());
        } else {
            host.queue_dispatch_in_flight
                .lock()
                .unwrap()
                .insert("session".into(), "head".into());
        }
        assert!(!host
            .retry_queued_with_store("session", &item.id, || panic!(
                "blocked retry must not open storage"
            ))
            .unwrap());
        host.queue_dispatch_cancelled.lock().unwrap().clear();
        host.queue_dispatch_in_flight.lock().unwrap().clear();
    }
    assert_eq!(host.queued_count(), 2);
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
