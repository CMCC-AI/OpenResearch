use super::steering_tests::{test_host, test_store};
use super::*;

fn request(text: &str) -> SteerMessage {
    let overrides = TurnOverrides {
        model: Some("original-model".into()),
        ..Default::default()
    };
    let hash = turn_request_hash(
        &[AnnotatedText {
            text: text.into(),
            annotations: Vec::new(),
        }],
        &TranscriptDisplay {
            text: None,
            annotations: None,
            record_user_message: true,
        },
        &overrides,
        &TurnAttachments::Uploaded(Vec::new()),
    )
    .unwrap();
    SteerMessage {
        text: format!("expanded {text}"),
        display: text.into(),
        submission: Some(Box::new(QueuedMessage {
            id: new_queued_id(),
            client_turn_id: "original-client".into(),
            request_hash: hash,
            text: text.into(),
            transcript_text: None,
            overrides,
            images: Vec::new(),
            annotations: Vec::new(),
            dispatch_attempts: 0,
            dispatch_error: None,
            next_retry_at: None,
        })),
    }
}

#[tokio::test]
async fn native_retry_and_reopened_host_never_send_a_second_instruction() {
    let host = test_host();
    let (store, root) = test_store("receipts");
    let (tx, mut rx) = mpsc::unbounded_channel();
    assert!(host
        .admit_steer_with_store("owner", request("first"), tx.clone(), &store)
        .unwrap()
        .is_none());
    assert_eq!(rx.recv().await.unwrap().text, "expanded first");
    let retry = host
        .admit_steer_with_store("owner", request("first"), tx.clone(), &store)
        .unwrap()
        .unwrap();
    assert!(retry.existing && retry.steered && !retry.queued);
    assert!(rx.try_recv().is_err());
    assert!(is_client_turn_conflict(
        &host
            .admit_steer_with_store("owner", request("different"), tx.clone(), &store)
            .unwrap_err()
    ));
    drop(host);
    drop(store);
    let host = test_host();
    let store = Store::open_at(root.clone()).unwrap();
    assert!(
        host.admit_steer_with_store("owner", request("first"), tx, &store)
            .unwrap()
            .unwrap()
            .existing
    );
    assert!(rx.try_recv().is_err());
    drop(host);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn closed_native_sink_parks_original_identity_settings_and_hash_once() {
    let host = test_host();
    let (store, root) = test_store("closed-receipt");
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    let hash = request("first").submission.unwrap().request_hash;
    let result = host
        .admit_steer_with_store("owner", request("first"), tx.clone(), &store)
        .unwrap()
        .unwrap();
    assert_eq!(result.turn_id, "original-client");
    assert!(result.queued);
    let payload = store.list_queued_chat_messages().unwrap().pop().unwrap();
    assert_eq!(payload.client_turn_id, "original-client");
    assert_eq!(payload.request_hash, hash);
    let queued: QueuedMessage = serde_json::from_str(&payload.payload_json).unwrap();
    assert_eq!(queued.text, "first");
    assert_eq!(queued.overrides.model.as_deref(), Some("original-model"));
    assert!(
        host.admit_steer_with_store("owner", request("first"), tx, &store)
            .unwrap()
            .unwrap()
            .existing
    );
    assert_eq!(host.queued_items("owner").len(), 1);
    let reopen = root.clone();
    host.clear_queue_inner_with_store("owner", false, move || Store::open_at(reopen))
        .unwrap();
    // The registry outlives a deliberately cleared queue.
    assert_eq!(
        store
            .chat_submission("owner", "original-client")
            .unwrap()
            .unwrap()
            .kind,
        "steer"
    );
    drop(host);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn cancelling_http_waiter_cannot_abandon_an_admitting_native_handoff() {
    let host = test_host();
    let (store, root) = test_store("cancelled-waiter");
    let other = Store::open_at(root.clone()).unwrap();
    let write = store.begin_immediate().unwrap();
    let lock = host.submission_lock("owner");
    let guard = lock.clone().lock_owned().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let worker = host.clone();
    let waiter = tokio::spawn(async move {
        crate::local::blocking::run(move || {
            let _guard = guard;
            started.send(()).unwrap();
            worker.admit_steer_with_store("owner", request("first"), tx, &other)
        })
        .await
        .unwrap()
    });
    ready.await.unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    assert!(
        lock.try_lock().is_err(),
        "the worker must retain submission ownership"
    );
    write.commit().unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap()
            .display,
        "first"
    );
    // Wait for the worker to release its Store before cleaning the fixture.
    let _settled = lock.lock().await;
    assert_eq!(
        store
            .chat_submission("owner", "original-client")
            .unwrap()
            .unwrap()
            .kind,
        "steer"
    );
    drop(host);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_handoff_checkpoints_one_stable_transcript_part_and_receipt() {
    for confirmed in [false, true] {
        let (root, store, mut ctx) = super::checkpoint_tests::checkpoint_fixture();
        let message = request("first");
        let queued = message.submission.as_ref().unwrap();
        store
            .admit_chat_steer(&StoredQueuedChatMessage {
                id: queued.id.clone(),
                session_id: ctx.session_id.clone(),
                client_turn_id: queued.client_turn_id.clone(),
                request_hash: queued.request_hash.clone(),
                payload_json: serde_json::to_string(queued).unwrap(),
                created_at: 1,
            })
            .unwrap();
        for _ in 0..2 {
            let open_root = root.clone();
            ctx.record_steer_with_store(&message, confirmed, move || Store::open_at(open_root))
                .await;
        }
        let parts: Vec<WirePart> = serde_json::from_str(
            &store
                .get_chat_message(&ctx.assistant.id)
                .unwrap()
                .unwrap()
                .parts_json,
        )
        .unwrap();
        assert_eq!(
            parts
                .iter()
                .filter(|p| p.id == "steer-original-client")
                .count(),
            1
        );
        assert_eq!(
            store
                .chat_submission(&ctx.session_id, "original-client")
                .unwrap()
                .unwrap()
                .kind,
            "steer"
        );
        let stored = StoredQueuedChatMessage {
            id: queued.id.clone(),
            session_id: ctx.session_id.clone(),
            client_turn_id: queued.client_turn_id.clone(),
            request_hash: queued.request_hash.clone(),
            payload_json: serde_json::to_string(queued).unwrap(),
            created_at: 1,
        };
        assert!(
            !store.park_chat_steer(&stored).unwrap(),
            "a handoff, confirmed or uncertain, must not be replayed"
        );
        drop(ctx);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
