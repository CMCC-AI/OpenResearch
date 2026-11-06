fn read_receipt(
    context: crate::store::material_reads::ReadContext,
    source: &str,
) -> crate::store::material_reads::ReadReceipt {
    crate::store::material_reads::ReadReceipt {
        package_id: context.package_id.clone(),
        context,
        source: source.into(),
        path: "notes.txt".into(),
        sha256: "registered-hash".into(),
        format: "text".into(),
        requested_offset: 1,
        requested_limit: 200,
        requested_page: None,
        verified: true,
        outcome: "prepared".into(),
        selection: Some(
            serde_json::json!({"offset":1,"lineCount":1,"contentSha256":"returned-hash"}),
        ),
        view: None,
        error: None,
        started_at: 1,
        recorded_at: 2,
    }
}

#[test]
fn material_read_events_bind_lead_task_descendant_and_snapshot_plan_inputs() {
    let (_dir, store, study) = setup();
    let manual = store
        .material_read_context("project", None, "package")
        .unwrap();
    assert!(manual.session_id.is_none());
    assert!(manual.study_id.is_none());
    let lead = store
        .material_read_context("project", Some("lead"), "package")
        .unwrap();
    assert_eq!(lead.study_id.as_deref(), Some(study.id.as_str()));
    assert_eq!(lead.plan_version, Some(0));
    store.research_set_plan(&study.id, plan()).unwrap();
    store
        .research_update(&study.id, |s| {
            s.plans[0].material_ids = Some(vec!["package".into()]);
            s.request_gate("G1", s.plan_scope()?)
        })
        .unwrap();
    approve(&store, &study, "G1");
    store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,parent_session_id) VALUES('worker','project','codex',1,1,'lead')",[]).unwrap();
    bind(&store, &study, "design", "worker");
    store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,parent_session_id) VALUES('nested','project','codex',1,1,'worker')",[]).unwrap();
    let captured = store
        .material_read_context("project", Some("nested"), "package")
        .unwrap();
    assert_eq!(captured.task_id.as_deref(), Some("design"));
    assert_eq!(captured.task_session_id.as_deref(), Some("worker"));
    assert_eq!(captured.session_id.as_deref(), Some("nested"));
    assert_eq!(captured.plan_version, Some(1));
    assert_eq!(captured.in_plan_inputs, Some(true));
    let outside = store
        .material_read_context("project", Some("nested"), "other-package")
        .unwrap();
    assert_eq!(outside.in_plan_inputs, Some(false));
    // Plan moves after capture. Receipt keeps the version/input set at read start.
    finish(&store, &study, "design");
    store.research_set_plan(&study.id, plan()).unwrap();
    let current = store
        .material_read_context("project", Some("nested"), "package")
        .unwrap();
    assert_eq!(current.plan_version, Some(1));
    assert_eq!(current.in_plan_inputs, Some(true));
    let lead_now = store
        .material_read_context("project", Some("lead"), "package")
        .unwrap();
    assert_eq!(lead_now.plan_version, Some(2));
    assert_eq!(lead_now.in_plan_inputs, Some(false));
    let before = store.research_study(&study.id).unwrap();
    let id = store
        .record_material_read(&read_receipt(captured, "SRC-0001"))
        .unwrap();
    let events = store
        .material_read_events("project", &Default::default(), 0, 10)
        .unwrap();
    assert_eq!(events["events"][0]["id"], id);
    assert_eq!(store.research_study(&study.id).unwrap(), before);
    assert_eq!(events["events"][0]["receipt"]["context"]["planVersion"], 1);
    assert_eq!(
        events["events"][0]["receipt"]["context"]["inPlanInputs"],
        true
    );
    assert!(store
        .material_read_context("project", Some("missing"), "package")
        .is_err());
    let mut project = store.get_local_project("project").unwrap().unwrap();
    project.id = "other".into();
    project.slug = "other".into();
    store.create_local_project(&project).unwrap();
    assert!(store
        .material_read_context("other", Some("nested"), "package")
        .is_err());
}

#[test]
fn material_read_events_query_is_project_scoped_filtered_and_seek_paginated() {
    use crate::store::material_reads::ReadFilter;
    let (_dir, store, _study) = setup();
    let context = store
        .material_read_context("project", Some("lead"), "package")
        .unwrap();
    for source in ["SRC-0001", "SRC-0002", "SRC-0001"] {
        store
            .record_material_read(&read_receipt(context.clone(), source))
            .unwrap();
    }
    let first = store
        .material_read_events("project", &ReadFilter::default(), 0, 1)
        .unwrap();
    let cursor = first["nextAfter"].as_i64().unwrap();
    assert_eq!(first["events"].as_array().unwrap().len(), 1);
    // A later insert does not shift the next page or repeat previous results.
    store
        .record_material_read(&read_receipt(context, "SRC-0003"))
        .unwrap();
    let next = store
        .material_read_events("project", &ReadFilter::default(), cursor, 200)
        .unwrap();
    assert_eq!(next["events"].as_array().unwrap().len(), 3);
    assert!(next["nextAfter"].is_null());
    assert!(next["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["sequence"].as_i64().unwrap() > cursor));
    let filter = ReadFilter {
        package: Some("package".into()),
        source: Some("SRC-0001".into()),
        session: Some("lead".into()),
        study: None,
    };
    assert_eq!(
        store
            .material_read_events("project", &filter, 0, 200)
            .unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let filter = ReadFilter {
        study: Some("unknown".into()),
        ..Default::default()
    };
    assert_eq!(
        store
            .material_read_events("project", &filter, 0, 200)
            .unwrap()["events"],
        serde_json::json!([])
    );
    let mut project = store.get_local_project("project").unwrap().unwrap();
    project.id = "other".into();
    project.slug = "other".into();
    store.create_local_project(&project).unwrap();
    assert_eq!(
        store
            .material_read_events("other", &ReadFilter::default(), 0, 200)
            .unwrap()["events"],
        serde_json::json!([])
    );
    for (after, limit) in [(-1, 50), (0, 0), (0, 201)] {
        assert!(store
            .material_read_events("project", &ReadFilter::default(), after, limit)
            .is_err());
    }
    assert!(store
        .material_read_events(
            "project",
            &ReadFilter {
                source: Some("SRC-0001".into()),
                ..Default::default()
            },
            0,
            50
        )
        .is_err());
}

#[test]
fn material_read_events_keep_receipts_immutable_confirm_output_once_and_cascade_project_delete() {
    let (_dir, store, _study) = setup();
    let context = store
        .material_read_context("project", None, "package")
        .unwrap();
    let id = store
        .record_material_read(&read_receipt(context, "SRC-0001"))
        .unwrap();
    assert!(store.material_read_output("other", &id, None).is_err());
    assert!(store
        .conn
        .execute(
            "UPDATE material_read_events SET receipt='{}' WHERE id=?1",
            [&id]
        )
        .is_err());
    assert!(store
        .conn
        .execute("DELETE FROM material_read_events WHERE id=?1", [&id])
        .is_err());
    store.material_read_output("project", &id, None).unwrap();
    assert!(store
        .material_read_output("project", &id, Some("overwrite"))
        .is_err());
    store
        .conn
        .execute("DELETE FROM local_projects WHERE id='project'", [])
        .unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM material_read_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(crate::store::material_reads::bounded_error(&"🙂".repeat(1000)).len() <= 2048);
}
