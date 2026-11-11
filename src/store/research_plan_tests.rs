// Plan inheritance concurrency, filesystem identity and descriptor regressions.
fn setup_completed_plan() -> (TestDir, Store, Study) {
    let (dir, store, study) = setup();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    for (task, session) in [
        ("design", "designer"),
        ("review", "reviewer"),
        ("audit", "auditor"),
    ] {
        bind(&store, &study, task, session);
        finish(&store, &study, task);
    }
    (dir, store, study)
}

#[test]
fn plan_inheritance_hashing_allows_an_independent_writer() {
    let (dir, store, study) = setup_completed_plan();
    let other = Store::open_at(dir.path().to_path_buf()).unwrap();
    other.set_busy_timeout(std::time::Duration::ZERO).unwrap();
    let mut inspected = 0;
    let prepared = store
        .research_prepare_plan_with_inspector(&study.id, plan(), |root, path| {
            assert!(store.conn.is_autocommit());
            // The independent writer holds its transaction during actual file
            // hashing. No sleeps or wall-clock threshold can hide a writer lock.
            let tx = other.begin_immediate().unwrap();
            other
                .conn
                .execute(
                    "UPDATE chat_sessions SET title='parallel writer' WHERE id='lead'",
                    [],
                )
                .unwrap();
            let artifact = files::PreparedArtifact::inspect(root, path)?;
            tx.commit().unwrap();
            inspected += 1;
            Ok(artifact)
        })
        .unwrap();
    assert_eq!(inspected, 3);
    store.research_commit_plan(prepared).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.plan().unwrap().version, 2);
    assert!(saved
        .plan()
        .unwrap()
        .tasks
        .iter()
        .all(|t| t.state == "completed"));
    assert_eq!(
        other.research_session_task("designer").unwrap(),
        Some(("design".into(), 2))
    );
    assert!(saved.ready("design").is_err()); // New G1 still needs approval.
}

#[test]
fn plan_inheritance_rejects_concurrent_document_and_activity_without_partial_writes() {
    for change in ["document", "claim", "spawn", "run"] {
        let (dir, store, study) = setup_completed_plan();
        if change == "run" {
            store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('run','exp','project','done','{}',1,1)", []).unwrap();
            store
                .research_update(&study.id, |s| {
                    s.task_mut("design")?.run_ids.push("run".into());
                    Ok(())
                })
                .unwrap();
        }
        let prepared = store
            .research_prepare_plan_with_inspector(
                &study.id,
                plan(),
                files::PreparedArtifact::inspect,
            )
            .unwrap();
        let other = Store::open_at(dir.path().to_path_buf()).unwrap();
        match change {
            "document" => {
                let mut newer = other.research_study(&study.id).unwrap();
                newer
                    .objective
                    .push_str(" concurrent edit with identical timestamp");
                other.research_save(&newer).unwrap();
            }
            "claim" => other
                .research_add_claim(
                    &study.id,
                    ClaimInput {
                        text: "new hypothesis".into(),
                        support: "inference".into(),
                        source: "test".into(),
                        location: None,
                        run_id: None,
                        line_start: None,
                        line_end: None,
                        material_read_id: None,
                        metric: None,
                    },
                )
                .unwrap(),
            "spawn" => {
                other.conn.execute("INSERT INTO chat_spawns(session_id,parent_session_id,prompt,state,requested_at) VALUES('helper','lead','test','pending',1)", []).unwrap();
            }
            "run" => {
                other
                    .conn
                    .execute("UPDATE runs SET status='running' WHERE id='run'", [])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = other.research_study(&study.id).unwrap();
        assert!(store.research_commit_plan(prepared).is_err(), "{change}");
        assert!(
            other
                .research_study(&study.id)
                .unwrap()
                .same_document(&before),
            "{change}"
        );
        assert_eq!(
            other.research_session_task("designer").unwrap(),
            Some(("design".into(), 1))
        );
    }
}

#[test]
fn plan_inheritance_rechecks_material_ancestry_and_legacy_context_at_commit() {
    for legacy in [false, true] {
        let (dir, store, study) = setup_completed_plan();
        if legacy {
            store
                .research_update(&study.id, |s| {
                    s.plan_mut()?.material_ids = None;
                    Ok(())
                })
                .unwrap();
            store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('designer','project','codex',1,1)", []).unwrap();
        }
        let prepared = store
            .research_prepare_plan_with_inspector(
                &study.id,
                plan(),
                files::PreparedArtifact::inspect,
            )
            .unwrap();
        let other = Store::open_at(dir.path().to_path_buf()).unwrap();
        if legacy {
            other.conn.execute("UPDATE chat_sessions SET bootstrap_context='<research-materials>legacy input</research-materials>' WHERE id='designer'", []).unwrap();
        } else {
            other.conn.execute("INSERT INTO chat_messages(id,session_id,role,parts_json,created_at) VALUES('upload','lead','user',?1,1)", [serde_json::json!([{"type":"material","text":"new-package"}]).to_string()]).unwrap();
            other
                .conn
                .execute(
                    "UPDATE chat_sessions SET active_leaf_id='upload' WHERE id='lead'",
                    [],
                )
                .unwrap();
        }
        store.research_commit_plan(prepared).unwrap();
        let saved = other.research_study(&study.id).unwrap();
        assert_eq!(saved.plan().unwrap().version, 2);
        assert!(saved
            .plan()
            .unwrap()
            .tasks
            .iter()
            .all(|t| t.state == "pending"));
        let expected = if legacy {
            vec![]
        } else {
            vec!["new-package".to_string()]
        };
        assert_eq!(
            saved.plan().unwrap().material_ids.as_ref().unwrap(),
            &expected
        );
    }
}

#[test]
fn plan_inheritance_rejects_post_hash_file_changes_and_preserves_the_old_plan() {
    for change in ["write", "replace", "remove", "root"] {
        let (_dir, store, study) = setup_completed_plan();
        let prepared = store
            .research_prepare_plan_with_inspector(
                &study.id,
                plan(),
                files::PreparedArtifact::inspect,
            )
            .unwrap();
        let root = store.research_root(&study).unwrap();
        let file = root.join("design.md");
        let metadata = std::fs::metadata(&file).unwrap();
        match change {
            "write" => {
                std::fs::write(&file, b"changed").unwrap();
            }
            "replace" => {
                let replacement = root.join("replacement.md");
                std::fs::write(&replacement, std::fs::read(&file).unwrap()).unwrap();
                std::fs::File::options().write(true).open(&replacement)
                    .unwrap()
                    .set_modified(metadata.modified().unwrap())
                    .unwrap();
                std::fs::rename(replacement, &file).unwrap();
            }
            "remove" => {
                std::fs::remove_file(&file).unwrap();
            }
            "root" => {
                store
                    .conn
                    .execute(
                        "UPDATE local_projects SET slug='new-root' WHERE id='project'",
                        [],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = store.research_study(&study.id).unwrap();
        assert!(store.research_commit_plan(prepared).is_err(), "{change}");
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .same_document(&before));
        assert_eq!(
            store.research_session_task("designer").unwrap(),
            Some(("design".into(), 1))
        );
    }
}

#[test]
fn plan_inheritance_marks_preexisting_invalid_outputs_and_dependents_pending() {
    for change in ["write", "remove", "oversize"] {
        let (_dir, store, study) = setup_completed_plan();
        let file = store.research_root(&study).unwrap().join("design.md");
        match change {
            "write" => std::fs::write(&file, b"changed").unwrap(),
            "remove" => std::fs::remove_file(&file).unwrap(),
            "oversize" => std::fs::File::create(&file)
                .unwrap()
                .set_len(MAX_ARTIFACT_BYTES + 1)
                .unwrap(),
            _ => unreachable!(),
        }
        store.research_set_plan(&study.id, plan()).unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert!(
            saved
                .plan()
                .unwrap()
                .tasks
                .iter()
                .all(|t| t.state == "pending"),
            "{change}"
        );
    }
}

#[cfg(unix)]
#[test]
fn plan_inheritance_detects_retargeted_symlinks_and_restored_mtime() {
    use std::os::unix::fs::symlink;
    for retarget in [false, true] {
        let (_dir, store, study) = setup_completed_plan();
        let root = store.research_root(&study).unwrap();
        let file = root.join("design.md");
        let original = std::fs::read(&file).unwrap();
        if retarget {
            std::fs::rename(&file, root.join("first.md")).unwrap();
            symlink("first.md", &file).unwrap();
        }
        let prepared = store
            .research_prepare_plan_with_inspector(
                &study.id,
                plan(),
                files::PreparedArtifact::inspect,
            )
            .unwrap();
        if retarget {
            std::fs::write(root.join("second.md"), original).unwrap();
            std::fs::remove_file(&file).unwrap();
            symlink("second.md", &file).unwrap();
        } else {
            let stamp = std::fs::metadata(&file).unwrap().modified().unwrap();
            std::fs::write(&file, vec![b'x'; original.len()]).unwrap();
            std::fs::File::open(&file)
                .unwrap()
                .set_modified(stamp)
                .unwrap();
        }
        assert!(store.research_commit_plan(prepared).is_err());
        assert_eq!(
            store
                .research_study(&study.id)
                .unwrap()
                .plan()
                .unwrap()
                .version,
            1
        );
    }
}

#[cfg(unix)]
#[test]
fn plan_inheritance_accepts_full_output_budget_with_low_descriptor_limit() {
    const WORKER: &str = "ORX_TEST_PLAN_DESCRIPTOR_WORKER";
    if std::env::var_os(WORKER).is_none() {
        let result = std::process::Command::new("sh")
            .args(["-c", "ulimit -n 128; exec \"$@\"", "plan-descriptor-test"])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", "store::research::tests::plan_inheritance_accepts_full_output_budget_with_low_descriptor_limit", "--nocapture"])
            .env(WORKER, "1").output().unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed; 0 failed"));
        return;
    }
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks = (0..40)
        .map(|index| {
            let mut task = spec(&format!("task-{index}"), "as-experiment-designer", &[]);
            task.outputs = (0..30)
                .map(|output| format!("{index}-{output}.md"))
                .collect();
            task
        })
        .collect();
    input.tasks[38].role = "as-independent-reviewer".into();
    input.tasks[38].depends_on = (0..38).map(|index| format!("task-{index}")).collect();
    input.tasks[39].role = "as-quality-citation-auditor".into();
    input.tasks[39].depends_on = vec!["task-38".into()];
    store.research_set_plan(&study.id, input.clone()).unwrap();
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    store
        .research_update(&study.id, |s| {
            let evidence = store.research_evidence(s)?.digest()?;
            for task in &mut s.plan_mut()?.tasks {
                task.state = "completed".into();
                task.evidence_digest = Some(evidence.clone());
                for path in &task.spec.outputs {
                    std::fs::write(root.join(path), b"bounded fixture")?;
                    task.artifacts.push(inspect_artifact(&root, path)?);
                }
            }
            Ok(())
        })
        .unwrap();
    store.research_set_plan(&study.id, input).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.plan().unwrap().tasks.len(), 40);
    assert!(saved
        .plan()
        .unwrap()
        .tasks
        .iter()
        .all(|t| t.state == "completed" && t.artifacts.len() == 30));
}

#[test]
fn custom_agents_are_snapshotted_and_duplicate_submissions_share_a_version() {
    let (_dir, store, study) = setup();
    let agent = store
        .create_workflow_agent(crate::workflow::AgentInput {
            name: "Evidence statistician".into(),
            description: "Check quantitative claims".into(),
            prompt: "Use only traceable quantitative evidence.".into(),
        })
        .unwrap();
    let mut input = plan();
    input.tasks[0].role = agent.id.clone();
    let (version, duplicate) = store
        .research_set_plan_idempotent(&study.id, input.clone())
        .unwrap();
    assert_eq!((version, duplicate), (1, false));
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.plan().unwrap().tasks[0].agent.as_ref().unwrap().version, 1);
    assert!(saved.plan_scope().unwrap().contains("agentDefinitions"));
    let (same_version, duplicate) = store
        .research_set_plan_idempotent(&study.id, input.clone())
        .unwrap();
    assert_eq!((same_version, duplicate), (1, true));
    assert_eq!(store.research_study(&study.id).unwrap().plans.len(), 1);

    store
        .update_workflow_agent(
            &agent.id,
            crate::workflow::AgentInput {
                name: "Evidence statistician".into(),
                description: "Check quantitative claims".into(),
                prompt: "Use only traceable quantitative evidence and report uncertainty.".into(),
            },
        )
        .unwrap();
    let (next_version, duplicate) = store
        .research_set_plan_idempotent(&study.id, input)
        .unwrap();
    assert_eq!((next_version, duplicate), (2, false));
    assert_eq!(
        store.research_study(&study.id).unwrap().plan().unwrap().tasks[0]
            .agent
            .as_ref()
            .unwrap()
            .version,
        2
    );
    assert!(store.delete_workflow_agent(&agent.id).unwrap());
    let saved = store.research_study(&study.id).unwrap();
    assert!(
        crate::local::research::task_role(&store, &saved.plan().unwrap().tasks[0])
            .unwrap()
            .contains("report uncertainty")
    );
}

