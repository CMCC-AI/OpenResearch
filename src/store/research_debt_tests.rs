#[test]
fn rerun_requires_current_attempt_acknowledgement_for_unchanged_files() {
    let (dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "old-designer");
    finish(&store, &study, "design");
    let old = store
        .research_study(&study.id)
        .unwrap()
        .task("design")
        .unwrap()
        .artifacts[0]
        .sha256
        .clone();
    let mut next = plan();
    next.tasks[0].force_rerun = true;
    store.research_set_plan(&study.id, next).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "new-designer");
    // Binding and restarting never erase the original or lose the baseline.
    drop(store);
    let store = Store::open_at(dir.path().to_path_buf()).unwrap();
    assert!(store
        .research_auto_finish(&study.id, "design", "no new files".into())
        .is_err());
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .task("design")
            .unwrap()
            .state,
        "running"
    );
    // An explicit finish acknowledges valid same-byte results for this attempt.
    store
        .research_finish(
            &study.id,
            "design",
            true,
            "verified this attempt; identical result".into(),
        )
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("design").unwrap().artifacts[0].sha256, old);
    assert_eq!(
        saved.task("design").unwrap().session_id.as_deref(),
        Some("new-designer")
    );
}

#[test]
fn retry_rejects_partial_stale_outputs_but_accepts_changed_outputs() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[0].outputs.push("second.md".into());
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "first");
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("design.md"), "old").unwrap();
    std::fs::write(root.join("second.md"), "old second").unwrap();
    store
        .research_finish(&study.id, "design", false, "failed after writing".into())
        .unwrap();
    store.research_retry_task(&study.id, "design").unwrap();
    bind(&store, &study, "design", "second");
    std::fs::write(root.join("design.md"), "new").unwrap();
    assert!(store
        .research_auto_finish(&study.id, "design", "partial".into())
        .is_err());
    std::fs::write(root.join("second.md"), "new second").unwrap();
    store
        .research_auto_finish(&study.id, "design", "complete".into())
        .unwrap();
}

#[test]
fn completed_delivery_reconciliation_does_not_rewrite_unchanged_study() {
    let (_dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        bind(&store, &study, task, task);
        finish(&store, &study, task);
    }
    crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
    approve(&store, &study, "G4");
    store.conn.execute_batch("CREATE TEMP TABLE debt_writes(n INTEGER); CREATE TEMP TRIGGER debt_update AFTER UPDATE ON main.research_studies BEGIN INSERT INTO debt_writes VALUES(1); END;").unwrap();
    for _ in 0..2 {
        crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
    }
    let writes: i64 = store
        .conn
        .query_row("SELECT COUNT(*) FROM debt_writes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(writes, 0);
    // Integrity validation is retained even after approval.
    std::fs::write(
        store.research_root(&study).unwrap().join("design.md"),
        "changed",
    )
    .unwrap();
    crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
    assert!(store
        .research_study(&study.id)
        .unwrap()
        .decisions
        .iter()
        .any(|d| d.gate == "G4" && d.status == "superseded"));
}

#[test]
fn blocked_dispatch_exposes_reason_and_does_not_starve_independent_task() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input
        .tasks
        .insert(1, spec("blocked", "as-experiment-designer", &["design"]));
    input
        .tasks
        .insert(2, spec("independent", "as-experiment-designer", &[]));
    input.tasks[3]
        .depends_on
        .extend(["blocked".into(), "independent".into()]);
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "designer");
    finish(&store, &study, "design");
    std::fs::write(
        store.research_root(&study).unwrap().join("design.md"),
        "changed",
    )
    .unwrap();
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert!(dispatched.iter().any(|(task, _)| task == "independent"));
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("blocked").unwrap().state, "pending");
    assert!(saved
        .task("blocked")
        .unwrap()
        .summary
        .as_ref()
        .unwrap()
        .contains("前置产物已变化"));
}

#[test]
fn delivery_checks_are_throttled_but_decisions_always_validate_current_files() {
    use crate::commands::research_dispatch::{reconcile_active_studies_with_checks, PackageChecks};
    let (_dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        bind(&store, &study, task, task);
        finish(&store, &study, task);
    }
    let mut checks = PackageChecks::new();
    reconcile_active_studies_with_checks(&store, &mut checks).unwrap();
    let before = store.research_study(&study.id).unwrap();
    let decision = before.decisions.iter().find(|d| d.gate == "G4").unwrap();
    std::fs::write(
        store.research_root(&study).unwrap().join("design.md"),
        "changed",
    )
    .unwrap();
    reconcile_active_studies_with_checks(&store, &mut checks).unwrap();
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .decisions
            .last()
            .unwrap()
            .status,
        "pending"
    );
    assert!(store
        .research_decide(
            &study.id,
            &decision.id,
            &decision.scope_hash,
            true,
            "stale click".into()
        )
        .is_err());
    checks.get_mut(&study.id).unwrap().1 =
        std::time::Instant::now() - std::time::Duration::from_secs(61);
    reconcile_active_studies_with_checks(&store, &mut checks).unwrap();
    assert!(store
        .research_study(&study.id)
        .unwrap()
        .decisions
        .iter()
        .any(|d| d.gate == "G4" && d.status == "superseded"));
}

#[test]
fn plan_inheritance_invalidates_changed_brief_and_transitive_reviews_only() {
    for changed_id in ["design", "review", "audit"] {
        let (_dir, store, study) = setup();
        let mut input = plan();
        input
            .tasks
            .insert(1, spec("independent", "as-experiment-designer", &[]));
        input.tasks[2].depends_on.push("independent".into());
        store.research_set_plan(&study.id, input.clone()).unwrap();
        approve(&store, &study, "G1");
        for id in ["design", "independent", "review", "audit"] {
            bind(&store, &study, id, &format!("{id}-v1"));
            finish(&store, &study, id);
        }
        let completed = store.research_study(&study.id).unwrap();
        let scope = store.research_package_scope(&completed).unwrap();
        store
            .research_update(&study.id, |s| s.request_gate("G4", scope))
            .unwrap();
        approve(&store, &study, "G4");
        let before = store.research_study(&study.id).unwrap();
        let history = serde_json::to_value(before.plan().unwrap()).unwrap();
        let delivery = before
            .decisions
            .iter()
            .find(|d| d.gate == "G4")
            .unwrap()
            .clone();
        input
            .tasks
            .iter_mut()
            .find(|t| t.id == changed_id)
            .unwrap()
            .brief = "Use a different dataset and evaluation criterion".into();
        store.research_set_plan(&study.id, input).unwrap();
        let revised = store.research_study(&study.id).unwrap();
        assert_eq!(serde_json::to_value(&revised.plans[0]).unwrap(), history);
        assert_eq!(revised.plan().unwrap().version, 2);
        for id in ["design", "independent", "review", "audit"] {
            let invalidated = id == changed_id
                || (changed_id == "design" && matches!(id, "review" | "audit"))
                || (changed_id == "review" && id == "audit");
            let task = revised.task(id).unwrap();
            if invalidated {
                assert_eq!(task.state, "pending", "{changed_id} -> {id}");
                assert!(task.session_id.is_none());
                assert!(task.artifacts.is_empty());
                assert!(task.output_baseline.is_none());
                assert_eq!(
                    store
                        .research_session_task(&format!("{id}-v1"))
                        .unwrap()
                        .unwrap()
                        .1,
                    1
                );
            } else {
                assert_eq!(task.state, "completed", "{changed_id} -> {id}");
                assert_eq!(
                    task.session_id.as_deref(),
                    Some(format!("{id}-v1").as_str())
                );
                assert_eq!(
                    store
                        .research_session_task(&format!("{id}-v1"))
                        .unwrap()
                        .unwrap()
                        .1,
                    2
                );
            }
            let old = &before.task(id).unwrap().artifacts[0];
            assert_eq!(
                digest(&read_artifact(&store.research_root(&revised).unwrap(), &old.path).unwrap()),
                old.sha256
            );
        }
        assert!(
            revised.ready(changed_id).is_err(),
            "new G1 must be required"
        );
        approve(&store, &study, "G1");
        let approved = store.research_study(&study.id).unwrap();
        assert!(approved.ready(changed_id).is_ok());
        assert!(store.research_package_scope(&approved).is_err());
        assert!(store
            .research_decide(
                &study.id,
                &delivery.id,
                &delivery.scope_hash,
                true,
                "stale confirmation".into()
            )
            .is_err());
    }
}

#[test]
fn plan_inheritance_preserves_all_completed_tasks_for_summary_only_changes() {
    let (_dir, store, study) = setup();
    let input = plan();
    store.research_set_plan(&study.id, input.clone()).unwrap();
    approve(&store, &study, "G1");
    for id in ["design", "review", "audit"] {
        bind(&store, &study, id, id);
        finish(&store, &study, id);
    }
    let mut revised = input;
    revised.summary = "Clarify the display summary without changing task instructions".into();
    store.research_set_plan(&study.id, revised).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert!(saved
        .plan()
        .unwrap()
        .tasks
        .iter()
        .all(|t| t.state == "completed"));
    assert!(saved.ready("design").is_err());
    approve(&store, &study, "G1");
    assert!(store
        .research_package_scope(&store.research_study(&study.id).unwrap())
        .is_ok());
}

#[test]
fn plan_inheritance_invalidates_matching_tasks_when_effective_workflow_changes() {
    for routed_before in [false, true] {
        let (_dir, store, study) = setup();
        let mut input = preset_plan("analysis");
        input.workflow = routed_before.then(|| "analysis".into());
        store.research_set_plan(&study.id, input.clone()).unwrap();
        approve(&store, &study, "G1");
        for task in &input.tasks {
            bind(&store, &study, &task.id, &task.id);
            finish(&store, &study, &task.id);
        }
        input.workflow = (!routed_before).then(|| "analysis".into());
        store.research_set_plan(&study.id, input).unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert!(saved
            .plan()
            .unwrap()
            .tasks
            .iter()
            .all(|t| t.state == "pending" && t.session_id.is_none()));
    }
}

#[test]
fn plan_inheritance_normalizes_legacy_and_explicit_same_manual_workflow() {
    let (_dir, store, _) = setup();
    store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('manual','project','codex',1,1)", []).unwrap();
    let study = store
        .research_create("manual", "proposal", "manual proposal")
        .unwrap();
    let mut input = preset_plan("proposal");
    store.research_set_plan(&study.id, input.clone()).unwrap();
    approve(&store, &study, "G1");
    for task in &input.tasks {
        bind(&store, &study, &task.id, &task.id);
        finish(&store, &study, &task.id);
    }
    input.workflow = Some("proposal".into());
    store.research_set_plan(&study.id, input.clone()).unwrap();
    assert!(store
        .research_study(&study.id)
        .unwrap()
        .plan()
        .unwrap()
        .tasks
        .iter()
        .all(|t| t.state == "completed"));
    approve(&store, &study, "G1");
    input.workflow = None;
    store.research_set_plan(&study.id, input).unwrap();
    assert!(store
        .research_study(&study.id)
        .unwrap()
        .plan()
        .unwrap()
        .tasks
        .iter()
        .all(|t| t.state == "completed"));
}
