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
    read_expected_at(store, context, request, root, None).await
}

async fn read_expected_at(
    store: &Store,
    context: ReadContext,
    request: ReadRequest,
    root: &Path,
    expected: Option<&crate::store::material_reads::MaterialCitation>,
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
        view: None,
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
    let result = result.and_then(|result| {
        if let Some(expected) = expected {
            verify_citation(expected, &receipt.format, &result)?;
            if let Some(view) =
                store.material_read_view(&receipt.context.project_id, &expected.read_event_id)?
            {
                if serde_json::to_value(view)? != result["view"] {
                    return Err(anyhow!(
                        "解析器或完整视图与引用回执不一致，不能返回旧引用选区"
                    ));
                }
            }
        }
        Ok(result)
    });
    receipt.recorded_at = crate::store::now_ms();
    match result {
        Ok(mut result) => {
            let content = result["content"]
                .as_str()
                .ok_or_else(|| anyhow!("读取结果缺少正文"))?;
            receipt.view = Some(serde_json::from_value(result["view"].clone())?);
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

pub async fn locate(
    store: &Store,
    project: &str,
    session: Option<&str>,
    event: &str,
) -> Result<serde_json::Value> {
    let citation = store.material_citation(project, event)?;
    let context = store.material_read_context(project, session, &citation.package_id)?;
    let request = ReadRequest {
        package: citation.package_id.clone(),
        source: citation.source.clone(),
        offset: citation.offset,
        limit: citation.line_count,
        page: citation.page,
    };
    let mut result = read_expected_at(store, context, request, &root(), Some(&citation)).await?;
    result["locatedReadEventId"] = event.into();
    Ok(result)
}

fn verify_citation(
    expected: &crate::store::material_reads::MaterialCitation,
    format: &str,
    result: &serde_json::Value,
) -> Result<()> {
    let content = result["content"]
        .as_str()
        .ok_or_else(|| anyhow!("读取结果缺少正文"))?;
    if format != expected.format
        || result["path"] != expected.path
        || result["sha256"] != expected.sha256
        || result["packageId"] != expected.package_id
        || result["source"] != expected.source
        || result["offset"] != expected.offset
        || result["page"] != serde_json::to_value(expected.page)?
        || result["lineCount"] != expected.line_count
        || content.len() != expected.content_bytes
        || format!("{:x}", Sha256::digest(content.as_bytes())) != expected.content_sha256
    {
        return Err(anyhow!(
            "当前原文或解析结果与引用回执不一致，不能返回旧引用选区"
        ));
    }
    Ok(())
}

/// Browser-only replay: the owned verified snapshot can cross a blocking-task
/// boundary. It never creates or confirms an agent reading receipt.
pub struct CitationPreview {
    prepared: PreparedRead,
    citation: crate::store::material_reads::MaterialCitation,
}

pub fn prepare_citation_preview(
    project: &str,
    citation: crate::store::material_reads::MaterialCitation,
) -> Result<CitationPreview> {
    prepare_citation_preview_at(&root(), project, citation)
}

fn prepare_citation_preview_at(
    root: &Path,
    project: &str,
    citation: crate::store::material_reads::MaterialCitation,
) -> Result<CitationPreview> {
    let package = read_at(root, &citation.package_id, project)?;
    if !package.ready {
        return Err(anyhow!("材料尚未封存"));
    }
    let entry = package
        .files
        .into_iter()
        .find(|entry| entry.id == citation.source)
        .ok_or_else(|| anyhow!("引用来源不存在"))?;
    if entry.path != citation.path
        || entry.format != citation.format
        || entry.sha256 != citation.sha256
    {
        return Err(anyhow!("材料登记信息与引用回执不一致"));
    }
    Ok(CitationPreview {
        prepared: prepare_entry_at(root, &citation.package_id, entry)?,
        citation,
    })
}

impl CitationPreview {
    pub async fn read(self) -> Result<serde_json::Value> {
        let result = self
            .prepared
            .read(
                self.citation.offset,
                self.citation.line_count,
                self.citation.page,
            )
            .await?;
        verify_citation(&self.citation, &self.prepared.entry.format, &result)?;
        Ok(serde_json::json!({"citation":self.citation,"content":result["content"]}))
    }
}

#[cfg(test)]
mod tests;
