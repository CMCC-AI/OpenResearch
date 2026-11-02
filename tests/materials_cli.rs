//! Real CLI output and event persistence, isolated from the user's database.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    process::{Command, Output},
};

struct Sandbox {
    root: PathBuf,
    package: String,
}
impl Sandbox {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("orx-materials-cli-{}", uuid::Uuid::new_v4()));
        let sandbox = Self {
            root,
            package: uuid::Uuid::new_v4().to_string(),
        };
        let _ = sandbox.run(&["materials", "--project", "project", "events"]);
        let conn = rusqlite::Connection::open(sandbox.root.join("data/orx.db")).unwrap();
        conn.execute("INSERT INTO local_projects(id,name,slug,github_owner,github_repo,github_sync_enabled,baseline_branch,repo_path,created_at,updated_at) VALUES('project','P','p','','',0,'main',?1,1,1)",[sandbox.root.to_string_lossy().as_ref()]).unwrap();
        conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('reader','project','codex',1,1)",[]).unwrap();
        let dir = sandbox.root.join("data/materials").join(&sandbox.package);
        std::fs::create_dir_all(dir.join("originals")).unwrap();
        let body = "first\n第二行\nthird\n";
        std::fs::write(dir.join("originals/notes.txt"), body).unwrap();
        let manifest = json!({"id":sandbox.package,"projectId":"project","createdAt":1,"ready":true,"files":[{"id":"SRC-0001","path":"notes.txt","size":body.len(),"sha256":format!("{:x}",Sha256::digest(body.as_bytes())),"format":"text","status":"ready","note":null}]});
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        sandbox
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_orx"));
        command
            .env("ORX_DATA_DIR", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("ORX_NO_UPDATE_CHECK", "1")
            .env_remove("ORX_CHAT_SESSION_ID")
            .arg("--no-telemetry");
        command
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().unwrap()
    }
    fn events(&self) -> Value {
        let output = self.run(&["materials", "--project", "project", "events"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn material_cli_read_confirms_stream_and_list_does_not_record_reading() {
    let sandbox = Sandbox::new();
    let listed = sandbox.run(&[
        "materials",
        "--project",
        "project",
        "list",
        &sandbox.package,
    ]);
    assert!(listed.status.success());
    assert_eq!(sandbox.events()["events"], json!([]));
    let output = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args([
            "materials",
            "read",
            &sandbox.package,
            "SRC-0001",
            "--offset",
            "2",
            "--limit",
            "1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let read: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(read["content"], "2: 第二行\n");
    let events = sandbox.events();
    let event = &events["events"][0];
    assert_eq!(event["id"], read["readEventId"]);
    assert_eq!(event["outputState"], "written");
    assert_eq!(event["receipt"]["context"]["sessionId"], "reader");
    assert!(event["receipt"]["context"]["studyId"].is_null());
    assert_eq!(event["receipt"]["selection"]["lineCount"], 1);
    assert!(!events.to_string().contains("第二行"));
    let bad = sandbox.run(&[
        "materials",
        "--project",
        "project",
        "read",
        &sandbox.package,
        "SRC-0001",
        "--offset",
        "999",
    ]);
    assert!(!bad.status.success());
    assert!(bad.stdout.is_empty());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("offset 超出内容范围"));
    assert_eq!(
        sandbox.events()["events"][1]["receipt"]["outcome"],
        "failed"
    );
}

#[test]
fn material_cli_unknown_agent_cannot_fall_back_to_explicit_project() {
    let sandbox = Sandbox::new();
    for args in [
        vec![
            "materials",
            "--project",
            "project",
            "read",
            &sandbox.package,
            "SRC-0001",
        ],
        vec!["materials", "--project", "project", "events"],
    ] {
        let output = sandbox
            .command()
            .env("ORX_CHAT_SESSION_ID", "missing")
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("agent session not found"));
    }
    assert_eq!(sandbox.events()["events"], json!([]));
}
