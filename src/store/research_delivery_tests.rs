fn delivery_scope_fixture() -> (TestDir, Store, Study) {
    let (dir, store, study) = setup();
    for id in ["historical", "previous", "current"] {
        store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at,commit_sha) VALUES(?1,'exp','project','done','{\"kind\":\"local\"}',1,2,'abc')", [id]).unwrap();
        let path = store.research_log_path(id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("{id} result\n")).unwrap();
    }
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    store
        .research_update(&study.id, |s| {
            s.task_mut("design")?.run_ids.push("historical".into());
            Ok(())
        })
        .unwrap();
    for id in ["design", "review", "audit"] {
        bind(&store, &study, id, &format!("{id}-v1"));
        finish(&store, &study, id);
    }
    let mut revised = plan();
    revised.tasks[0].brief = "use the revised dataset".into();
    store.research_set_plan(&study.id, revised).unwrap();
    approve(&store, &study, "G1");
    store
        .research_update(&study.id, |s| {
            let task = s.task_mut("design")?;
            task.run_ids.push("current".into());
            task.previous_run_ids.push("previous".into());
            Ok(())
        })
        .unwrap();
    (dir, store, study)
}

fn finish_delivery_scope(store: &Store, study: &Study) -> Study {
    for id in ["design", "review", "audit"] {
        bind(store, study, id, &format!("{id}-v2"));
        finish(store, study, id);
    }
    store.research_study(&study.id).unwrap()
}

#[test]
fn delivery_scope_ignores_uncited_historical_logs_and_preserves_current_provenance() {
    let (_dir, store, study) = delivery_scope_fixture();
    let completed = finish_delivery_scope(&store, &study);
    let before = store.research_study(&study.id).unwrap();
    for id in ["historical", "previous"] {
        std::fs::remove_file(store.research_log_path(id).unwrap()).unwrap();
    }
    let scope: serde_json::Value =
        serde_json::from_str(&store.research_package_scope(&completed).unwrap()).unwrap();
    assert_eq!(scope["runs"].as_array().unwrap().len(), 1);
    assert_eq!(scope["runs"][0]["id"], "current");
    assert_eq!(scope["runs"][0]["logHash"], digest(b"current result\n"));
    assert_eq!(store.research_study(&study.id).unwrap(), before);
    assert_eq!(store.research_runs(&completed).unwrap().len(), 3);
    std::fs::remove_file(store.research_log_path("current").unwrap()).unwrap();
    assert!(store.research_package_scope(&completed).is_err());
}

#[test]
fn delivery_scope_keeps_explicit_historical_claims_including_previous_attempts() {
    for id in ["historical", "previous"] {
        let (_dir, store, study) = delivery_scope_fixture();
        store
            .research_add_claim(
                &study.id,
                ClaimInput {
                    text: "result from the earlier run".into(),
                    support: "experiment".into(),
                    source: "run log".into(),
                    location: None,
                    run_id: Some(id.into()),
                    line_start: Some(1),
                    line_end: Some(1),
                },
            )
            .unwrap();
        let completed = finish_delivery_scope(&store, &study);
        let scope: serde_json::Value =
            serde_json::from_str(&store.research_package_scope(&completed).unwrap()).unwrap();
        let ids: Vec<_> = scope["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["current", id]);
        std::fs::write(store.research_log_path(id).unwrap(), b"tampered result\n").unwrap();
        assert!(store
            .research_package_scope(&completed)
            .unwrap_err()
            .to_string()
            .contains("证据日志已变化"));
        std::fs::remove_file(store.research_log_path(id).unwrap()).unwrap();
        assert!(store.research_package_scope(&completed).is_err());
    }
}

#[test]
fn delivery_scope_still_blocks_unfinished_historical_runs_without_reading_their_logs() {
    let (_dir, store, study) = delivery_scope_fixture();
    let completed = finish_delivery_scope(&store, &study);
    std::fs::remove_file(store.research_log_path("historical").unwrap()).unwrap();
    store
        .conn
        .execute("UPDATE runs SET status='running' WHERE id='historical'", [])
        .unwrap();
    assert!(store
        .research_package_scope(&completed)
        .unwrap_err()
        .to_string()
        .contains("未结束"));
    assert!(store.research_end(&study.id, 2, &[]).is_err());
    store
        .conn
        .execute("UPDATE runs SET status='done' WHERE id='historical'", [])
        .unwrap();
    assert!(store.research_package_scope(&completed).is_ok());
    // Log retention is separate from the durable run identity: this patch
    // does not silently accept deleted historical metadata or implement GC.
    store
        .conn
        .execute("DELETE FROM runs WHERE id='historical'", [])
        .unwrap();
    assert!(store
        .research_package_scope(&completed)
        .unwrap_err()
        .to_string()
        .contains("研究 Run 记录缺失"));
}

#[test]
fn delivery_scope_requires_logs_for_inherited_current_results() {
    let (_dir, store, study) = delivery_scope_fixture();
    finish_delivery_scope(&store, &study);
    let mut inherited = plan();
    inherited.tasks[0].brief = "use the revised dataset".into();
    store.research_set_plan(&study.id, inherited).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.plan().unwrap().version, 3);
    assert!(saved
        .plan()
        .unwrap()
        .tasks
        .iter()
        .all(|task| task.state == "completed"));
    assert_eq!(saved.task("design").unwrap().run_ids, vec!["current"]);
    for id in ["historical", "previous"] {
        std::fs::remove_file(store.research_log_path(id).unwrap()).unwrap();
    }
    assert!(store.research_package_scope(&saved).is_ok());
    std::fs::remove_file(store.research_log_path("current").unwrap()).unwrap();
    assert!(store.research_package_scope(&saved).is_err());
}

#[test]
fn delivery_scope_change_requires_fresh_confirmation_and_ignores_later_history_edits() {
    let (_dir, store, study) = delivery_scope_fixture();
    let completed = finish_delivery_scope(&store, &study);
    let mut legacy: serde_json::Value =
        serde_json::from_str(&store.research_package_scope(&completed).unwrap()).unwrap();
    let runs = legacy["runs"].as_array_mut().unwrap();
    for id in ["historical", "previous"] {
        if !runs.iter().any(|run| run["id"] == id) {
            runs.push(serde_json::json!({"id":id,"commit":"abc","status":"done","logHash":digest(format!("{id} result\n").as_bytes()),"sourceHash":null}));
        }
    }
    runs.sort_by_key(|run| run["id"].as_str().unwrap().to_string());
    store
        .research_update(&study.id, |s| {
            s.request_gate("G4", serde_json::to_string(&legacy)?)
        })
        .unwrap();
    let pending = store
        .research_study(&study.id)
        .unwrap()
        .decisions
        .last()
        .unwrap()
        .clone();
    assert!(store
        .research_decide(
            &study.id,
            &pending.id,
            &pending.scope_hash,
            true,
            "old click".into()
        )
        .is_err());
    crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
    let updated = store.research_study(&study.id).unwrap();
    assert_eq!(
        updated
            .decisions
            .iter()
            .find(|d| d.id == pending.id)
            .unwrap()
            .status,
        "superseded"
    );
    let current = updated.decisions.last().unwrap().clone();
    assert_eq!(current.status, "pending");
    approve(&store, &study, "G4");
    std::fs::write(
        store.research_log_path("historical").unwrap(),
        b"unrelated history changed\n",
    )
    .unwrap();
    std::fs::remove_file(store.research_log_path("previous").unwrap()).unwrap();
    let scope = store
        .research_package_scope(&store.research_study(&study.id).unwrap())
        .unwrap();
    assert_eq!(digest(scope.as_bytes()), current.scope_hash);
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .decisions
            .last()
            .unwrap()
            .status,
        "approved"
    );
}
