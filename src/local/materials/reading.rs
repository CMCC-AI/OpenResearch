//! Persist prepared selections before output; a separate receipt confirms stream writes.
use super::*;
use crate::store::{
    material_reads::{bounded_error, ReadContext, ReadReceipt},
    Store,
};

pub struct ReadRequest {
    pub package: String,
    pub source: String,
    pub offset: usize,
    pub limit: usize,
    pub page: Option<u32>,
}

pub async fn read_recorded(
    store: &Store,
    context: ReadContext,
    request: ReadRequest,
) -> Result<serde_json::Value> {
    read_recorded_at(store, context, request, &root()).await
}

async fn read_recorded_at(
    store: &Store,
    context: ReadContext,
    request: ReadRequest,
    root: &Path,
) -> Result<serde_json::Value> {
    if context.package_id != request.package {
        return Err(anyhow!("读取上下文与材料包不一致"));
    }
    // Unknown/cross-project/unsealed inputs are rejected before any receipt, so
    // guessed identities never become claimed registered sources.
    let package = read_at(root, &request.package, &context.project_id)?;
    if !package.ready {
        return Err(anyhow!("material upload is incomplete"));
    }
    let entry = package
        .files
        .into_iter()
        .find(|entry| entry.id == request.source)
        .ok_or_else(|| anyhow!("unknown source"))?;
    let mut receipt = ReadReceipt {
        context,
        package_id: request.package.clone(),
        source: entry.id.clone(),
        path: entry.path.clone(),
        sha256: entry.sha256.clone(),
        format: entry.format.clone(),
        requested_offset: request.offset,
        requested_limit: request.limit,
        requested_page: request.page,
        verified: false,
        outcome: "failed".into(),
        selection: None,
        error: None,
        started_at: crate::store::now_ms(),
        recorded_at: 0,
    };
    let result = match prepare_entry_at(root, &request.package, entry) {
        Ok(prepared) => {
            receipt.verified = true;
            prepared
                .read(request.offset, request.limit, request.page)
                .await
        }
        Err(error) => Err(error),
    };
    receipt.recorded_at = crate::store::now_ms();
    match result {
        Ok(mut result) => {
            let content = result["content"]
                .as_str()
                .ok_or_else(|| anyhow!("读取结果缺少正文"))?;
            receipt.outcome = "prepared".into();
            receipt.selection = Some(
                serde_json::json!({"page":result["page"],"offset":result["offset"],"lineCount":result["lineCount"],"totalLines":result["totalLines"],"nextOffset":result["nextOffset"],"contentBytes":content.len(),"contentSha256":format!("{:x}",Sha256::digest(content.as_bytes()))}),
            );
            let event = store.record_material_read(&receipt)?;
            result["readEventId"] = event.into();
            Ok(result)
        }
        Err(error) => {
            receipt.error = Some(bounded_error(&error.to_string()));
            let event = store
                .record_material_read(&receipt)
                .map_err(|persist| anyhow!("材料读取失败：{error}；回执保存失败：{persist}"))?;
            let message = format!("材料读取失败（回执 {event}）：{error}");
            Err(error.context(message))
        }
    }
}

#[cfg(test)]
mod tests;
