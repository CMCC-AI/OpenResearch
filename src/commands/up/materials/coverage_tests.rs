#[test]
fn coverage_http_preserves_scope_unions_and_receipts() {
    const TEST: &str = "commands::up::materials::tests::coverage_http_preserves_scope_unions_and_receipts";
    if crate::test_support::run_isolated(TEST, &["ORX_DATA_DIR"]) {
        return;
    }
    let root = crate::local::git::TemporaryDirectory::new("orx-coverage-http").unwrap();
    std::env::set_var("ORX_DATA_DIR", root.path());
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let store = Store::open().unwrap();
        for id in ["project", "other"] {
            store.create_local_project(&crate::local::model::LocalProject {
                id:id.into(),name:id.into(),slug:id.into(),github_owner:"".into(),github_repo:"".into(),github_sync_enabled:false,
                baseline_branch:"main".into(),repo_path:crate::store::data_dir().to_string_lossy().into(),
                run_command:None,paper_id:None,created_at:1,updated_at:1,
            }).unwrap();
            store.create_chat_session(&crate::store::StoredChatSession {
                id:id.into(),project_id:id.into(),harness:"opencode".into(),native_session_id:None,title:None,title_source:None,
                model:None,service_tier:None,permission_mode:None,plan_mode:false,plan_reset_pending:false,reasoning_level:None,
                archived:false,context_usage_json:None,bootstrap_context:None,goal:None,autonomy:None,active_leaf_id:None,
                parent_session_id:None,side_parent_session_id:None,side_parent_leaf_id:None,created_at:1,updated_at:1,
            }).unwrap();
        }
        let package=material::create("project").unwrap();
        material::upload(&package.id,"project","输入/notes.txt",b"one\ntwo\nthree\nfour\n").unwrap();
        let package=material::finalize(&package.id,"project").unwrap();
        let source=&package.files[0].id;
        let context=store.material_read_context("project",Some("project"),&package.id).unwrap();
        for offset in [1,2] {
            let value=material::read_recorded(&store,context.clone(),material::ReadRequest {
                package:package.id.clone(),source:source.clone(),offset,limit:2,page:None,
            }).await.unwrap();
            crate::commands::materials::write_result(&store,"project",&value,Vec::new()).unwrap();
        }
        material::read_recorded(&store,context.clone(),material::ReadRequest {
            package:package.id.clone(),source:source.clone(),offset:4,limit:1,page:None,
        }).await.unwrap();
        let events=store.material_read_events("project",&Default::default(),0,200).unwrap();
        let mut legacy=events["events"][0]["receipt"].clone();
        legacy.as_object_mut().unwrap().remove("view");
        let legacy:crate::store::material_reads::ReadReceipt=serde_json::from_value(legacy).unwrap();
        let event=store.record_material_read(&legacy).unwrap();
        store.material_read_output("project",&event,None).unwrap();
        let before=store.material_read_events("project",&Default::default(),0,200).unwrap();
        let app=axum::Router::new().route("/api/materials/{id}/coverage",get(coverage));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {axum::serve(listener,app).await.unwrap()});
        let client=crate::net::loopback_client().build().unwrap();
        let url=format!("http://{address}/api/materials/{}/coverage",package.id);
        let response=client.get(&url).send().await.unwrap();
        assert_eq!(response.status(),reqwest::StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL],"no-store");
        assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS],"nosniff");
        let value:serde_json::Value=response.json().await.unwrap();
        assert_eq!(value["projectId"],"project");
        assert_eq!(value["packageId"],package.id);
        assert_eq!(value["coverage"]["consideredEvents"],4);
        assert_eq!(value["coverage"]["excluded"]["outputPending"],1);
        assert_eq!(value["coverage"]["excluded"]["unknownView"],1);
        assert_eq!(value["coverage"]["groups"][0]["ranges"],json!([[1,3]]));
        assert_eq!(value["coverage"]["groups"][0]["coveredLines"],3);
        let filtered:serde_json::Value=client.get(&url).query(&[("source",source.as_str()),("session","project")]).send().await.unwrap().json().await.unwrap();
        assert_eq!(filtered["source"],source.as_str());
        assert_eq!(filtered["session"],"project");
        assert_eq!(filtered["coverage"],value["coverage"]);
        for query in ["source=missing","session=other","study=missing","ignored=1"] {
            assert_eq!(client.get(format!("{url}?{query}")).send().await.unwrap().status(),reqwest::StatusCode::BAD_REQUEST);
        }
        assert_eq!(client.post(&url).send().await.unwrap().status(),reqwest::StatusCode::METHOD_NOT_ALLOWED);
        let first=coverage_permits().clone().acquire_owned().await.unwrap();
        let second=coverage_permits().clone().acquire_owned().await.unwrap();
        assert_eq!(client.get(&url).send().await.unwrap().status(),reqwest::StatusCode::TOO_MANY_REQUESTS);
        drop(first);drop(second);
        let draft=material::create("project").unwrap();
        assert_eq!(client.get(format!("http://{address}/api/materials/{}/coverage",draft.id)).send().await.unwrap().status(),reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(store.material_read_events("project",&Default::default(),0,200).unwrap(),before);
        server.abort(); let _=server.await;
    });
}
