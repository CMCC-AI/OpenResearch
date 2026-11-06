//! Bounded, snapshot-consistent unions of confirmed output ranges. No understanding claims.
use super::*;
use std::collections::BTreeMap;

#[derive(PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    package_id: String,
    source: String,
    path: String,
    sha256: String,
    format: String,
    study_id: Option<String>,
    plan_version: Option<u32>,
    task_id: Option<String>,
    task_session_id: Option<String>,
    conversation_id: Option<String>,
    in_plan_inputs: Option<bool>,
    page: Option<u32>,
    view: ReadView,
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl ReadView {
    fn known(&self, format: &str) -> bool {
        if self.view_revision != "numbered-lines-v1"
            || self.producer_version.is_empty()
            || self.producer_version.len() > 64
            || !hash(&self.text_sha256)
        {
            return false;
        }
        match format {
            "text" => {
                self.parser == "utf8-lines"
                    && self.parser_version.is_none()
                    && self.executable_sha256.is_none()
            }
            "notebook" => {
                self.parser == "ipynb-cells"
                    && self.parser_version.is_none()
                    && self.executable_sha256.is_none()
            }
            "pdf" => {
                self.parser == "pdftotext-layout"
                    && self
                        .parser_version
                        .as_ref()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 64)
                    && self.executable_sha256.as_ref().is_some_and(|s| hash(s))
            }
            _ => false,
        }
    }
}

impl Store {
    /// Require a package to keep this interactive query bounded. Large packages
    /// must be narrowed by source/session/study; never return a partial union.
    pub fn material_read_coverage(
        &self,
        project: &str,
        filter: &ReadFilter,
    ) -> Result<serde_json::Value> {
        if filter.package.is_none() {
            return Err(anyhow!("阅读范围汇总必须指定 package"));
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut groups: BTreeMap<Scope, (usize, Vec<(usize, usize)>)> = BTreeMap::new();
        let mut excluded = BTreeMap::<&str, usize>::new();
        let mut after = 0;
        let mut considered = 0;
        loop {
            let page = self.material_read_events(project, filter, after, 200)?;
            for event in page["events"].as_array().unwrap() {
                considered += 1;
                if considered > 10_000 {
                    return Err(anyhow!(
                        "回执超过 10000 条，请按 source/session/study 缩小范围；未返回部分汇总"
                    ));
                }
                let state = event["outputState"].as_str().unwrap_or("");
                let receipt: ReadReceipt = match serde_json::from_value(event["receipt"].clone()) {
                    Ok(receipt) => receipt,
                    Err(_) => {
                        *excluded.entry("invalidReceipt").or_default() += 1;
                        continue;
                    }
                };
                let reason = if receipt.outcome == "failed" {
                    Some("readFailed")
                } else if state == "pending" {
                    Some("outputPending")
                } else if state == "failed" {
                    Some("outputFailed")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    *excluded.entry(reason).or_default() += 1;
                    continue;
                }
                let context = receipt.context.clone();
                let view = receipt.view.clone();
                let total = receipt
                    .selection
                    .as_ref()
                    .and_then(|s| s["totalLines"].as_u64());
                let citation = match citation_from_receipt(
                    project,
                    event["id"].as_str().unwrap_or(""),
                    receipt,
                    state,
                ) {
                    Ok(citation) => citation,
                    Err(_) => {
                        *excluded.entry("invalidOrEmptySelection").or_default() += 1;
                        continue;
                    }
                };
                let Some(view) = view.filter(|v| v.known(&citation.format)) else {
                    *excluded.entry("unknownView").or_default() += 1;
                    continue;
                };
                let total = usize::try_from(total.ok_or_else(|| anyhow!("missing totalLines"))?)?;
                let scope = Scope {
                    package_id: citation.package_id,
                    source: citation.source,
                    path: citation.path,
                    sha256: citation.sha256,
                    format: citation.format,
                    study_id: context.study_id,
                    plan_version: context.plan_version,
                    conversation_id: context
                        .task_id
                        .is_none()
                        .then_some(context.session_id)
                        .flatten(),
                    task_id: context.task_id,
                    task_session_id: context.task_session_id,
                    in_plan_inputs: context.in_plan_inputs,
                    page: citation.page,
                    view,
                };
                let value = groups.entry(scope).or_insert_with(|| (total, Vec::new()));
                if value.0 != total {
                    return Err(anyhow!("同一解析视图的总行数不一致，不能合并范围"));
                }
                value
                    .1
                    .push((citation.offset, citation.offset + citation.line_count - 1));
                if groups.len() > 512 {
                    return Err(anyhow!("解析视图超过 512 组，请缩小范围；未返回部分汇总"));
                }
            }
            if let Some(next) = page["nextAfter"].as_i64() {
                after = next;
            } else {
                break;
            }
        }
        let mut results = Vec::new();
        for (scope, (total, mut ranges)) in groups {
            ranges.sort_unstable();
            let mut union: Vec<(usize, usize)> = Vec::new();
            for (start, end) in ranges {
                if let Some(last) = union
                    .last_mut()
                    .filter(|last| start <= last.1.saturating_add(1))
                {
                    last.1 = last.1.max(end);
                } else {
                    union.push((start, end));
                }
            }
            let covered: usize = union.iter().map(|(start, end)| end - start + 1).sum();
            results.push(serde_json::json!({"scope":scope,"ranges":union,"coveredLines":covered,"viewTotalLines":total}));
        }
        tx.commit()?;
        Ok(
            serde_json::json!({"groups":results,"consideredEvents":considered,"excluded":excluded,
            "meaning":"仅汇总已核验且 CLI 输出确认成功的选区；不证明模型接收、理解或完成审查。PDF 行数仅针对观察到的页面，不提供文档总覆盖率。不同任务、计划、来源或解析视图不累计。"}),
        )
    }
}
