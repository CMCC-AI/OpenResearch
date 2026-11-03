#[test]
fn citation_preview_http_is_scoped_bounded_readonly_and_hash_checked() {
    const CHILD: &str = "ORX_TEST_CITATION_PREVIEW_HTTP";
    const TEST: &str = "commands::up::materials::tests::citation_preview_http_is_scoped_bounded_readonly_and_hash_checked";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let store = Store::open().unwrap();
                let root = crate::store::data_dir();
                for id in ["project", "other"] {
                    store
                        .create_local_project(&crate::local::model::LocalProject {
                            id: id.into(),
                            name: id.into(),
                            slug: id.into(),
                            github_owner: "".into(),
                            github_repo: "".into(),
                            github_sync_enabled: false,
                            baseline_branch: "main".into(),
                            repo_path: root.to_string_lossy().into(),
                            run_command: None,
                            paper_id: None,
                            created_at: 1,
                            updated_at: 1,
                        })
                        .unwrap();
                }
                let package = material::create("project").unwrap();
                material::upload(
                    &package.id,
                    "project",
                    "引用/原文.txt",
                    b"first\n<script>unsafe()</script>\nthird\n",
                )
                .unwrap();
                let package = material::finalize(&package.id, "project").unwrap();
                let source = &package.files[0].id;
                let context = store
                    .material_read_context("project", None, &package.id)
                    .unwrap();
                let result = material::read_recorded(
                    &store,
                    context,
                    material::ReadRequest {
                        package: package.id.clone(),
                        source: source.clone(),
                        offset: 2,
                        limit: 1,
                        page: None,
                    },
                )
                .await
                .unwrap();
                let event = result["readEventId"].as_str().unwrap();
                let before_pending = store
                    .material_read_events("project", &Default::default(), 0, 200)
                    .unwrap();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let app = axum::Router::new().route(
                    "/api/materials/{id}/{source}/citations/{event}",
                    get(citation_preview),
                );
                let server = tokio::spawn(async move {
                    axum::serve(listener, app).await.unwrap();
                });
                let client = crate::net::loopback_client().build().unwrap();
                let url = format!(
                    "http://{address}/api/materials/{}/{}/citations/{event}",
                    package.id, source
                );
                assert_eq!(
                    client.get(&url).send().await.unwrap().status(),
                    reqwest::StatusCode::BAD_REQUEST
                );
                assert_eq!(
                    store
                        .material_read_events("project", &Default::default(), 0, 200)
                        .unwrap(),
                    before_pending
                );
                crate::commands::materials::write_result(&store, "project", &result, Vec::new())
                    .unwrap();
                let before = store
                    .material_read_events("project", &Default::default(), 0, 200)
                    .unwrap();
                let response = client.get(&url).send().await.unwrap();
                assert!(response.status().is_success());
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
                assert_eq!(
                    response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                    "nosniff"
                );
                assert!(response.headers()[header::CONTENT_TYPE]
                    .to_str()
                    .unwrap()
                    .starts_with("application/json"));
                let value: Value = response.json().await.unwrap();
                assert_eq!(value["content"], "2: <script>unsafe()</script>\n");
                assert_eq!(value["citation"]["readEventId"], event);
                assert_eq!(value["citation"]["offset"], 2);
                assert!(value.get("readEventId").is_none());
                assert!(value.get("original").is_none());
                for owner in ["project", "other", "not-registered"] {
                    let foreign = material::create(owner).unwrap();
                    material::upload(&foreign.id, owner, "other.txt", b"private").unwrap();
                    let foreign = material::finalize(&foreign.id, owner).unwrap();
                    let response = client
                        .get(format!(
                            "http://{address}/api/materials/{}/{}/citations/{event}",
                            foreign.id, foreign.files[0].id
                        ))
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(
                        response.status(),
                        if owner == "not-registered" {
                            reqwest::StatusCode::NOT_FOUND
                        } else {
                            reqwest::StatusCode::BAD_REQUEST
                        }
                    );
                    assert!(!response.text().await.unwrap().contains("unsafe()"));
                }
                assert_eq!(
                    client
                        .get(url.replace(source, "SRC-9999"))
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    reqwest::StatusCode::BAD_REQUEST
                );
                assert_eq!(
                    client
                        .get(url.replace(event, "missing"))
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    reqwest::StatusCode::BAD_REQUEST
                );
                let held = citation_permits()
                    .clone()
                    .acquire_many_owned(2)
                    .await
                    .unwrap();
                assert_eq!(
                    client.get(&url).send().await.unwrap().status(),
                    reqwest::StatusCode::TOO_MANY_REQUESTS
                );
                drop(held);
                assert!(client.get(&url).send().await.unwrap().status().is_success());
                let original = material::original(&package.id, "project", source).unwrap();
                std::fs::write(original, b"modified original\n").unwrap();
                let response = client.get(&url).send().await.unwrap();
                assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
                assert!(response.text().await.unwrap().contains("原件已变化"));
                assert_eq!(
                    store
                        .material_read_events("project", &Default::default(), 0, 200)
                        .unwrap(),
                    before
                );
                assert_eq!(
                    serde_json::to_value(material::inspect(&package.id).unwrap()).unwrap(),
                    serde_json::to_value(package).unwrap()
                );
                server.abort();
                let _ = server.await;
            });
        return;
    }
    let root = std::env::temp_dir().join(format!("orx-citation-preview-{}", uuid::Uuid::new_v4()));
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
