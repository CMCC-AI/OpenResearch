use super::super::tests::Fixture;
use super::*;
use crate::{jobs::BackendDescriptor, local::model::LocalExperiment, store::StoredRun};

struct Case {
    f: Fixture,
    input_id: String,
    reference: InputSetRef,
    code: PathBuf,
}
impl Case {
    fn new(alias: bool) -> Self {
        let f = Fixture::new();
        f.store.input_budget(Some(16384)).unwrap();
        f.store
            .create_local_experiment(&LocalExperiment {
                id: "e".into(),
                project_id: "p".into(),
                parent_experiment_id: None,
                slug: "e".into(),
                branch_name: "main".into(),
                title: None,
                description: None,
                run_command: "controlled test".into(),
                agent_status: "idle".into(),
                created_at: 1,
                updated_at: 1,
                chat_session_id: None,
                archived: false,
            })
            .unwrap();
        let mut request = f.request();
        if alias {
            let mut other = request.files[0].clone();
            other.path = "second/data.txt".into();
            request.files.push(other);
        }
        let frozen = freeze(&f.store, "p", request).unwrap();
        let input_id = frozen["snapshot"]["id"].as_str().unwrap().to_string();
        let reference = prepare(&f.store, "p", &input_id).unwrap().reference;
        let code = f.dir.join("code.tar");
        fs::write(&code, b"synthetic code archive bytes").unwrap();
        Self {
            f,
            input_id,
            reference,
            code,
        }
    }
    fn run(&self) -> StoredRun {
        let descriptor=BackendDescriptor::parse(&serde_json::json!({"kind":"local_job","inputSet":self.reference,"sourceDigest":hash(b"synthetic code archive bytes"),"sourceSize":28,"sourcePath":self.code}).to_string()).unwrap();
        StoredRun {
            id: uuid::Uuid::new_v4().to_string(),
            experiment_id: "e".into(),
            project_id: "p".into(),
            status: "starting".into(),
            backend_json: descriptor.to_json(),
            command: "controlled test".into(),
            created_at: 1,
            updated_at: 1,
            ended_at: None,
            exit_code: None,
            commit_sha: Some("b".repeat(40)),
            result_markdown: None,
            cancel_requested: false,
            cancel_reason: None,
            chat_session_id: None,
        }
    }
    fn reserve(&self) -> StoredRun {
        let run = self.run();
        let tx = self.f.store.begin_immediate().unwrap();
        self.f.store.upsert_run(&run).unwrap();
        self.f.store.reserve_input_delivery(&run.id).unwrap();
        tx.commit().unwrap();
        run
    }
    fn used(&self) -> u64 {
        self.f.store.input_budget(None).unwrap()["chargedBytes"]
            .as_u64()
            .unwrap()
    }
}

#[test]
fn independent_alias_copies_retain_historical_bytes_and_verify_code_before_start() {
    let c = Case::new(true);
    let before = c.used();
    let run = c.reserve();
    let record = c.f.store.input_record("p", &c.input_id).unwrap();
    let expected = serde_json::to_vec(&record.manifest).unwrap().len() as u64 + 28;
    assert_eq!(c.used() - before, expected);
    let dir = deliver(&c.f.store, "p", &run.id).unwrap();
    let one = dir.join("files").join(&record.manifest.files[0].path);
    let two = dir.join("files/second/data.txt");
    assert_eq!(fs::read(&one).unwrap(), b"original data\n");
    assert_eq!(fs::read(&two).unwrap(), b"original data\n");
    assert_ne!(
        same_file::Handle::from_path(&one).unwrap(),
        same_file::Handle::from_path(&two).unwrap()
    );
    fs::remove_dir_all(c.f.dir.join("materials")).unwrap();
    assert_eq!(
        verify(&c.f.store, "p", &run.id).unwrap()["codeSnapshotVerified"],
        true
    );
    assert!(
        !verify(&c.f.store, "p", &run.id).unwrap()["consumptionObserved"]
            .as_bool()
            .unwrap()
    );
    assert!(show(&c.f.store, "other", &run.id).is_err());
    assert!(recover(&c.f.store, "p", &run.id, true).is_err());
    fs::write(&c.code, b"wrong code archive").unwrap();
    assert!(verify(&c.f.store, "p", &run.id).is_err());
}

#[test]
fn shared_capacity_reserves_atomically_and_protects_against_old_freeze_writers() {
    let c = Case::new(false);
    let frozen = c.used();
    let m = c.f.store.input_record("p", &c.input_id).unwrap().manifest;
    let delivery = serde_json::to_vec(&m).unwrap().len() as u64 + 14;
    c.f.store.input_budget(Some(frozen + delivery)).unwrap();
    let run = c.reserve();
    assert_eq!(c.used(), frozen + delivery);
    let another = c.run();
    {
        let tx = c.f.store.begin_immediate().unwrap();
        c.f.store.upsert_run(&another).unwrap();
        assert!(c.f.store.reserve_input_delivery(&another.id).is_err());
        drop(tx);
    }
    assert!(c.f.store.get_run(&another.id).unwrap().is_none());
    let old = rusqlite::Connection::open(c.f.dir.join("orx.db")).unwrap();
    assert!(old
        .execute("UPDATE input_set_budget SET bytes=?1", [frozen])
        .is_err());
    let mut extra = m;
    extra.id = uuid::Uuid::new_v4().to_string();
    let json = serde_json::to_string(&extra).unwrap();
    assert!(old.execute("INSERT INTO frozen_input_sets(id,project_id,created_at,state,charged_bytes,manifest_sha256,manifest) VALUES(?1,'p',1,'preparing',?2,?3,?4)",rusqlite::params![extra.id,delivery,hash(json.as_bytes()),json]).is_err());
    assert!(old
        .execute(
            "UPDATE input_deliveries SET charged_bytes=1 WHERE run_id=?1",
            [&run.id]
        )
        .is_err());
    assert!(old
        .execute("DELETE FROM input_deliveries WHERE run_id=?1", [&run.id])
        .is_err());
    assert_eq!(
        recover(&c.f.store, "p", &run.id, false).unwrap()["notStartedAtInspection"],
        true
    );
    assert!(!c.f.dir.join("input-sets/deliveries").exists());
    recover(&c.f.store, "p", &run.id, true).unwrap();
    assert_eq!(c.used(), frozen);
    assert_eq!(
        c.f.store.get_run(&run.id).unwrap().unwrap().status,
        "failed"
    );
    assert!(deliver(&c.f.store, "p", &run.id).is_err());
}

#[test]
fn concurrent_runs_cannot_overcommit_the_shared_input_pool() {
    let c = Case::new(false);
    let before = c.used();
    let m = c.f.store.input_record("p", &c.input_id).unwrap().manifest;
    c.f.store
        .input_budget(Some(
            before + serde_json::to_vec(&m).unwrap().len() as u64 + 14,
        ))
        .unwrap();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let jobs = (0..2)
        .map(|_| {
            let run = c.run();
            let root = c.f.dir.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                let store = Store::open_at(root).unwrap();
                gate.wait();
                let tx = store.begin_immediate().unwrap();
                store.upsert_run(&run).unwrap();
                let result = store.reserve_input_delivery(&run.id);
                if result.is_ok() {
                    tx.commit().unwrap();
                    true
                } else {
                    drop(tx);
                    assert!(store.get_run(&run.id).unwrap().is_none());
                    false
                }
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        jobs.into_iter()
            .map(|j| j.join().unwrap())
            .filter(|ok| *ok)
            .count(),
        1
    );
}

#[test]
fn copying_and_readback_do_not_hold_the_sqlite_writer() {
    let c = Case::new(false);
    let run = c.reserve();
    let other = Store::open_at(c.f.dir.clone()).unwrap();
    let mut writer = None;
    let mut observed = 0;
    deliver_with_check(&c.f.store, "p", &run.id, |phase| {
        if phase == Phase::Copying {
            writer = Some(other.begin_immediate()?);
            observed += 1;
        } else {
            writer.take().unwrap().commit()?;
            observed += 1;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(observed, 2);
    assert_eq!(
        verify(&c.f.store, "p", &run.id).unwrap()["copiesVerified"],
        true
    );
}

#[test]
fn unknown_paths_block_all_cleanup_and_recovery_until_operator_inspection() {
    let c = Case::new(false);
    let before = c.used();
    let run = c.reserve();
    let dir = c.f.dir.join("input-sets/deliveries").join(&run.id);
    assert!(deliver_with_check(&c.f.store, "p", &run.id, |phase| {
        if phase == Phase::Committing {
            fs::write(dir.join("unknown"), b"keep me")?;
        }
        Ok(())
    })
    .is_err());
    let charge = c.used();
    assert!(charge > before);
    for apply in [false, true] {
        assert!(recover(&c.f.store, "p", &run.id, apply).is_err());
        assert_eq!(fs::read(dir.join("unknown")).unwrap(), b"keep me");
        assert!(dir.join("manifest.json").exists());
    }
    fs::rename(dir.join("unknown"), c.f.dir.join("operator-inspected")).unwrap();
    recover(&c.f.store, "p", &run.id, true).unwrap();
    assert_eq!(c.used(), before);
    assert!(!dir.exists());
    assert_eq!(
        super::super::verify(&c.f.store, "p", &c.input_id).unwrap()["copiesVerified"],
        true
    );
}

#[test]
fn cancellation_before_availability_prevents_publication_and_releases_only_run_copies() {
    let c = Case::new(false);
    let before = c.used();
    let run = c.reserve();
    assert!(deliver_with_check(&c.f.store, "p", &run.id, |phase| {
        if phase == Phase::Committing {
            c.f.store.request_cancel(&run.id, "operator")?;
        }
        Ok(())
    })
    .is_err());
    assert_eq!(c.used(), before);
    assert_eq!(
        c.f.store.input_delivery("p", &run.id).unwrap().state,
        "cancelled"
    );
    assert!(verify(&c.f.store, "p", &run.id).is_err());
}

#[test]
fn interrupted_delivery_keeps_charge_and_lease_until_explicit_recovery() {
    const WORKER: &str = "ORX_TEST_RUN_INPUT_DELIVERY_WORKER";
    if let Some(root) = std::env::var_os(WORKER) {
        let root = PathBuf::from(root);
        let store = Store::open_at(root.clone()).unwrap();
        let run = std::env::var("ORX_TEST_DELIVERY_RUN_ID").unwrap();
        deliver_with_check(&store, "p", &run, |phase| {
            if phase == Phase::Committing {
                fs::write(root.join("checkpoint.tmp"), b"copied")?;
                fs::rename(root.join("checkpoint.tmp"), root.join("checkpoint"))?;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
            Ok(())
        })
        .unwrap();
        unreachable!();
    }
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let c = Case::new(false);
    let before = c.used();
    let run = c.reserve();
    let mut child=Child(std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","input_sets::delivery::tests::interrupted_delivery_keeps_charge_and_lease_until_explicit_recovery","--nocapture"])
      .env(WORKER,&*c.f.dir).env("ORX_TEST_DELIVERY_RUN_ID",&run.id).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !c.f.dir.join("checkpoint").exists() {
        assert!(child.0.try_wait().unwrap().is_none(), "worker exited");
        assert!(std::time::Instant::now() < until, "worker did not copy");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(recover(&c.f.store, "p", &run.id, true).is_err());
    assert!(c.used() > before);
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert_eq!(
        c.f.store.input_delivery("p", &run.id).unwrap().state,
        "copying"
    );
    recover(&c.f.store, "p", &run.id, true).unwrap();
    assert_eq!(c.used(), before);
}

#[test]
fn actual_input_refs_invalidate_old_g2_g3_while_legacy_contracts_omit_inputs() {
    const NAME:&str="input_sets::delivery::tests::actual_input_refs_invalidate_old_g2_g3_while_legacy_contracts_omit_inputs";
    if crate::test_support::run_isolated(NAME, &["ORX_CHAT_SESSION_ID", "ORX_INVOCATION_CONTEXT"]) {
        return;
    }
    use crate::store::research::{PlanInput, TaskSpec};
    let c = Case::new(false);
    std::env::set_var("XDG_CONFIG_HOME", c.f.dir.join("config"));
    let repo = c.f.dir.join("repo");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("marker.txt"), b"fixture code\n").unwrap();
    for args in [
        vec!["init", "--initial-branch=main"],
        vec!["add", "marker.txt"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "controlled fixture",
        ],
    ] {
        let out = std::process::Command::new("git")
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", c.f.dir.join("empty-git-config"))
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let mut args = crate::compute::tests::tinker_args();
    args.exp_id = "e".into();
    args.backend = Some("local".into());
    let legacy = crate::local::research::run_contract(&c.f.store, &args).unwrap();
    assert!(legacy.options.get("inputSet").is_none());
    args.input_set = Some(c.input_id.clone());
    let first = crate::local::research::run_contract(&c.f.store, &args).unwrap();
    assert_eq!(
        first.options["inputSet"],
        serde_json::to_value(&c.reference).unwrap()
    );
    let mut omitted = first.clone();
    omitted.options.as_object_mut().unwrap().remove("inputSet");
    assert_eq!(
        serde_json::to_vec(&omitted).unwrap(),
        serde_json::to_vec(&legacy).unwrap()
    );
    let frozen = freeze(&c.f.store, "p", c.f.request()).unwrap();
    args.input_set = Some(frozen["snapshot"]["id"].as_str().unwrap().into());
    let second = crate::local::research::run_contract(&c.f.store, &args).unwrap();
    assert_ne!(first, second);
    let db = rusqlite::Connection::open(c.f.dir.join("orx.db")).unwrap();
    for id in ["lead", "operator"] {
        db.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES(?1,'p','codex',1,1)",[id]).unwrap();
    }
    drop(db);
    let study =
        c.f.store
            .research_create(
                "lead",
                "team",
                "synthetic gate acceptance; no experiment launched",
            )
            .unwrap();
    c.f.store
        .research_set_plan(
            &study.id,
            PlanInput {
                workflow: None,
                summary: "input gate fixture".into(),
                tasks: vec![
                    TaskSpec {
                        id: "execute".into(),
                        role: "as-experiment-operator".into(),
                        brief: "controlled test".into(),
                        depends_on: vec![],
                        outputs: vec!["result.txt".into()],
                        force_rerun: false,
                    },
                    TaskSpec {
                        id: "review".into(),
                        role: "as-independent-reviewer".into(),
                        brief: "review fixture".into(),
                        depends_on: vec!["execute".into()],
                        outputs: vec!["review.txt".into()],
                        force_rerun: false,
                    },
                    TaskSpec {
                        id: "audit".into(),
                        role: "as-quality-citation-auditor".into(),
                        brief: "audit fixture".into(),
                        depends_on: vec!["review".into()],
                        outputs: vec!["audit.txt".into()],
                        force_rerun: false,
                    },
                ],
            },
        )
        .unwrap();
    let approve = |gate: &str| {
        let saved = c.f.store.research_study(&study.id).unwrap();
        let d = saved
            .decisions
            .iter()
            .rev()
            .find(|d| d.gate == gate && d.status == "pending")
            .unwrap();
        c.f.store
            .research_decide(
                &study.id,
                &d.id,
                &d.scope_hash,
                true,
                "synthetic test user approval".into(),
            )
            .unwrap();
    };
    approve("G1");
    c.f.store
        .research_prepare(&study.id, "execute", first.clone())
        .unwrap();
    approve("G2");
    approve("G3");
    let old =
        c.f.store
            .research_study(&study.id)
            .unwrap()
            .decisions
            .iter()
            .filter(|d| matches!(d.gate.as_str(), "G2" | "G3"))
            .map(|d| d.id.clone())
            .collect::<Vec<_>>();
    c.f.store
        .research_prepare(&study.id, "execute", second.clone())
        .unwrap();
    let saved = c.f.store.research_study(&study.id).unwrap();
    assert_eq!(old.len(), 2);
    for id in old {
        assert_eq!(
            saved.decisions.iter().find(|d| d.id == id).unwrap().status,
            "superseded"
        );
    }
    assert!(c
        .f
        .store
        .research_bind_task(&study.id, "execute", "operator")
        .is_err());
    approve("G2");
    approve("G3");
    let tx = c.f.store.begin_immediate().unwrap();
    c.f.store
        .research_bind_task(&study.id, "execute", "operator")
        .unwrap();
    tx.commit().unwrap();
    assert!(c
        .f
        .store
        .research_check_run("e", Some("operator"), &first, None)
        .is_err());
    c.f.store
        .research_check_run("e", Some("operator"), &second, None)
        .unwrap();
    assert!(c.f.store.list_runs_by_experiment("e").unwrap().is_empty());
}
