#[test]
fn research_end_preserves_history_and_prevents_late_dispatch_and_revision() {
    let (dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    let before = store.research_study(&study.id).unwrap();
    assert!(store.delete_chat_session("lead").is_err());
    assert!(store.research_end(&study.id, 0, &[]).is_err());
    store.research_end(&study.id, 1, &[]).unwrap();
    store.research_end(&study.id, 1, &[]).unwrap();
    assert!(store.research_active_studies().unwrap().is_empty());
    assert!(store.research_set_plan(&study.id, plan()).is_err());
    assert!(store.research_retry_task(&study.id, "design").is_err());
    assert!(
        crate::commands::research_dispatch::dispatch_study_task_sync(
            &store, &study.id, "design", None
        )
        .is_err()
    );
    assert!(
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id)
            .unwrap()
            .is_empty()
    );
    crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
    drop(store);
    let store = Store::open_at(dir.path().to_path_buf()).unwrap();
    let ended = store.research_study(&study.id).unwrap();
    assert_eq!(ended.status, "stopped");
    assert_eq!(
        serde_json::to_value(&ended.plans).unwrap(),
        serde_json::to_value(&before.plans).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&ended.decisions).unwrap(),
        serde_json::to_value(&before.decisions).unwrap()
    );
    assert!(store.get_chat_session("lead").unwrap().is_some());
    // Ending removes the active-study deletion barrier; deletion stays explicit.
    store.delete_chat_session("lead").unwrap();
}

#[test]
fn research_end_accepts_unplanned_and_approved_delivered_studies_without_implied_approval() {
    let (_dir, store, study) = setup();
    store.research_end(&study.id, 0, &[]).unwrap();
    assert!(store
        .research_study(&study.id)
        .unwrap()
        .decisions
        .is_empty());

    let (_dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        bind(&store, &study, task, task);
        finish(&store, &study, task);
    }
    crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
    approve(&store, &study, "G4");
    let path = store.research_root(&study).unwrap().join("design.md");
    let original = std::fs::read(&path).unwrap();
    store.research_end(&study.id, 1, &[]).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn research_end_rejects_running_tasks_and_historical_active_runs() {
    let (_dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "expert");
    assert!(store
        .research_end(&study.id, 1, &[])
        .unwrap_err()
        .to_string()
        .contains("专家任务"));
    finish(&store, &study, "design");
    store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('history','exp','project','running','{}',1,1)", []).unwrap();
    store
        .research_update(&study.id, |s| {
            s.task_mut("design")?
                .previous_run_ids
                .push("history".into());
            Ok(())
        })
        .unwrap();
    assert!(store
        .research_end(&study.id, 1, &[])
        .unwrap_err()
        .to_string()
        .contains("实验"));
    assert_eq!(store.get_run("history").unwrap().unwrap().status, "running");
    store
        .conn
        .execute("UPDATE runs SET status='cancelled' WHERE id='history'", [])
        .unwrap();
    store.research_end(&study.id, 1, &[]).unwrap();
}

#[test]
fn research_end_checks_lead_and_historical_session_activity_without_clearing_it() {
    for session in ["lead", "old-expert"] {
        for activity in ["memory", "lease", "queue", "spawn", "steer"] {
            let (_dir, store, study) = setup();
            if session != "lead" {
                store
                    .conn
                    .execute(
                        "INSERT INTO research_sessions VALUES(?1,?2,'old',0)",
                        params![session, study.id],
                    )
                    .unwrap();
            }
            let busy = if activity == "memory" {
                vec![session.into()]
            } else {
                vec![]
            };
            match activity {
                "lease" => {
                    store
                        .conn
                        .execute(
                            "INSERT INTO chat_turn_leases VALUES(?1,'lease',?2)",
                            params![session, now_ms()],
                        )
                        .unwrap();
                }
                "queue" => {
                    store.conn.execute("INSERT INTO chat_queued_messages VALUES('q',?1,'client','hash','{}',1)", [session]).unwrap();
                }
                "spawn" => {
                    store.conn.execute("INSERT INTO chat_spawns(session_id,parent_session_id,prompt,requested_at) VALUES(?1,'lead','work',1)", [session]).unwrap();
                }
                "steer" => {
                    store.conn.execute("INSERT INTO chat_steering_requests VALUES('s',?1,'client','hash','{}','registered',1)", [session]).unwrap();
                }
                _ => {}
            }
            assert!(
                store.research_end(&study.id, 0, &busy).is_err(),
                "accepted {session}/{activity}"
            );
            assert_eq!(store.research_study(&study.id).unwrap().status, "active");
            store.conn.execute_batch("DELETE FROM chat_turn_leases; DELETE FROM chat_queued_messages; DELETE FROM chat_spawns; DELETE FROM chat_steering_requests;").unwrap();
            store.research_end(&study.id, 0, &[]).unwrap();
        }
    }
}

#[test]
fn research_end_checks_related_branches_without_blocking_unrelated_sessions() {
    for session in ["lead-side", "expert-side", "nested-side", "child"] {
        for activity in ["memory", "lease", "queue", "spawn", "steer"] {
            let (_dir, store, study) = setup();
            store.conn.execute_batch("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,side_parent_session_id,parent_session_id) VALUES
                ('old-expert','project','codex',1,1,NULL,NULL),
                ('lead-side','project','codex',1,1,'lead',NULL),
                ('expert-side','project','codex',1,1,'old-expert',NULL),
                ('nested-side','project','codex',1,1,'expert-side',NULL),
                ('child','project','codex',1,1,NULL,'nested-side'),
                ('unrelated','project','codex',1,1,NULL,NULL);").unwrap();
            store
                .conn
                .execute(
                    "INSERT INTO research_sessions VALUES('old-expert',?1,'old',0)",
                    [&study.id],
                )
                .unwrap();
            let busy = if activity == "memory" {
                vec![session.into()]
            } else {
                vec![]
            };
            match activity {
                "lease" => {
                    store
                        .conn
                        .execute(
                            "INSERT INTO chat_turn_leases VALUES(?1,'lease',?2)",
                            params![session, now_ms()],
                        )
                        .unwrap();
                }
                "queue" => {
                    store.conn.execute("INSERT INTO chat_queued_messages VALUES('q',?1,'client','hash','{}',1)", [session]).unwrap();
                }
                "spawn" => {
                    store.conn.execute("INSERT INTO chat_spawns(session_id,parent_session_id,prompt,requested_at) VALUES(?1,'lead','work',1)", [session]).unwrap();
                }
                "steer" => {
                    store.conn.execute("INSERT INTO chat_steering_requests VALUES('s',?1,'client','hash','{}','registered',1)", [session]).unwrap();
                }
                _ => {}
            }
            assert!(
                store.research_end(&study.id, 0, &busy).is_err(),
                "accepted {session}/{activity}"
            );
            assert_eq!(store.research_study(&study.id).unwrap().status, "active");
            store.conn.execute_batch("DELETE FROM chat_turn_leases; DELETE FROM chat_queued_messages; DELETE FROM chat_spawns; DELETE FROM chat_steering_requests;
                INSERT INTO chat_queued_messages VALUES('other-q','unrelated','other-client','hash','{}',1);").unwrap();
            store
                .research_end(&study.id, 0, &["unrelated".into()])
                .unwrap();
            assert_eq!(
                store
                    .list_queued_chat_messages_for_session("unrelated")
                    .unwrap()
                    .len(),
                1
            );
        }
    }
}

#[test]
fn research_end_member_union_deduplicates_overlapping_roots_and_legacy_cycles() {
    let (_dir, store, study) = setup();
    store.conn.execute_batch("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,parent_session_id,side_parent_session_id) VALUES
        ('expert','project','codex',1,1,'lead',NULL),
        ('a','project','codex',1,1,'b','lead'),
        ('b','project','codex',1,1,'a',NULL);").unwrap();
    store
        .conn
        .execute(
            "INSERT INTO research_sessions VALUES('expert',?1,'past',0)",
            [&study.id],
        )
        .unwrap();
    // LIMIT lets this regression fail instead of hanging if UNION accidentally
    // becomes UNION ALL on an overlapping/cyclic legacy graph.
    let members: Vec<String> = store
        .conn
        .prepare(&format!(
            "{RESEARCH_MEMBERS_CTE} SELECT id FROM members LIMIT 16"
        ))
        .unwrap()
        .query_map(params![study.id, study.session_id], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(members.len(), 4);
    assert_eq!(members.iter().collect::<HashSet<_>>().len(), 4);
    store.research_end(&study.id, 0, &[]).unwrap();
}

#[test]
fn research_pause_soft_returns_running_tasks_and_blocks_until_resume() {
    let (_dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    let wave1 = crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert_eq!(wave1.len(), 1);
    let bound_session = wave1[0].1.clone();

    // Pausing reports the bound expert session and soft-returns the task.
    let sessions = store.research_pause(&study.id, 1).unwrap();
    assert_eq!(sessions, vec![bound_session.clone()]);
    let paused = store.research_study(&study.id).unwrap();
    assert_eq!(paused.status, "paused");
    let design = paused.task("design").unwrap();
    assert_eq!(design.state, "pending");
    assert_eq!(design.session_id, None);
    assert_eq!(design.attempts, 0);
    // Already-paused pause is idempotent and reports nothing new.
    assert!(store.research_pause(&study.id, 1).unwrap().is_empty());
    assert!(store.research_pause(&study.id, 999).is_err());

    // Paused studies stay out of dispatch and reject lifecycle mutations.
    assert!(
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id)
            .unwrap()
            .is_empty()
    );
    assert!(store.research_set_plan(&study.id, plan()).is_err());
    assert!(store.research_retry_task(&study.id, "design").is_err());
    let error = format!(
        "{}",
        store.research_retry_task(&study.id, "design").unwrap_err()
    );
    assert!(error.contains("研究已暂停"), "unexpected error: {error}");
    assert!(store.research_active_studies().unwrap().is_empty());

    // An interrupted expert settling after the pause retires silently: the
    // task must stay pending instead of being recorded as failed.
    store
        .conn
        .execute(
            "UPDATE chat_spawns SET state='running',finished_at=1 WHERE session_id=?1",
            [&bound_session],
        )
        .unwrap();
    for attempts in [0u32, 2] {
        store
            .research_update(&study.id, |s| {
                s.task_mut("design")?.attempts = attempts;
                Ok(())
            })
            .unwrap();
        let action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &bound_session,
            true,
            None,
            false,
        )
        .unwrap();
        assert!(
            matches!(
                action,
                Some(crate::commands::research_dispatch::ResearchWakeAction::RetireSilently)
            ),
            "interrupted settlement after pause must retire silently"
        );
        let saved = store.research_study(&study.id).unwrap();
        let design = saved.task("design").unwrap();
        assert_eq!(design.state, "pending", "attempts={attempts}");
        assert_eq!(design.attempts, attempts, "pause must not consume attempts");
    }

    // Resuming dispatches again from where the study stood, attempts intact.
    store.research_resume(&study.id, 1).unwrap();
    assert_eq!(store.research_study(&study.id).unwrap().status, "active");
    store.research_resume(&study.id, 1).unwrap();
    let wave2 = crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert_eq!(wave2.len(), 1);
    assert_eq!(wave2[0].0, "design");
    assert_ne!(wave2[0].1, bound_session, "a fresh expert session is bound");
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(
        saved.task("design").unwrap().attempts,
        2,
        "pause/resume must not consume attempts"
    );
    // Resume only works from paused.
    assert!(store.research_resume(&study.id, 999).is_err());
}

#[test]
fn research_end_accepts_paused_studies_and_pause_rejects_stopped_ones() {
    let (_dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    store.research_pause(&study.id, 1).unwrap();
    // Paused studies carry no running tasks, so ending them stays one step.
    store.research_end(&study.id, 1, &[]).unwrap();
    assert_eq!(store.research_study(&study.id).unwrap().status, "stopped");
    assert!(store.research_pause(&study.id, 1).is_err());
    let error = format!("{}", store.research_pause(&study.id, 1).unwrap_err());
    assert!(error.contains("研究已停止"), "unexpected error: {error}");
    assert!(store.research_resume(&study.id, 1).is_err());
}

#[test]
fn paused_and_ended_studies_inject_distinct_turn_context() {
    let (_dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    store.research_pause(&study.id, 1).unwrap();
    let paused = crate::local::research::turn_context(&store, "lead")
        .unwrap()
        .unwrap();
    assert!(
        paused.contains("<paused-research>") && paused.contains("已暂停"),
        "unexpected paused context: {paused}"
    );
    assert!(
        !paused.contains("<ended-research>"),
        "paused must not use the ended context: {paused}"
    );
    store.research_end(&study.id, 1, &[]).unwrap();
    let ended = crate::local::research::turn_context(&store, "lead")
        .unwrap()
        .unwrap();
    assert!(ended.contains("<ended-research>") && ended.contains("已结束"));
}
