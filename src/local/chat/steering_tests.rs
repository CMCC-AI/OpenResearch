use super::*;

pub(super) fn test_host() -> Arc<ChatHost> {
    Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ))
}

pub(super) fn test_store(tag: &str) -> (Store, PathBuf) {
    let dir = std::env::temp_dir().join(format!("orx-steer-{tag}-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&StoredChatSession {
            id: "owner".into(),
            project_id: "p1".into(),
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
        })
        .unwrap();
    (store, dir)
}

fn running_settings() -> TurnSettings {
    TurnSettings {
        model: Some("opus".into()),
        service_tier: Some("default".into()),
        permission_mode: Some("auto".into()),
        plan_mode: false,
        reasoning_level: None,
    }
}

fn steer(text: &str) -> SteerMessage {
    SteerMessage {
        submission: None,
        display: text.into(),
        text: text.into(),
    }
}

#[test]
fn the_settings_a_turn_is_running_under_are_accepted() {
    // What the composer sends every time: the turn's own settings.
    assert!(running_settings().accept(&TurnOverrides {
        model: Some("opus".into()),
        permission_mode: Some("auto".into()),
        plan_mode: Some(false),
        ..TurnOverrides::default()
    }));
    // An empty string is "unset", not a different model.
    assert!(running_settings().accept(&TurnOverrides {
        model: Some(String::new()),
        ..TurnOverrides::default()
    }));
}

#[test]
fn a_changed_composer_setting_routes_to_the_queue() {
    for changed in [
        TurnOverrides {
            clear_model: true,
            ..TurnOverrides::default()
        },
        TurnOverrides {
            model: Some("sonnet".into()),
            ..TurnOverrides::default()
        },
        TurnOverrides {
            service_tier: Some("priority".into()),
            ..TurnOverrides::default()
        },
        // The session row already says "plan" by the time this arrives —
        // only the running turn's own mode can catch it.
        TurnOverrides {
            permission_mode: Some("plan".into()),
            ..TurnOverrides::default()
        },
        TurnOverrides {
            plan_mode: Some(true),
            ..TurnOverrides::default()
        },
        // A turn that pinned no reasoning level is still a different
        // setting from one that pins it.
        TurnOverrides {
            reasoning_level: Some("high".into()),
            ..TurnOverrides::default()
        },
    ] {
        assert!(!running_settings().accept(&changed));
    }
}

#[tokio::test]
async fn an_undeliverable_steer_becomes_a_queued_chip() {
    let host = test_host();
    let (store, dir) = test_store("queued");

    host.park_steer_with_store("owner", steer("/plan the migration"), &store)
        .unwrap();

    let queued = host.queued_items("owner");
    assert_eq!(queued.len(), 1);
    // The chip shows what the user typed, and the queue path re-expands it.
    assert_eq!(queued[0]["text"], "/plan the migration");
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_dead_turns_route_never_detaches_its_successors() {
    let host = test_host();
    let (first_tx, _first_rx) = mpsc::unbounded_channel();
    let first = host.register_steering("owner", first_tx, TurnSettings::default());
    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let _second = host.register_steering("owner", second_tx, TurnSettings::default());

    // The aborted turn's guard drops after its successor registered.
    drop(first);

    let sink = host
        .steering
        .lock()
        .unwrap()
        .get("owner")
        .map(|sink| sink.tx.clone());
    sink.expect("successor sink survives")
        .send(steer("keep going"))
        .unwrap();
    assert_eq!(second_rx.recv().await.unwrap().display, "keep going");
}

#[tokio::test]
async fn a_turn_without_a_steering_sink_waits_forever() {
    // The `select!` arm must never fire on harnesses that can't steer.
    let mut none = None;
    assert!(tokio::time::timeout(
        Duration::from_millis(20),
        crate::local::harness::next_steer(&mut none),
    )
    .await
    .is_err());
}

#[test]
fn queue_dispatch_and_stop_release_only_their_own_cancellation_state() {
    let host = test_host();
    host.queue_cancellation_held
        .lock()
        .unwrap()
        .insert("owner".into(), 1);
    host.queue_dispatch_cancelled
        .lock()
        .unwrap()
        .insert("owner".into());
    let mut dispatch = QueueDispatchGuard::begin_locked(host.clone(), "owner", "q1");

    dispatch.finish_locked(true);
    assert!(host
        .queue_dispatch_cancelled
        .lock()
        .unwrap()
        .contains("owner"));
    host.release_queue_cancellation_if_idle("owner");
    assert!(!host
        .queue_dispatch_cancelled
        .lock()
        .unwrap()
        .contains("owner"));

    host.queue_cancellation_held
        .lock()
        .unwrap()
        .insert("owner".into(), 1);
    host.queue_dispatch_cancelled
        .lock()
        .unwrap()
        .insert("owner".into());
    let mut dispatch = QueueDispatchGuard::begin_locked(host.clone(), "owner", "q2");
    host.release_queue_cancellation_if_idle("owner");
    assert!(host
        .queue_dispatch_cancelled
        .lock()
        .unwrap()
        .contains("owner"));
    dispatch.finish_locked(true);
    assert!(!host
        .queue_dispatch_cancelled
        .lock()
        .unwrap()
        .contains("owner"));
}

#[tokio::test]
async fn a_steer_survives_the_event_arm_winning_the_select() {
    // Cancel-safety is what lets the harness loops park a steer beside
    // their own event wait; without it this message would be swallowed.
    let (tx, rx) = mpsc::unbounded_channel();
    let mut steering = Some(rx);
    tx.send(steer("go")).unwrap();
    tokio::select! {
        biased;
        () = std::future::ready(()) => {}
        _ = crate::local::harness::next_steer(&mut steering) => unreachable!(),
    }
    assert_eq!(
        crate::local::harness::next_steer(&mut steering)
            .await
            .display,
        "go"
    );
}

#[tokio::test]
async fn a_closed_sink_sends_the_message_back_to_the_queue() {
    // What the turn epilogue does: detach, close, park the remainder.
    let host = test_host();
    let (store, dir) = test_store("closed");
    let (tx, rx) = mpsc::unbounded_channel();
    let route = host.register_steering("owner", tx.clone(), TurnSettings::default());
    let mut steering = Some(rx);

    tx.send(steer("still here")).unwrap();
    drop(route);
    if let Some(mut rx) = steering.take() {
        rx.close();
        while let Some(message) = rx.recv().await {
            host.park_steer_with_store("owner", message, &store)
                .unwrap();
        }
    }

    assert!(host.steering.lock().unwrap().get("owner").is_none());
    assert!(tx.send(steer("too late")).is_err());
    assert_eq!(host.queued_items("owner")[0]["text"], "still here");
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}
