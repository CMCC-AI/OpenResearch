use super::*;
use crate::store::StoredChatMessage;

fn msg(id: &str, role: &str, parent: Option<&str>) -> StoredChatMessage {
    StoredChatMessage {
        id: id.into(),
        session_id: "s1".into(),
        role: role.into(),
        parts_json: "[]".into(),
        created_at: 0,
        completed_at: None,
        parent_id: parent.map(Into::into),
        base_native_session_id: None,
        result_native_session_id: None,
    }
}

/// u1 → a1, plus a re-sampled a2 beside it; u2 → a3 continues under a1.
fn forked() -> Vec<StoredChatMessage> {
    vec![
        msg("u1", "user", None),
        msg("a1", "assistant", Some("u1")),
        msg("a2", "assistant", Some("u1")),
        msg("u2", "user", Some("a1")),
        msg("a3", "assistant", Some("u2")),
    ]
}

fn ids(path: Vec<&StoredChatMessage>) -> Vec<&str> {
    path.iter().map(|m| m.id.as_str()).collect()
}

#[test]
fn active_path_follows_parents_from_the_leaf() {
    let messages = forked();
    assert_eq!(
        ids(active_path(&messages, Some("a3"))),
        ["u1", "a1", "u2", "a3"]
    );
    // The sibling fork hides everything that only exists under the other one.
    assert_eq!(ids(active_path(&messages, Some("a2"))), ["u1", "a2"]);
}

fn said(id: &str, role: &str, parent: Option<&str>, text: &str) -> StoredChatMessage {
    StoredChatMessage {
        parts_json: json!([{ "id": "p", "type": "text", "text": text }]).to_string(),
        ..msg(id, role, parent)
    }
}

#[test]
fn material_context_follows_selected_branch_and_replays_references() {
    let dir = std::env::temp_dir().join(format!("orx-material-branch-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = parent_session("codex");
    session.active_leaf_id = None;
    store.create_chat_session(&session).unwrap();
    let first_id = uuid::Uuid::new_v4().to_string();
    let other_id = uuid::Uuid::new_v4().to_string();
    for (id, parent, package) in [
        ("root", None, None),
        ("left", Some("root"), Some(&first_id)),
        ("right", Some("root"), Some(&other_id)),
    ] {
        store
            .upsert_chat_message(&StoredChatMessage {
                id: id.into(),
                session_id: session.id.clone(),
                role: "user".into(),
                parts_json: package
                    .map(|id| json!([{"id":"m", "type":"material", "text":id}]))
                    .unwrap_or(json!([]))
                    .to_string(),
                created_at: 1,
                completed_at: Some(1),
                parent_id: parent.map(String::from),
                base_native_session_id: None,
                result_native_session_id: None,
            })
            .unwrap();
    }
    store
        .set_chat_session_active_leaf(&session.id, Some("left"))
        .unwrap();
    assert_eq!(
        super::super::materials::session_ids(&store, &session.id).unwrap(),
        vec![first_id.clone()]
    );
    store
        .set_chat_session_active_leaf(&session.id, Some("right"))
        .unwrap();
    assert_eq!(
        super::super::materials::session_ids(&store, &session.id).unwrap(),
        vec![other_id]
    );
    let part: WirePart =
        serde_json::from_value(json!({"id":"m", "type":"material", "text":first_id})).unwrap();
    let saved = replayed_attachments(&[part]).unwrap();
    assert_eq!(saved[0].material_id.as_deref(), Some(first_id.as_str()));
    assert_eq!(transcript_parts("", &saved, &[])[0].kind, "material");
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

fn parent_session(harness: &str) -> StoredChatSession {
    StoredChatSession {
        id: "chat_parent".into(),
        project_id: "proj_1".into(),
        harness: harness.into(),
        native_session_id: Some("native-parent".into()),
        title: Some("Parent".into()),
        title_source: Some("user".into()),
        model: Some("model-x".into()),
        service_tier: None,
        permission_mode: Some("bypass".into()),
        plan_mode: false,
        plan_reset_pending: false,
        reasoning_level: Some("high".into()),
        archived: false,
        context_usage_json: None,
        bootstrap_context: None,
        goal: Some("keep training".into()),
        autonomy: None,
        active_leaf_id: Some("a3".into()),
        parent_session_id: None,
        side_parent_session_id: None,
        side_parent_leaf_id: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn a_side_chat_is_seeded_from_the_parents_live_branch_only() {
    let messages = vec![
        said("u1", "user", None, "train the model"),
        said("a1", "assistant", Some("u1"), "kept branch"),
        said("a2", "assistant", Some("u1"), "abandoned retry"),
        said("u2", "user", Some("a1"), "how is it going"),
        said("a3", "assistant", Some("u2"), "loss is falling"),
    ];
    let side = side_chat_session(&parent_session("codex"), &messages);
    assert_eq!(side.bootstrap_context, None);
    assert_eq!(side.side_parent_leaf_id.as_deref(), Some("a3"));
    let context =
        side_chat_context(active_path(&messages, side.side_parent_leaf_id.as_deref())).unwrap();
    assert!(context.contains("kept branch") && context.contains("loss is falling"));
    assert!(!context.contains("abandoned retry"));
    assert_eq!(side.side_parent_session_id.as_deref(), Some("chat_parent"));
    assert_eq!(side.native_session_id, None);
    assert_eq!(side.goal, None);
    assert_eq!(side.model.as_deref(), Some("model-x"));
    assert_eq!(side.permission_mode.as_deref(), Some("bypass"));
    assert!(!side.plan_mode);
}

#[test]
fn a_side_chat_leaves_claudes_plan_permission_behind() {
    let mut parent = parent_session("claude-code");
    parent.permission_mode = Some("plan".into());
    assert_eq!(side_chat_session(&parent, &[]).permission_mode, None);
}

#[test]
fn a_side_chat_of_an_empty_chat_has_no_seed_context() {
    let side = side_chat_session(&parent_session("claude-code"), &[]);
    assert_eq!(side.bootstrap_context, None);
}

#[test]
fn side_context_references_survive_restart_and_parent_branch_changes() {
    let dir = std::env::temp_dir().join(format!("orx-side-context-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let parent = parent_session("codex");
    store.create_chat_session(&parent).unwrap();
    let mut messages = vec![
        said("u1", "user", None, "train the model"),
        said("a1", "assistant", Some("u1"), "kept branch"),
        said("a2", "assistant", Some("u1"), "abandoned retry"),
        said("u2", "user", Some("a1"), "how is it going"),
        said("a3", "assistant", Some("u2"), "loss is falling"),
    ];
    for message in &mut messages {
        message.session_id = parent.id.clone();
        store.upsert_chat_message(message).unwrap();
    }
    let side = side_chat_session(&parent, &messages);
    store.create_chat_session(&side).unwrap();
    let expected = side_chat_context(active_path(&messages, parent.active_leaf_id.as_deref()));
    assert_eq!(
        effective_bootstrap_context(&store, &side).unwrap(),
        expected
    );

    store
        .set_chat_session_active_leaf(&parent.id, Some("a2"))
        .unwrap();
    let mut later = said("later", "user", Some("a3"), "do not inherit this");
    later.session_id = parent.id.clone();
    store.upsert_chat_message(&later).unwrap();
    drop(store);
    let store = Store::open_at(dir.clone()).unwrap();
    let mut side = store.get_chat_session(&side.id).unwrap().unwrap();
    assert_eq!(side.side_parent_leaf_id.as_deref(), Some("a3"));
    assert_eq!(
        effective_bootstrap_context(&store, &side).unwrap(),
        expected
    );

    // Parent content changes are accepted, but the saved branch boundary stays fixed.
    messages[4].parts_json = said("a3", "assistant", None, "updated result").parts_json;
    store.upsert_chat_message(&messages[4]).unwrap();
    assert!(effective_bootstrap_context(&store, &side)
        .unwrap()
        .unwrap()
        .contains("updated result"));
    side.bootstrap_context = Some("compaction or legacy snapshot".into());
    assert_eq!(
        effective_bootstrap_context(&store, &side)
            .unwrap()
            .as_deref(),
        Some("compaction or legacy snapshot")
    );
    side.bootstrap_context = None;
    side.side_parent_leaf_id = Some("missing".into());
    assert!(effective_bootstrap_context(&store, &side).is_err());
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_empty_side_context_stays_empty_after_parent_messages_arrive() {
    let dir = std::env::temp_dir().join(format!("orx-empty-side-context-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut parent = parent_session("codex");
    parent.active_leaf_id = None;
    store.create_chat_session(&parent).unwrap();
    let side = side_chat_session(&parent, &[]);
    store.create_chat_session(&side).unwrap();
    let mut later = said("later", "user", None, "new parent context");
    later.session_id = parent.id.clone();
    store.upsert_chat_message(&later).unwrap();
    assert_eq!(effective_bootstrap_context(&store, &side).unwrap(), None);
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn side_context_keeps_legacy_fallback_and_utf8_snapshot_limit() {
    let mut parent = parent_session("codex");
    parent.active_leaf_id = None;
    let messages = vec![said("u1", "user", None, &"界".repeat(20_000))];
    let side = side_chat_session(&parent, &messages);
    assert_eq!(side.side_parent_leaf_id, None);
    let expected = crate::local::harness::transcript_snapshot(messages.iter());
    assert!(expected.len() <= 32 * 1024);
    assert!(expected.ends_with('界'));
    assert_eq!(side.bootstrap_context, side_chat_context(messages.iter()));
    assert!(side.bootstrap_context.unwrap().contains(&expected));
}

#[test]
fn active_path_without_a_leaf_keeps_the_whole_transcript() {
    let messages = forked();
    assert_eq!(
        ids(active_path(&messages, None)),
        ["u1", "a1", "a2", "u2", "a3"]
    );
    // A pointer at a message that is gone must not blank the transcript.
    assert_eq!(
        active_path(&messages, Some("missing")).len(),
        messages.len()
    );
}

#[test]
fn only_a_turn_that_began_a_session_may_clear_the_harness_id() {
    let mut anchor = msg("u1", "user", None);
    // Recorded fork point: resume the turn from exactly where it started.
    anchor.base_native_session_id = Some("sess-abc".into());
    assert_eq!(rewind_target(&anchor), Some(Some("sess-abc".into())));

    // A turn that opened the session has nothing to resume from, so clearing
    // is what a fork of it should do.
    anchor.base_native_session_id = None;
    assert_eq!(rewind_target(&anchor), Some(None));

    // Recorded before this build: leave the harness alone rather than wipe a
    // live conversation's thread.
    let legacy = msg("a1", "assistant", Some("u1"));
    assert_eq!(rewind_target(&legacy), None);
}

#[test]
fn turn_anchor_is_the_user_message_the_reply_answers() {
    let messages = forked();
    let anchor = |id: &str| {
        turn_anchor(&messages, messages.iter().find(|m| m.id == id).unwrap())
            .unwrap()
            .id
            .clone()
    };
    assert_eq!(anchor("a2"), "u1");
    assert_eq!(anchor("a3"), "u2");
    // A user message anchors its own turn.
    assert_eq!(anchor("u2"), "u2");
}

#[test]
fn selecting_a_fork_descends_to_its_newest_tip() {
    let messages = forked();
    let tip = |id: &str| {
        branch_tip(&messages, messages.iter().find(|m| m.id == id).unwrap())
            .id
            .clone()
    };
    assert_eq!(tip("a1"), "a3");
    // A fork with nothing under it is its own tip.
    assert_eq!(tip("a2"), "a2");
}
