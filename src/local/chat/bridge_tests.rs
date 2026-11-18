use super::*;

fn test_host() -> ChatHost {
    ChatHost::new(
        Arc::new(crate::local::opencode::AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    )
}

#[tokio::test]
async fn while_idle_refuses_a_running_session_and_runs_otherwise() {
    let host = test_host();
    host.turns.lock().await.insert(
        "busy".into(),
        TurnState::Reserved {
            turn_id: None,
            reservation_id: uuid::Uuid::new_v4().to_string(),
        },
    );
    let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let marked = ran.clone();
    assert!(host
        .while_idle(&["busy".into()], move || {
            marked.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .await
        .is_err());
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    let turns = host.turns.clone();
    assert_eq!(
        host.while_idle(&[], move || {
            assert!(turns.try_lock().is_ok());
            Ok(7)
        })
        .await
        .unwrap(),
        7
    );
}

#[tokio::test]
async fn restart_stops_admitting_turns_only_when_idle() {
    let host = test_host();
    host.turns.lock().await.insert(
        "busy".into(),
        TurnState::Reserved {
            turn_id: None,
            reservation_id: uuid::Uuid::new_v4().to_string(),
        },
    );
    assert!(!host.stop_admitting_if_idle().await);
    host.turns.lock().await.clear();
    assert!(host.stop_admitting_if_idle().await);
    assert!(host
        .claim_durable_turn_with_store("next", || panic!("restarting must not open storage"))
        .is_none());
}

#[tokio::test]
async fn claude_permission_reviews_are_serialized_per_session() {
    let host = test_host();
    let lock = host
        .permission_review_locks
        .lock()
        .await
        .entry("session".into())
        .or_default()
        .clone();
    let active = lock.lock().await;
    assert!(lock.try_lock().is_err());
    drop(active);
    assert!(lock.try_lock().is_ok());
}

#[test]
fn shared_permission_order_only_activates_the_oldest_unresolved_card() {
    let permission = |id: &str, resolved| {
        WirePart::prompt(
            id,
            WirePrompt {
                kind: "permission".into(),
                resolved,
                ..Default::default()
            },
        )
    };
    let parts = vec![
        WirePart::prompt(
            "plan",
            WirePrompt {
                kind: "plan".into(),
                ..Default::default()
            },
        ),
        permission("first", false),
        permission("second", false),
    ];
    assert_eq!(
        first_unresolved_permission_in_parts(&parts).as_deref(),
        Some("first")
    );

    let parts = vec![permission("first", true), permission("second", false)];
    assert_eq!(
        first_unresolved_permission_in_parts(&parts).as_deref(),
        Some("second")
    );
}

#[test]
fn stale_native_prompt_sweep_reaches_nested_cards() {
    let mut parts = vec![WirePart {
        id: "tool".into(),
        kind: "tool".into(),
        text: None,
        tool: Some("Task".into()),
        state: None,
        prompt: None,
        phase: None,
        children: vec![WirePart::prompt(
            "permission",
            WirePrompt {
                kind: "permission".into(),
                native_id: Some("request-1".into()),
                ..Default::default()
            },
        )],
    }];

    assert!(resolve_stale_prompts_in_parts(&mut parts, true));
    assert!(parts[0].children[0].prompt.as_ref().unwrap().resolved);
}

#[test]
fn opencode_stop_closes_native_cards_and_rejects_cards_from_another_turn() {
    const TEST: &str = "local::chat::bridge_tests::opencode_stop_closes_native_cards_and_rejects_cards_from_another_turn";
    const CHILD: &str = "ORX_TEST_OPENCODE_STOP_PROMPTS";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let host = Arc::new(test_host());
            let store = Store::open().unwrap();
            let mut session = bare_session();
            session.harness = "opencode".into();
            session.native_session_id = Some("native".into());
            session.plan_mode = true;
            store.create_chat_session(&session).unwrap();
            let native_prompt = |id: &str| {
                WirePart::prompt(
                    id,
                    WirePrompt {
                        kind: "question".into(),
                        native_id: Some("reused-native-request".into()),
                        plan_exit: true,
                        ..Default::default()
                    },
                )
            };
            let save = |id: &str, parts: Vec<WirePart>| {
                store
                    .upsert_chat_message_on_branch(&StoredChatMessage {
                        id: id.into(),
                        session_id: session.id.clone(),
                        role: "assistant".into(),
                        parts_json: serde_json::to_string(&parts).unwrap(),
                        created_at: 1,
                        completed_at: None,
                        parent_id: None,
                        base_native_session_id: None,
                        result_native_session_id: Some("native".into()),
                    })
                    .unwrap();
            };
            let answered = WirePart::prompt(
                "answered",
                WirePrompt {
                    kind: "question".into(),
                    native_id: Some("answered-request".into()),
                    resolved: true,
                    answers: vec!["Keep".into()],
                    approved: Some(true),
                    note: Some("Preserve note".into()),
                    ..Default::default()
                },
            );
            let mut nested = WirePart::text("nested", "");
            nested.children.push(native_prompt("nested-question"));
            save(
                "stopped",
                vec![
                    native_prompt("stopped:request"),
                    answered,
                    nested,
                    WirePart::prompt(
                        "end-turn-plan",
                        WirePrompt {
                            kind: "plan".into(),
                            ..Default::default()
                        },
                    ),
                ],
            );
            save("older", vec![native_prompt("older:request")]);
            let active = |message_id: &str| {
                TurnState::Active(ActiveTurn {
                    native: NativeInterruptTarget::default(),
                    handle: tokio::spawn(std::future::pending()),
                    message_id: message_id.into(),
                    turn_id: format!("turn-{message_id}"),
                })
            };
            host.turns
                .lock()
                .await
                .insert(session.id.clone(), active("stopped"));
            host.interrupt_by_user(&session.id).await.unwrap();
            assert!(!host.is_busy(&session.id).await);
            let stopped = stored_to_wire(&store.get_chat_message("stopped").unwrap().unwrap());
            let prompt = stopped.parts[0].prompt.as_ref().unwrap();
            assert!(prompt.resolved);
            assert_eq!(prompt.approved, None);
            assert!(prompt.answers.is_empty());
            let answered = stopped.parts[1].prompt.as_ref().unwrap();
            assert_eq!(answered.answers, ["Keep"]);
            assert_eq!(answered.note.as_deref(), Some("Preserve note"));
            assert!(
                stopped.parts[2].children[0]
                    .prompt
                    .as_ref()
                    .unwrap()
                    .resolved
            );
            assert!(!stopped.parts[3].prompt.as_ref().unwrap().resolved);
            let older = stored_to_wire(&store.get_chat_message("older").unwrap().unwrap());
            assert!(
                !older.parts[0].prompt.as_ref().unwrap().resolved,
                "Stop cleanup must target its own message"
            );

            save("successor", vec![native_prompt("successor:request")]);
            host.turns
                .lock()
                .await
                .insert(session.id.clone(), active("successor"));
            let answer = |prompt_id: &str| PromptAnswer {
                session_id: session.id.clone(),
                prompt_id: prompt_id.into(),
                approve: true,
                resume_mode: None,
                answers: vec!["Yes".into()],
                note: None,
                annotations: Vec::new(),
            };
            host.respond(answer("stopped:request")).await.unwrap();
            let error = host.respond(answer("older:request")).await.unwrap_err();
            assert!(error.to_string().contains("no longer running"), "{error}");
            let older = stored_to_wire(&store.get_chat_message("older").unwrap().unwrap());
            assert!(older.parts[0].prompt.as_ref().unwrap().resolved);
            assert_eq!(older.parts[0].prompt.as_ref().unwrap().approved, None);
            let successor = stored_to_wire(&store.get_chat_message("successor").unwrap().unwrap());
            assert!(!successor.parts[0].prompt.as_ref().unwrap().resolved);
            assert!(host.is_busy(&session.id).await);
            assert!(
                store
                    .get_chat_session(&session.id)
                    .unwrap()
                    .unwrap()
                    .plan_mode
            );
            assert!(
                host.plan_changes
                    .session(&session.id)
                    .lock_owned()
                    .await
                    .is_empty(),
                "stale Plan replies must not change revisions"
            );
            host.interrupt(&session.id).await.unwrap();
        });
        return;
    }
    let fixture = crate::local::git::TemporaryDirectory::new("orx-stop-native-prompts").unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env(CHILD, "1")
        .env("ORX_DATA_DIR", fixture.path().join("data"))
        .env("XDG_CONFIG_HOME", fixture.path().join("config"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The decision wire shapes are Claude Code's permission-prompt-tool
/// contract verbatim — the bridge stringifies them unchanged, so a drift
/// here breaks every approval.
#[test]
fn permission_decision_serializes_to_the_cli_contract() {
    let allow = PermissionDecision::Allow {
        updated_input: Some(json!({"command": "orx runs"})),
    };
    assert_eq!(
        serde_json::to_value(&allow).unwrap(),
        json!({"behavior": "allow", "updatedInput": {"command": "orx runs"}})
    );
    let allow_bare = PermissionDecision::Allow {
        updated_input: None,
    };
    assert_eq!(
        serde_json::to_value(&allow_bare).unwrap(),
        json!({"behavior": "allow"})
    );
    let deny = PermissionDecision::deny("no");
    assert_eq!(
        serde_json::to_value(&deny).unwrap(),
        json!({"behavior": "deny", "message": "no"})
    );
}

#[test]
fn gate_token_captures_the_childs_plan_policy() {
    let host = test_host();
    let token = host.mint_gate_token("session", true, false);
    let gates = host.gate_tokens.lock().unwrap();
    let gate = gates.get("session").unwrap();
    assert_eq!(gate.value, token);
    assert!(gate.plan_mode);
    assert!(!gate.bypass);
}

#[test]
fn gate_token_captures_bypass() {
    let host = test_host();
    let token = host.mint_gate_token("session", false, true);
    let gates = host.gate_tokens.lock().unwrap();
    let gate = gates.get("session").unwrap();
    assert_eq!(gate.value, token);
    assert!(!gate.plan_mode);
    assert!(gate.bypass);
}

#[test]
fn plan_auto_policy_decides_the_unambiguous_tiers() {
    let allow = |d: Option<PermissionDecision>| matches!(d, Some(PermissionDecision::Allow { .. }));
    let deny = |d: Option<PermissionDecision>| matches!(d, Some(PermissionDecision::Deny { .. }));

    // Read-only Bash: allowed without a card.
    assert!(allow(plan_auto_policy(
        "Bash",
        &json!({"command": "orx runs 2>&1 | head -50"})
    )));
    assert!(allow(plan_auto_policy(
        "Bash",
        &json!({"command": "git show origin/b:f.py | head -100"})
    )));
    // Gray-area Bash: the user's call — card.
    assert!(plan_auto_policy("Bash", &json!({"command": "cargo metadata"})).is_none());
    assert!(plan_auto_policy("Bash", &json!({"command": "rm -rf /"})).is_none());
    // Read-only research tools: allowed (plan mode denies them natively).
    assert!(allow(plan_auto_policy(
        "WebFetch",
        &json!({"url": "https://example.com"})
    )));
    assert!(allow(plan_auto_policy("WebSearch", &json!({"query": "x"}))));
    // AskUserQuestion: tier 2, but its card is the QUESTION itself, held
    // mid-turn (see `request_permission`) — auto-allowing would run the
    // tool headless, which returns no answer, so the model would guess
    // instead of blocking on the user.
    assert!(plan_auto_policy(
        "AskUserQuestion",
        &json!({"questions": [{"question": "Which?", "options": []}]})
    )
    .is_none());
    // File edits: denied — this branch IS plan mode's edit block once a
    // permission tool is configured.
    for tool in ["Write", "Edit", "MultiEdit", "NotebookEdit"] {
        assert!(
            deny(plan_auto_policy(tool, &json!({"file_path": "/x"}))),
            "{tool}"
        );
    }
    // ExitPlanMode and unknown tools: the user's call — card.
    assert!(plan_auto_policy("ExitPlanMode", &json!({"plan": "x"})).is_none());
    assert!(plan_auto_policy("mcp__foo__bar", &json!({})).is_none());
}

fn answer(answers: &[&str], approve: bool, note: Option<&str>) -> PromptAnswer {
    PromptAnswer {
        session_id: "s".into(),
        prompt_id: "p".into(),
        approve,
        resume_mode: None,
        answers: answers.iter().map(|s| s.to_string()).collect(),
        note: note.map(str::to_string),
        annotations: Vec::new(),
    }
}

#[test]
fn annotation_only_question_has_a_clean_answer_echo() {
    let prompt = WirePrompt {
        kind: "question".into(),
        ..Default::default()
    };
    let mut response = answer(&[], true, None);
    response.annotations = vec![TextAnnotation {
        text: "selected excerpt".into(),
    }];
    ensure_annotation_answer_display(&prompt, &mut response);
    assert_eq!(response.note.as_deref(), Some("Asked about selected text"));
}

#[test]
fn stamp_resolved_records_the_answer_echo() {
    let mut prompt = WirePrompt {
        kind: "question".into(),
        ..Default::default()
    };
    let mut response = answer(&["Core patching science"], true, Some("go deep"));
    response.annotations = vec![TextAnnotation {
        text: "selected excerpt".into(),
    }];
    stamp_resolved(&mut prompt, Some(&response));
    assert!(prompt.resolved);
    assert_eq!(prompt.answers, vec!["Core patching science"]);
    assert_eq!(prompt.approved, Some(true));
    assert_eq!(prompt.note.as_deref(), Some("go deep"));
    assert_eq!(prompt.annotations[0].text, "selected excerpt");

    // A whitespace-only note is dropped, a denial echoes approved=false.
    let mut prompt = WirePrompt {
        kind: "permission".into(),
        ..Default::default()
    };
    stamp_resolved(&mut prompt, Some(&answer(&[], false, Some("   "))));
    assert!(prompt.resolved);
    assert_eq!(prompt.approved, Some(false));
    assert_eq!(prompt.note, None);
}

#[test]
fn stamp_resolved_without_answer_preserves_an_earlier_echo() {
    // A stale-card cleanup (PendingGuard drop, resolve_stale_prompts) runs
    // with no answer; re-resolving must not erase what the user chose.
    let mut prompt = WirePrompt {
        kind: "question".into(),
        ..Default::default()
    };
    stamp_resolved(&mut prompt, Some(&answer(&["A"], true, None)));
    stamp_resolved(&mut prompt, None);
    assert!(prompt.resolved);
    assert_eq!(prompt.answers, vec!["A"]);
    assert_eq!(prompt.approved, Some(true));
}

fn bare_session() -> StoredChatSession {
    StoredChatSession {
        id: "chat_1".into(),
        project_id: "proj_1".into(),
        harness: "claude-code".into(),
        native_session_id: None,
        title: None,
        title_source: None,
        model: Some("claude-haiku-4-5".into()),
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
    }
}

#[test]
fn target_recovery_keeps_session_ownership_and_message_metadata() {
    let dir = std::env::temp_dir().join(format!("orx-target-recovery-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let session = bare_session();
    store.create_chat_session(&session).unwrap();
    let stored = StoredChatMessage {
        id: "target".into(),
        session_id: session.id.clone(),
        role: "assistant".into(),
        parts_json: serde_json::to_string(&vec![WirePart::tool("tool", "bash", "running", None)])
            .unwrap(),
        created_at: 1,
        completed_at: None,
        parent_id: Some("root".into()),
        base_native_session_id: Some("base".into()),
        result_native_session_id: Some("result".into()),
    };
    store.upsert_chat_message(&stored).unwrap();
    assert!(reconcile_target_message(&store, "another-session", "target", "").is_none());
    assert_eq!(
        store
            .get_chat_message("target")
            .unwrap()
            .unwrap()
            .parts_json,
        stored.parts_json
    );
    assert!(reconcile_target_message(&store, &session.id, "missing", "").is_none());
    let recovered = reconcile_target_message(&store, &session.id, "target", "").unwrap();
    assert_eq!(
        recovered.parts[0].state.as_ref().unwrap().status,
        "interrupted"
    );
    let saved = store.get_chat_message("target").unwrap().unwrap();
    assert_eq!(saved.parent_id, stored.parent_id);
    assert_eq!(saved.base_native_session_id, stored.base_native_session_id);
    assert_eq!(
        saved.result_native_session_id,
        stored.result_native_session_id
    );
    assert_eq!(saved.created_at, stored.created_at);
    assert_eq!(saved.completed_at, stored.completed_at);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "synthetic lookup benchmark; run explicitly with --ignored --nocapture"]
fn target_message_lookup_benchmark() {
    let dir = std::env::temp_dir().join(format!("orx-target-bench-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store.create_chat_session(&bare_session()).unwrap();
    let payload = serde_json::to_string(&vec![WirePart::text("text", "x".repeat(4096))]).unwrap();
    let tx = store.begin().unwrap();
    for i in 0..5000 {
        tx.execute("INSERT INTO chat_messages(id,session_id,role,parts_json,created_at) VALUES(?1,'chat_1','assistant',?2,?3)", rusqlite::params![format!("m{i}"), payload, i]).unwrap();
    }
    tx.commit().unwrap();
    let started = Instant::now();
    for _ in 0..20 {
        let all = store.list_chat_messages("chat_1").unwrap();
        assert!(std::hint::black_box(all).iter().any(|m| m.id == "m2500"));
    }
    let old = started.elapsed();
    let started = Instant::now();
    for _ in 0..20 {
        let message = store.get_chat_message("m2500").unwrap().unwrap();
        assert_eq!(std::hint::black_box(message).session_id, "chat_1");
    }
    eprintln!("target lookup: rows=5000 rounds=20 list_and_find_ms={:.3} indexed_ms={:.3} old_payload_bytes_per_lookup={} indexed_payload_bytes_per_lookup={}",old.as_secs_f64()*1000.0,started.elapsed().as_secs_f64()*1000.0,5000*payload.len(),payload.len());
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn opencode_fallback_compaction_requires_a_model() {
    let host = test_host();
    let mut session = bare_session();
    session.harness = "opencode".into();
    let harness = crate::local::harness::chat_harness("opencode").unwrap();
    for model in [None, Some("  ".into())] {
        session.model = model;
        let error = host
            .compaction_summary(&session, harness.as_ref(), "history")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Select an OpenCode model"));
    }
}

#[test]
fn missing_opencode_compaction_model_leaves_history_unchanged() {
    const CHILD: &str = "ORX_TEST_MISSING_COMPACTION_MODEL";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let host = Arc::new(test_host());
            let store = Store::open().unwrap();
            for (index, (model, native_id)) in [
                (None, None),
                (Some("  ".to_string()), None),
                (None, Some("native".to_string())),
                (Some("  ".to_string()), Some("native".to_string())),
            ]
            .into_iter()
            .enumerate()
            {
                let mut session = bare_session();
                session.id = format!("missing-model-{index}");
                session.harness = "opencode".into();
                session.model = model;
                session.native_session_id = native_id;
                session.archived = true;
                session.bootstrap_context = Some("earlier context".into());
                session.context_usage_json = Some(r#"{"usedTokens":9000}"#.into());
                store.create_chat_session(&session).unwrap();
                store
                    .upsert_chat_message_on_branch(&StoredChatMessage {
                        id: format!("message-{index}"),
                        session_id: session.id.clone(),
                        role: "user".into(),
                        parts_json: serde_json::to_string(&vec![WirePart::text(
                            "text",
                            "History to preserve",
                        )])
                        .unwrap(),
                        created_at: 1,
                        completed_at: Some(1),
                        parent_id: None,
                        base_native_session_id: None,
                        result_native_session_id: None,
                    })
                    .unwrap();
                store
                    .set_chat_session_context_usage(
                        &session.id,
                        session.context_usage_json.as_deref().unwrap(),
                    )
                    .unwrap();
                let before = store.list_chat_messages(&session.id).unwrap();
                let error = host.compact_session(&session.id).await.unwrap_err();
                assert!(
                    error.to_string().contains("Select an OpenCode model"),
                    "{error}"
                );
                let after = store.list_chat_messages(&session.id).unwrap();
                assert_eq!(after.len(), before.len());
                assert_eq!(after[0].id, before[0].id);
                assert_eq!(after[0].parts_json, before[0].parts_json);
                let saved = store.get_chat_session(&session.id).unwrap().unwrap();
                assert_eq!(saved.native_session_id, session.native_session_id);
                assert_eq!(saved.bootstrap_context, session.bootstrap_context);
                assert_eq!(saved.context_usage_json, session.context_usage_json);
                assert!(saved.archived);
            }
        });
        return;
    }
    let fixture =
        crate::local::git::TemporaryDirectory::new("orx-missing-compaction-model").unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "local::chat::bridge_tests::missing_opencode_compaction_model_leaves_history_unchanged",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env("ORX_DATA_DIR", fixture.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn session_json_includes_context_usage_when_set_null_otherwise() {
    // No usage stored → the field is JSON null.
    let session = bare_session();
    assert!(session_json(&session, false)["contextUsage"].is_null());

    // Stored usage is inlined as a parsed object, not a string.
    let mut with_usage = bare_session();
    with_usage.context_usage_json = Some(r#"{"usedTokens":27564,"contextWindow":200000}"#.into());
    let value = session_json(&with_usage, false);
    assert_eq!(value["contextUsage"]["usedTokens"], 27564);
    assert_eq!(value["contextUsage"]["contextWindow"], 200000);
}

#[test]
fn session_json_carries_title_source() {
    // The UI keys its title-reveal animation off this field, so it has to
    // survive to the wire — null on a legacy row, verbatim otherwise.
    assert!(session_json(&bare_session(), false)["titleSource"].is_null());

    let mut generated = bare_session();
    generated.title_source = Some("generated".into());
    assert_eq!(session_json(&generated, false)["titleSource"], "generated");
}

#[test]
fn session_json_exposes_plan_and_normalizes_invalid_permissions() {
    let mut session = bare_session();
    session.harness = "codex".into();
    session.permission_mode = Some("plan".into());
    session.plan_mode = true;
    let value = session_json(&session, false);
    assert_eq!(value["permissionMode"], "approve-for-me");
    assert_eq!(value["planMode"], true);
    assert!(value["serviceTier"].is_null());
}

#[test]
fn queued_overrides_keep_the_last_explicit_value_on_each_axis() {
    let first = TurnOverrides {
        model: Some("first-model".into()),
        clear_model: false,
        service_tier: Some("priority".into()),
        permission_mode: Some("ask".into()),
        permission_revision: Some(1),
        plan_mode: Some(true),
        plan_revision: Some(1),
        reasoning_level: Some("high".into()),
    };
    let second = TurnOverrides {
        model: Some("second-model".into()),
        clear_model: false,
        service_tier: None,
        permission_mode: None,
        permission_revision: None,
        plan_mode: None,
        plan_revision: None,
        reasoning_level: Some("low".into()),
    };
    let mut merged = TurnOverrides::default();
    merged.apply_explicit(&first);
    merged.apply_explicit(&second);

    assert_eq!(merged.model.as_deref(), Some("second-model"));
    assert_eq!(merged.service_tier.as_deref(), Some("priority"));
    assert_eq!(merged.permission_mode.as_deref(), Some("ask"));
    assert_eq!(merged.plan_mode, Some(true));
    assert_eq!(merged.reasoning_level.as_deref(), Some("low"));

    let leave_plan = TurnOverrides {
        plan_mode: Some(false),
        ..Default::default()
    };
    merged.apply_explicit(&leave_plan);
    assert_eq!(merged.plan_mode, Some(false));

    merged.apply_explicit(&TurnOverrides {
        clear_model: true,
        ..Default::default()
    });
    assert_eq!(merged.model, None);
    assert!(merged.clear_model);
    merged.apply_explicit(&TurnOverrides {
        model: Some("new-model".into()),
        ..Default::default()
    });
    assert_eq!(merged.model.as_deref(), Some("new-model"));
    assert!(!merged.clear_model);
}

#[test]
fn detached_queue_plan_change_defers_to_a_newer_revision() {
    let changes = HashMap::from([("session".to_string(), (2, false))]);
    assert_eq!(
        resolve_plan_change(&changes, "session", true, Some(1)),
        (2, false)
    );
    assert_eq!(changes["session"], (2, false));
}

#[test]
fn detached_queue_permission_defers_to_a_newer_selection() {
    let changes = HashMap::from([("session".to_string(), (2, "plan".to_string()))]);
    assert_eq!(
        resolve_permission_change(&changes, "session", "auto".into(), Some(1)),
        (2, "plan".to_string())
    );
}

#[test]
fn context_usage_serde_camel_cases_and_skips_none() {
    let usage = ContextUsage {
        used_tokens: 100,
        context_window: None,
    };
    // Only usedTokens survives; the None window is skipped.
    assert_eq!(
        serde_json::to_value(&usage).unwrap(),
        json!({ "usedTokens": 100 })
    );
}
