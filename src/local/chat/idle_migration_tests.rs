use super::checkpoint_tests::checkpoint_fixture;
use super::*;

async fn wait_idle(host: &ChatHost) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.is_busy("session").await {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn while_idle_worker_keeps_only_affected_sessions_fenced_after_waiter_cancel() {
    for phase in ["storage", "git"] {
        let (dir, store, ctx) = checkpoint_fixture();
        let host = ctx.host.clone();
        let mut events = host.subscribe();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let mut pause = Some(move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(30)).unwrap();
        });
        let open_pause = if phase == "storage" {
            pause.take()
        } else {
            None
        };
        let work_pause = pause;
        let root = dir.clone();
        let worker_host = host.clone();
        let task = tokio::spawn(async move {
            worker_host
                .while_idle_with_store(
                    &["session".into(), "session".into()],
                    move || {
                        if let Some(pause) = open_pause {
                            pause();
                        }
                        Store::open_at(root)
                    },
                    move || {
                        if let Some(pause) = work_pause {
                            pause();
                        }
                        Ok(17)
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(15), ready)
            .await
            .unwrap()
            .unwrap();
        assert!(host.is_busy("session").await);
        let (name, event) = events.try_recv().unwrap();
        assert_eq!(name, "chat.busy");
        assert_eq!(event, json!({"sessionId":"session","busy":true}));
        assert!(!host.is_busy("unrelated").await);
        assert!(!host.stop_admitting_if_idle().await);
        assert!(!host.interrupt("session").await.unwrap());
        let root = dir.clone();
        tokio::time::timeout(
            Duration::from_secs(5),
            host.interrupt_by_user_with_store(
                "session",
                move || Store::open_at(root),
                || Err(anyhow!("migration has no turn interruption marker")),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(host.is_busy("session").await);
        assert!(host
            .delete_session("session")
            .await
            .unwrap_err()
            .to_string()
            .contains("迁移"));
        assert!(TurnGuard::claim(&host, "session", None).await.is_none());
        let root = dir.clone();
        let turns = host.turns.clone().lock_owned().await;
        let (mut other, turns) = tokio::time::timeout(
            Duration::from_secs(5),
            TurnGuard::claim_locked_with_store(&host, "unrelated", turns, move || {
                Store::open_at(root)
            }),
        )
        .await
        .unwrap()
        .unwrap();
        drop(turns);
        other.release().await;
        // The single-thread runtime remains available while storage/Git waits.
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::time::sleep(Duration::from_millis(5)),
        )
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(host.is_busy("session").await);
        assert!(host.cleanup_lock("session").try_lock_owned().is_err());
        while let Ok((name, event)) = events.try_recv() {
            assert!(
                !(name == "chat.busy" && event["sessionId"] == "session" && event["busy"] == false)
            );
        }
        release.send(()).unwrap();
        wait_idle(&host).await;
        let (name, event) = events.try_recv().unwrap();
        assert_eq!(name, "chat.busy");
        assert_eq!(event, json!({"sessionId":"session","busy":false}));
        assert!(host.cleanup_lock("session").try_lock_owned().is_ok());
        drop(ctx);
        drop(host);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn while_idle_failures_release_reservations_and_do_not_treat_sql_errors_as_idle() {
    for failure in ["open", "foreign-lease", "sql", "work", "panic"] {
        let (dir, store, ctx) = checkpoint_fixture();
        if failure == "foreign-lease" {
            assert!(store.claim_chat_turn("session", "foreign").unwrap());
        }
        if failure == "sql" {
            let tx = store.begin().unwrap();
            tx.execute_batch("DROP TABLE chat_turn_leases").unwrap();
            tx.commit().unwrap();
        }
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let marked = ran.clone();
        let result = ctx
            .host
            .while_idle_with_store(
                &["session".into()],
                move || {
                    if failure == "open" {
                        return Err(anyhow!("injected open failure"));
                    }
                    Ok(store)
                },
                move || {
                    marked.store(true, std::sync::atomic::Ordering::SeqCst);
                    if failure == "panic" {
                        panic!("injected maintenance panic");
                    }
                    Err::<(), _>(anyhow!("injected maintenance failure"))
                },
            )
            .await;
        assert!(result.is_err(), "accepted {failure}");
        assert_eq!(
            ran.load(std::sync::atomic::Ordering::SeqCst),
            matches!(failure, "work" | "panic")
        );
        wait_idle(&ctx.host).await;
        assert!(ctx.host.cleanup_lock("session").try_lock_owned().is_ok());
        drop(ctx);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn while_idle_cleanup_can_wait_for_the_turn_map_without_blocking_worker_completion() {
    let (dir, store, ctx) = checkpoint_fixture();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let root = dir.clone();
    let host = ctx.host.clone();
    let task = tokio::spawn(async move {
        host.while_idle_with_store(
            &["session".into()],
            move || Store::open_at(root),
            move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(30)).unwrap();
                Ok(23)
            },
        )
        .await
    });
    ready.await.unwrap();
    let turns = ctx.host.turns.lock().await;
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        23
    );
    assert!(turns.contains_key("session"));
    assert!(ctx.host.cleanup_lock("session").try_lock_owned().is_err());
    drop(turns);
    wait_idle(&ctx.host).await;
    assert!(ctx.host.cleanup_lock("session").try_lock_owned().is_ok());
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
