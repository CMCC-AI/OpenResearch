use super::*;
use crate::store::{Store, StoredChatSession, StoredRun};

fn session(store: &Store, id: &str) {
    store
        .create_chat_session(&StoredChatSession {
            id: id.into(),
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
}

fn run(status: &str) -> StoredRun {
    StoredRun {
        id: "run_x".into(),
        experiment_id: "exp_1".into(),
        project_id: "p1".into(),
        status: status.into(),
        backend_json: "{}".into(),
        command: "echo hi".into(),
        created_at: 1,
        updated_at: 1,
        ended_at: None,
        exit_code: None,
        commit_sha: None,
        result_markdown: None,
        cancel_requested: false,
        cancel_reason: None,
        chat_session_id: Some("owner".into()),
    }
}

fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("orx-wakeup-{tag}-{}", uuid::Uuid::new_v4()));
    (Store::open_at(dir.clone()).unwrap(), dir)
}

#[test]
fn wakeup_messages_are_exact_and_exclude_cancellation() {
    assert_eq!(
        run_wakeup_text(&run("done")).as_deref(),
        Some(
            "[orx] Run `run_x` finished with status **done**. You can compare this result \
with other project runs using `orx runs p1` and inspect the file located by `orx logs run_x`."
        )
    );
    assert_eq!(
        run_wakeup_text(&run("failed")).as_deref(),
        Some(
            "[orx] Run `run_x` finished with status **failed**. You can compare this result \
with other project runs using `orx runs p1` and inspect the file located by `orx logs run_x`."
        )
    );
    assert!(run_wakeup_text(&run("cancelled")).is_none());
}

fn assistant_message(id: &str, parent: Option<&str>, text: &str) -> StoredChatMessage {
    StoredChatMessage {
        id: id.into(),
        session_id: "child".into(),
        role: "assistant".into(),
        parts_json: serde_json::to_string(&[WirePart::text(format!("{id}-part"), text)]).unwrap(),
        created_at: 1,
        completed_at: None,
        parent_id: parent.map(str::to_string),
        base_native_session_id: None,
        result_native_session_id: None,
    }
}

/// `create_chat_spawn` always inserts `pending`, so a test that needs a
/// later state advances the row the way the watcher would.
fn spawn_row(store: &Store, child: &str, parent: &str, state: ChatSpawnState) {
    store
        .create_chat_spawn(&crate::store::ChatSpawn {
            session_id: child.into(),
            parent_session_id: parent.into(),
            prompt: "Sweep the literature".into(),
            wake_parent: true,
            attempts: 0,
            finished_at: None,
        })
        .unwrap();
    if matches!(state, ChatSpawnState::Running) {
        let token = store
            .claim_chat_spawn(child, ChatSpawnState::Pending, ChatSpawnState::Starting)
            .unwrap()
            .unwrap();
        store
            .settle_chat_spawn(child, &token, ChatSpawnState::Running)
            .unwrap();
        // A Running row stands for a turn that reached `finish_turn`; the
        // crash and Stop cases are exercised in the report-text tests.
        store.mark_chat_spawn_finished(child).unwrap();
    }
}

fn spawn_fixture(child: &str, parent: &str) -> crate::store::ChatSpawn {
    crate::store::ChatSpawn {
        session_id: child.into(),
        parent_session_id: parent.into(),
        prompt: "Sweep the literature".into(),
        wake_parent: true,
        attempts: 0,
        finished_at: Some(1),
    }
}

fn bare_host() -> Arc<ChatHost> {
    Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ))
}

#[test]
fn expired_spawn_start_cannot_spend_the_new_owners_retry_budget() {
    let (store, dir) = temp_store("stale-start");
    session(&store, "child");
    spawn_row(&store, "child", "parent", ChatSpawnState::Pending);
    let old = store
        .claim_chat_spawn("child", ChatSpawnState::Pending, ChatSpawnState::Starting)
        .unwrap()
        .unwrap();
    let other = Store::open_at(dir.clone()).unwrap();
    let tx = other.begin().unwrap();
    tx.execute(
        "UPDATE chat_spawns SET claimed_at=1 WHERE session_id='child'",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    other.prune_chat_spawns().unwrap();
    let current = other
        .claim_chat_spawn("child", ChatSpawnState::Pending, ChatSpawnState::Starting)
        .unwrap()
        .unwrap();
    assert_eq!(other.get_chat_spawn("child").unwrap().unwrap().attempts, 1);
    assert!(
        settle_spawn_start(&store, "child", &old, ChatSpawnState::Pending).is_err(),
        "a stale start was treated as settled"
    );
    assert_eq!(other.get_chat_spawn("child").unwrap().unwrap().attempts, 1);
    assert_eq!(
        other
            .list_chat_spawns(ChatSpawnState::Starting)
            .unwrap()
            .len(),
        1
    );
    settle_spawn_start(&other, "child", &current, ChatSpawnState::Pending).unwrap();
    assert_eq!(store.get_chat_spawn("child").unwrap().unwrap().attempts, 2);
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Pending)
            .unwrap()
            .len(),
        1
    );
    drop(other);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn failed_spawn_settlement_does_not_commit_a_retry_charge() {
    let (store, dir) = temp_store("failed-start-settlement");
    session(&store, "child");
    spawn_row(&store, "child", "parent", ChatSpawnState::Pending);
    let token = store
        .claim_chat_spawn("child", ChatSpawnState::Pending, ChatSpawnState::Starting)
        .unwrap()
        .unwrap();
    let tx = store.begin().unwrap();
    tx.execute_batch("CREATE TRIGGER fail_spawn_settlement BEFORE UPDATE OF state ON chat_spawns
        WHEN NEW.state='pending' BEGIN SELECT RAISE(ABORT, 'injected spawn settlement failure'); END;").unwrap();
    tx.commit().unwrap();
    let error = settle_spawn_start(&store, "child", &token, ChatSpawnState::Pending).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("injected spawn settlement failure"),
        "{error:#}"
    );
    assert_eq!(
        store.get_chat_spawn("child").unwrap().unwrap().attempts,
        0,
        "settlement failure charged a retry without releasing the claim"
    );
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Starting)
            .unwrap()
            .len(),
        1
    );
    let tx = store.begin().unwrap();
    tx.execute_batch("DROP TRIGGER fail_spawn_settlement")
        .unwrap();
    tx.commit().unwrap();
    settle_spawn_start(&store, "child", &token, ChatSpawnState::Pending).unwrap();
    assert_eq!(store.get_chat_spawn("child").unwrap().unwrap().attempts, 1);
    let token = store
        .claim_chat_spawn("child", ChatSpawnState::Pending, ChatSpawnState::Starting)
        .unwrap()
        .unwrap();
    settle_spawn_start(&store, "child", &token, ChatSpawnState::Running).unwrap();
    assert_eq!(store.get_chat_spawn("child").unwrap().unwrap().attempts, 1);
    // Retrying a failed parent wake-up must not charge another startup attempt.
    spawn_row(&store, "notification", "parent", ChatSpawnState::Pending);
    let token = store
        .claim_chat_spawn(
            "notification",
            ChatSpawnState::Pending,
            ChatSpawnState::Waking,
        )
        .unwrap()
        .unwrap();
    assert!(store
        .settle_chat_spawn("notification", &token, ChatSpawnState::Pending)
        .unwrap());
    assert_eq!(
        store
            .get_chat_spawn("notification")
            .unwrap()
            .unwrap()
            .attempts,
        0
    );
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_helper_whose_turn_is_already_held_keeps_its_row_pending() {
    let (store, dir) = temp_store("spawn-busy");
    session(&store, "child");
    spawn_row(&store, "child", "parent", ChatSpawnState::Pending);
    let host = bare_host();
    host.turns
        .lock()
        .await
        .insert("child".into(), TurnState::Draining);

    drop(store);
    process_chat_spawns(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Pending)
            .unwrap()
            .len(),
        1
    );
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_working_helper_is_not_reported_until_it_goes_idle() {
    let (store, dir) = temp_store("spawn-working");
    session(&store, "child");
    session(&store, "parent");
    spawn_row(&store, "child", "parent", ChatSpawnState::Running);
    let host = bare_host();
    host.turns.lock().await.insert(
        "child".into(),
        TurnState::Reserved {
            turn_id: None,
            reservation_id: uuid::Uuid::new_v4().to_string(),
        },
    );

    drop(store);
    process_chat_spawns(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Running)
            .unwrap()
            .len(),
        1
    );
    assert!(!host.is_busy("parent").await);
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_helper_still_running_under_another_orx_up_is_not_reported_finished() {
    let (store, dir) = temp_store("spawn-leased");
    session(&store, "child");
    session(&store, "parent");
    spawn_row(&store, "child", "parent", ChatSpawnState::Running);
    // Another process holds the turn: this one's `turns` map knows nothing
    // about it, so only the durable lease can stop a false completion.
    store
        .claim_chat_turn("child", "other-process-token", &[])
        .unwrap();
    let host = bare_host();

    drop(store);
    process_chat_spawns(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(
        store
            .list_chat_spawns(ChatSpawnState::Running)
            .unwrap()
            .len(),
        1,
        "a leased helper must stay Running"
    );
    assert!(!host.is_busy("parent").await);
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_interrupted_helper_is_not_reported_as_finished() {
    let (store, dir) = temp_store("spawn-interrupted");
    session(&store, "child");
    store
        .upsert_chat_message(&assistant_message("a1", None, "halfway through"))
        .unwrap();
    let spawn = crate::store::ChatSpawn {
        session_id: "child".into(),
        parent_session_id: "parent".into(),
        prompt: "Sweep the literature".into(),
        wake_parent: true,
        attempts: 0,
        finished_at: None,
    };

    let text = spawn_report_text(&store, &spawn, true).unwrap();
    assert!(
        text.contains("was interrupted before it finished"),
        "{text}"
    );
    assert!(!text.contains("has finished"), "{text}");
    // The partial text must not be handed back as a closing answer.
    assert!(!text.contains("halfway through"), "{text}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_helper_that_errored_is_reported_as_failed_not_silent() {
    let (store, dir) = temp_store("spawn-errored");
    session(&store, "child");
    // Exactly what `TurnCtx::push_error` writes.
    let parts = vec![WirePart::tool(
        "err-0",
        "error",
        "error",
        Some("model 'gpt-5' is not supported".into()),
    )];
    store
        .upsert_chat_message(&StoredChatMessage {
            id: "a1".into(),
            session_id: "child".into(),
            role: "assistant".into(),
            parts_json: serde_json::to_string(&parts).unwrap(),
            created_at: 1,
            completed_at: None,
            parent_id: None,
            base_native_session_id: None,
            result_native_session_id: None,
        })
        .unwrap();

    let child = store.get_chat_session("child").unwrap().unwrap();
    let SpawnOutcome::Failed(error) = spawn_outcome(&store, &child).unwrap() else {
        panic!("an error part must not read as a silent turn");
    };
    assert!(error.contains("not supported"), "{error}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_long_helper_reply_keeps_its_final_answer() {
    let (store, dir) = temp_store("spawn-final");
    session(&store, "child");
    let reply_with_progress = |progress_text: String| {
        let mut progress = WirePart::text("p", progress_text);
        progress.phase = Some(MessagePhase::Commentary);
        let mut answer = WirePart::text("a", "the report");
        answer.phase = Some(MessagePhase::FinalAnswer);
        let mut message = assistant_message("a1", None, "");
        message.parts_json = serde_json::to_string(&[progress, answer]).unwrap();
        store.upsert_chat_message(&message).unwrap();
        let child = store.get_chat_session("child").unwrap().unwrap();
        let SpawnOutcome::Reply(reply) = spawn_outcome(&store, &child).unwrap() else {
            panic!("expected a reply");
        };
        reply
    };
    assert_eq!(
        reply_with_progress("findings".into()),
        "findings\n\nthe report"
    );
    assert_eq!(
        reply_with_progress("x".repeat(SPAWN_REPORT_LIMIT)),
        "the report"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_answered_prompt_card_does_not_mask_the_real_reply() {
    let (store, dir) = temp_store("spawn-card");
    session(&store, "child");
    store
        .upsert_chat_message(&assistant_message("a1", None, "the answer"))
        .unwrap();
    // A resolved card rides its own text-less assistant message and becomes
    // the branch tip; reading only the tip would lose the answer above it.
    store
        .upsert_chat_message(&StoredChatMessage {
            id: "a2".into(),
            session_id: "child".into(),
            role: "assistant".into(),
            parts_json: "[]".into(),
            created_at: 2,
            completed_at: None,
            parent_id: Some("a1".into()),
            base_native_session_id: None,
            result_native_session_id: None,
        })
        .unwrap();
    store
        .set_chat_session_active_leaf("child", Some("a2"))
        .unwrap();

    let child = store.get_chat_session("child").unwrap().unwrap();
    let SpawnOutcome::Reply(reply) = spawn_outcome(&store, &child).unwrap() else {
        panic!("expected the reply above the card");
    };
    assert_eq!(reply, "the answer");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_long_reply_and_a_long_brief_are_both_bounded() {
    let (store, dir) = temp_store("spawn-truncate");
    session(&store, "child");
    store
        .upsert_chat_message(&assistant_message("a1", None, &"x".repeat(9000)))
        .unwrap();
    let spawn = crate::store::ChatSpawn {
        session_id: "child".into(),
        parent_session_id: "parent".into(),
        prompt: "y".repeat(9000),
        wake_parent: true,
        attempts: 0,
        finished_at: Some(1),
    };

    let text = spawn_report_text(&store, &spawn, false).unwrap();
    assert_eq!(text.matches("… (truncated)").count(), 2, "{text}");
    assert!(text.chars().count() < SPAWN_REPORT_LIMIT + SPAWN_BRIEF_LIMIT + 600);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_finished_helper_whose_parent_is_gone_retires_quietly() {
    let (store, dir) = temp_store("spawn-orphan");
    session(&store, "child");
    spawn_row(&store, "child", "deleted_parent", ChatSpawnState::Running);
    let host = bare_host();

    drop(store);
    process_chat_spawns(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert!(store
        .list_chat_spawns(ChatSpawnState::Running)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list_chat_spawns(ChatSpawnState::Done).unwrap().len(),
        1
    );
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_spawned_agent_reports_its_last_reply_on_the_branch_on_screen() {
    let (store, dir) = temp_store("spawn-report");
    session(&store, "child");
    store
        .upsert_chat_message(&assistant_message("a1", None, "first pass"))
        .unwrap();
    store
        .upsert_chat_message(&assistant_message("a2", Some("a1"), "the answer"))
        .unwrap();
    // A re-sampled sibling that is *not* the branch on screen must not win.
    store
        .upsert_chat_message(&assistant_message("a3", Some("a1"), "discarded fork"))
        .unwrap();
    store
        .set_chat_session_active_leaf("child", Some("a2"))
        .unwrap();

    let child = store.get_chat_session("child").unwrap().unwrap();
    let SpawnOutcome::Reply(reply) = spawn_outcome(&store, &child).unwrap() else {
        panic!("expected a written reply");
    };
    assert_eq!(reply, "the answer");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_parent_is_told_what_it_asked_for_and_what_came_back() {
    let (store, dir) = temp_store("spawn-text");
    session(&store, "child");
    store
        .set_chat_session_title("child", "Lit sweep", "user")
        .unwrap();
    store
        .upsert_chat_message(&assistant_message("a1", None, "Rank 8 wins."))
        .unwrap();
    let spawn = spawn_fixture("child", "parent");

    let text = spawn_report_text(&store, &spawn, false).unwrap();
    // No workspace clause: the fixture's project has no checkout on disk,
    // which is also what a helper that never wrote anything looks like.
    assert_eq!(
        text,
        "[orx] The agent you spawned for `child` (\"Lit sweep\") has finished.\n\n\
         It was asked to: Sweep the literature\n\nIts closing reply:\n\nRank 8 wins."
    );

    // An untitled helper still reads as a sentence.
    session(&store, "untitled");
    store
        .upsert_chat_message(&StoredChatMessage {
            id: "b1".into(),
            session_id: "untitled".into(),
            role: "assistant".into(),
            parts_json: serde_json::to_string(&[WirePart::text("p", "Rank 8 wins.")]).unwrap(),
            created_at: 1,
            completed_at: None,
            parent_id: None,
            base_native_session_id: None,
            result_native_session_id: None,
        })
        .unwrap();
    assert!(
        spawn_report_text(&store, &spawn_fixture("untitled", "parent"), false)
            .unwrap()
            .starts_with("[orx] The agent you spawned for `untitled` has finished.")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_helper_that_wrote_nothing_reads_as_silent_not_as_a_reply() {
    let (store, dir) = temp_store("spawn-silent");
    session(&store, "child");

    let child = store.get_chat_session("child").unwrap().unwrap();
    assert!(matches!(
        spawn_outcome(&store, &child).unwrap(),
        SpawnOutcome::Silent
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hidden_transcript_override_creates_no_user_parts() {
    assert!(transcript_parts("", &[], &[]).is_empty());
}

#[test]
fn only_earliest_wakeup_per_session_is_attempted_each_tick() {
    let mut first = run("done");
    first.id = "run_first".into();
    let mut second = run("done");
    second.id = "run_second".into();
    let selected = first_wakeup_per_session(vec![
        crate::store::RunWakeup {
            run: first,
            chat_session_id: "owner".into(),
            state: "pending".into(),
            monitoring_alerted: false,
            monitoring_delivery_id: None,
        },
        crate::store::RunWakeup {
            run: second,
            chat_session_id: "owner".into(),
            state: "pending".into(),
            monitoring_alerted: false,
            monitoring_delivery_id: None,
        },
    ]);

    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].run.id, "run_first");
}

#[test]
fn delivery_certainty_never_replays_accepted_or_unknown_turns() {
    assert_eq!(DeliveryState::NotSent.recovery_action(), "retry");
    assert_eq!(DeliveryState::Rejected.recovery_action(), "retry");
    assert_eq!(DeliveryState::Accepted.recovery_action(), "continue");
    assert_eq!(DeliveryState::Unknown.recovery_action(), "continue");
}

#[test]
fn orx_retry_budget_is_shared_across_adapter_phases() {
    let mut ctx = TurnCtx::test_stub();
    assert_eq!(ctx.schedule_orx_retry(None).unwrap().0, 1);
    assert_eq!(ctx.schedule_orx_retry(None).unwrap().0, 2);
    assert_eq!(ctx.schedule_orx_retry(None).unwrap().0, 3);
    assert!(ctx.schedule_orx_retry(None).is_none());
}

#[test]
fn prepared_attachment_paths_rebase_after_data_directory_moves() {
    let input =
        "<attached-files>\n- paper — /old/data/chat-attachments/file.pdf\n</attached-files>";
    let rebased = rebase_prepared_attachment_paths(input);
    assert!(rebased.contains(
        &attachments_dir()
            .unwrap()
            .join("file.pdf")
            .display()
            .to_string()
    ));
    assert!(!rebased.contains("/old/data/chat-attachments"));
}

#[tokio::test]
async fn queued_user_message_blocks_hidden_turn_claim() {
    let host = Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));
    host.queued.lock().unwrap().insert(
        "owner".into(),
        VecDeque::from([QueuedMessage {
            id: "q_1".into(),
            client_turn_id: "ct_1".into(),
            request_hash: "hash".into(),
            text: "user first".into(),
            transcript_text: None,
            overrides: TurnOverrides::default(),
            images: Vec::new(),
            annotations: Vec::new(),
            dispatch_attempts: 0,
            dispatch_error: None,
            next_retry_at: None,
        }]),
    );

    assert!(TurnGuard::claim_hidden(&host, "owner").await.is_none());
}

#[test]
fn only_exhausted_queued_delivery_can_be_reset() {
    let mut message = QueuedMessage {
        id: "q_1".into(),
        client_turn_id: "ct_1".into(),
        request_hash: "hash".into(),
        text: "retry me".into(),
        transcript_text: None,
        overrides: TurnOverrides::default(),
        images: Vec::new(),
        annotations: Vec::new(),
        dispatch_attempts: crate::local::harness::ORX_MAX_RETRIES + 1,
        dispatch_error: Some("connection refused".into()),
        next_retry_at: None,
    };

    let reset = reset_exhausted_queued_message(&message).unwrap();
    assert_eq!(reset.id, message.id);
    assert_eq!(reset.client_turn_id, message.client_turn_id);
    assert_eq!(reset.dispatch_attempts, 0);
    assert!(reset.dispatch_error.is_none());
    assert!(reset.next_retry_at.is_none());

    message.next_retry_at = Some(123);
    assert!(reset_exhausted_queued_message(&message).is_none());
    message.next_retry_at = None;
    message.dispatch_attempts = crate::local::harness::ORX_MAX_RETRIES;
    assert!(reset_exhausted_queued_message(&message).is_some());
    message.dispatch_error = None;
    assert!(reset_exhausted_queued_message(&message).is_none());
}

#[tokio::test]
async fn terminal_run_without_subscription_starts_no_turn() {
    let (store, dir) = temp_store("unsubscribed");
    session(&store, "owner");
    store.upsert_run(&run("done")).unwrap();
    let host = Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));

    drop(store);
    process_run_wakeups(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    assert!(!host.is_busy("owner").await);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn data_directory_move_keeps_wakeup_pending() {
    let (store, dir) = temp_store("moving");
    session(&store, "owner");
    store.upsert_run(&run("done")).unwrap();
    store.register_run_wakeup("run_x", "owner").unwrap();
    let host = Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));
    let moving = std::sync::atomic::AtomicBool::new(true);

    drop(store);
    process_run_wakeups(&host, Store::open_at(dir.clone()).unwrap(), Some(&moving))
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(store.list_ready_run_wakeups().unwrap().len(), 1);
    assert!(!host.is_busy("owner").await);
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn draining_user_messages_keep_wakeup_pending() {
    let (store, dir) = temp_store("draining");
    session(&store, "owner");
    store.upsert_run(&run("done")).unwrap();
    store.register_run_wakeup("run_x", "owner").unwrap();
    let host = Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));
    host.turns
        .lock()
        .await
        .insert("owner".into(), TurnState::Draining);

    drop(store);
    process_run_wakeups(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert_eq!(store.list_ready_run_wakeups().unwrap().len(), 1);
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

fn unmonitored_run() -> StoredRun {
    StoredRun {
        backend_json:
            r#"{"kind":"slurm_job","monitoringError":"Monitoring unavailable: ssh failed."}"#.into(),
        ..run("starting")
    }
}

#[test]
fn monitoring_message_names_runs_without_remote_text() {
    let first = StoredRun {
        backend_json: r#"{"kind":"slurm_job","monitoringError":"REMOTE_SENTINEL"}"#.into(),
        ..run("starting")
    };
    let mut second = run("running");
    second.id = "run_y".into();
    let text = run_monitoring_text(&[first, second]);
    assert!(!text.contains("REMOTE_SENTINEL"));
    assert_eq!(
        text,
        "[orx] orx can no longer monitor these live runs:\n\
- run `run_x` of experiment `exp_1` (still **starting**)\n\
- run `run_y` of experiment `exp_1` (still **running**)\n\
Run `orx exp status <expId>` for the reason and tell the user so they can fix it. orx wakes you \
once it can see a run finish; until then each run keeps its current status."
    );
}

#[test]
fn monitoring_alert_claim_failure_does_not_consume_unsent_alerts() {
    const CHILD: &str = "ORX_TEST_MONITORING_CLAIM_ROLLBACK";
    const TEST: &str = "local::chat::run_wakeup_tests::monitoring_alert_claim_failure_does_not_consume_unsent_alerts";
    async fn check() {
        let store = Store::open().unwrap();
        session(&store, "owner");
        for id in ["run_x", "run_y", "run_z"] {
            let mut row = unmonitored_run();
            row.id = id.into();
            store.upsert_run(&row).unwrap();
            store.register_run_wakeup(id, "owner").unwrap();
        }
        store
            .set_run_wakeup_monitoring_alerted("run_z", "owner", true)
            .unwrap();
        let tx = store.begin().unwrap();
        tx.execute_batch("CREATE TRIGGER fail_second_alert BEFORE UPDATE OF monitoring_alerted ON chat_run_wakeups
            WHEN NEW.monitoring_alerted=1 AND NEW.run_id='run_y'
            BEGIN SELECT RAISE(ABORT, 'injected monitoring claim failure'); END;").unwrap();
        tx.commit().unwrap();
        let host = bare_host();
        let error = process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected monitoring claim failure"),
            "{error:#}"
        );
        let rows = store.list_active_run_wakeups().unwrap();
        assert_eq!(rows.len(), 3);
        assert!(
            rows.iter()
                .all(|row| row.monitoring_alerted == (row.run.id == "run_z")),
            "a failed claim batch consumed an alert before notification"
        );
        assert!(rows.iter().all(|row| row.run.status == "starting"));
        let tx = store.begin().unwrap();
        let turns: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM chat_turns WHERE session_id='owner'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(turns, 0);
        tx.commit().unwrap();
        // Drop cleanup owns the reservation after the failed storage phase.
        tokio::time::timeout(Duration::from_secs(5), async {
            while host.is_busy("owner").await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let tx = store.begin().unwrap();
        tx.execute_batch("DROP TRIGGER fail_second_alert;
            CREATE TABLE observed_alert_claims(run_id TEXT);
            CREATE TRIGGER observe_alert_claim AFTER UPDATE OF monitoring_alerted ON chat_run_wakeups
            WHEN NEW.monitoring_alerted=1
            BEGIN INSERT INTO observed_alert_claims VALUES(NEW.run_id); END;").unwrap();
        tx.commit().unwrap();
        // Missing project p1 stops hidden-turn setup before any harness launch.
        // The next pass can claim both unsent alerts, then rearm them on that error.
        process_run_monitoring_alerts(&host, Store::open().unwrap(), None, None)
            .await
            .unwrap();
        let tx = store.begin().unwrap();
        let mut stmt = tx
            .prepare("SELECT run_id FROM observed_alert_claims ORDER BY run_id")
            .unwrap();
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, ["run_x", "run_y"]);
        let turns: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM chat_turns WHERE session_id='owner'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(turns, 0);
        drop(stmt);
        tx.commit().unwrap();
        assert!(store
            .list_active_run_wakeups()
            .unwrap()
            .iter()
            .all(|row| row.monitoring_alerted == (row.run.id == "run_z")));
        tokio::time::timeout(Duration::from_secs(5), async {
            while host.is_busy("owner").await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(check());
        return;
    }
    let root = std::env::temp_dir().join(format!("orx-monitoring-claim-{}", uuid::Uuid::new_v4()));
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

#[tokio::test]
async fn busy_session_leaves_monitoring_alert_unclaimed() {
    let (store, dir) = temp_store("alert-busy");
    session(&store, "owner");
    store.upsert_run(&unmonitored_run()).unwrap();
    store.register_run_wakeup("run_x", "owner").unwrap();
    let host = Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));
    host.turns
        .lock()
        .await
        .insert("owner".into(), TurnState::Draining);

    drop(store);
    process_run_wakeups(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert!(!store.list_active_run_wakeups().unwrap()[0].monitoring_alerted);
    assert!(matches!(
        host.turns.lock().await.get("owner"),
        Some(TurnState::Draining)
    ));
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn restored_monitoring_rearms_the_alert() {
    let (store, dir) = temp_store("alert-restored");
    session(&store, "owner");
    store.upsert_run(&run("running")).unwrap();
    store.register_run_wakeup("run_x", "owner").unwrap();
    store
        .set_run_wakeup_monitoring_alerted("run_x", "owner", true)
        .unwrap();
    let host = Arc::new(ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));

    drop(store);
    process_run_wakeups(&host, Store::open_at(dir.clone()).unwrap(), None)
        .await
        .unwrap();

    let store = Store::open_at(dir.clone()).unwrap();
    assert!(!store.list_active_run_wakeups().unwrap()[0].monitoring_alerted);
    assert!(!host.is_busy("owner").await);
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}
include!("notification_recovery_tests.rs");
