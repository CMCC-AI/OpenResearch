use super::steering::SteerAdmission;
use super::tests::{chat_session_fixture, chat_turn_fixture};
use super::*;

fn fixture() -> (PathBuf, Store, StoredQueuedChatMessage) {
    let root = std::env::temp_dir().join(format!("orx-steer-receipt-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(root.clone()).unwrap();
    store
        .create_chat_session(&chat_session_fixture("chat_1"))
        .unwrap();
    let message = StoredQueuedChatMessage {
        id: "steer-receipt".into(),
        session_id: "chat_1".into(),
        client_turn_id: "client".into(),
        request_hash: "request".into(),
        payload_json: "private body".into(),
        created_at: 1,
    };
    (root, store, message)
}

#[test]
fn steering_receipt_survives_reopen_and_isolates_payload_and_session() {
    let (root, store, message) = fixture();
    assert_eq!(
        store.admit_chat_steer(&message).unwrap(),
        SteerAdmission::Inserted
    );
    drop(store);
    let store = Store::open_at(root.clone()).unwrap();
    assert!(
        matches!(store.admit_chat_steer(&message).unwrap(), SteerAdmission::Existing(r) if r.kind == "steer")
    );
    let mut changed = message;
    changed.request_hash = "different".into();
    assert_eq!(
        store.admit_chat_steer(&changed).unwrap(),
        SteerAdmission::Conflict
    );
    assert!(store.chat_submission("chat_2", "client").unwrap().is_none());
    assert!(store.chat_submission("chat_1", "other").unwrap().is_none());
    store
        .create_chat_session(&chat_session_fixture("chat_2"))
        .unwrap();
    changed.session_id = "chat_2".into();
    changed.id = "other-receipt".into();
    assert_eq!(
        store.admit_chat_steer(&changed).unwrap(),
        SteerAdmission::Inserted
    );
    store.delete_chat_session("chat_1").unwrap();
    assert!(store.chat_submission("chat_1", "client").unwrap().is_none());
    assert!(store
        .admit_chat_steer(&StoredQueuedChatMessage {
            session_id: "missing".into(),
            ..changed
        })
        .is_err());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn steering_admission_serializes_with_turn_and_queue_in_both_directions() {
    for first in ["steer", "turn", "queued"] {
        let (root, store, message) = fixture();
        let mut turn = chat_turn_fixture("turn", "client");
        turn.request_hash = message.request_hash.clone();
        match first {
            "steer" => {
                assert_eq!(
                    store.admit_chat_steer(&message).unwrap(),
                    SteerAdmission::Inserted
                );
                assert_eq!(
                    store.admit_chat_turn(None, &turn).unwrap(),
                    ChatTurnAdmission::Steered(message.id.clone())
                );
                assert!(store.insert_queued_chat_message(&message).is_err());
                let changed = StoredQueuedChatMessage {
                    request_hash: "different".into(),
                    ..message.clone()
                };
                let conflict = store.insert_queued_chat_message(&changed).unwrap_err();
                assert!(crate::local::chat::is_client_turn_conflict(&conflict));
                assert!(store.get_chat_turn("chat_1", "turn").unwrap().is_none());
                turn.request_hash = "different".into();
                assert_eq!(
                    store.admit_chat_turn(None, &turn).unwrap(),
                    ChatTurnAdmission::Conflict
                );
            }
            "turn" => {
                store.admit_chat_turn(None, &turn).unwrap();
            }
            _ => {
                store.insert_queued_chat_message(&message).unwrap();
            }
        }
        assert!(
            matches!(store.admit_chat_steer(&message).unwrap(), SteerAdmission::Existing(r) if r.kind == first)
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn registered_fallback_promotes_once_and_cannot_reappear_after_stop() {
    for promote in [false, true] {
        let (root, store, message) = fixture();
        store.admit_chat_steer(&message).unwrap();
        assert!(store.park_chat_steer(&message).unwrap());
        assert!(!store.park_chat_steer(&message).unwrap());
        let mut turn = chat_turn_fixture("turn", "client");
        turn.request_hash = message.request_hash.clone();
        let mut wrong = turn.clone();
        wrong.request_hash = "different".into();
        assert_eq!(
            store.admit_chat_turn(None, &wrong).unwrap(),
            ChatTurnAdmission::Conflict
        );
        if promote {
            assert_eq!(
                store.admit_chat_turn(None, &turn).unwrap(),
                ChatTurnAdmission::Inserted
            );
        }
        store
            .delete_queued_chat_messages_for_session("chat_1")
            .unwrap();
        assert!(!store.park_chat_steer(&message).unwrap());
        assert!(matches!(
            store.admit_chat_steer(&message).unwrap(),
            SteerAdmission::Existing(_)
        ));
        if !promote {
            assert_eq!(
                store.admit_chat_turn(None, &turn).unwrap(),
                ChatTurnAdmission::Steered(message.id.clone())
            );
        }
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn uncertain_native_delivery_is_never_automatically_queued() {
    for confirmed in [false, true] {
        let (root, store, message) = fixture();
        store.admit_chat_steer(&message).unwrap();
        store
            .mark_chat_steer_handoff("chat_1", "client", confirmed)
            .unwrap();
        assert!(!store.park_chat_steer(&message).unwrap());
        assert!(store.list_queued_chat_messages().unwrap().is_empty());
        assert!(matches!(
            store.admit_chat_steer(&message).unwrap(),
            SteerAdmission::Existing(_)
        ));
        let state: String = store
            .conn
            .query_row("SELECT state FROM chat_steering_requests", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, if confirmed { "handed_off" } else { "uncertain" });
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn native_registration_and_ordinary_turn_race_across_connections() {
    let (root, store, message) = fixture();
    let other = Store::open_at(root.clone()).unwrap();
    let mut turn = chat_turn_fixture("turn", "client");
    turn.request_hash = message.request_hash.clone();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let ready = barrier.clone();
    let ordinary = std::thread::spawn(move || {
        ready.wait();
        other.admit_chat_turn(None, &turn).unwrap()
    });
    barrier.wait();
    let native = store.admit_chat_steer(&message).unwrap();
    match (native, ordinary.join().unwrap()) {
        (SteerAdmission::Inserted, ChatTurnAdmission::Steered(_)) => {}
        (SteerAdmission::Existing(r), ChatTurnAdmission::Inserted) => assert_eq!(r.kind, "turn"),
        result => panic!("both channels must share one admission: {result:?}"),
    }
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn parking_storage_failure_rolls_back_the_queue_and_receipt_together() {
    let (root, store, message) = fixture();
    store.admit_chat_steer(&message).unwrap();
    store.conn.execute_batch("CREATE TRIGGER reject_park BEFORE UPDATE ON chat_steering_requests BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(store.park_chat_steer(&message).is_err());
    assert!(store.list_queued_chat_messages().unwrap().is_empty());
    store
        .conn
        .execute_batch("DROP TRIGGER reject_park")
        .unwrap();
    assert!(store.park_chat_steer(&message).unwrap());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_registration_and_ordinary_queue_race_across_connections() {
    let (root, store, message) = fixture();
    let other = Store::open_at(root.clone()).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let ready = barrier.clone();
    let queued = StoredQueuedChatMessage {
        id: "ordinary-queue".into(),
        ..message.clone()
    };
    let ordinary = std::thread::spawn(move || {
        ready.wait();
        other.insert_queued_chat_message(&queued)
    });
    barrier.wait();
    let native = store.admit_chat_steer(&message).unwrap();
    match (native, ordinary.join().unwrap()) {
        (SteerAdmission::Inserted, Err(_)) => {
            assert!(store.list_queued_chat_messages().unwrap().is_empty())
        }
        (SteerAdmission::Existing(r), Ok(())) => assert_eq!(r.kind, "queued"),
        result => panic!("native and queue admission must be exclusive: {result:?}"),
    }
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn upgrading_a_store_preserves_old_queue_and_adds_native_receipts() {
    let (root, store, message) = fixture();
    store.insert_queued_chat_message(&message).unwrap();
    store
        .conn
        .execute_batch("DROP TABLE chat_steering_requests")
        .unwrap();
    drop(store);
    let store = Store::open_at(root.clone()).unwrap();
    assert!(
        matches!(store.admit_chat_steer(&message).unwrap(), SteerAdmission::Existing(r) if r.kind == "queued")
    );
    let next = StoredQueuedChatMessage {
        id: "new-native".into(),
        client_turn_id: "new-client".into(),
        ..message
    };
    assert_eq!(
        store.admit_chat_steer(&next).unwrap(),
        SteerAdmission::Inserted
    );
    assert_eq!(store.list_queued_chat_messages().unwrap().len(), 1);
    store.delete_local_project("proj_1").unwrap();
    // The fixture session belongs to proj_1; project deletion also removes receipts.
    assert!(store
        .chat_submission("chat_1", "new-client")
        .unwrap()
        .is_none());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
