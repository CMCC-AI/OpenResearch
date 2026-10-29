fn settlement_fixture() -> (TestDir, Store, Study, String) {
    let (dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    let session = crate::commands::research_dispatch::dispatch_study_task_sync(
        &store, &study.id, "design", None,
    )
    .unwrap()
    .unwrap();
    store
        .conn
        .execute(
            "UPDATE chat_spawns SET state='running',finished_at=1 WHERE session_id=?1",
            [&session],
        )
        .unwrap();
    (dir, store, study, session)
}

#[test]
fn research_settlement_persistence_errors_do_not_retire_or_consume_recovery() {
    use crate::commands::research_dispatch::{on_research_spawn_finished, ResearchWakeAction};
    for phase in [
        "nudge",
        "failure",
        "retry",
        "auto-finish",
        "gate",
        "invalidate",
    ] {
        let (_dir, store, study, session) = settlement_fixture();
        if phase == "retry" {
            store
                .research_update(&study.id, |s| {
                    s.task_mut("design")?.attempts = 1;
                    Ok(())
                })
                .unwrap();
        }
        if phase == "auto-finish" {
            let root = store.research_root(&study).unwrap();
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("design.md"), b"new output").unwrap();
        }
        if matches!(phase, "gate" | "invalidate") {
            finish(&store, &study, "design");
            for task in ["review", "audit"] {
                bind(&store, &study, task, task);
                finish(&store, &study, task);
            }
            if phase == "invalidate" {
                crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
                approve(&store, &study, "G4");
                std::fs::write(
                    store.research_root(&study).unwrap().join("design.md"),
                    b"changed",
                )
                .unwrap();
            }
        }
        let before = store.research_study(&study.id).unwrap();
        store.conn.execute_batch("CREATE TEMP TRIGGER fail_settlement BEFORE UPDATE ON main.research_studies BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END;").unwrap();
        let action = on_research_spawn_finished(
            &store,
            &session,
            phase == "failure",
            Some("finished".into()),
            phase == "retry",
        );
        assert!(
            action.is_err(),
            "{phase}: persistence failure must not yield {action:?}"
        );
        assert_eq!(store.research_study(&study.id).unwrap(), before);
        let state: String = store
            .conn
            .query_row(
                "SELECT state FROM chat_spawns WHERE session_id=?1",
                [&session],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "running");
        store
            .conn
            .execute_batch("DROP TRIGGER fail_settlement")
            .unwrap();
        let action = on_research_spawn_finished(
            &store,
            &session,
            phase == "failure",
            Some("finished".into()),
            phase == "retry",
        )
        .unwrap();
        let saved = store.research_study(&study.id).unwrap();
        match phase {
            "nudge" => {
                assert!(matches!(action, Some(ResearchWakeAction::NudgeHelper(_))));
                assert_eq!(saved.task("design").unwrap().attempts, 1);
                assert!(saved.task("design").unwrap().pending_nudge.is_some());
            }
            "failure" => {
                assert_eq!(saved.task("design").unwrap().state, "failed");
                assert!(matches!(action, Some(ResearchWakeAction::WakeLead(_))));
            }
            "retry" => {
                assert_ne!(
                    saved.task("design").unwrap().session_id.as_deref(),
                    Some(session.as_str())
                );
                assert_eq!(saved.task("design").unwrap().attempts, 2);
            }
            "auto-finish" => {
                assert_eq!(saved.task("design").unwrap().state, "completed");
                assert_eq!(saved.task("design").unwrap().attempts, 0);
            }
            "gate" => assert!(saved
                .decisions
                .iter()
                .any(|d| d.gate == "G4" && d.status == "pending")),
            "invalidate" => {
                assert!(
                    !saved
                        .decisions
                        .iter()
                        .any(|d| d.gate == "G4"
                            && matches!(d.status.as_str(), "pending" | "approved"))
                );
                assert!(saved.delivery_error.is_some());
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn research_settlement_requires_readable_study_and_existing_current_runs() {
    let (_dir, store, study, session) = settlement_fixture();
    store
        .research_update(&study.id, |s| {
            s.task_mut("design")?.run_ids.push("missing-run".into());
            Ok(())
        })
        .unwrap();
    let before = store.research_study(&study.id).unwrap();
    assert!(store.research_session_has_active_runs(&session).is_err());
    assert!(store.research_retry_task(&study.id, "design").is_err());
    assert_eq!(store.research_study(&study.id).unwrap(), before);
    store
        .conn
        .execute(
            "UPDATE research_studies SET document='{broken' WHERE id=?1",
            [&study.id],
        )
        .unwrap();
    let error = store
        .research_session_has_active_runs(&session)
        .unwrap_err();
    assert!(error.to_string().contains(&study.id));
}
