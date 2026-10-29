fn material_message(
    store: &Store,
    id: &str,
    packages: &[String],
    parent: Option<&str>,
    select: bool,
) {
    let parts: Vec<_> = packages
        .iter()
        .map(|id| serde_json::json!({"type":"material", "text":id}))
        .collect();
    store.conn.execute(
        "INSERT INTO chat_messages(id,session_id,role,parts_json,created_at,parent_id) VALUES(?1,'lead','user',?2,1,?3)",
        params![id, serde_json::to_string(&parts).unwrap(), parent],
    ).unwrap();
    if select {
        store
            .set_chat_session_active_leaf("lead", Some(id))
            .unwrap();
    }
}

#[test]
fn material_plan_revision_invalidates_results_only_when_the_active_input_set_changes() {
    for change in ["same", "added", "removed", "abandoned"] {
        let (_dir, store, study) = setup();
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        material_message(&store, "input-a", std::slice::from_ref(&a), None, true);
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");
        for id in ["design", "review", "audit"] {
            bind(&store, &study, id, id);
            finish(&store, &study, id);
        }
        match change {
            "added" => material_message(&store, "input-b", &[b], Some("input-a"), true),
            "removed" => store.set_chat_session_active_leaf("lead", None).unwrap(),
            "abandoned" => material_message(&store, "unused-branch", &[b], None, false),
            _ => material_message(&store, "repeated-a", &[a], Some("input-a"), true),
        }
        let mut revised = plan();
        revised.summary = "clarify summary only".into();
        store.research_set_plan(&study.id, revised).unwrap();
        let saved = store.research_study(&study.id).unwrap();
        let expected = if matches!(change, "same" | "abandoned") {
            "completed"
        } else {
            "pending"
        };
        assert!(
            saved
                .plan()
                .unwrap()
                .tasks
                .iter()
                .all(|task| task.state == expected),
            "material change {change} incorrectly inherited previous results"
        );
        assert!(
            saved.ready("design").is_err(),
            "a revised plan still requires G1"
        );
        if expected == "pending" {
            assert!(saved
                .plan()
                .unwrap()
                .tasks
                .iter()
                .all(|task| task.session_id.is_none() && task.artifacts.is_empty()));
        }
    }
}

#[test]
fn material_plan_scope_binds_registered_ids_and_preserves_legacy_hash_shape() {
    let (_dir, store, study) = setup();
    let a = uuid::Uuid::new_v4().to_string();
    material_message(&store, "input", std::slice::from_ref(&a), None, true);
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    let saved = store.research_study(&study.id).unwrap();
    assert!(saved.ready("design").is_ok());
    let scope: serde_json::Value = serde_json::from_str(&saved.plan_scope().unwrap()).unwrap();
    assert_eq!(scope["materialIds"], serde_json::json!([a]));
    let mut raw = serde_json::to_value(&saved).unwrap();
    raw["plans"][0]["materialIds"] = serde_json::json!(["different-input"]);
    let changed: Study = serde_json::from_value(raw.clone()).unwrap();
    assert!(
        changed.ready("design").is_err(),
        "input changes must not retain the old G1"
    );
    raw["plans"][0]
        .as_object_mut()
        .unwrap()
        .remove("materialIds");
    let legacy: Study = serde_json::from_value(raw).unwrap();
    let mut expected = scope;
    expected.as_object_mut().unwrap().remove("materialIds");
    assert_eq!(
        legacy.plan_scope().unwrap(),
        serde_json::to_string(&expected).unwrap()
    );
}

#[test]
fn material_plan_dispatch_keeps_approved_inputs_after_parent_uploads_change() {
    const CHILD: &str = "ORX_TEST_MATERIAL_PLAN_DISPATCH";
    const TEST: &str = "store::research::tests::material_plan_dispatch_keeps_approved_inputs_after_parent_uploads_change";
    if std::env::var_os(CHILD).is_some() {
        use crate::local::materials;
        let make_package = |text: &[u8]| {
            let package = materials::create("project").unwrap();
            materials::upload(&package.id, "project", "folder/dataset.txt", text).unwrap();
            materials::finalize(&package.id, "project").unwrap().id
        };
        for with_initial_material in [false, true] {
            let (_dir, store, study) = setup();
            let initial = if with_initial_material {
                vec![make_package(b"original dataset")]
            } else {
                vec![]
            };
            material_message(&store, "initial", &initial, None, true);
            store.research_set_plan(&study.id, plan()).unwrap();
            approve(&store, &study, "G1");
            let replacement = make_package(b"replacement dataset");
            material_message(&store, "after-approval", &[replacement], None, true);
            let helper = crate::commands::research_dispatch::dispatch_study_task_sync(
                &store, &study.id, "design", None,
            )
            .unwrap()
            .unwrap();
            let actual = store
                .get_chat_session(&helper)
                .unwrap()
                .unwrap()
                .bootstrap_context
                .unwrap();
            assert!(
                actual == materials::context_for(&initial, "project").unwrap(),
                "dispatch used materials changed after approval rather than the fixed plan inputs"
            );
        }
        for with_material in [false, true] {
            let (_dir, store, study) = setup();
            if with_material {
                material_message(
                    &store,
                    "legacy-input",
                    &[make_package(b"legacy data")],
                    None,
                    true,
                );
            }
            store.research_set_plan(&study.id, plan()).unwrap();
            store
                .research_update(&study.id, |study| {
                    study.plan_mut()?.material_ids = None;
                    study.decisions.clear();
                    study.request_gate("G1", study.plan_scope()?)
                })
                .unwrap();
            approve(&store, &study, "G1");
            assert!(store
                .research_study(&study.id)
                .unwrap()
                .ready("design")
                .is_ok());
            let result = crate::commands::research_dispatch::dispatch_study_task_sync(
                &store, &study.id, "design", None,
            );
            if with_material {
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("旧计划未固定材料范围"));
                assert_eq!(store.count_live_chat_spawns("lead").unwrap(), 0);
                assert_eq!(
                    store
                        .research_study(&study.id)
                        .unwrap()
                        .task("design")
                        .unwrap()
                        .state,
                    "pending"
                );
            } else {
                assert!(result.unwrap().is_some());
            }
        }
        return;
    }
    let root = std::env::temp_dir().join(format!("orx-plan-materials-{}", uuid::Uuid::new_v4()));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env(CHILD, "1")
        .env("ORX_DATA_DIR", &root)
        .env("ORX_CONFIG_DIR", root.join("config"))
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

#[test]
fn material_plan_legacy_reuse_requires_no_known_material_inputs() {
    for scenario in ["none", "current", "removed"] {
        let (_dir, store, study) = setup();
        if scenario != "none" {
            material_message(
                &store,
                "old-input",
                &[uuid::Uuid::new_v4().to_string()],
                None,
                true,
            );
        }
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");
        for task in ["design", "review", "audit"] {
            bind(&store, &study, task, task);
            finish(&store, &study, task);
        }
        store
            .research_update(&study.id, |study| {
                study.plan_mut()?.material_ids = None;
                Ok(())
            })
            .unwrap();
        if scenario == "removed" {
            store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,bootstrap_context,created_at,updated_at) VALUES('design','project','codex','<research-materials>old frozen context</research-materials>',1,1)", []).unwrap();
            store.set_chat_session_active_leaf("lead", None).unwrap();
        }
        store.research_set_plan(&study.id, plan()).unwrap();
        let saved = store.research_study(&study.id).unwrap();
        let expected = if scenario == "none" {
            "completed"
        } else {
            "pending"
        };
        assert!(
            saved
                .plan()
                .unwrap()
                .tasks
                .iter()
                .all(|t| t.state == expected),
            "legacy input case {scenario}"
        );
        assert!(saved.plan().unwrap().material_ids.is_some());
    }
}
