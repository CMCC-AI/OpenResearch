use rusqlite::params;
use serde_json::{json, Value};
use std::process::{Command, Output};

#[test]
fn saved_workflow_runs_in_existing_chat_without_spawning_or_approving() {
    let root = std::env::temp_dir().join(format!("orx-workflow-chat-{}", uuid::Uuid::new_v4()));
    let run = |args: &[&str], session: Option<&str>| -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_orx"));
        cmd.arg("--no-telemetry")
            .args(args)
            .env("ORX_DATA_DIR", root.join("data"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("ORX_NO_UPDATE_CHECK", "1")
            .env_remove("ORX_CHAT_SESSION_ID");
        if let Some(session) = session {
            cmd.env("ORX_CHAT_SESSION_ID", session);
        }
        cmd.output().unwrap()
    };
    let parse = |output: Output| -> Value {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    };
    assert_eq!(
        parse(run(&["research", "workflow", "list"], None)),
        json!([])
    );
    let db = rusqlite::Connection::open(root.join("data/orx.db")).unwrap();
    db.execute("INSERT INTO local_projects(id,name,slug,github_owner,github_repo,github_sync_enabled,baseline_branch,repo_path,created_at,updated_at) VALUES('project','Test','test','','',0,'main',?1,1,1)", [root.to_string_lossy().as_ref()]).unwrap();
    db.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('chat','project','codex',1,1)", []).unwrap();
    db.execute("INSERT INTO chat_messages(id,session_id,role,parts_json,created_at) VALUES('request','chat','user','[]',1)", []).unwrap();
    let presets: Value =
        serde_json::from_str(include_str!("../ui/src/researchWorkflows.json")).unwrap();
    let profile = &presets["literature"];
    let tasks: Vec<_> = profile["requiredRoles"].as_array().unwrap().iter().map(|role| {
        let role = role.as_str().unwrap();
        let deps: Vec<_> = profile["dependencies"].as_array().unwrap().iter().filter(|edge| edge[1] == role).map(|edge| edge[0].clone()).collect();
        json!({"id":role,"role":role,"brief":format!("Review evidence as {role}"),"dependsOn":deps,"outputs":[format!("{role}.md")]})
    }).collect();
    let draft = json!({"id":"saved","projectId":"","name":"证据综述方法","workflow":"literature","objective":"","summary":"","tasks":tasks,"positions":{},"viewport":null,"createdAt":1,"updatedAt":2});
    db.execute("INSERT INTO workflow_drafts(id,project_id,document,created_at,updated_at) VALUES('saved','',?1,1,2)", [draft.to_string()]).unwrap();
    let methods = parse(run(&["research", "workflow", "list"], None));
    assert_eq!(methods[0]["name"], "证据综述方法");
    assert_eq!(methods[0]["taskCount"], tasks.len());
    assert!(methods[0].get("tasks").is_none());
    assert_eq!(
        parse(run(&["research", "workflow", "show", "saved"], None))["name"],
        "证据综述方法"
    );
    let args = [
        "research",
        "workflow",
        "use",
        "saved",
        "--objective",
        "Compare evidence and report limitations",
    ];
    assert!(!run(&args, None).status.success());
    let first = parse(run(&args, Some("chat")));
    let duplicate = parse(run(&args, Some("chat")));
    assert_eq!(first["sessionId"], "chat");
    assert_eq!(first["version"], 1);
    assert_eq!(duplicate["studyId"], first["studyId"]);
    assert_eq!(duplicate["deduplicated"], true);
    let study = parse(run(&["research", "status"], Some("chat")));
    assert_eq!(study["plans"][0]["workflowSource"]["name"], "证据综述方法");
    assert!(study["plans"][0]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|task| task["state"] == "pending" && task["sessionId"].is_null()));
    assert_eq!(study["decisions"][0]["gate"], "G1");
    assert_eq!(study["decisions"][0]["status"], "pending");
    let scope: Value =
        serde_json::from_str(study["decisions"][0]["scope"].as_str().unwrap()).unwrap();
    assert_eq!(scope["workflowSource"]["updatedAt"], 2);
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM chat_sessions WHERE parent_session_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let messages: i64 = db
        .query_row(
            "SELECT count(*) FROM chat_messages WHERE session_id='chat'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(messages, 1);
    let updated = parse(run(
        &[
            "research",
            "workflow",
            "use",
            "saved",
            "--objective",
            "Compare a new question",
        ],
        Some("chat"),
    ));
    assert_eq!(updated["version"], 2);
    assert!(!run(&["research", "approve"], Some("chat")).status.success());
    db.execute("DELETE FROM workflow_drafts WHERE id='saved'", [])
        .unwrap();
    let document: String = db
        .query_row(
            "SELECT document FROM research_studies WHERE id=?1",
            params![first["studyId"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&document).unwrap()["plans"][1]["workflowSource"]["name"],
        "证据综述方法"
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
