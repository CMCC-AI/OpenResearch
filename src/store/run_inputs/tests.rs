use super::*;
use crate::{
    jobs::BackendDescriptor,
    run_inputs::InputSetRef,
    store::{Store, StoredRun},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

struct TestRoot(PathBuf);
impl std::ops::Deref for TestRoot {
    type Target = PathBuf;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Real frozen bytes, with synthetic Run metadata; no experiment is launched.
struct Fixture {
    store: Store,
    // Close SQLite before deleting the directory, including on Windows.
    root: TestRoot,
    reference: InputSetRef,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("orx-run-inputs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = Store::open_at(root.clone()).unwrap();
        for p in ["p", "other"] {
            store.conn.execute("INSERT INTO local_projects(id,name,slug,github_owner,github_repo,baseline_branch,repo_path,created_at,updated_at) VALUES(?1,?1,?1,'','','main',?2,1,1)",rusqlite::params![p,root.to_string_lossy()]).unwrap();
            store.conn.execute("INSERT INTO local_experiments(id,project_id,slug,branch_name,run_command,created_at,updated_at) VALUES(?1,?1,?1,'main','cat input',1,1)",[p]).unwrap();
        }
        store.input_budget(Some(16384)).unwrap();
        let package = uuid::Uuid::new_v4().to_string();
        let base = root.join("materials").join(&package);
        fs::create_dir_all(base.join("originals")).unwrap();
        fs::write(base.join("originals/data.txt"), b"frozen bytes\n").unwrap();
        fs::write(base.join("manifest.json"),json!({"id":package,"projectId":"p","createdAt":1,"ready":true,"files":[{"id":"SRC-0001","path":"data.txt","size":13,"sha256":format!("{:x}",Sha256::digest(b"frozen bytes\n")),"format":"text","status":"ready","note":null}]}).to_string()).unwrap();
        let request=serde_json::from_value(json!({"schemaVersion":1,"files":[{"path":"data.txt","source":{"kind":"material","packageId":package,"sourceId":"SRC-0001"}}]})).unwrap();
        let frozen = crate::input_sets::freeze(&store, "p", request).unwrap();
        let reference = InputSetRef {
            id: frozen["snapshot"]["id"].as_str().unwrap().into(),
            manifest_sha256: frozen["snapshot"]["manifestSha256"]
                .as_str()
                .unwrap()
                .into(),
        };
        Self {
            root: TestRoot(root),
            store,
            reference,
        }
    }
    fn descriptor(&self) -> BackendDescriptor {
        BackendDescriptor::parse(&json!({"kind":"local_job","inputSet":self.reference,"sourceDigest":"a".repeat(64),"sourceSize":1024,"sourcePath":"/synthetic/code.tar"}).to_string()).unwrap()
    }
    fn run(&self, id: &str, bound: bool) -> StoredRun {
        let mut descriptor = self.descriptor();
        if !bound {
            descriptor.input_set = None;
        }
        StoredRun {
            id: id.into(),
            experiment_id: "p".into(),
            project_id: "p".into(),
            status: "starting".into(),
            backend_json: descriptor.to_json(),
            command: "cat input".into(),
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
        let run = self.run("run", true);
        self.store.upsert_run(&run).unwrap();
        run
    }
}

#[test]
fn descriptor_roundtrip_retains_inputs_and_omits_legacy_absence() {
    let f = Fixture::new();
    let descriptor = f.descriptor();
    assert_eq!(
        BackendDescriptor::parse(&descriptor.to_json())
            .unwrap()
            .input_set,
        Some(f.reference.clone())
    );
    let legacy = f.run("legacy", false);
    assert!(serde_json::from_str::<Value>(&legacy.backend_json)
        .unwrap()
        .get("inputSet")
        .is_none());
    let mut invalid: Value = serde_json::from_str(&descriptor.to_json()).unwrap();
    invalid["inputSet"]["execute"] = json!("anything");
    assert!(BackendDescriptor::parse(&invalid.to_string()).is_err());
}

#[test]
fn old_sql_writers_cannot_erase_input_or_code_identity() {
    let f = Fixture::new();
    let run = f.reserve();
    let old = Connection::open(f.root.join("orx.db")).unwrap();
    for (key, value) in [
        ("inputSet", Value::Null),
        (
            "inputSet",
            json!({"id":f.reference.id,"manifestSha256":"0".repeat(64)}),
        ),
        (
            "inputSet",
            json!({"id":f.reference.id,"manifestSha256":f.reference.manifest_sha256,"extra":true}),
        ),
        ("sourceDigest", json!("c".repeat(64))),
        ("sourceSize", json!(1025)),
        ("sourceSize", json!(1024.0)),
        ("sourcePath", json!("elsewhere")),
        ("kind", json!("ssh_job")),
    ] {
        let mut changed: Value = serde_json::from_str(&run.backend_json).unwrap();
        changed[key] = value;
        let error = old
            .execute(
                "UPDATE runs SET backend_json=?1 WHERE id='run'",
                [changed.to_string()],
            )
            .unwrap_err();
        assert!(
            error.to_string().contains(crate::run_inputs::GUARD),
            "{error}"
        );
    }
    for field in [
        "id",
        "project_id",
        "experiment_id",
        "commit_sha",
        "command",
        "created_at",
        "chat_session_id",
    ] {
        let sql = format!("UPDATE runs SET {field}='changed' WHERE id='run'");
        assert!(old
            .execute(&sql, [])
            .unwrap_err()
            .to_string()
            .contains(crate::run_inputs::GUARD));
    }
    assert!(old
        .execute(
            "UPDATE runs SET backend_json='invalid json' WHERE id='run'",
            []
        )
        .unwrap_err()
        .to_string()
        .contains(crate::run_inputs::GUARD));
    assert_eq!(
        f.store.get_run("run").unwrap().unwrap().backend_json,
        run.backend_json
    );
}

#[test]
fn new_bindings_require_frozen_scope_and_complete_source_identity() {
    let f = Fixture::new();
    let original = f.run("run", true);
    for (key, value) in [
        (
            "inputSet",
            json!({"id":uuid::Uuid::new_v4().to_string(),"manifestSha256":f.reference.manifest_sha256}),
        ),
        (
            "inputSet",
            json!({"id":f.reference.id,"manifestSha256":f.reference.manifest_sha256,"extra":true}),
        ),
        ("inputSet", json!("not an object")),
        ("sourceDigest", Value::Null),
        ("sourceDigest", json!("A".repeat(64))),
        ("sourceSize", json!(0)),
        ("sourceSize", json!(1.5)),
        ("sourcePath", json!("")),
    ] {
        let mut changed = original.clone();
        let mut descriptor: Value = serde_json::from_str(&changed.backend_json).unwrap();
        descriptor[key] = value;
        changed.backend_json = descriptor.to_string();
        assert!(f.store.upsert_run(&changed).is_err(), "{key}");
        assert!(f.store.get_run("run").unwrap().is_none());
    }
    for (project, experiment, commit, command, status) in [
        ("other", "other", Some("revision"), "cat input", "starting"),
        ("p", "other", Some("revision"), "cat input", "starting"),
        ("p", "p", None, "cat input", "starting"),
        ("p", "p", Some("revision"), " ", "starting"),
        ("p", "p", Some("revision"), "cat input", "done"),
    ] {
        let mut changed = original.clone();
        changed.project_id = project.into();
        changed.experiment_id = experiment.into();
        changed.commit_sha = commit.map(str::to_string);
        changed.command = command.into();
        changed.status = status.into();
        assert!(f.store.upsert_run(&changed).is_err());
    }
    f.store.upsert_run(&original).unwrap();
}

#[test]
fn bindings_cannot_be_attached_late_or_deleted_and_legacy_runs_remain_mutable() {
    let f = Fixture::new();
    let run = f.reserve();
    let legacy = f.run("legacy", false);
    f.store.upsert_run(&legacy).unwrap();
    assert!(f
        .store
        .set_backend_json("legacy", &run.backend_json)
        .is_err());
    let mut late = run.clone();
    late.id = "legacy".into();
    assert!(f.store.upsert_run(&late).is_err());
    assert!(f
        .store
        .conn
        .execute("DELETE FROM runs WHERE id='run'", [])
        .is_err());
    f.store
        .conn
        .execute(
            "UPDATE runs SET backend_json='legacy malformed descriptor' WHERE id='legacy'",
            [],
        )
        .unwrap();
    assert!(f
        .store
        .update_status("legacy", crate::store::RunStatus::Failed, Some(2), Some(1))
        .unwrap());
    assert_eq!(
        f.store
            .conn
            .execute("DELETE FROM runs WHERE id='legacy'", [])
            .unwrap(),
        1
    );
}

#[test]
fn upsert_replace_and_update_guards_survive_reopen_and_preserve_normal_lifecycle() {
    let f = Fixture::new();
    let original = f.reserve();
    let reopened = Store::open_at(f.root.clone()).unwrap();
    let mut handle = f.descriptor();
    handle.job_id = Some("/synthetic/run-dir".into());
    let mut launched = original.clone();
    launched.backend_json = handle.to_json();
    launched.status = "running".into();
    reopened.upsert_run(&launched).unwrap();
    let mut missing = launched.clone();
    handle.input_set = None;
    missing.backend_json = handle.to_json();
    missing.status = "done".into();
    missing.exit_code = Some(0);
    assert!(reopened.upsert_run(&missing).is_err());
    assert_eq!(reopened.get_run("run").unwrap().unwrap().status, "running");
    reopened
        .conn
        .execute_batch("PRAGMA recursive_triggers=OFF")
        .unwrap();
    assert!(reopened.conn.execute("INSERT OR REPLACE INTO runs(id,experiment_id,project_id,status,backend_json,command,created_at,updated_at,commit_sha) VALUES('run','p','p','starting',?1,'cat input',1,2,?2)",rusqlite::params![missing.backend_json,original.commit_sha]).is_err());
    assert!(reopened
        .update_status("run", crate::store::RunStatus::Done, Some(3), Some(0))
        .unwrap());
    let mut finished = launched;
    finished.status = "done".into();
    finished.ended_at = Some(3);
    finished.exit_code = Some(0);
    reopened.upsert_run(&finished).unwrap();
    assert_eq!(reopened.get_run("run").unwrap().unwrap().status, "done");
}

#[test]
fn recovery_checks_the_bound_store_and_cannot_downgrade_to_an_unbound_file() {
    let f = Fixture::new();
    f.reserve();
    let dir = f.root.join("submission-handles");
    let mut handle = f.descriptor();
    handle.job_id = Some("/synthetic/handle".into());
    crate::compute::record_submission_handle_at(
        Store::open_at(f.root.clone()),
        &f.root,
        "run",
        &handle,
    )
    .unwrap();
    assert_eq!(
        crate::compute::recover_submission_handle(&f.store, "run")
            .unwrap()
            .unwrap()
            .job_id,
        handle.job_id
    );
    let saved = fs::read(dir.join("run.json")).unwrap();
    let mut missing = handle.clone();
    missing.input_set = None;
    assert!(crate::compute::record_submission_handle_at(
        Store::open_at(f.root.clone()),
        &f.root,
        "run",
        &missing
    )
    .is_err());
    assert_eq!(fs::read(dir.join("run.json")).unwrap(), saved);
    fs::write(dir.join("run.json"), missing.to_json()).unwrap();
    assert!(crate::compute::recover_submission_handle(&f.store, "run").is_err());
    for (key, value) in [
        (
            "inputSet",
            json!({"id":uuid::Uuid::new_v4().to_string(),"manifestSha256":f.reference.manifest_sha256}),
        ),
        ("sourceDigest", json!("c".repeat(64))),
        ("sourceSize", json!(1025)),
        ("sourcePath", json!("wrong-code.tar")),
        ("kind", json!("ssh_job")),
    ] {
        let mut changed: Value = serde_json::from_str(&handle.to_json()).unwrap();
        changed[key] = value;
        fs::write(dir.join("run.json"), changed.to_string()).unwrap();
        assert!(
            crate::compute::recover_submission_handle(&f.store, "run").is_err(),
            "{key}"
        );
        assert_eq!(
            f.store.get_run("run").unwrap().unwrap().backend_json,
            handle.to_json()
        );
    }
    fs::write(dir.join("run.json"), saved).unwrap();
    let failure = crate::error::anyhow!("simulated database unavailable");
    assert!(crate::compute::record_submission_handle_at(
        Err(failure),
        &f.root,
        "not-reserved",
        &handle
    )
    .is_err());
    assert!(!dir.join("not-reserved.json").exists());
    assert!(crate::compute::record_submission_handle_at(
        Store::open_at(f.root.clone()),
        &f.root,
        "missing-run",
        &handle
    )
    .is_err());
    assert!(!dir.join("missing-run.json").exists());
}

#[test]
fn legacy_recovery_fallback_remains_available_without_inputs() {
    let f = Fixture::new();
    let run = f.run("legacy", false);
    f.store.upsert_run(&run).unwrap();
    let mut descriptor = BackendDescriptor::parse(&run.backend_json).unwrap();
    descriptor.job_id = Some("legacy-handle".into());
    crate::compute::record_submission_handle_at(
        Err(crate::error::anyhow!("simulated database unavailable")),
        &f.root,
        "legacy",
        &descriptor,
    )
    .unwrap();
    assert_eq!(
        crate::compute::recover_submission_handle(&f.store, "legacy")
            .unwrap()
            .unwrap()
            .job_id,
        descriptor.job_id
    );
}

#[test]
fn historical_identity_protection_does_not_disable_cancellation_after_metadata_drift() {
    let f = Fixture::new();
    let mut run = f.reserve();
    // An old/external writer changes experiment metadata. This must prevent
    // new invalid admissions, but never stop an existing run being cancelled.
    f.store
        .conn
        .execute(
            "UPDATE local_experiments SET project_id='other' WHERE id='p'",
            [],
        )
        .unwrap();
    assert!(f
        .store
        .request_cancel("run", "operator cancellation")
        .unwrap());
    let mut descriptor = f.descriptor();
    descriptor.job_id = Some("historical-handle".into());
    run.backend_json = descriptor.to_json();
    f.store.upsert_run(&run).unwrap();
    let saved = f.store.get_run("run").unwrap().unwrap();
    assert!(saved.cancel_requested);
    assert_eq!(saved.project_id, "p");
    assert!(f
        .store
        .update_status(
            "run",
            crate::store::RunStatus::Cancelled,
            Some(2),
            Some(143)
        )
        .unwrap());
    assert!(f.store.upsert_run(&f.run("new-invalid-run", true)).is_err());
}
