//! Real isolated snapshots and controlled local reads; never production research.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    process::{Command, Output},
};
struct Fixture {
    root: PathBuf,
    package: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("orx-inputs-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let f = Self {
            root,
            package: uuid::Uuid::new_v4().to_string(),
        };
        assert!(f
            .run(&["inputs", "quota", "--bytes", "16384"])
            .status
            .success());
        let conn = rusqlite::Connection::open(f.root.join("data/orx.db")).unwrap();
        for id in ["p", "other"] {
            conn.execute("INSERT INTO local_projects(id,name,slug,github_owner,github_repo,github_sync_enabled,baseline_branch,repo_path,created_at,updated_at) VALUES(?1,?1,?1,'','',0,'main',?2,1,1)",rusqlite::params![id,f.root.to_string_lossy()]).unwrap();
        }
        conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('agent','p','codex',1,1)",[]).unwrap();
        let base = f.root.join("data/materials").join(&f.package);
        std::fs::create_dir_all(base.join("originals")).unwrap();
        std::fs::write(base.join("originals/data.txt"), b"real copied bytes\n").unwrap();
        std::fs::write(base.join("manifest.json"),json!({"id":f.package,"projectId":"p","createdAt":1,"ready":true,"files":[{"id":"SRC-0001","path":"data.txt","size":18,"sha256":format!("{:x}",Sha256::digest(b"real copied bytes\n")),"format":"text","status":"ready","note":null}]}).to_string()).unwrap();
        std::fs::write(f.root.join("inputs.json"),json!({"schemaVersion":1,"files":[{"path":"dataset/data.txt","source":{"kind":"material","packageId":f.package,"sourceId":"SRC-0001"}}]}).to_string()).unwrap();
        f
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_orx"));
        c.env("ORX_DATA_DIR", self.root.join("data"))
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.root.join("empty-git-config"))
            .env("ORX_CACHE_DIR", self.root.join("cache"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("ORX_NO_UPDATE_CHECK", "1")
            .env_remove("ORX_CHAT_SESSION_ID")
            .env_remove("HF_TOKEN")
            .env_remove("TINKER_API_KEY")
            .env_remove("MODAL_TOKEN_ID")
            .env_remove("MODAL_TOKEN_SECRET")
            .current_dir(&self.root)
            .arg("--no-telemetry");
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().unwrap()
    }
    fn json(&self, args: &[&str]) -> Value {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn experiment(&self) {
        for args in [
            vec!["init", "--initial-branch=main"],
            vec!["add", "code-marker.txt"],
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
            if args[0] == "add" {
                std::fs::write(self.root.join("code-marker.txt"), b"code-v1\n").unwrap();
            }
            let output = Command::new("git")
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", self.root.join("empty-git-config"))
                .current_dir(&self.root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let conn = rusqlite::Connection::open(self.root.join("data/orx.db")).unwrap();
        conn.execute("INSERT INTO local_experiments(id,project_id,slug,branch_name,run_command,created_at,updated_at) VALUES('e','p','e','main',?1,1,1)",["cat code-marker.txt; cat \"$ORX_INPUTS_DIR/dataset/data.txt\""]).unwrap();
    }
    fn freeze(&self) -> String {
        self.json(&[
            "inputs",
            "--project",
            "p",
            "freeze",
            "--file",
            "inputs.json",
        ])["snapshot"]["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn wait_local_run(&self, id: &str) {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let conn = rusqlite::Connection::open(self.root.join("data/orx.db")).unwrap();
            let status: String = conn
                .query_row("SELECT status FROM runs WHERE id=?1", [id], |r| r.get(0))
                .unwrap();
            drop(conn);
            let idle = std::fs::OpenOptions::new()
                .write(true)
                .open(
                    self.root
                        .join("data/run-logs")
                        .join(format!("{id}.supervisor.lock")),
                )
                .ok()
                .is_some_and(|file| {
                    let mut lock = fd_lock::RwLock::new(file);
                    let idle = lock.try_write().is_ok();
                    idle
                });
            if matches!(status.as_str(), "done" | "failed" | "cancelled") && idle {
                assert_eq!(
                    status,
                    "done",
                    "local log: {:?}; supervisor: {:?}",
                    std::fs::read_to_string(self.root.join("data/local-runs").join(id).join("log")),
                    std::fs::read_to_string(
                        self.root
                            .join("data/run-logs")
                            .join(format!("{id}.supervisor.log"))
                    )
                );
                return;
            }
            assert!(
                std::time::Instant::now() < until,
                "controlled local Run did not finish: {status}"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Keep this fixture's files while its own detached monitor is active.
        // A failing assertion must not remove a live Run's recovery data.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
        let mut cancellation_requested = false;
        loop {
            let rows = rusqlite::Connection::open(self.root.join("data/orx.db"))
                .ok()
                .and_then(|db| {
                    let mut stmt = db.prepare("SELECT id,status FROM runs").ok()?;
                    let rows = stmt
                        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                        .ok()?
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .ok();
                    rows
                })
                .unwrap_or_default();
            let active = rows
                .iter()
                .any(|(_, s)| !matches!(s.as_str(), "done" | "failed" | "cancelled"));
            let leased = rows.iter().any(|(id, _)| {
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(
                        self.root
                            .join("data/run-logs")
                            .join(format!("{id}.supervisor.lock")),
                    )
                    .ok()
                    .is_some_and(|file| {
                        let mut lock = fd_lock::RwLock::new(file);
                        let held = lock.try_write().is_err();
                        held
                    })
            });
            if !active && !leased {
                break;
            }
            if active && !cancellation_requested {
                let _ = self.run(&["exp", "cancel", "e"]);
                cancellation_requested = true;
            }
            if std::time::Instant::now() >= deadline {
                eprintln!(
                    "Retained active controlled Run fixture: {}",
                    self.root.display()
                );
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        #[cfg(windows)]
        fn writable(path: &std::path::Path) {
            if let Ok(entries) = std::fs::read_dir(path) {
                for e in entries.flatten() {
                    if let Ok(kind) = e.file_type() {
                        if kind.is_dir() {
                            writable(&e.path());
                        } else if kind.is_file() {
                            if let Ok(m) = e.metadata() {
                                let mut p = m.permissions();
                                p.set_readonly(false);
                                let _ = std::fs::set_permissions(e.path(), p);
                            }
                        }
                    }
                }
            }
        }
        #[cfg(windows)]
        writable(&self.root);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn real_local_process_reads_frozen_data_and_recorded_code_after_originals_change() {
    let f = Fixture::new();
    f.experiment();
    let id = f.freeze();
    let frozen = f.json(&["inputs", "quota"])["chargedBytes"]
        .as_u64()
        .unwrap();
    std::fs::write(
        f.root
            .join("data/materials")
            .join(&f.package)
            .join("originals/data.txt"),
        b"changed original\n",
    )
    .unwrap();
    std::fs::write(f.root.join("code-marker.txt"), b"uncommitted code-v2\n").unwrap();
    let output = f.run(&["exp", "run", "e", "--backend", "local", "--input-set", &id]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let conn = rusqlite::Connection::open(f.root.join("data/orx.db")).unwrap();
    let (run, backend): (String, String) = conn
        .query_row(
            "SELECT id,backend_json FROM runs WHERE experiment_id='e'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    drop(conn);
    assert_eq!(
        serde_json::from_str::<Value>(&backend).unwrap()["inputSet"]["id"],
        id
    );
    f.wait_local_run(&run);
    assert_eq!(
        std::fs::read(f.root.join("data/local-runs").join(&run).join("log")).unwrap(),
        b"code-v1\nreal copied bytes\n"
    );
    let inspected = f.json(&["inputs", "--project", "p", "run", &run, "--verify"]);
    assert_eq!(inspected["copiesVerified"], true);
    assert_eq!(inspected["codeSnapshotVerified"], true);
    assert_eq!(inspected["consumptionObserved"], false);
    let charge = f.json(&["inputs", "quota"])["chargedBytes"]
        .as_u64()
        .unwrap();
    assert!(charge > frozen);
    let delivered = f
        .root
        .join("data/input-sets/deliveries")
        .join(&run)
        .join("files/dataset/data.txt");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&delivered, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[cfg(windows)]
    {
        let mut p = std::fs::metadata(&delivered).unwrap().permissions();
        p.set_readonly(false);
        std::fs::set_permissions(&delivered, p).unwrap();
    }
    std::fs::write(delivered, b"tampered delivery").unwrap();
    assert!(!f
        .run(&["inputs", "--project", "p", "run", &run, "--verify"])
        .status
        .success());
    assert_eq!(
        f.json(&["inputs", "--project", "p", "verify", &id])["copiesVerified"],
        true
    );
    assert_eq!(f.json(&["inputs", "quota"])["chargedBytes"], charge);
    let conn = rusqlite::Connection::open(f.root.join("data/orx.db")).unwrap();
    for table in [
        "chat_messages",
        "chat_queued_messages",
        "chat_spawns",
        "material_read_events",
        "scientific_metric_evidence",
    ] {
        assert_eq!(
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn unsupported_backends_and_insufficient_delivery_capacity_create_no_run() {
    let f = Fixture::new();
    f.experiment();
    let id = f.freeze();
    let charge = f.json(&["inputs", "quota"])["chargedBytes"]
        .as_u64()
        .unwrap();
    for backend in [
        "tinker",
        "hf",
        "modal",
        "k8s",
        "ssh",
        "slurm",
        "ray",
        "openresearch",
    ] {
        let output = f.run(&["exp", "run", "e", "--backend", backend, "--input-set", &id]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("--input-set is currently supported only"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(f
        .run(&["inputs", "quota", "--bytes", &charge.to_string()])
        .status
        .success());
    let output = f.run(&["exp", "run", "e", "--backend", "local", "--input-set", &id]);
    assert!(!output.status.success());
    let conn = rusqlite::Connection::open(f.root.join("data/orx.db")).unwrap();
    for table in [
        "runs",
        "input_deliveries",
        "chat_messages",
        "chat_queued_messages",
        "chat_spawns",
    ] {
        assert_eq!(
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "{table}"
        );
    }
    assert_eq!(f.json(&["inputs", "quota"])["chargedBytes"], charge);
}
#[test]
fn real_cli_freezes_and_verifies_historical_bytes_without_domain_activity() {
    let f = Fixture::new();
    let output = f.json(&[
        "inputs",
        "--project",
        "p",
        "freeze",
        "--file",
        "inputs.json",
    ]);
    let id = output["snapshot"]["id"].as_str().unwrap();
    assert_eq!(output["executionObserved"], false);
    assert_eq!(output["snapshot"]["state"], "frozen");
    assert_eq!(f.json(&["inputs", "show", id, "--project", "p"])["id"], id);
    std::fs::write(
        f.root
            .join("data/materials")
            .join(&f.package)
            .join("originals/data.txt"),
        b"changed original",
    )
    .unwrap();
    assert_eq!(
        f.json(&["inputs", "--project", "p", "verify", id])["copiesVerified"],
        true
    );
    assert!(!f
        .run(&["inputs", "--project", "other", "show", id])
        .status
        .success());
    let list = f.json(&["inputs", "--project", "p", "list", "--limit", "1"]);
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["hasMore"], false);
    let row = f.json(&["inputs", "quota"]);
    assert_eq!(row["scope"], "frozen-and-run-input-copies");
    assert!(!f
        .run(&["inputs", "--project", "p", "quota", "--bytes", "1"])
        .status
        .success());
    let conn = rusqlite::Connection::open(f.root.join("data/orx.db")).unwrap();
    for table in [
        "runs",
        "chat_messages",
        "chat_queued_messages",
        "chat_spawns",
        "material_read_events",
        "scientific_metric_evidence",
    ] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    let blob = output["snapshot"]["manifest"]["files"][0]["sha256"]
        .as_str()
        .unwrap();
    std::fs::write(
        f.root
            .join("data/input-sets/sets")
            .join(id)
            .join("blobs")
            .join(blob),
        b"tamper",
    )
    .unwrap();
    assert!(!f
        .run(&["inputs", "--project", "p", "verify", id])
        .status
        .success());
}
#[test]
fn agent_scope_and_operator_boundaries_are_enforced_by_the_actual_cli() {
    let f = Fixture::new();
    for args in [
        vec!["inputs", "quota"],
        vec!["inputs", "quota", "--bytes", "1"],
        vec![
            "inputs",
            "recover",
            "00000000-0000-4000-8000-000000000000",
            "--apply",
        ],
        vec!["inputs", "--project", "other", "list"],
        vec![
            "inputs",
            "recover-run",
            "00000000-0000-4000-8000-000000000000",
        ],
        vec![
            "inputs",
            "recover-run",
            "00000000-0000-4000-8000-000000000000",
            "--apply",
        ],
    ] {
        let output = f
            .command()
            .env("ORX_CHAT_SESSION_ID", "agent")
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
    let output = f
        .command()
        .env("ORX_CHAT_SESSION_ID", "agent")
        .args(["inputs", "list"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = f
        .command()
        .env("ORX_CHAT_SESSION_ID", "agent")
        .args(["inputs", "freeze", "--file", "inputs.json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(parsed["snapshot"]["projectId"], "p");
}
