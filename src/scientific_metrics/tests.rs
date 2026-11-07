use super::*;
use serde_json::{json, Value};

fn fixture() -> (StoredRun, BackendDescriptor, Value) {
    let backend = BackendDescriptor::parse(
        &json!({"kind":"local_process","sourceDigest":"a".repeat(64)}).to_string(),
    )
    .unwrap();
    let run = StoredRun {
        id: "run".into(),
        experiment_id: "exp".into(),
        project_id: "project".into(),
        status: "done".into(),
        backend_json: backend.to_json(),
        command: "python train.py".into(),
        created_at: 1,
        updated_at: 2,
        ended_at: Some(2),
        exit_code: Some(0),
        commit_sha: Some("b".repeat(40)),
        result_markdown: None,
        cancel_requested: false,
        cancel_reason: None,
        chat_session_id: None,
    };
    let report = json!({"schemaVersion":1,"runId":"run","experimentId":"exp","commitSha":"b".repeat(40),
        "sourceSha256":"a".repeat(64),"data":{"kind":"none"},
        "series":[{"name":"loss","unit":"1","split":"validation","points":[{"step":0,"value":0.75},{"step":2,"value":0.5}]}]});
    (run, backend, report)
}

#[test]
fn report_rejects_other_run_source_and_unknown_contracts() {
    let (run, backend, report) = fixture();
    assert!(parse(&serde_json::to_vec(&report).unwrap(), &run, &backend).is_ok());
    for (field, value) in [
        ("schemaVersion", json!(2)),
        ("runId", json!("other")),
        ("experimentId", json!("other")),
        ("commitSha", json!("c".repeat(40))),
        ("sourceSha256", json!("c".repeat(64))),
        ("invented", json!(true)),
    ] {
        let mut bad = report.clone();
        bad[field] = value;
        assert!(
            parse(&serde_json::to_vec(&bad).unwrap(), &run, &backend).is_err(),
            "{field}"
        );
    }
    let mut legacy = run.clone();
    legacy.commit_sha = None;
    assert!(parse(&serde_json::to_vec(&report).unwrap(), &legacy, &backend).is_err());
}

#[test]
fn report_rejects_ambiguous_steps_units_and_series() {
    let (run, backend, report) = fixture();
    let reject = |bad: &Value| {
        assert!(
            parse(&serde_json::to_vec(bad).unwrap(), &run, &backend).is_err(),
            "{bad}"
        )
    };
    for points in [
        json!([]),
        json!([{"step":1,"value":1},{"step":1,"value":2}]),
        json!([{"step":3,"value":1},{"step":2,"value":2}]),
        json!([{"step":-1,"value":1}]),
        json!([{"step":1.5,"value":1}]),
        json!([{"step":MAX_SAFE_INTEGER+1,"value":1}]),
        json!([{"step":0,"value":null}]),
    ] {
        let mut bad = report.clone();
        bad["series"][0]["points"] = points;
        reject(&bad);
    }
    for field in ["name", "unit", "split"] {
        let mut bad = report.clone();
        bad["series"][0][field] = json!("\n");
        reject(&bad);
    }
    let mut bad = report.clone();
    bad["series"]
        .as_array_mut()
        .unwrap()
        .push(report["series"][0].clone());
    reject(&bad);
    // Changing the unit cannot disguise the same metric and split as a second series.
    bad["series"][1]["unit"] = json!("percent");
    reject(&bad);
    let mut valid = report.clone();
    let mut train = report["series"][0].clone();
    train["split"] = json!("train");
    valid["series"].as_array_mut().unwrap().push(train);
    assert!(parse(&serde_json::to_vec(&valid).unwrap(), &run, &backend).is_ok());
    let malformed = serde_json::to_string(&report)
        .unwrap()
        .replace("0.75", "1e999");
    assert!(parse(malformed.as_bytes(), &run, &backend).is_err());
}

#[test]
fn report_has_total_budgets_and_explicit_data_identity() {
    let (run, backend, report) = fixture();
    let check = |v: &Value| parse(&serde_json::to_vec(v).unwrap(), &run, &backend).is_ok();
    let mut value = report.clone();
    value["series"][0]["points"] = json!((0..MAX_POINTS)
        .map(|step| json!({"step":step,"value":1}))
        .collect::<Vec<_>>());
    assert!(check(&value));
    value["series"][0]["points"]
        .as_array_mut()
        .unwrap()
        .push(json!({"step":MAX_POINTS,"value":1}));
    assert!(!check(&value));
    assert!(parse(&vec![b' '; REPORT_BYTES as usize + 1], &run, &backend).is_err());
    let input = json!({"path":"datasets/test.csv","sha256":"f".repeat(64),"bytes":64});
    let mut unexpected = report.clone();
    unexpected["data"] = json!({"kind":"none","files":[input.clone()]});
    assert!(
        !check(&unexpected),
        "declared inputs must not disappear under kind=none"
    );
    value = report.clone();
    value["data"] = json!({"kind":"artifacts","files":[input.clone()]});
    assert!(check(&value));
    for path in [
        "../secret",
        "/etc/passwd",
        "a/../b",
        "a\\b",
        "C:secret",
        "a\nb",
        "",
    ] {
        let mut bad = value.clone();
        bad["data"]["files"][0]["path"] = json!(path);
        assert!(!check(&bad), "{path}");
    }
    let mut bad = value.clone();
    bad["data"]["files"].as_array_mut().unwrap().push(input);
    assert!(!check(&bad));
    bad = value.clone();
    bad["data"]["files"][0]["bytes"] = json!(INPUT_BYTES + 1);
    assert!(!check(&bad));
    bad = value.clone();
    bad["data"]["files"] = json!([]);
    assert!(!check(&bad));
    bad = report;
    bad.as_object_mut().unwrap().remove("data");
    assert!(!check(&bad));
}

#[test]
fn verified_files_reject_tampering_size_and_identity_changes() {
    let dir = crate::local::git::TemporaryDirectory::new("scientific-metrics").unwrap();
    let path = dir.path().join("data.csv");
    std::fs::write(&path, b"1234").unwrap();
    let hash = format!("{:x}", Sha256::digest(b"1234"));
    assert!(open_hashed(&path, &hash, 4, 4).is_ok());
    assert!(open_hashed(&path, &hash, 3, 4).is_err());
    assert!(open_hashed(&path, &hash, 4, 3).is_err());
    let held = open_hashed(&path, &hash, 4, 4).unwrap();
    let replacement = dir.path().join("new.csv");
    std::fs::write(&replacement, b"1234").unwrap();
    // Drop the original name before renaming so this tests the same identity
    // replacement on Windows and Unix without relying on rename-overwrite.
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert!(held.check_unchanged().is_err());
    std::fs::write(&path, b"abcd").unwrap();
    assert!(open_hashed(&path, &hash, 4, 4).is_err());
}

#[test]
fn registration_rechecks_run_under_lock_and_rolls_back_failed_inserts() {
    let dir = crate::local::git::TemporaryDirectory::new("metric-registration").unwrap();
    let store = Store::open_at(dir.path().into()).unwrap();
    let db = rusqlite::Connection::open(dir.path().join("orx.db")).unwrap();
    db.execute("INSERT INTO local_projects(id,name,slug,github_owner,github_repo,github_sync_enabled,baseline_branch,repo_path,created_at,updated_at) VALUES('project','project','project','','',0,'main','/tmp',1,1)",[]).unwrap();
    let (run, backend, report) = fixture();
    store.upsert_run(&run).unwrap();
    let expected = store.get_run(&run.id).unwrap().unwrap();
    let mut inspection = Inspection {
        schema_version: 1,
        project_id: run.project_id.clone(),
        run_id: run.id.clone(),
        experiment_id: run.experiment_id.clone(),
        status: run.status.clone(),
        command: run.command.clone(),
        execution: json!({}),
        report_path: "metrics.json".into(),
        report_sha256: "c".repeat(64),
        report_bytes: 100,
        source_bytes: 10,
        measured_at: 1,
        meaning: "synthetic registration fixture",
        report: parse(&serde_json::to_vec(&report).unwrap(), &run, &backend).unwrap(),
    };
    // This deterministically represents a different process changing identity
    // after all file verification but before the writer transaction begins.
    for sql in [
        "UPDATE runs SET updated_at=updated_at+1 WHERE id='run'",
        "UPDATE runs SET command='changed' WHERE id='run'",
        "UPDATE runs SET exit_code=1 WHERE id='run'",
        "UPDATE runs SET backend_json='{}' WHERE id='run'",
        "UPDATE runs SET commit_sha=NULL WHERE id='run'",
        "UPDATE runs SET ended_at=3 WHERE id='run'",
        "UPDATE runs SET project_id='other' WHERE id='run'",
        "UPDATE runs SET experiment_id='changed' WHERE id='run'",
        "UPDATE runs SET created_at=3 WHERE id='run'",
        "UPDATE runs SET status='error' WHERE id='run'",
    ] {
        db.execute("DELETE FROM runs", []).unwrap();
        store.upsert_run(&expected).unwrap();
        db.execute(sql, []).unwrap();
        assert!(
            store
                .register_metric_evidence(&expected, &inspection)
                .is_err(),
            "{sql}"
        );
    }
    db.execute("DELETE FROM runs", []).unwrap();
    assert!(store
        .register_metric_evidence(&expected, &inspection)
        .is_err());
    store.upsert_run(&expected).unwrap();
    db.execute_batch("CREATE TRIGGER reject_metric_insert BEFORE INSERT ON scientific_metric_evidence BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;").unwrap();
    assert!(store
        .register_metric_evidence(&expected, &inspection)
        .is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM scientific_metric_evidence", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    db.execute_batch("DROP TRIGGER reject_metric_insert")
        .unwrap();
    let first = store
        .register_metric_evidence(&expected, &inspection)
        .unwrap();
    // A successful retry appends exactly one observation and releases its lock.
    assert_eq!(
        store.metric_evidence("project", &first.id).unwrap().id,
        first.id
    );
    let other = Store::open_at(dir.path().into()).unwrap();
    assert!(
        other
            .register_metric_evidence(&expected, &inspection)
            .unwrap()
            .sequence
            > first.sequence
    );
    inspection.command = "x".repeat(4 * 1024 * 1024 + 1);
    assert!(other
        .register_metric_evidence(&expected, &inspection)
        .is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM scientific_metric_evidence", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    // Idempotent schema reopen preserves the original observation unchanged.
    drop(other);
    drop(store);
    let reopened = Store::open_at(dir.path().into()).unwrap();
    assert_eq!(
        reopened
            .metric_evidence("project", &first.id)
            .unwrap()
            .snapshot_sha256,
        first.snapshot_sha256
    );
}
