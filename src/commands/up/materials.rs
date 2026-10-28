//! Raw file transfer, separate from chat JSON. Uses the same project/local instance boundary.
use super::*;
use crate::local::materials as material;

/// Admit before Axum buffers the request body, including cancellation paths.
pub(super) async fn limit_upload(mut request: axum::extract::Request, next: Next) -> Response {
    static LIMIT: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let limit = LIMIT.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)));
    let Ok(permit) = limit.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"材料上传繁忙，请稍后重试"})),
        )
            .into_response();
    };
    request.extensions_mut().insert(Arc::new(permit));
    next.run(request).await
}

fn project(id: &str) -> std::result::Result<(), ApiError> {
    Store::open()?
        .get_local_project(id)?
        .ok_or_else(|| not_found("project"))?;
    Ok(())
}
pub(super) async fn create(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    blocking_api(move || {
        reject_if_stopping(&state)?;
        reject_if_moving(&state)?;
        project(&id)?;
        Ok(Json(json!(material::create(&id)?)))
    })
    .await
}
#[derive(Deserialize)]
pub(super) struct UploadQuery {
    path: String,
}
pub(super) async fn upload(
    State(state): State<AppState>,
    Path((project_id, id)): Path<(String, String)>,
    Query(query): Query<UploadQuery>,
    axum::Extension(permit): axum::Extension<Arc<tokio::sync::OwnedSemaphorePermit>>,
    body: axum::body::Bytes,
) -> ApiResult {
    blocking_api(move || {
        let _permit = permit;
        reject_if_stopping(&state)?;
        reject_if_moving(&state)?;
        project(&project_id)?;
        let package =
            material::upload(&id, &project_id, &query.path, &body).map_err(bad_request)?;
        Ok(Json(json!(package)))
    })
    .await
}
pub(super) async fn finalize(
    State(state): State<AppState>,
    Path((project_id, id)): Path<(String, String)>,
) -> ApiResult {
    blocking_api(move || {
        reject_if_stopping(&state)?;
        reject_if_moving(&state)?;
        project(&project_id)?;
        let package = material::finalize(&id, &project_id).map_err(bad_request)?;
        Ok(Json(json!(package)))
    })
    .await
}
pub(super) async fn manifest(Path((project_id, id)): Path<(String, String)>) -> ApiResult {
    blocking_api(move || {
        project(&project_id)?;
        Ok(Json(json!(
            material::get(&id, &project_id).map_err(bad_request)?
        )))
    })
    .await
}

pub(super) async fn inspect(Path(id): Path<String>) -> ApiResult {
    blocking_api(move || {
        let package = material::inspect(&id).map_err(bad_request)?;
        project(&package.project_id)?;
        Ok(Json(json!(package)))
    })
    .await
}
pub(super) async fn download(
    Path((id, source)): Path<(String, String)>,
) -> std::result::Result<Response, ApiError> {
    let path = blocking_task(move || -> std::result::Result<_, ApiError> {
        let package = material::inspect(&id).map_err(bad_request)?;
        project(&package.project_id)?;
        material::original(&id, &package.project_id, &source).map_err(bad_request)
    })
    .await??;
    let bytes = tokio::fs::read(path).await.map_err(bad_request)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CONTENT_DISPOSITION, "attachment"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

pub(super) async fn preview(
    Path((id, source)): Path<(String, String)>,
) -> std::result::Result<Response, ApiError> {
    let preview = blocking_task(move || -> std::result::Result<_, ApiError> {
        let package = material::inspect(&id).map_err(bad_request)?;
        project(&package.project_id)?;
        material::preview(&id, &package.project_id, &source).map_err(bad_request)
    })
    .await??;
    Ok((
        [
            (header::CONTENT_TYPE, preview.content_type),
            (header::CONTENT_DISPOSITION, "inline"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'; frame-ancestors 'none'",
            ),
        ],
        preview.bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn material_preview_http_checks_scope_hash_and_safe_headers() {
        const CHILD: &str = "ORX_TEST_MATERIAL_PREVIEW_HTTP";
        const TEST: &str = "commands::up::materials::tests::material_preview_http_checks_scope_hash_and_safe_headers";
        if std::env::var_os(CHILD).is_some() {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let store = Store::open().unwrap();
                    let root = crate::store::data_dir();
                    store
                        .create_local_project(&crate::local::model::LocalProject {
                            id: "project".into(),
                            name: "preview".into(),
                            slug: "preview".into(),
                            github_owner: String::new(),
                            github_repo: String::new(),
                            github_sync_enabled: false,
                            baseline_branch: "main".into(),
                            repo_path: root.to_string_lossy().into_owned(),
                            run_command: None,
                            paper_id: None,
                            created_at: 1,
                            updated_at: 1,
                        })
                        .unwrap();
                    let package = material::create("project").unwrap();
                    material::upload(
                        &package.id,
                        "project",
                        "安全/页面.html",
                        b"<script>unsafe()</script>",
                    )
                    .unwrap();
                    let package = material::finalize(&package.id, "project").unwrap();
                    let file = &package.files[0];
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let address = listener.local_addr().unwrap();
                    let app = axum::Router::new()
                        .route("/api/materials/{id}/{source}/preview", get(preview));
                    let server = tokio::spawn(async move {
                        axum::serve(listener, app).await.unwrap();
                    });
                    let url = format!(
                        "http://{address}/api/materials/{}/{}/preview",
                        package.id, file.id
                    );
                    let client = crate::net::loopback_client().build().unwrap();
                    let response = client.get(&url).send().await.unwrap();
                    assert!(response.status().is_success());
                    assert_eq!(
                        response.headers()[header::CONTENT_TYPE],
                        "text/plain; charset=utf-8"
                    );
                    assert_eq!(response.headers()[header::CONTENT_DISPOSITION], "inline");
                    assert_eq!(
                        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                        "nosniff"
                    );
                    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
                    assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
                        .to_str()
                        .unwrap()
                        .contains("sandbox"));
                    assert_eq!(response.text().await.unwrap(), "<script>unsafe()</script>");
                    assert_eq!(
                        serde_json::to_value(material::inspect(&package.id).unwrap()).unwrap(),
                        serde_json::to_value(&package).unwrap()
                    );
                    let path = material::original(&package.id, "project", &file.id).unwrap();
                    std::fs::write(path, "tampered").unwrap();
                    let response = client.get(&url).send().await.unwrap();
                    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
                    assert!(response.text().await.unwrap().contains("原件已变化"));
                    let foreign = material::create("not-registered").unwrap();
                    material::upload(&foreign.id, "not-registered", "data.txt", b"private")
                        .unwrap();
                    let foreign = material::finalize(&foreign.id, "not-registered").unwrap();
                    assert_eq!(
                        client
                            .get(format!(
                                "http://{address}/api/materials/{}/{}/preview",
                                foreign.id, foreign.files[0].id
                            ))
                            .send()
                            .await
                            .unwrap()
                            .status(),
                        reqwest::StatusCode::NOT_FOUND
                    );
                    server.abort();
                    let _ = server.await;
                });
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "orx-material-preview-http-{}",
            uuid::Uuid::new_v4()
        ));
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
}
