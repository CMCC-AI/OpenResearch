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
            .env("ORX_CACHE_DIR", self.root.join("cache"))
            .env("ORX_MATERIAL_STORAGE_BYTES", "4294967296")
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

#[test]
fn material_cli_locate_verifies_original_selection_and_creates_a_fresh_read_receipt() {
    let sandbox = Sandbox::new();
    let output = sandbox.run(&[
        "materials",
        "--project",
        "project",
        "read",
        &sandbox.package,
        "SRC-0001",
        "--offset",
        "2",
        "--limit",
        "1",
    ]);
    assert!(output.status.success());
    let first: Value = serde_json::from_slice(&output.stdout).unwrap();
    let event = first["readEventId"].as_str().unwrap();
    let output = sandbox.run(&["materials", "--project", "project", "locate", event]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let located: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(located["content"], first["content"]);
    assert_eq!(located["locatedReadEventId"], event);
    assert_ne!(located["readEventId"], first["readEventId"]);
    let events = sandbox.events();
    assert_eq!(events["events"].as_array().unwrap().len(), 2);
    assert_eq!(events["events"][0]["outputState"], "written");
    assert_eq!(events["events"][1]["outputState"], "written");
    std::fs::write(
        sandbox
            .root
            .join("data/materials")
            .join(&sandbox.package)
            .join("originals/notes.txt"),
        "changed",
    )
    .unwrap();
    let failed = sandbox.run(&["materials", "--project", "project", "locate", event]);
    assert!(!failed.status.success());
    assert!(failed.stdout.is_empty());
    assert_eq!(
        sandbox.events()["events"][2]["receipt"]["outcome"],
        "failed"
    );
}

#[test]
fn material_cli_claim_resolves_canonical_provenance_and_locates_it_after_restart() {
    let sandbox = Sandbox::new();
    let study = json!({"id":"study","projectId":"project","sessionId":"reader","mode":"team","objective":"trace sources","status":"active","plans":[{"version":1,"materialIds":[sandbox.package],"summary":"input snapshot","tasks":[]}],"decisions":[],"claims":[],"createdAt":1,"updatedAt":1});
    let conn = rusqlite::Connection::open(sandbox.root.join("data/orx.db")).unwrap();
    conn.execute("INSERT INTO research_studies(id,project_id,session_id,document) VALUES('study','project','reader',?1)",[study.to_string()]).unwrap();
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
    assert!(output.status.success());
    let read: Value = serde_json::from_slice(&output.stdout).unwrap();
    let request = json!({"text":"source observation","support":"paper","source":"registered notes","location":"line 2","materialReadId":read["readEventId"]});
    let request_path = sandbox.root.join("claim.json");
    std::fs::write(&request_path, request.to_string()).unwrap();
    let output = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args([
            "research",
            "claim",
            "--file",
            request_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let status = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args(["research", "status"])
        .output()
        .unwrap();
    assert!(status.status.success());
    let study: Value = serde_json::from_slice(&status.stdout).unwrap();
    let citation = &study["claims"][0]["materialCitation"];
    assert_eq!(citation["readEventId"], read["readEventId"]);
    assert_eq!(citation["offset"], 2);
    assert_eq!(citation["readerSessionId"], "reader");
    assert_eq!(citation["packageId"], sandbox.package);
    assert_eq!(study["materialCitationRevision"], 1);
    let replacement = json!({"action":"replace","version":1,"revision":0,"reason":"tighten the interpretation","replacement":{"text":"qualified source observation","support":"paper","source":"registered notes","location":"line 2","materialReadId":read["readEventId"]}});
    std::fs::write(&request_path, replacement.to_string()).unwrap();
    let claim_id = study["claims"][0]["id"].as_str().unwrap();
    let amend = || {
        sandbox
            .command()
            .env("ORX_CHAT_SESSION_ID", "reader")
            .args([
                "research",
                "amend-claim",
                claim_id,
                "--file",
                request_path.to_str().unwrap(),
            ])
            .output()
            .unwrap()
    };
    let amended = amend();
    assert!(
        amended.status.success(),
        "{}",
        String::from_utf8_lossy(&amended.stderr)
    );
    let first_receipt: Value = serde_json::from_slice(&amended.stdout).unwrap();
    let retried = amend();
    assert!(retried.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&retried.stdout).unwrap(),
        first_receipt
    );
    let status = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args(["research", "status"])
        .output()
        .unwrap();
    assert!(status.status.success());
    let amended: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(amended["claims"].as_array().unwrap().len(), 2);
    assert_eq!(amended["materialCitationRevision"], 2);
    assert_eq!(amended["claimRevision"], 1);
    assert_eq!(
        amended["activeClaimIds"],
        json!([first_receipt["replacementId"]])
    );
    assert_eq!(amended["claims"][0]["materialCitation"], *citation);
    let located = sandbox.run(&[
        "materials",
        "--project",
        "project",
        "locate",
        citation["readEventId"].as_str().unwrap(),
    ]);
    assert!(located.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&located.stdout).unwrap()["content"],
        read["content"]
    );
}

#[cfg(unix)]
#[test]
fn material_cli_pdf_locator_rejects_changed_extractor_layout() {
    use std::os::unix::fs::PermissionsExt;
    let sandbox = Sandbox::new();
    let dir = sandbox.root.join("data/materials").join(&sandbox.package);
    let body = b"%PDF-synthetic-source";
    std::fs::write(dir.join("originals/paper.pdf"), body).unwrap();
    let manifest = json!({"id":sandbox.package,"projectId":"project","createdAt":1,"ready":true,"files":[{"id":"SRC-0001","path":"paper.pdf","size":body.len(),"sha256":format!("{:x}",Sha256::digest(body)),"format":"pdf","status":"ready","note":null}]});
    std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    let bin = sandbox.root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let parser = bin.join("pdftotext");
    std::fs::write(
        &parser,
        "#!/bin/sh\ncat >/dev/null\nprintf 'first layout\\n'\n",
    )
    .unwrap();
    std::fs::set_permissions(&parser, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let output = sandbox
        .command()
        .env("PATH", &path)
        .args([
            "materials",
            "--project",
            "project",
            "read",
            &sandbox.package,
            "SRC-0001",
            "--page",
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
    std::fs::write(
        &parser,
        "#!/bin/sh\ncat >/dev/null\nprintf 'second layout\\n'\n",
    )
    .unwrap();
    let located = sandbox
        .command()
        .env("PATH", path)
        .args([
            "materials",
            "--project",
            "project",
            "locate",
            read["readEventId"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!located.status.success());
    assert!(located.stdout.is_empty());
    assert!(String::from_utf8_lossy(&located.stderr).contains("解析结果与引用回执不一致"));
    let events = sandbox.events();
    assert_eq!(events["events"][0]["outputState"], "written");
    assert_eq!(events["events"][1]["receipt"]["outcome"], "failed");
    assert!(events["events"][1]["receipt"]["selection"].is_null());
}

#[test]
fn research_cli_exports_only_the_confirmed_zip_and_denies_non_lead_sessions() {
    use std::io::Read;
    let sandbox = Sandbox::new();
    let db = rusqlite::Connection::open(sandbox.root.join("data/orx.db")).unwrap();
    let study = json!({"id":"export-study","projectId":"project","sessionId":"reader","mode":"team","objective":"package outputs","status":"active","plans":[],"decisions":[],"claims":[],"createdAt":1,"updatedAt":1});
    db.execute("INSERT INTO research_studies(id,project_id,session_id,document) VALUES('export-study','project','reader',?1)",[study.to_string()]).unwrap();
    let plan = json!({"summary":"review the outputs","tasks":[{"id":"design","role":"as-experiment-designer","brief":"write design","dependsOn":[],"outputs":["design.md"]},{"id":"review","role":"as-independent-reviewer","brief":"review design","dependsOn":["design"],"outputs":["review.md"]},{"id":"audit","role":"as-quality-citation-auditor","brief":"audit design","dependsOn":["review"],"outputs":["audit.md"]}]});
    let request = sandbox.root.join("plan.json");
    std::fs::write(&request, plan.to_string()).unwrap();
    let output = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args(["research", "plan", "--file", request.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let raw: String = db
        .query_row(
            "SELECT document FROM research_studies WHERE id='export-study'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut study: Value = serde_json::from_str(&raw).unwrap();
    study["decisions"][0]["status"] = "approved".into();
    study["decisions"][0]["approver"] = "isolated-test-user".into();
    let root = sandbox.root.join("data/files/p/research/export-study");
    std::fs::create_dir_all(&root).unwrap();
    for task in study["plans"][0]["tasks"].as_array_mut().unwrap() {
        let id = task["id"].as_str().unwrap().to_string();
        let body = format!("checked {id}\n");
        let path = format!("{id}.md");
        std::fs::write(root.join(&path), &body).unwrap();
        task["state"] = "completed".into();
        task["sessionId"] = id.into();
        task["summary"] = "checked".into();
        task["artifacts"] = json!([{"path":path,"sha256":format!("{:x}",Sha256::digest(body.as_bytes())),"bytes":body.len()}]);
        task["evidenceDigest"] = format!("{:x}", Sha256::digest(b"[]")).into();
    }
    db.execute(
        "UPDATE research_studies SET document=?1 WHERE id='export-study'",
        [study.to_string()],
    )
    .unwrap();
    let package = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args(["research", "package"])
        .output()
        .unwrap();
    assert!(
        package.status.success(),
        "{}",
        String::from_utf8_lossy(&package.stderr)
    );
    let denied = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args(["research", "export"])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(denied.stdout.is_empty());
    db.execute("UPDATE research_studies SET document=json_set(document,'$.decisions[#-1].status','approved','$.decisions[#-1].approver','isolated-test-user') WHERE id='export-study'",[]).unwrap();
    let export = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args(["research", "export"])
        .output()
        .unwrap();
    assert!(
        export.status.success(),
        "{}",
        String::from_utf8_lossy(&export.stderr)
    );
    assert!(export.stdout.starts_with(b"PK"));
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&export.stdout)).unwrap();
    let mut artifact = String::new();
    zip.by_name("artifacts/design.md")
        .unwrap()
        .read_to_string(&mut artifact)
        .unwrap();
    assert_eq!(artifact, "checked design\n");
    let raw: String = db
        .query_row(
            "SELECT document FROM research_studies WHERE id='export-study'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let saved: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        saved["deliverySnapshot"]["archive"]["sha256"],
        format!("{:x}", Sha256::digest(&export.stdout))
    );
    db.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,parent_session_id) VALUES('expert','project','codex',1,1,'reader')",[]).unwrap();
    let denied = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "expert")
        .args(["research", "export"])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(denied.stdout.is_empty());
}

/// Explicit external-tool acceptance. Linux/macOS CI must run this through
/// scripts/test-real-pdf.sh; an unavailable/incompatible parser fails the gate.
#[test]
#[ignore = "requires real Poppler; Linux/macOS CI run the explicit PDF gate"]
fn material_cli_real_pdf_pages_failures_and_parser_recovery_preserve_receipts() {
    let version = Command::new("pdftotext")
        .arg("-v")
        .output()
        .expect("real Poppler is required for PDF acceptance");
    assert!(
        version.status.success(),
        "Poppler probe failed ({}): stdout={} stderr={}",
        version.status,
        String::from_utf8_lossy(&version.stdout),
        String::from_utf8_lossy(&version.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&version.stderr));
    let sandbox = Sandbox::new();
    let dir = sandbox.root.join("data/materials").join(&sandbox.package);
    let files = [
        (
            "SRC-0001",
            "normal.pdf",
            include_bytes!("fixtures/materials/normal.pdf").as_slice(),
        ),
        (
            "SRC-0002",
            "image-only.pdf",
            include_bytes!("fixtures/materials/image-only.pdf").as_slice(),
        ),
        (
            "SRC-0003",
            "broken.pdf",
            include_bytes!("fixtures/materials/broken.pdf").as_slice(),
        ),
    ];
    let entries: Vec<_> = files.iter().map(|(id,path,bytes)| {
        std::fs::write(dir.join("originals").join(path), bytes).unwrap();
        json!({"id":id,"path":path,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"format":"pdf","status":"needs-tool","note":null})
    }).collect();
    std::fs::write(dir.join("manifest.json"), json!({"id":sandbox.package,"projectId":"project","createdAt":1,"ready":true,"files":entries}).to_string()).unwrap();
    let read = |source: &str, page: &str, path: Option<&std::path::Path>| {
        let mut command = sandbox.command();
        command.env("ORX_CHAT_SESSION_ID", "reader");
        if let Some(path) = path {
            command.env("PATH", path);
        }
        command
            .args([
                "materials",
                "read",
                &sandbox.package,
                source,
                "--page",
                page,
                "--limit",
                "1",
            ])
            .output()
            .unwrap()
    };
    let first = read("SRC-0001", "1", None);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(first["page"], 1);
    assert_eq!(first["content"], "1: First page alpha\n");
    assert_eq!(first["view"]["parser"], "pdftotext-layout");
    assert!(first["view"]["parserVersion"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
    assert_eq!(
        first["view"]["executableSha256"].as_str().unwrap().len(),
        64
    );
    assert_eq!(first["view"]["textSha256"].as_str().unwrap().len(), 64);
    let second = read("SRC-0001", "2", None);
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let second: Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(second["content"], "1: Second page gamma\n");
    for (source, page, message) in [
        ("SRC-0001", "3", "PDF 读取失败"),
        ("SRC-0002", "1", "OCR"),
        ("SRC-0003", "1", "PDF 读取失败"),
    ] {
        let output = read(source, page, None);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains(message));
    }
    let empty_path = sandbox.root.join("no-parser");
    std::fs::create_dir(&empty_path).unwrap();
    let missing = read("SRC-0001", "2", Some(&empty_path));
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("执行端需安装 pdftotext"));
    let located = sandbox.run(&[
        "materials",
        "--project",
        "project",
        "locate",
        second["readEventId"].as_str().unwrap(),
    ]);
    assert!(
        located.status.success(),
        "{}",
        String::from_utf8_lossy(&located.stderr)
    );
    let located: Value = serde_json::from_slice(&located.stdout).unwrap();
    assert_eq!(located["content"], second["content"]);
    assert_ne!(located["readEventId"], second["readEventId"]);
    let events = sandbox.events();
    let events = events["events"].as_array().unwrap();
    assert_eq!(events.len(), 7);
    assert_eq!(
        events
            .iter()
            .filter(|e| e["outputState"] == "written")
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e["receipt"]["outcome"] == "failed")
            .count(),
        4
    );
    assert!(events
        .iter()
        .filter(|e| e["receipt"]["outcome"] == "failed")
        .all(|e| e["outputState"] != "written"));
}

#[test]
fn storage_cli_observes_project_bytes_without_exposing_other_materials_or_collecting_archives() {
    let sandbox = Sandbox::new();
    let package_root = sandbox.root.join("data/materials").join(&sandbox.package);
    let manifest_file = package_root.join("manifest.json");
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
    std::fs::rename(
        package_root.join("originals/notes.txt"),
        package_root.join("originals/材料.txt"),
    )
    .unwrap();
    manifest["files"][0]["path"] = "材料.txt".into();
    std::fs::write(manifest_file, manifest.to_string()).unwrap();
    let read = sandbox.run(&[
        "materials",
        "--project",
        "project",
        "read",
        &sandbox.package,
        "SRC-0001",
        "--limit",
        "1",
    ]);
    assert!(read.status.success());
    let before = sandbox.events();
    let foreign = uuid::Uuid::new_v4().to_string();
    let foreign_root = sandbox.root.join("data/materials").join(&foreign);
    std::fs::create_dir_all(&foreign_root).unwrap();
    std::fs::write(
        foreign_root.join("manifest.json"),
        json!({"id":foreign,"projectId":"other","createdAt":1,"ready":true,"files":[]}).to_string(),
    )
    .unwrap();
    std::fs::write(
        foreign_root.join("foreign-content"),
        b"private other project",
    )
    .unwrap();
    let archive = sandbox
        .root
        .join("data/files/p/research/.delivery-bundles/history/unindexed.zip");
    std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
    std::fs::write(&archive, b"retained archive").unwrap();
    let legacy = sandbox.root.join("cache/repos/untouched.txt");
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, b"preserve legacy cache").unwrap();
    let output = sandbox.run(&["storage", "--project", "project", "usage"]);
    assert_eq!(std::fs::read(&legacy).unwrap(), b"preserve legacy cache");
    assert!(!sandbox.root.join("data/repos").exists());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["projectId"], "project");
    assert_eq!(report["materials"]["sealedPackages"], 1);
    assert_eq!(report["materials"]["unsealedPackages"], 0);
    assert_eq!(report["projectMetadata"]["readEvents"], 1);
    assert_eq!(
        report["projectMetadata"]["receiptJsonBytes"]
            .as_u64()
            .unwrap(),
        before["events"][0]["receipt"].to_string().len() as u64
    );
    assert_eq!(
        report["projectFilesIncludingDeliveryBundles"]["regularFileBytes"],
        16
    );
    assert_eq!(report["deliveryBundlesSubset"]["regularFileBytes"], 16);
    assert_eq!(
        report["archiveRetention"]["automaticDeletionEnabled"],
        false
    );
    assert_eq!(report["archiveRetention"]["deletionCandidates"], json!([]));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("foreign-content"));
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains(sandbox.root.to_string_lossy().as_ref())
    );
    assert_eq!(sandbox.events(), before);
    assert_eq!(std::fs::read(&archive).unwrap(), b"retained archive");
    for session in ["reader", "missing"] {
        let output = sandbox
            .command()
            .env("ORX_CHAT_SESSION_ID", session)
            .args(["storage", "--project", "other", "usage"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn material_cli_coverage_unions_outputs_without_creating_reading_events() {
    let sandbox = Sandbox::new();
    for (offset, limit) in [("1", "2"), ("2", "2"), ("1", "2")] {
        let output = sandbox.run(&[
            "materials",
            "--project",
            "project",
            "read",
            &sandbox.package,
            "SRC-0001",
            "--offset",
            offset,
            "--limit",
            limit,
        ]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let before = sandbox.events();
    let output = sandbox.run(&[
        "materials",
        "--project",
        "project",
        "coverage",
        "--package",
        &sandbox.package,
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let coverage: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(coverage["groups"].as_array().unwrap().len(), 1);
    assert_eq!(coverage["groups"][0]["ranges"], json!([[1, 3]]));
    assert_eq!(coverage["groups"][0]["coveredLines"], 3);
    assert_eq!(
        coverage["groups"][0]["scope"]["view"]["parser"],
        "utf8-lines"
    );
    assert!(coverage["groups"][0]["scope"]["view"]["parserVersion"].is_null());
    assert_eq!(sandbox.events(), before);
    let denied = sandbox
        .command()
        .env("ORX_CHAT_SESSION_ID", "reader")
        .args([
            "materials",
            "--project",
            "other",
            "coverage",
            "--package",
            &sandbox.package,
        ])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(denied.stdout.is_empty());
}

fn storage_archive_fixture(sandbox: &Sandbox) -> (rusqlite::Connection, PathBuf, String) {
    let conn = rusqlite::Connection::open(sandbox.root.join("data/orx.db")).unwrap();
    let body = json!({"id":"gc-study","projectId":"project","sessionId":"reader","mode":"team","objective":"synthetic GC fixture","status":"stopped","plans":[],"decisions":[],"claims":[],"createdAt":1,"updatedAt":1});
    conn.execute("INSERT INTO research_studies(id,project_id,session_id,document) VALUES('gc-study','project','reader',?1)",[body.to_string()]).unwrap();
    let bytes = b"synthetic unused archive";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let directory = sandbox
        .root
        .join("data/files/p/research/.delivery-bundles/gc-study");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{hash}.zip"));
    std::fs::write(&path, bytes).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 86_400))
        .unwrap();
    conn.execute("INSERT INTO research_archive_objects(study_id,sha256,bytes,manifest_sha256,legacy,created_at) VALUES('gc-study',?1,?2,'synthetic',0,1)",rusqlite::params![hash,bytes.len()]).unwrap();
    (conn, path, hash)
}

#[test]
fn storage_archive_cli_reviews_exact_cutoff_and_denies_agent_mutations() {
    let sandbox = Sandbox::new();
    let (_conn, path, hash) = storage_archive_fixture(&sandbox);
    let before_events = sandbox.events();
    let output = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let preview: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(preview["candidates"].as_array().unwrap().len(), 1);
    let before = preview["before"].to_string();
    let token = preview["previewHash"].as_str().unwrap();
    for session in ["reader", "missing"] {
        for command in [
            vec![
                "storage",
                "--project",
                "project",
                "archive-gc",
                "--study",
                "gc-study",
                "--before",
                &before,
                "--apply",
                token,
            ],
            vec![
                "storage",
                "--project",
                "project",
                "archive-recover",
                "--study",
                "gc-study",
            ],
        ] {
            let output = sandbox
                .command()
                .env("ORX_CHAT_SESSION_ID", session)
                .args(command)
                .output()
                .unwrap();
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
        }
    }
    let missing_cutoff = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
        "--apply",
        token,
    ]);
    assert!(!missing_cutoff.status.success());
    assert!(path.exists());
    let listed = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archives",
        "--study",
        "gc-study",
        "--limit",
        "1",
    ]);
    assert!(listed.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&listed.stdout).unwrap()["items"][0]["sha256"],
        hash
    );
    let output = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
        "--before",
        &before,
        "--apply",
        token,
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["removed"],
        json!([hash])
    );
    assert!(!path.exists());
    assert_eq!(sandbox.events(), before_events);
}

#[test]
fn storage_archive_cli_pins_and_applies_the_reviewed_scan_window() {
    let sandbox = Sandbox::new();
    let (conn, first_path, first_hash) = storage_archive_fixture(&sandbox);
    let preview = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
    ]);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let first: Value = serde_json::from_slice(&preview.stdout).unwrap();
    let before = first["before"].to_string();
    let through = first["through"].to_string();
    let token = first["previewHash"].as_str().unwrap();
    let bytes = b"second synthetic archive";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let path = first_path.parent().unwrap().join(format!("{hash}.zip"));
    std::fs::write(&path, bytes).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::fs::metadata(&first_path).unwrap().modified().unwrap())
        .unwrap();
    conn.execute("INSERT INTO research_archive_objects(study_id,sha256,bytes,manifest_sha256,legacy,created_at) VALUES('gc-study',?1,?2,'synthetic',0,1)",rusqlite::params![hash,bytes.len()]).unwrap();
    let changed = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
        "--before",
        &before,
        "--apply",
        token,
    ]);
    assert!(
        !changed.status.success(),
        "a changed implicit horizon must invalidate the review token"
    );
    assert!(first_path.exists() && path.exists());
    let applied = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
        "--before",
        &before,
        "--after",
        "0",
        "--through",
        &through,
        "--apply",
        token,
    ]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let report: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(report["removed"], json!([first_hash]));
    assert_eq!(
        report["hasMore"], false,
        "the fixed window is complete; newer registrations belong to another sweep"
    );
    assert!(!first_path.exists());
    assert!(path.exists());
    let next_cursor = report["nextCursor"].to_string();
    let preview = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
        "--before",
        &before,
        "--after",
        &next_cursor,
    ]);
    assert!(preview.status.success());
    let next: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(next["candidates"][0]["sha256"], hash);
    let next_through = next["through"].to_string();
    let next_token = next["previewHash"].as_str().unwrap();
    let wrong_page = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
        "--before",
        &before,
        "--through",
        &next_through,
        "--apply",
        next_token,
    ]);
    assert!(
        !wrong_page.status.success(),
        "the page cursor must also match the reviewed token"
    );
    assert!(path.exists());
    let applied = sandbox.run(&[
        "storage",
        "--project",
        "project",
        "archive-gc",
        "--study",
        "gc-study",
        "--before",
        &before,
        "--after",
        &next_cursor,
        "--through",
        &next_through,
        "--apply",
        next_token,
    ]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    assert!(!path.exists());
    assert_eq!(
        serde_json::from_slice::<Value>(&applied.stdout).unwrap()["removed"],
        json!([hash])
    );
}
