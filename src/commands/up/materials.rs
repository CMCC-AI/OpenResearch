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
