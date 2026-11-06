//! Actual CLI inspection, using declared synthetic results and an isolated store.
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::process::{Command, Output};

struct Fixture {
    root: std::path::PathBuf,
    report: Value,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("orx-scientific-metrics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut fixture = Self {
            root,
            report: Value::Null,
        };
        let _ = fixture
            .command()
            .args(["logs", "missing"])
            .output()
            .unwrap();
        let source = fixture.root.join("source.tar");
        // Deliberately synthetic archive bytes; this suite does not claim a real experiment.
        std::fs::write(&source, b"synthetic source archive").unwrap();
        let source_hash = format!("{:x}", Sha256::digest(b"synthetic source archive"));
        let backend = json!({"kind":"local_process","sourceDigest":source_hash,"sourceSize":24,
            "sourcePath":source,"cpusPerTask":2,"mem":"1G","sshHost":"not-for-output.invalid"});
        let c = fixture.db();
        for id in ["project", "other"] {
            c.execute("INSERT INTO local_projects(id,name,slug,github_owner,github_repo,github_sync_enabled,baseline_branch,repo_path,created_at,updated_at) VALUES(?1,?1,?1,'','',0,'main',?2,1,1)",params![id,fixture.root.to_string_lossy()]).unwrap();
            c.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES(?1,?1,'codex',1,1)",[id]).unwrap();
        }
        c.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,command,created_at,updated_at,ended_at,exit_code,commit_sha) VALUES('run','experiment','project','done',?1,'python train.py',1,2,2,0,?2)",params![backend.to_string(),"b".repeat(40)]).unwrap();
        std::fs::create_dir_all(fixture.artifacts().join("datasets")).unwrap();
        std::fs::write(
            fixture.artifacts().join("datasets/validation.csv"),
            b"1,2\n",
        )
        .unwrap();
        fixture.report = json!({"schemaVersion":1,"runId":"run","experimentId":"experiment","commitSha":"b".repeat(40),"sourceSha256":source_hash,
            "data":{"kind":"artifacts","files":[{"path":"datasets/validation.csv","sha256":format!("{:x}",Sha256::digest(b"1,2\n")),"bytes":4}]},
            "series":[{"name":"accuracy","unit":"1","split":"validation","points":[{"step":0,"value":0.8},{"step":1,"value":0.9}]}]});
        fixture.write_report(&fixture.report);
        fixture
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_orx"));
        c.env("ORX_DATA_DIR", self.root.join("data"))
            .env("ORX_CACHE_DIR", self.root.join("cache"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("ORX_NO_UPDATE_CHECK", "1")
            .env_remove("ORX_CHAT_SESSION_ID")
            .arg("--no-telemetry");
        c
    }
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.root.join("data/orx.db")).unwrap()
    }
    fn artifacts(&self) -> std::path::PathBuf {
        self.root.join("data/files/project")
    }
    fn write_report(&self, value: &Value) {
        std::fs::write(self.artifacts().join("metrics.json"), value.to_string()).unwrap();
    }
    fn inspect(&self) -> Output {
        self.command()
            .args([
                "metrics",
                "inspect",
                "run",
                "--file",
                "metrics.json",
                "--project",
                "project",
            ])
            .output()
            .unwrap()
    }
}

#[test]
fn inspection_binds_run_code_data_and_reports_facts_without_mutations() {
    let f = Fixture::new();
    let out = f.inspect();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["report"], f.report);
    assert_eq!(
        report["reportSha256"],
        format!("{:x}", Sha256::digest(f.report.to_string().as_bytes()))
    );
    assert_eq!(report["execution"]["cpusPerTask"], 2);
    assert!(!String::from_utf8_lossy(&out.stdout).contains("not-for-output.invalid"));
    assert!(report["meaning"]
        .as_str()
        .unwrap()
        .contains("不证明运行时实际使用"));
    let out = f
        .command()
        .env("ORX_CHAT_SESSION_ID", "project")
        .args(["metrics", "inspect", "run", "--file", "metrics.json"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        f.db()
            .query_row("SELECT COUNT(*) FROM runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        f.db()
            .query_row("SELECT COUNT(*) FROM material_read_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        f.db()
            .query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn inspection_fails_closed_for_identity_status_paths_and_tampered_files() {
    let f = Fixture::new();
    let out = f
        .command()
        .env("ORX_CHAT_SESSION_ID", "other")
        .args([
            "metrics",
            "inspect",
            "run",
            "--file",
            "metrics.json",
            "--project",
            "project",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let out = f
        .command()
        .args([
            "metrics",
            "inspect",
            "run",
            "--file",
            "metrics.json",
            "--project",
            "other",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    for path in ["../metrics.json", "/etc/passwd", "C:\\secret"] {
        assert!(!f
            .command()
            .args([
                "metrics",
                "inspect",
                "run",
                "--file",
                path,
                "--project",
                "project"
            ])
            .output()
            .unwrap()
            .status
            .success());
    }
    let c = f.db();
    for (status, exit) in [
        ("running", Some(0)),
        ("done", None),
        ("done", Some(1)),
        ("error", Some(1)),
    ] {
        c.execute(
            "UPDATE runs SET status=?1,exit_code=?2 WHERE id='run'",
            params![status, exit],
        )
        .unwrap();
        assert!(!f.inspect().status.success());
    }
    c.execute(
        "UPDATE runs SET status='done',exit_code=0 WHERE id='run'",
        [],
    )
    .unwrap();
    let mut bad = f.report.clone();
    bad["runId"] = json!("different");
    f.write_report(&bad);
    assert!(!f.inspect().status.success());
    f.write_report(&f.report);
    std::fs::write(f.artifacts().join("datasets/validation.csv"), b"9,9\n").unwrap();
    assert!(!f.inspect().status.success());
    std::fs::write(f.artifacts().join("datasets/validation.csv"), b"1,2\n").unwrap();
    std::fs::write(f.root.join("source.tar"), b"tampered source archive!").unwrap();
    assert!(!f.inspect().status.success());
}

#[cfg(unix)]
#[test]
fn inspection_rejects_symlink_escape_for_report_and_data() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.root.join("outside.json");
    std::fs::write(&outside, f.report.to_string()).unwrap();
    std::fs::remove_file(f.artifacts().join("metrics.json")).unwrap();
    symlink(&outside, f.artifacts().join("metrics.json")).unwrap();
    assert!(!f.inspect().status.success());
    std::fs::remove_file(f.artifacts().join("metrics.json")).unwrap();
    f.write_report(&f.report);
    let data = f.artifacts().join("datasets/validation.csv");
    std::fs::remove_file(&data).unwrap();
    std::fs::write(&outside, b"1,2\n").unwrap();
    symlink(&outside, data).unwrap();
    assert!(!f.inspect().status.success());
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
