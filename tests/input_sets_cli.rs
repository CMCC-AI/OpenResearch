//! Real isolated CLI byte snapshots; no experiments, reads or approvals are fabricated.
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
            .env("ORX_CACHE_DIR", self.root.join("cache"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("ORX_NO_UPDATE_CHECK", "1")
            .env_remove("ORX_CHAT_SESSION_ID")
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
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
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
    assert_eq!(row["scope"], "frozen-input-pool-only");
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
