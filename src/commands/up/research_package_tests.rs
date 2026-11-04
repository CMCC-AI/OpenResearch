#[test]
fn approved_package_http_streams_the_confirmed_snapshot_without_reading_mutable_originals() {
    const CHILD: &str = "ORX_TEST_PACKAGE_HTTP";
    const TEST:&str="commands::up::research::tests::approved_package_http_streams_the_confirmed_snapshot_without_reading_mutable_originals";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            use std::io::Read;
            let store=Store::open().unwrap();let root=crate::store::data_dir();
            store.create_local_project(&crate::local::model::LocalProject {id:"project".into(),name:"package test".into(),slug:"project".into(),github_owner:"".into(),github_repo:"".into(),github_sync_enabled:false,baseline_branch:"main".into(),repo_path:root.to_string_lossy().into(),run_command:None,paper_id:None,created_at:1,updated_at:1}).unwrap();
            let db=rusqlite::Connection::open(root.join("orx.db")).unwrap();db.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('lead','project','codex',1,1)",[]).unwrap();
            let materials=crate::local::materials::create("project").unwrap();crate::local::materials::upload(&materials.id,"project","资料/notes.txt",b"approved original\n").unwrap();let materials=crate::local::materials::finalize(&materials.id,"project").unwrap();
            let study=store.research_create("lead","team","package sources").unwrap();
            let plan=serde_json::from_value(json!({"summary":"review the bounded source","tasks":[{"id":"design","role":"as-experiment-designer","brief":"write design","dependsOn":[],"outputs":["design.md"]},{"id":"review","role":"as-independent-reviewer","brief":"review design","dependsOn":["design"],"outputs":["review.md"]},{"id":"audit","role":"as-quality-citation-auditor","brief":"audit sources","dependsOn":["review"],"outputs":["audit.md"]}]})).unwrap();
            store.research_set_plan(&study.id,plan).unwrap();store.research_update(&study.id,|s|{s.plans[0].material_ids=Some(vec![materials.id.clone()]);s.request_gate("G1",s.plan_scope()?)}).unwrap();
            let context=store.material_read_context("project",Some("lead"),&materials.id).unwrap();
            let read=crate::local::materials::read_recorded(&store,context,crate::local::materials::ReadRequest {package:materials.id.clone(),source:materials.files[0].id.clone(),offset:1,limit:1,page:None}).await.unwrap();
            crate::commands::materials::write_result(&store,"project",&read,Vec::new()).unwrap();
            store.research_add_claim(&study.id,serde_json::from_value(json!({"text":"source observation","support":"paper","source":"notes","location":"line 1","materialReadId":read["readEventId"]})).unwrap()).unwrap();
            let current=store.research_study(&study.id).unwrap();let g1=current.decisions.last().unwrap();store.research_decide(&study.id,&g1.id,&g1.scope_hash,true,"human test approval".into()).unwrap();
            let artifacts=store.research_root(&study).unwrap();std::fs::create_dir_all(&artifacts).unwrap();
            for task in ["design","review","audit"] {let tx=store.begin_immediate().unwrap();store.research_bind_task(&study.id,task,task).unwrap();tx.commit().unwrap();std::fs::write(artifacts.join(format!("{task}.md")),format!("reviewed {task}")).unwrap();store.research_finish(&study.id,task,true,"verified".into()).unwrap();}
            store.research_request_package(&study.id).unwrap();
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
            let app=axum::Router::new().route("/api/research/studies/{id}/package",get(package));let server=tokio::spawn(async move {axum::serve(listener,app).await.unwrap();});
            let url=format!("http://{address}/api/research/studies/{}/package",study.id);let client=crate::net::loopback_client().build().unwrap();
            assert_eq!(client.get(&url).send().await.unwrap().status(),reqwest::StatusCode::BAD_REQUEST);
            let pending=store.research_study(&study.id).unwrap();let gate=pending.decisions.last().unwrap();store.research_decide(&study.id,&gate.id,&gate.scope_hash,true,"human package approval".into()).unwrap();
            let approved=store.research_study(&study.id).unwrap();let snapshot=approved.delivery_snapshot.as_ref().unwrap();
            std::fs::remove_file(crate::local::materials::original(&materials.id,"project",&materials.files[0].id).unwrap()).unwrap();
            let response=client.get(&url).send().await.unwrap();assert!(response.status().is_success());
            assert_eq!(response.headers()[header::CONTENT_TYPE],"application/zip");assert_eq!(response.headers()[header::CACHE_CONTROL],"no-store");assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS],"nosniff");assert!(response.headers()[header::CONTENT_DISPOSITION].to_str().unwrap().contains("attachment"));assert_eq!(response.headers()["x-content-sha256"],snapshot.archive.sha256);
            let bytes=response.bytes().await.unwrap();assert_eq!(bytes.len() as u64,snapshot.archive.bytes);assert_eq!(crate::store::research::digest(&bytes),snapshot.archive.sha256);
            let mut zip=zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();let original_name=format!("materials/{}/{}/{}",materials.id,materials.files[0].id,materials.files[0].path);let mut original=String::new();zip.by_name(&original_name).unwrap().read_to_string(&mut original).unwrap();assert_eq!(original,"approved original\n");
            assert_eq!(store.research_study(&study.id).unwrap(),approved);
            assert_eq!(store.material_read_events("project",&Default::default(),0,200).unwrap()["events"].as_array().unwrap().len(),1);
            server.abort();let _=server.await;
        });
        return;
    }
    let root = std::env::temp_dir().join(format!("orx-package-http-{}", uuid::Uuid::new_v4()));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env(CHILD, "1")
        .env("ORX_DATA_DIR", &root)
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(root);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
