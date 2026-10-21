//! Raw file transfer, separate from chat JSON. Uses the same project/local instance boundary.
use super::*;
use crate::local::materials as material;

fn project(id: &str) -> std::result::Result<(), ApiError> {
    Store::open()?
        .get_local_project(id)?
        .ok_or_else(|| not_found("project"))?;
    Ok(())
}
pub(super) async fn create(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    reject_if_stopping(&state)?;
    reject_if_moving(&state)?;
    project(&id)?;
    Ok(Json(json!(material::create(&id)?)))
}
#[derive(Deserialize)]
pub(super) struct UploadQuery {
    path: String,
}
pub(super) async fn upload(
    State(state): State<AppState>,
    Path((project_id, id)): Path<(String, String)>,
    Query(query): Query<UploadQuery>,
    body: axum::body::Bytes,
) -> ApiResult {
    reject_if_stopping(&state)?;
    reject_if_moving(&state)?;
    project(&project_id)?;
    let package =
        tokio::task::spawn_blocking(move || material::upload(&id, &project_id, &query.path, &body))
            .await
            .map_err(bad_request)?
            .map_err(bad_request)?;
    Ok(Json(json!(package)))
}
pub(super) async fn finalize(
    State(state): State<AppState>,
    Path((project_id, id)): Path<(String, String)>,
) -> ApiResult {
    reject_if_stopping(&state)?;
    reject_if_moving(&state)?;
    project(&project_id)?;
    let package = tokio::task::spawn_blocking(move || material::finalize(&id, &project_id))
        .await
        .map_err(bad_request)?
        .map_err(bad_request)?;
    Ok(Json(json!(package)))
}
pub(super) async fn manifest(Path((project_id, id)): Path<(String, String)>) -> ApiResult {
    project(&project_id)?;
    Ok(Json(json!(
        material::get(&id, &project_id).map_err(bad_request)?
    )))
}

pub(super) async fn inspect(Path(id): Path<String>) -> ApiResult {
    let package = material::inspect(&id).map_err(bad_request)?;
    project(&package.project_id)?;
    Ok(Json(json!(package)))
}
pub(super) async fn download(
    Path((id, source)): Path<(String, String)>,
) -> std::result::Result<Response, ApiError> {
    let package = material::inspect(&id).map_err(bad_request)?;
    project(&package.project_id)?;
    let path = material::original(&id, &package.project_id, &source).map_err(bad_request)?;
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
