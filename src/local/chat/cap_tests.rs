use super::*;

#[test]
fn session_path_names_are_injective_for_punctuation() {
    assert_ne!(safe_session_name("a/b"), safe_session_name("ab"));
    assert!(!safe_session_name("...").is_empty());
}

// BASH_ENV hooks over POSIX paths; Git Bash sees a different filesystem root.
#[cfg(unix)]
#[test]
fn shell_hooks_tolerate_nounset_and_preserve_spaced_bash_env() {
    let root = std::env::temp_dir().join(format!("orx-shell-hook-{}", uuid::Uuid::new_v4()));
    let hook_dir = root.join("path with space");
    std::fs::create_dir_all(&hook_dir).unwrap();
    let user_hook = hook_dir.join("user_hook");
    std::fs::write(&user_hook, "set -u\nexport ORX_USER_HOOK_LOADED=yes\n").unwrap();
    let shim = root.join("bash_env");
    std::fs::write(
        &shim,
        bash_env_hook(Some("$ORX_TEST_HOME/path with space/user_hook".into())),
    )
    .unwrap();

    let output = std::process::Command::new("bash")
        .arg("-c")
        .arg("printf '%s' \"$ORX_USER_HOOK_LOADED\"")
        .env("BASH_ENV", &shim)
        .env("ORX_TEST_HOME", &root)
        .env_remove(CHAT_TARGET_FILE_ENV)
        .env_remove(CHAT_TARGET_POINTER_ENV)
        .output()
        .unwrap();

    let _ = std::fs::remove_dir_all(root);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "yes");
    assert!(zshenv_hook(std::path::Path::new("/tmp")).contains("${ORX_CHAT_TARGET_FILE-}"));
    assert!(bash_env_hook(None).contains("${BASH_EXECUTION_STRING-}"));
    assert!(zshenv_hook(std::path::Path::new("/tmp")).contains("${ZSH_EXECUTION_STRING-}"));
}

#[cfg(unix)]
fn write_orx_stub(dir: &std::path::Path, marker: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).unwrap();
    let bin = dir.join("orx");
    std::fs::write(&bin, format!("#!/bin/sh\nprintf '%s' {marker}\n")).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A stale `orx` on a directory a user startup file prepends, ahead of the
/// one `prepare_env` fronted.
#[cfg(unix)]
fn path_guard_fixture(root: &std::path::Path) -> (PathBuf, String, String) {
    let ours = root.join("ours");
    let decoy = root.join("decoy");
    write_orx_stub(&ours, "ours");
    write_orx_stub(&decoy, "decoy");
    let path = format!(
        "{}:{}",
        ours.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let prepend_decoy = format!("export PATH=\"{}:$PATH\"\n", decoy.display());
    (ours, path, prepend_decoy)
}

/// The hooks branch on the chat target vars, which a `cargo test` run from
/// inside a chat session would otherwise inherit; interactive zsh wants a
/// `TERM` it can name.
#[cfg(unix)]
fn shell_output(mut cmd: std::process::Command) -> String {
    let out = cmd
        .env_remove(CHAT_TARGET_FILE_ENV)
        .env_remove(CHAT_TARGET_POINTER_ENV)
        .env("TERM", "dumb")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[cfg(unix)]
#[test]
fn path_guard_refronts_orx_after_a_bash_hook_prepends_its_own_bin() {
    let root = std::env::temp_dir().join(format!("orx-path-guard-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (ours, path, prepend_decoy) = path_guard_fixture(&root);
    let user_hook = root.join("user_hook");
    std::fs::write(&user_hook, prepend_decoy).unwrap();
    let shim = root.join("bash_env");
    std::fs::write(
        &shim,
        bash_env_hook(Some(user_hook.to_string_lossy().into_owned())),
    )
    .unwrap();

    let run = |bin_dir: Option<&std::path::Path>| {
        let mut cmd = std::process::Command::new("bash");
        cmd.args(["-c", "orx"])
            .env("BASH_ENV", &shim)
            .env("PATH", &path);
        match bin_dir {
            Some(dir) => cmd.env(BIN_DIR_ENV, dir),
            None => cmd.env_remove(BIN_DIR_ENV),
        };
        shell_output(cmd)
    };
    let guarded = run(Some(&ours));
    let unguarded = run(None);

    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(guarded, "ours");
    assert_eq!(unguarded, "decoy", "the user hook's prepend never ran");
}

#[cfg(unix)]
#[test]
fn path_guard_refronts_orx_after_a_zsh_startup_file_prepends_its_own_bin() {
    if !std::process::Command::new("zsh")
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
    {
        eprintln!("skipping: no usable zsh on this machine");
        return;
    }
    let root = std::env::temp_dir().join(format!("orx-path-guard-{}", uuid::Uuid::new_v4()));
    let user_dir = root.join("user");
    let shim_dir = root.join("shim");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::create_dir_all(&shim_dir).unwrap();
    let (ours, path, prepend_decoy) = path_guard_fixture(&root);
    // Every startup file a tool shell can read prepends the decoy, so each
    // one's guard has to answer for itself.
    for name in [".zshrc", ".zprofile", ".zlogin"] {
        std::fs::write(user_dir.join(name), &prepend_decoy).unwrap();
        std::fs::write(shim_dir.join(name), zsh_startup_wrapper(name)).unwrap();
    }
    std::fs::write(shim_dir.join(".zshenv"), zshenv_hook(&user_dir)).unwrap();

    // `-d` drops the machine's own global rc files. A harness spells its tool
    // shell `-lc`; one snapshotting the user's shell reaches `.zshrc` instead.
    let run = |mode: &str, bin_dir: Option<&std::path::Path>| {
        let mut cmd = std::process::Command::new("zsh");
        cmd.args([mode, "orx"])
            .env("ZDOTDIR", &shim_dir)
            .env("PATH", &path);
        match bin_dir {
            Some(dir) => cmd.env(BIN_DIR_ENV, dir),
            None => cmd.env_remove(BIN_DIR_ENV),
        };
        shell_output(cmd)
    };
    let guarded_login = run("-dlc", Some(&ours));
    let guarded_interactive = run("-dic", Some(&ours));
    let unguarded_login = run("-dlc", None);
    let unguarded_interactive = run("-dic", None);

    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(guarded_login, "ours");
    assert_eq!(guarded_interactive, "ours");
    assert_eq!(unguarded_login, "decoy");
    assert_eq!(unguarded_interactive, "decoy");
}

#[tokio::test]
async fn failed_setup_releases_reservation_after_lock_contention() {
    let host = Arc::new(ChatHost::new(
        Arc::new(AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));
    let guard = TurnGuard::reserve(&host, "session", &mut *host.turns.lock().await);
    let turns = host.turns.lock().await;
    drop(guard);
    drop(turns);

    tokio::time::timeout(Duration::from_secs(1), async {
        while host.turns.lock().await.contains_key("session") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn the_compaction_row_updates_in_place_rather_than_branching() {
    let dir = std::env::temp_dir().join(format!("orx-compact-row-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_chat_session(&StoredChatSession {
            id: "session".into(),
            project_id: "proj_1".into(),
            harness: "claude-code".into(),
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
    let host = Arc::new(ChatHost::new(
        Arc::new(AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));

    let running = host
        .publish_compaction_marker(&store, "session", None, "running", None)
        .unwrap();
    assert_eq!(running.parts[0].state.as_ref().unwrap().status, "running");
    assert!(running.completed_at.is_none());

    let done = host
        .publish_compaction_marker(&store, "session", Some(&running), "completed", None)
        .unwrap();
    assert_eq!(done.id, running.id, "the row is updated, not replaced");
    assert_eq!(done.parent_id, running.parent_id);
    assert!(done.completed_at.is_some());
    assert_eq!(done.parts[0].state.as_ref().unwrap().status, "completed");
    // One row on the branch: a second would read as a new branch root.
    assert_eq!(store.list_chat_messages("session").unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_adopted_row_records_the_agents_session() {
    let spoken = |role: &'static str, text: &str| crate::local::native_chats::NativeMessage {
        role,
        text: text.into(),
        created_at: 1_700_000_000_000,
    };
    let rows = imported_rows(
        "chat_1",
        "native-1",
        vec![spoken("user", "run it"), spoken("assistant", "done")],
    )
    .unwrap();

    assert_eq!(rows.len(), 3, "both messages plus the marker");
    assert_eq!(rows[0].parent_id, None);
    assert_eq!(rows[1].parent_id.as_deref(), Some(rows[0].id.as_str()));
    assert_eq!(rows[2].parent_id.as_deref(), Some(rows[1].id.as_str()));
    // The whole point: a rewind to the first row must resume the agent's
    // own session rather than clear it.
    assert!(rows
        .iter()
        .all(|row| row.base_native_session_id.as_deref() == Some("native-1")));
    assert_eq!(
        rows[2].result_native_session_id.as_deref(),
        Some("native-1"),
        "the leaf is what a branch switch reads",
    );
    assert_eq!(
        rows[0].created_at, 1_700_000_000_000,
        "kept when it was said"
    );
}

#[tokio::test]
async fn an_adopted_chat_is_only_adopted_once() {
    let dir = std::env::temp_dir().join(format!("orx-import-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    store
        .create_local_project(&crate::local::model::LocalProject {
            id: "proj_1".into(),
            name: "Test".into(),
            slug: "test".into(),
            github_owner: "owner".into(),
            github_repo: "repo".into(),
            github_sync_enabled: false,
            baseline_branch: "main".into(),
            repo_path: dir.join("repo").display().to_string(),
            run_command: None,
            paper_id: None,
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();

    // No transcript on disk: the marker-only shape an emptied rollout gives.
    let session = import_native_chat(&store, "proj_1", "claude-code", "native-1", None);
    assert!(session.is_err(), "a chat orx cannot read is not adopted");

    let adopted = StoredChatSession {
        id: "chat_1".into(),
        project_id: "proj_1".into(),
        harness: "claude-code".into(),
        native_session_id: Some("native-1".into()),
        title: Some("Adopted".into()),
        title_source: Some("user".into()),
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
    };
    store.create_chat_session(&adopted).unwrap();
    // Adopting the same chat again returns the session that already owns
    // it — two sessions driving one native chat would split the history.
    let again = import_native_chat(&store, "proj_1", "claude-code", "native-1", None).unwrap();
    assert_eq!(again.id, "chat_1");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_cancelled_compaction_row_is_failed_rather_than_left_running() {
    let mut parts = vec![
        WirePart::tool("compacted", COMPACTED_TOOL, "running", None),
        WirePart::tool("other", "bash", "running", None),
    ];
    fail_running_compaction(&mut parts);
    assert_eq!(parts[0].state.as_ref().unwrap().status, "error");
    assert_eq!(parts[1].state.as_ref().unwrap().status, "running");

    // A row that already settled keeps the status it settled with.
    let mut done = vec![WirePart::tool(
        "compacted",
        COMPACTED_TOOL,
        "completed",
        None,
    )];
    fail_running_compaction(&mut done);
    assert_eq!(done[0].state.as_ref().unwrap().status, "completed");
}

#[test]
fn the_reseed_hands_the_next_turn_a_summary_and_no_native_session() {
    let dir = std::env::temp_dir().join(format!("orx-compact-reseed-{}", uuid::Uuid::new_v4()));
    let store = Store::open_at(dir.clone()).unwrap();
    let mut session = StoredChatSession {
        id: "session".into(),
        project_id: "proj_1".into(),
        harness: "cursor".into(),
        native_session_id: Some("native-1".into()),
        title: None,
        title_source: None,
        model: None,
        service_tier: None,
        permission_mode: None,
        plan_mode: false,
        plan_reset_pending: false,
        reasoning_level: None,
        archived: true,
        context_usage_json: Some("{\"usedTokens\":9000}".into()),
        bootstrap_context: None,
        goal: None,
        autonomy: None,
        active_leaf_id: None,
        parent_session_id: None,
        side_parent_session_id: None,
        side_parent_leaf_id: None,
        created_at: 1,
        updated_at: 1,
    };
    store.create_chat_session(&session).unwrap();
    let host = Arc::new(ChatHost::new(
        Arc::new(AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));

    host.apply_compaction(&store, "session", Some("the summary".into()))
        .unwrap();

    session = store.get_chat_session("session").unwrap().unwrap();
    assert_eq!(session.bootstrap_context.as_deref(), Some("the summary"));
    // Without clearing the native id the summary is never injected.
    assert_eq!(session.native_session_id, None);
    assert_eq!(session.context_usage_json, None);
    assert!(
        !session.archived,
        "compacting is activity, which unarchives"
    );
    assert!(with_turn_context(
        session.native_session_id.as_deref(),
        session.bootstrap_context.as_deref(),
        None,
        None,
        None,
        None,
        "next".into(),
    )
    .contains("the summary"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn compaction_refuses_to_run_during_a_turn() {
    let host = Arc::new(ChatHost::new(
        Arc::new(AgentHost::new(None)),
        Arc::new(crate::local::codex::CodexHost::new()),
        Arc::new(crate::local::claude::ClaudeHost::new()),
    ));
    host.turns.lock().await.insert(
        "session".into(),
        TurnState::Reserved {
            turn_id: None,
            reservation_id: uuid::Uuid::new_v4().to_string(),
        },
    );

    let error = host
        .compact_session("session")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("busy"), "unexpected error: {error}");
    // The live turn's slot survives the refusal.
    assert!(host.turns.lock().await.contains_key("session"));
}

#[test]
fn cap_tool_text_truncates_and_is_idempotent() {
    let mut short = "hello".to_string();
    cap_tool_text(&mut short);
    assert_eq!(short, "hello");

    let mut long = "x".repeat(TOOL_TEXT_CAP + 1);
    cap_tool_text(&mut long);
    assert_eq!(long.chars().count(), TOOL_TEXT_CAP);
    assert!(long.contains(TOOL_TEXT_TRUNCATION_MARKER));
    assert!(long.starts_with('x'));
    assert!(long.ends_with('x'));

    // Re-capping a capped string must not shave it further.
    let capped = long.clone();
    cap_tool_text(&mut long);
    assert_eq!(long, capped);

    long.push_str("terminal error");
    cap_tool_text(&mut long);
    assert_eq!(long.chars().count(), TOOL_TEXT_CAP);
    assert!(long.ends_with("terminal error"));

    // Multi-byte chars: truncation lands on a char boundary.
    let mut wide = "é".repeat(TOOL_TEXT_CAP * 2);
    cap_tool_text(&mut wide);
    assert_eq!(wide.chars().count(), TOOL_TEXT_CAP);
    assert!(wide.contains(TOOL_TEXT_TRUNCATION_MARKER));
    assert!(wide.ends_with('é'));
}

/// The per-flush pass caps `output` and `error` on tool parts and leaves
/// text parts alone. Nested sub-agent parts (`children`) are capped too.
#[test]
fn cap_tool_parts_caps_output_and_error() {
    let bloated_tool = |id: &str| WirePart {
        id: id.into(),
        kind: "tool".into(),
        text: None,
        tool: Some("Bash".into()),
        state: Some(WireToolState {
            status: "completed".into(),
            input: None,
            output: Some("y".repeat(1_000_000)),
            error: Some("e".repeat(1_000_000)),
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    };
    // A spawn part whose sub-agent transcript (a child) has huge output.
    let mut spawn = bloated_tool("spawn");
    spawn.tool = Some("subagent".into());
    spawn.children = vec![bloated_tool("sub-t1")];
    let mut parts = vec![
        WirePart::text("t0", "z".repeat(TOOL_TEXT_CAP * 2)),
        bloated_tool("t1"),
        spawn,
    ];
    cap_tool_parts(&mut parts);
    // Assistant prose is never capped — only tool payloads.
    assert_eq!(parts[0].text.as_ref().unwrap().len(), TOOL_TEXT_CAP * 2);
    let state = parts[1].state.as_ref().unwrap();
    assert_eq!(
        state.output.as_ref().unwrap().chars().count(),
        TOOL_TEXT_CAP
    );
    assert_eq!(state.error.as_ref().unwrap().chars().count(), TOOL_TEXT_CAP);
    // The nested sub-agent part's output is bounded by the recursion.
    let child_state = parts[2].children[0].state.as_ref().unwrap();
    assert_eq!(
        child_state.output.as_ref().unwrap().chars().count(),
        TOOL_TEXT_CAP
    );
}

#[test]
fn cap_tool_parts_preserves_semantic_targets() {
    let first = "11111111-1111-1111-1111-111111111111";
    let middle = "22222222-2222-2222-2222-222222222222";
    let last = "33333333-3333-3333-3333-333333333333";
    let output = format!(
        "[orx-run:{first}]\n{}\n[orx-run:{middle}]\n{}\n[orx-run:{last}]",
        "x".repeat(20_000),
        "y".repeat(20_000)
    );
    let mut parts = vec![WirePart {
        id: "logs".into(),
        kind: "tool".into(),
        text: None,
        tool: Some("bash".into()),
        state: Some(WireToolState {
            status: "completed".into(),
            input: Some(json!({ "command": "orx logs $id" })),
            output: Some(output),
            error: None,
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    }];

    cap_tool_parts(&mut parts);

    let state = parts[0].state.as_ref().unwrap();
    let output = state.output.as_ref().unwrap();
    assert!(output.chars().count() <= TOOL_TEXT_CAP);
    assert!(output.contains(TOOL_TEXT_TRUNCATION_MARKER));
    assert_eq!(
        state.input.as_ref().unwrap()["runTargetIds"],
        json!([first, middle, last])
    );
}

#[test]
fn semantic_targets_are_resource_specific_and_bounded() {
    let parent = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let latest_run = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let mut output = format!(
        "id: 11111111-1111-1111-1111-111111111111\nparent: {parent}\nlast run: {latest_run}\n"
    );
    for index in 0..300 {
        output.push_str(&format!(
            "[orx-experiment:{index:08x}-1111-1111-1111-111111111111]\n"
        ));
    }
    let mut state = WireToolState {
        status: "completed".into(),
        input: Some(json!({ "arguments": { "cmd": "orx exp status $id" } })),
        output: Some(output),
        error: None,
        title: None,
    };

    preserve_tool_targets(&mut state);

    let targets = state.input.as_ref().unwrap()["experimentTargetIds"]
        .as_array()
        .unwrap();
    assert_eq!(targets.len(), TOOL_TARGET_CAP);
    assert!(!targets.iter().any(|value| value == parent));
    assert!(!targets.iter().any(|value| value == latest_run));
}

#[test]
fn semantic_markers_are_authoritative_and_preserve_newlines() {
    let target = "11111111-1111-1111-1111-111111111111";
    let mentioned = "22222222-2222-2222-2222-222222222222";
    let mut state = WireToolState {
        status: "error".into(),
        input: Some(json!({ "command": "orx logs $id" })),
        output: Some(format!(
            "[orx-run:{target}]\nfirst line\n/runs/{mentioned}\n"
        )),
        error: None,
        title: None,
    };

    preserve_tool_targets(&mut state);

    assert_eq!(
        state.input.as_ref().unwrap()["runTargetIds"],
        json!([target])
    );
    let expected = format!("first line\n/runs/{mentioned}\n");
    assert_eq!(state.output.as_deref(), Some(expected.as_str()));
}

#[test]
fn semantic_markers_beyond_legacy_scan_limit_are_preserved() {
    let target = "11111111-1111-1111-1111-111111111111";
    let mut state = WireToolState {
        status: "completed".into(),
        input: Some(json!({ "command": "orx logs $id" })),
        output: Some(format!(
            "{}\n[orx-run:{target}]\n",
            "x".repeat(TOOL_TARGET_SCAN_BYTES + 1)
        )),
        error: None,
        title: None,
    };

    preserve_tool_targets(&mut state);

    assert_eq!(
        state.input.as_ref().unwrap()["runTargetIds"],
        json!([target])
    );
    assert!(!state.output.as_ref().unwrap().contains("[orx-run:"));
}

#[test]
fn out_of_band_target_attaches_to_latest_matching_tool() {
    let target = "11111111-1111-1111-1111-111111111111";
    let mut parts = vec![WirePart {
        id: "logs".into(),
        kind: "tool".into(),
        text: None,
        tool: Some("bash".into()),
        state: Some(WireToolState {
            status: "completed".into(),
            input: Some(json!({ "command": "id=$(lookup); orx logs \"$id\"" })),
            output: Some("ordinary log content".into()),
            error: None,
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    }];

    assert!(!attach_target_event(
        &mut parts,
        None,
        &HashSet::new(),
        "id=$(lookup); orx logs \"$id\"",
        "",
        "runs",
        target,
    )
    .is_empty());
    let input = parts[0].state.as_ref().unwrap().input.as_ref().unwrap();
    assert_eq!(input["runTargetIds"], json!([target]));
    assert_eq!(input["runTargetIdsAuthoritative"], true);
}

#[test]
fn identical_parallel_commands_are_left_unattributed() {
    let target = "11111111-1111-1111-1111-111111111111";
    let make_part = |id: &str| WirePart {
        id: id.into(),
        kind: "tool".into(),
        text: None,
        tool: Some("bash".into()),
        state: Some(WireToolState {
            status: "completed".into(),
            input: Some(json!({ "command": "orx logs \"$id\"" })),
            output: None,
            error: None,
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    };
    let mut parts = vec![make_part("one"), make_part("two")];
    let claimed = HashSet::new();
    let ids = attach_target_event(
        &mut parts,
        None,
        &claimed,
        "orx logs \"$id\"",
        "",
        "runs",
        target,
    );
    assert!(ids.is_empty());

    for part in parts {
        let input = part.state.unwrap().input.unwrap();
        assert!(input["runTargetIds"].is_null());
    }
}

#[test]
fn target_cwd_disambiguates_parallel_commands() {
    let target = "11111111-1111-1111-1111-111111111111";
    let make_part = |id: &str, cwd: &str| WirePart {
        id: id.into(),
        kind: "tool".into(),
        text: None,
        tool: Some("bash".into()),
        state: Some(WireToolState {
            status: "completed".into(),
            input: Some(json!({ "command": "orx logs \"$id\"", "cwd": cwd })),
            output: None,
            error: None,
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    };
    let mut parts = vec![make_part("one", "/one"), make_part("two", "/two")];
    let mut ids = attach_target_event(
        &mut parts,
        None,
        &HashSet::new(),
        "orx logs \"$id\"",
        "/one",
        "runs",
        target,
    );

    ids.sort();
    assert_eq!(ids, vec!["one"]);
    assert_eq!(
        parts[0].state.as_ref().unwrap().input.as_ref().unwrap()["runTargetIds"],
        json!([target])
    );
    assert!(parts[1].state.as_ref().unwrap().input.as_ref().unwrap()["runTargetIds"].is_null());
}

#[test]
fn interrupted_reconciliation_settles_running_tools() {
    let mut parts = vec![WirePart {
        id: "running".into(),
        kind: "tool".into(),
        text: None,
        tool: Some("bash".into()),
        state: Some(WireToolState {
            status: "running".into(),
            input: None,
            output: None,
            error: None,
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    }];

    settle_interrupted_tool_parts(&mut parts);

    assert_eq!(parts[0].state.as_ref().unwrap().status, "interrupted");
}

#[test]
fn tool_upsert_preserves_out_of_band_targets() {
    let target = "11111111-1111-1111-1111-111111111111";
    let mut parts = vec![WirePart {
        id: "logs".into(),
        kind: "tool".into(),
        text: None,
        tool: Some("bash".into()),
        state: Some(WireToolState {
            status: "running".into(),
            input: Some(json!({
                "command": "orx logs $id",
                "runTargetIds": [target],
                "runTargetIdsAuthoritative": true
            })),
            output: None,
            error: None,
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    }];
    let replacement = WirePart {
        id: "logs".into(),
        kind: "tool".into(),
        text: None,
        tool: Some("bash".into()),
        state: Some(WireToolState {
            status: "completed".into(),
            input: Some(json!({ "command": "orx logs $id" })),
            output: Some("done".into()),
            error: None,
            title: None,
        }),
        prompt: None,
        phase: None,
        children: Vec::new(),
    };

    upsert_preserving_children(&mut parts, replacement);

    let input = parts[0].state.as_ref().unwrap().input.as_ref().unwrap();
    assert_eq!(input["runTargetIds"], json!([target]));
    assert_eq!(input["runTargetIdsAuthoritative"], true);
}

#[test]
fn later_marker_replaces_heuristic_targets() {
    let target = "11111111-1111-1111-1111-111111111111";
    let mentioned = "22222222-2222-2222-2222-222222222222";
    let mut state = WireToolState {
        status: "running".into(),
        input: Some(json!({ "command": "orx logs $id" })),
        output: Some(format!("/runs/{mentioned}\n")),
        error: None,
        title: None,
    };

    preserve_tool_targets(&mut state);
    assert_eq!(
        state.input.as_ref().unwrap()["runTargetIds"],
        json!([mentioned])
    );

    state
        .output
        .as_mut()
        .unwrap()
        .push_str(&format!("[orx-run:{target}]\n"));
    preserve_tool_targets(&mut state);

    assert_eq!(
        state.input.as_ref().unwrap()["runTargetIds"],
        json!([target])
    );
    assert_eq!(
        state.input.as_ref().unwrap()["runTargetIdsAuthoritative"],
        true
    );
}
