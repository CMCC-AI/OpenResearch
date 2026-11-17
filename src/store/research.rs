//! Durable research orchestration. One versioned aggregate is updated under a
//! SQLite write transaction; native chats, experiments and runs remain canonical.
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{now_ms, Store, StoredRun};
use crate::error::{anyhow, Result};

mod archive_retention;
pub use archive_retention::ArchiveGcWindow;
mod claims;
mod delivery;
pub use delivery::{DeliverySnapshot, PreparedDelivery};
mod evidence;
mod material_citations;
mod metric_citations;
pub use claims::ClaimAmendmentInput;
pub use metric_citations::{MetricCitation, MetricSelection};
mod files;
mod plans;

/// The same membership drives accounting and lifecycle protection: the lead,
/// every registered expert (including past plans), and their chat descendants.
/// UNION deduplicates overlapping roots and terminates even for legacy cycles.
pub(super) const RESEARCH_MEMBERS_CTE: &str =
    "WITH RECURSIVE members(id) AS (SELECT ?2 UNION SELECT session_id FROM research_sessions WHERE study_id=?1 UNION SELECT s.id FROM chat_sessions s JOIN members m ON s.parent_session_id=m.id OR s.side_parent_session_id=m.id) ";

// Share the exact predicate so SQLite can use the partial index without
// parsing ended studies. Malformed legacy JSON must not prevent index creation.
const ACTIVE_STUDY_FILTER: &str =
    "CASE WHEN json_valid(document) THEN json_extract(document, '$.status') = 'active' ELSE 0 END";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSpec {
    pub id: String,
    pub role: String,
    pub brief: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub outputs: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force_rerun: bool,
    /// 声明要读取的上游产物路径；派发时注入子会话提示词并核对哈希。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<String>,
    /// 完成后需主理人在人工确认页批准（G5:{任务id}）才放行下游。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub requires_approval: bool,
    /// 结论把关：完成时读取 `<首个产物>.verdict.json`，结论为阻塞时拦截下游派发。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gate_downstream: bool,
    /// 结论为阻塞时自动带意见返工上游的轮数上限（0–3）。
    #[serde(default, skip_serializing_if = "is_zero")]
    pub max_rework: u32,
    /// 节点类型：空或 "agent" 为专家任务；"route" 为条件分流节点（引擎求值，不派发专家会话）。
    /// 空值兼容旧计划，不参与 plan_scope 哈希，已批准计划的哈希保持不变。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// kind = "route" 时的条件定义；专家任务必须留空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<RouteSpec>,
    /// 分流节点直接下游的分支标记："then"（条件成立）或 "else"（不成立）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub route_branch: String,
    /// 多前置汇合策略：空或 "all"（默认，全部完成/跳过）｜"any"（任一完成即继续）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub wait_for: String,
    /// kind = "foreach" 时的逐项处理定义；其他节点必须留空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub for_each: Option<ForEachSpec>,
}
fn is_zero(value: &u32) -> bool {
    *value == 0
}
/// 逐项处理定义。首批为串行执行（并发度固定 1）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForEachSpec {
    /// 读取的列表产物路径（直接前置任务的产物，其旁存在 `.items.json` 清单）。
    pub source: String,
    /// 逐项产物模板，必须含 `{item}` 占位（按项 id 展开），如 `readings/{item}.md`。
    pub item_output: String,
    /// 每项派发给专家的简报；`{item}` 会替换为该项标题。
    pub item_brief: String,
    /// 部分失败策略："pause"（默认，整任务失败等待主理人）｜"skip"（跳过该项继续剩余项）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub on_failure: String,
}
/// 列表清单 sidecar 中的一项（`<产物>.items.json`），沿用结论文件的旁路文件模式。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForEachItem {
    /// 项标识：进入产物路径，仅允许小写字母、数字、横线与下划线。
    pub id: String,
    /// 项标题：注入逐项简报与迭代记录，便于追溯。
    #[serde(default)]
    pub title: String,
}
/// 清单文件与产物一一对应：`discovery/papers.md` → `discovery/papers.md.items.json`。
pub fn items_path_for(output: &str) -> String {
    format!("{output}.items.json")
}
pub const MAX_FOREACH_ITEMS: usize = 20;
/// 解析并校验逐项清单：条数、项 id 字符集与长度、标题长度、重复 id 都在此拦截。
pub fn parse_items(path: &str, bytes: &[u8]) -> Result<Vec<ForEachItem>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ItemsFile {
        items: Vec<ForEachItem>,
    }
    let file: ItemsFile = serde_json::from_slice(bytes)
        .map_err(|error| anyhow!("清单文件 {path} 不是有效的清单 JSON: {error}"))?;
    if file.items.is_empty() || file.items.len() > MAX_FOREACH_ITEMS {
        return Err(anyhow!(
            "清单文件 {path} 需要 1–{MAX_FOREACH_ITEMS} 个列表项"
        ));
    }
    let mut seen = HashSet::new();
    for item in &file.items {
        if item.id.is_empty()
            || item.id.len() > 40
            || !item
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        {
            return Err(anyhow!(
                "清单文件 {path} 的项 id 仅允许 1–40 个小写字母、数字、横线和下划线: {}",
                item.id
            ));
        }
        if item.title.len() > 120 {
            return Err(anyhow!("清单文件 {path} 的项标题不能超过 120 字: {}", item.id));
        }
        if !seen.insert(item.id.clone()) {
            return Err(anyhow!("清单文件 {path} 的项 id 重复: {}", item.id));
        }
    }
    Ok(file.items)
}
/// 展开逐项产物模板：`readings/{item}.md` + 项 id → 具体产物路径。
pub fn item_path_for(template: &str, item_id: &str) -> String {
    template.replace("{item}", item_id)
}
/// 分流节点的条件定义。首批白名单：上游结论（verdict）与上游执行失败（failure）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteSpec {
    /// "verdict" 读取上游结论文件；"failure" 在任一直接前置执行失败时成立。
    pub on: String,
    /// verdict 谓词的来源产物路径（须为直接前置任务的产物，其旁存在 .verdict.json）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// verdict 谓词的成立值："pass" 或 "blocked"。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub verdict_is: String,
}
/// 分流节点最近一次求值结果，持久化在任务上供界面与排查追溯。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    /// "matched"（条件成立，走 then）或 "unmatched"（不成立，走 else）。
    pub outcome: String,
    /// 求值依据：上游结论状态或前置失败情况，人类可读。
    pub basis: String,
    pub decided_at: i64,
}
/// 分流节点求值后的分支与任务状态常量。
pub const ROUTE_KIND: &str = "route";
pub const ROUTE_THEN: &str = "then";
pub const ROUTE_ELSE: &str = "else";
pub const TASK_SKIPPED: &str = "skipped";
/// 结论把关任务的机器可读验收结论，来自产物旁的 `<首个产物>.verdict.json`。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskVerdict {
    /// `pass` 或 `blocked`。
    pub status: String,
    pub reasons: Vec<String>,
    pub path: String,
    pub sha256: String,
}
pub const MAX_REWORK: u32 = 3;
/// 结论文件与产物一一对应：`review/independent.md` → `review/independent.md.verdict.json`。
pub fn verdict_path_for(output: &str) -> String {
    format!("{output}.verdict.json")
}
pub fn parse_verdict(path: &str, sha256: String, bytes: &[u8]) -> Result<TaskVerdict> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct VerdictFile {
        verdict: String,
        #[serde(default)]
        reasons: Vec<String>,
    }
    let file: VerdictFile = serde_json::from_slice(bytes)
        .map_err(|error| anyhow!("结论文件 {path} 不是有效的结论 JSON: {error}"))?;
    let status = match file.verdict.as_str() {
        "pass" => "pass",
        "blocked" => "blocked",
        other => {
            return Err(anyhow!(
                "结论文件 {path} 的 verdict 必须是 pass 或 blocked，当前为 {other}"
            ))
        }
    };
    if file.reasons.len() > 20 || file.reasons.iter().any(|r| r.len() > 500) {
        return Err(anyhow!(
            "结论文件 {path} 的 reasons 最多 20 条且每条不超过 500 字"
        ));
    }
    if status == "blocked" && file.reasons.iter().all(|r| r.trim().is_empty()) {
        return Err(anyhow!(
            "结论文件 {path} 结论为阻塞，需要在 reasons 中给出具体修订意见"
        ));
    }
    Ok(TaskVerdict {
        status: status.into(),
        reasons: file.reasons,
        path: path.into(),
        sha256,
    })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    pub summary: String,
    pub tasks: Vec<TaskSpec>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunContract {
    pub experiment_id: String,
    pub revision: String,
    pub command: String,
    pub options: serde_json::Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTask {
    #[serde(flatten)]
    pub spec: TaskSpec,
    pub state: String,
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_sessions: Vec<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub contract_batch: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_nudge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_nudge_turn_id: Option<String>,
    pub summary: Option<String>,
    pub artifacts: Vec<Artifact>,
    /// Files present when this attempt was bound. Unchanged files require an
    /// explicit `research finish` acknowledgement; absence means legacy data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_baseline: Option<Vec<Artifact>>,
    pub run_contract: Option<RunContract>,
    pub run_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_run_ids: Vec<String>,
    #[serde(default)]
    pub evidence_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<crate::workflow::AgentSnapshot>,
    /// 结论把关任务最近一次验收结论；返工期间保留供界面展示，下一次验收覆盖。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<TaskVerdict>,
    /// 结论阻塞触发的自动返工已用轮数（上限为 spec.max_rework）。
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rework_count: u32,
    /// 返工时附加给直接上游的修订意见，派发时注入提示词，验收后清空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rework_feedback: Option<String>,
    /// 分流节点最近一次求值结果；返工/计划修订重置时清空，重新求值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_decision: Option<RouteDecision>,
    /// 逐项处理就绪时固化的清单（来自上游产物旁的 `.items.json`），执行期间不再重读。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreach_items: Option<Vec<ForEachItem>>,
    /// 已结束的迭代记录，按执行顺序追加；`session_id` 始终指向当前正在执行的迭代。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub foreach_runs: Vec<ForeachRun>,
}
/// 逐项处理的一次迭代记录；失败迭代 `artifact` 为空、`ok` 为 false。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeachRun {
    pub item_id: String,
    pub item_title: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<Artifact>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}
/// 人工任务等主理人产出时的状态：派发资格已满足，等待提交产物。
pub const TASK_AWAITING: &str = "awaiting";
impl ResearchTask {
    pub fn run_gate_scope(&self) -> Result<String> {
        let contract = self
            .run_contract
            .as_ref()
            .ok_or_else(|| anyhow!("先用 prepare-run 绑定真实实验"))?;
        let batch = self.contract_batch;
        if batch == 0 {
            Ok(serde_json::to_string(contract)?)
        } else {
            let mut scope = serde_json::to_value(contract)?;
            if let Some(obj) = scope.as_object_mut() {
                obj.insert("batch".into(), serde_json::json!(batch));
            }
            Ok(serde_json::to_string(&scope)?)
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPlan {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_source: Option<crate::workflow::WorkflowSource>,
    /// Immutable package IDs visible on the lead's branch when this plan was created.
    /// None is legacy data; Some(empty) explicitly fixes a plan with no materials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    pub summary: String,
    pub tasks: Vec<ResearchTask>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HumanDecision {
    pub id: String,
    pub gate: String,
    pub scope: String,
    pub scope_hash: String,
    pub version: u32,
    pub status: String,
    pub reason: Option<String>,
    pub approver: Option<String>,
    pub requested_at: i64,
    pub decided_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimInput {
    pub text: String,
    pub support: String,
    pub source: String,
    pub location: Option<String>,
    pub run_id: Option<String>,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_read_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<MetricSelection>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceClaim {
    pub id: String,
    #[serde(flatten)]
    pub input: ClaimInput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_citation: Option<super::material_reads::MaterialCitation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_citation: Option<MetricCitation>,
    pub commit_sha: Option<String>,
    pub log_sha256: Option<String>,
    pub excerpt: Option<String>,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Study {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub mode: String,
    pub objective: String,
    pub status: String,
    pub plans: Vec<ResearchPlan>,
    pub decisions: Vec<HumanDecision>,
    pub claims: Vec<EvidenceClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_citation_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_citation_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_snapshot: Option<DeliverySnapshot>,
    pub created_at: i64,
    pub updated_at: i64,
}
fn same_json_encoding(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            left == right && left.as_f64().map(f64::to_bits) == right.as_f64().map(f64::to_bits)
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_json_encoding(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|((left_key, left), (right_key, right))| {
                        left_key == right_key && same_json_encoding(left, right)
                    })
        }
        _ => left == right,
    }
}

impl Study {
    fn same_document(&self, other: &Self) -> bool {
        if self != other {
            return false;
        }
        // RunContract.options is the open JSON subtree. Value equality alone
        // equates -0.0 and 0.0, while approval scopes distinguish their encoding.
        self.plans
            .iter()
            .flat_map(|plan| &plan.tasks)
            .zip(other.plans.iter().flat_map(|plan| &plan.tasks))
            .all(
                |(left, right)| match (&left.run_contract, &right.run_contract) {
                    (Some(left), Some(right)) => same_json_encoding(&left.options, &right.options),
                    _ => true, // Structural equality above already checked presence.
                },
            )
    }

    pub fn plan(&self) -> Result<&ResearchPlan> {
        self.plans.last().ok_or_else(|| anyhow!("先提交研究计划"))
    }
    pub fn plan_mut(&mut self) -> Result<&mut ResearchPlan> {
        self.plans
            .last_mut()
            .ok_or_else(|| anyhow!("先提交研究计划"))
    }
    pub fn task(&self, id: &str) -> Result<&ResearchTask> {
        self.plan()?
            .tasks
            .iter()
            .find(|t| t.spec.id == id)
            .ok_or_else(|| anyhow!("任务不存在: {id}"))
    }
    pub fn task_mut(&mut self, id: &str) -> Result<&mut ResearchTask> {
        self.plan_mut()?
            .tasks
            .iter_mut()
            .find(|t| t.spec.id == id)
            .ok_or_else(|| anyhow!("任务不存在: {id}"))
    }
    pub fn ensure_active(&self) -> Result<()> {
        if self.status != "active" {
            return Err(anyhow!(if self.status == "paused" {
                "研究已暂停，请先继续研究"
            } else {
                "研究已停止"
            }));
        }
        Ok(())
    }
    pub fn require_gate(&self, gate: &str, scope: &str) -> Result<()> {
        let version = self.plan()?.version;
        let hash = digest(scope.as_bytes());
        if !self.decisions.iter().any(|d| {
            d.version == version && d.gate == gate && d.scope_hash == hash && d.status == "approved"
        }) {
            return Err(anyhow!("{gate} 尚未批准当前版本，请在研究面板确认"));
        }
        Ok(())
    }
    pub fn request_gate(&mut self, gate: &str, scope: String) -> Result<()> {
        let version = self.plan()?.version;
        let hash = digest(scope.as_bytes());
        let is_plan_wide =
            gate == "G1" || gate == crate::local::research::delivery_gate(self.workflow_mode());
        if is_plan_wide {
            for d in &mut self.decisions {
                if d.version == version
                    && d.gate == gate
                    && d.scope_hash != hash
                    && d.status != "superseded"
                {
                    d.status = "superseded".into();
                }
            }
        }
        if self.decisions.iter().any(|d| {
            d.version == version
                && d.gate == gate
                && d.scope_hash == hash
                && d.status != "superseded"
        }) {
            return Ok(());
        }
        self.decisions.push(HumanDecision {
            id: uuid::Uuid::new_v4().to_string(),
            gate: gate.into(),
            scope,
            scope_hash: hash,
            version,
            status: "pending".into(),
            reason: None,
            approver: None,
            requested_at: now_ms(),
            decided_at: None,
        });
        Ok(())
    }
    pub fn supersede_gate(&mut self, gate: &str) -> Result<()> {
        let version = self.plan()?.version;
        for d in &mut self.decisions {
            if d.version == version && d.gate == gate && d.status != "superseded" {
                d.status = "superseded".into();
            }
        }
        Ok(())
    }
    /// Automatic team studies select a route per versioned plan; manual studies keep their explicit route.
    pub fn workflow_mode(&self) -> &str {
        if self.mode == "team" {
            self.plans
                .last()
                .and_then(|p| p.workflow.as_deref())
                .unwrap_or("team")
        } else {
            &self.mode
        }
    }
    /// 当前交付快照是否已通过交付门（默认 G4）人工确认；研究成果页与下载入口共用这一判定。
    pub fn delivery_approved(&self) -> bool {
        let Some(snapshot) = self.delivery_snapshot.as_ref() else {
            return false;
        };
        let gate = crate::local::research::delivery_gate(self.workflow_mode());
        self.decisions.iter().any(|d| {
            d.version == self.plans.last().map_or(0, |p| p.version)
                && d.gate == gate
                && d.status == "approved"
                && d.scope_hash == snapshot.scope_hash
        })
    }
    pub fn plan_scope(&self) -> Result<String> {
        let plan = self.plan()?;
        let mut scope = serde_json::json!({"objective":self.objective,"version":plan.version,"summary":plan.summary,"tasks":plan.tasks.iter().map(|t| &t.spec).collect::<Vec<_>>()});
        // Preserve existing approval hashes when deserializing older plans.
        if let Some(workflow) = &plan.workflow {
            scope["workflow"] = serde_json::json!(workflow);
        }
        if let Some(ids) = &plan.material_ids {
            scope["materialIds"] = serde_json::json!(ids);
        }
        if let Some(source) = &plan.workflow_source {
            scope["workflowSource"] = serde_json::to_value(source)?;
        }
        let agents: Vec<_> = plan
            .tasks
            .iter()
            .filter_map(|task| {
                task.agent.as_ref().map(|agent| {
                    serde_json::json!({
                        "role": task.spec.role,
                        "version": agent.version,
                        "promptSha256": digest(agent.prompt.as_bytes()),
                    })
                })
            })
            .collect();
        if !agents.is_empty() {
            scope["agentDefinitions"] = serde_json::json!(agents);
        }
        Ok(serde_json::to_string(&scope)?)
    }
    /// 任务确认门的范围：同一任务产物或摘要变化后哈希随之变化，旧的批准自动失效。
    pub fn task_gate_scope(&self, task_id: &str) -> Result<String> {
        let task = self.task(task_id)?;
        let scope = serde_json::json!({
            "kind": "taskApproval",
            "taskId": task_id,
            "version": self.plan()?.version,
            "artifacts": task.artifacts,
            "summary": task.summary,
        });
        Ok(serde_json::to_string(&scope)?)
    }
    pub fn task_gate_id(task_id: &str) -> String {
        format!("G5:{task_id}")
    }
    pub fn ready(&self, id: &str) -> Result<()> {
        self.ensure_active()?;
        self.require_gate("G1", &self.plan_scope()?)?;
        let task = self.task(id)?;
        let wait_any = task.spec.wait_for == "any";
        let mut completed = 0usize;
        let mut satisfied = 0usize;
        for dep in &task.spec.depends_on {
            let dep_task = self.task(dep)?;
            if dep_task.state == "completed" {
                completed += 1;
                satisfied += 1;
            } else if dep_task.state == TASK_SKIPPED {
                // 分流未走此分支：默认汇合下视为已满足；「任一完成」不把跳过计入满足数。
                if !wait_any {
                    satisfied += 1;
                }
            } else if !wait_any {
                return Err(anyhow!("前置任务 {dep} 未通过产物验收"));
            }
            if dep_task.state != "completed" {
                continue;
            }
            if dep_task.spec.requires_approval {
                let scope = self.task_gate_scope(dep)?;
                self.require_gate(&Self::task_gate_id(dep), &scope)?;
            }
            if dep_task.spec.gate_downstream
                && dep_task
                    .verdict
                    .as_ref()
                    .is_some_and(|verdict| verdict.status == "blocked")
                && !task.reads_verdict_from(dep_task)
            {
                // 分流节点读取阻塞结论属于预期（按结论走备用路径）；其余下游维持暂停。
                return Err(anyhow!("前置任务 {dep} 结论为阻塞，需主理人处理后再派发"));
            }
        }
        if task.spec.depends_on.is_empty() {
            // 无前置任务时不需要汇合判定。
        } else if wait_any {
            if completed == 0 {
                return Err(anyhow!("汇合策略为「任一完成」，但前置任务还没有完成的"));
            }
        } else if satisfied < task.spec.depends_on.len() {
            return Err(anyhow!("前置任务未全部通过产物验收或被分流跳过"));
        }
        if task.spec.role == "as-experiment-operator" {
            let scope = task.run_gate_scope()?;
            self.require_gate("G2", &scope)?;
            self.require_gate("G3", &scope)?;
        }
        Ok(())
    }
    /// 求值所有就绪的分流节点并把未选中的分支传播为 skipped。
    /// 幂等：已求值或未就绪的节点保持原状；在派发、验收与后台对账前调用。
    pub fn resolve_routes(&mut self) -> Result<()> {
        loop {
            let mut changed = false;
            // 求值阶段：先收集待求值节点及其前置快照，再逐个写回，避免同时借用。
            let route_ids: Vec<String> = self
                .plan()?
                .tasks
                .iter()
                .filter(|task| {
                    task.spec.kind == ROUTE_KIND
                        && task.state == "pending"
                        && task.session_id.is_none()
                        && task.spec.route.is_some()
                })
                .map(|task| task.spec.id.clone())
                .collect();
            for route_id in route_ids {
                let (route, deps) = {
                    let task = self.task(&route_id)?;
                    let route = task.spec.route.clone().unwrap_or_else(|| RouteSpec {
                        on: String::new(),
                        source: String::new(),
                        verdict_is: String::new(),
                    });
                    let deps: Vec<ResearchTask> = task
                        .spec
                        .depends_on
                        .iter()
                        .filter_map(|dep| self.task(dep).ok())
                        .cloned()
                        .collect();
                    (route, deps)
                };
                if deps.len() != self.task(&route_id)?.spec.depends_on.len() {
                    continue;
                }
                let Some((matched, basis)) = route_outcome(&route, &deps) else {
                    continue; // 触发条件尚未就绪，等下一轮。
                };
                let drop = if matched { ROUTE_ELSE } else { ROUTE_THEN };
                let children: Vec<String> = self
                    .plan()?
                    .tasks
                    .iter()
                    .filter(|candidate| {
                        candidate.spec.depends_on.iter().any(|dep| dep == &route_id)
                    })
                    .map(|candidate| candidate.spec.id.clone())
                    .collect();
                {
                    let task = self.task_mut(&route_id)?;
                    task.state = "completed".into();
                    task.summary = Some(format!(
                        "分流判定：{basis}，走「{}」分支。",
                        if matched { "成立" } else { "不成立" }
                    ));
                    task.route_decision = Some(RouteDecision {
                        outcome: if matched { "matched" } else { "unmatched" }.into(),
                        basis: basis.clone(),
                        decided_at: now_ms(),
                    });
                }
                for child in children {
                    if let Ok(child_task) = self.task_mut(&child) {
                        if child_task.state == "pending"
                            && child_task.session_id.is_none()
                            && child_task.spec.route_branch == drop
                        {
                            child_task.state = TASK_SKIPPED.into();
                            child_task.summary = Some("上游分流未走此分支，任务已跳过。".into());
                        }
                    }
                }
                changed = true;
            }
            // 传播阶段：前置全部完成或跳过、且至少一个跳过的任务同样跳过；
            // 「任一完成」的汇合不传播，只有全部前置都被跳过时才跳过。
            let candidates: Vec<(String, bool)> = self
                .plan()?
                .tasks
                .iter()
                .filter(|task| {
                    task.state == "pending"
                        && task.session_id.is_none()
                        && !task.spec.depends_on.is_empty()
                })
                .map(|task| {
                    // 只有全部前置都被跳过才传播跳过：混合「已完成 + 已跳过」前置的任务
                    // 仍然运行（跳过的一侧按默认汇合视为已满足），与 ready() 语义一致。
                    let all_deps_skipped = !task.spec.depends_on.is_empty()
                        && task.spec.depends_on.iter().all(|dep| {
                            self.task(dep)
                                .map(|t| t.state == TASK_SKIPPED)
                                .unwrap_or(false)
                        });
                    (task.spec.id.clone(), all_deps_skipped)
                })
                .collect();
            for (task_id, skippable) in candidates {
                if !skippable {
                    continue;
                }
                let task = self.task_mut(&task_id)?;
                if task.state == "pending" && task.session_id.is_none() {
                    task.state = TASK_SKIPPED.into();
                    task.summary = Some("上游分流未走此分支，任务已跳过。".into());
                    changed = true;
                }
            }
            if !changed {
                return Ok(());
            }
        }
    }
}
/// 分流谓词求值：返回 None 表示触发条件未就绪。
fn route_outcome(route: &RouteSpec, deps: &[ResearchTask]) -> Option<(bool, String)> {
    match route.on.as_str() {
        "verdict" => {
            let source_task = deps.iter().find(|task| {
                task.spec
                    .outputs
                    .iter()
                    .any(|output| output == &route.source)
            })?;
            if source_task.state != "completed" {
                return None;
            }
            let verdict = source_task
                .verdict
                .as_ref()
                .map(|verdict| verdict.status.clone())
                .unwrap_or_else(|| "missing".into());
            Some((verdict == route.verdict_is, format!("上游结论为 {verdict}")))
        }
        "failure" => {
            // 任一直接前置仍在执行或等待时不下结论；全部到达终态后按失败情况判定。
            if !deps
                .iter()
                .all(|task| matches!(task.state.as_str(), "completed" | "failed" | "skipped"))
            {
                return None;
            }
            let failed = deps
                .iter()
                .filter(|task| task.state == "failed")
                .map(|task| task.spec.id.as_str())
                .collect::<Vec<_>>();
            Some((
                !failed.is_empty(),
                if failed.is_empty() {
                    "上游任务全部通过".into()
                } else {
                    format!("上游任务失败：{}", failed.join("、"))
                },
            ))
        }
        _ => None,
    }
}
impl ResearchTask {
    /// 该任务是否以 verdict 方式读取指定上游的结论（分流节点的预期读取路径）。
    fn reads_verdict_from(&self, upstream: &ResearchTask) -> bool {
        self.spec.kind == ROUTE_KIND
            && self.spec.route.as_ref().is_some_and(|route| {
                route.on == "verdict"
                    && upstream
                        .spec
                        .outputs
                        .iter()
                        .any(|output| output == &route.source)
            })
    }
}
/// 结论阻塞触发的有界返工：重置门控任务的直接上游及其全部传递下游。
/// 只重置已验收/已失败的任务（归档其会话回到待执行），运行中的任务不动；
/// 实验执行任务保持原状，避免已批准的 G2/G3 运行契约被作废。
/// 直接上游附带本轮返工意见，派发时注入提示词。
fn rework_upstream_tasks(study: &mut Study, gate_task_id: &str, reasons: &[String]) -> Result<()> {
    let (round, deps) = {
        let gate_task = study.task(gate_task_id)?;
        (
            gate_task.rework_count + 1,
            gate_task.spec.depends_on.clone(),
        )
    };
    let feedback = format!("第 {round} 轮返工意见：{}", reasons.join("；"));
    // 重置范围 = 直接上游 ∪ 其全部传递下游（含门控任务自身）。
    let mut reset_ids: HashSet<String> = deps.iter().cloned().collect();
    loop {
        let before = reset_ids.len();
        for task in study.plan()?.tasks.iter() {
            if task
                .spec
                .depends_on
                .iter()
                .any(|dep| reset_ids.contains(dep))
            {
                reset_ids.insert(task.spec.id.clone());
            }
        }
        if reset_ids.len() == before {
            break;
        }
    }
    for task_id in &reset_ids {
        let task = study.task_mut(task_id)?;
        if task.spec.role == "as-experiment-operator"
            || !matches!(task.state.as_str(), "completed" | "failed" | "skipped")
        {
            continue;
        }
        if let Some(old_session) = task.session_id.take() {
            task.previous_sessions.push(old_session);
        }
        task.pending_nudge = None;
        task.pending_nudge_turn_id = None;
        task.summary = None;
        task.rework_feedback = None;
        // 分流节点连同其历史判定一起重置：重新求值后才放行对应分支。
        task.route_decision = None;
        task.state = "pending".into();
        if deps.contains(task_id) {
            task.rework_feedback = Some(feedback.clone());
        }
    }
    let task = study.task_mut(gate_task_id)?;
    task.rework_count = round;
    Ok(())
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains(':')
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
const MAX_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;

pub fn inspect_artifact(root: &Path, relative: &str) -> Result<Artifact> {
    let (_, mut source) = files::open_artifact(root, relative)?;
    Ok(Artifact {
        path: relative.into(),
        sha256: source.hash()?,
        bytes: source.bytes(),
    })
}
#[cfg(test)]
pub fn validate_plan(input: &PlanInput, mode: &str) -> Result<()> {
    validate_plan_with_roles(input, mode, false, |role| {
        crate::local::research::role(role).map(|_| ())
    })
}

pub(crate) fn validate_plan_with_roles(
    input: &PlanInput,
    mode: &str,
    explicit_method: bool,
    mut validate_role: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    if let Some(workflow) = &input.workflow {
        if !crate::local::research::workflows().contains_key(workflow)
            || (mode != "team" && mode != workflow)
        {
            return Err(anyhow!("计划流程必须是有效预设，且与用户指定的流程一致"));
        }
    }
    let mode = input.workflow.as_deref().unwrap_or(mode);
    if input.summary.trim().is_empty()
        || input.summary.len() > 24000
        || input.tasks.is_empty()
        || input.tasks.len() > 40
    {
        return Err(anyhow!("计划需要摘要及 1–40 个任务"));
    }
    let ids: HashSet<_> = input.tasks.iter().map(|t| &t.id).collect();
    if ids.len() != input.tasks.len() {
        return Err(anyhow!("任务 ID 重复"));
    }
    let mut paths = HashSet::new();
    let outputs_by_id: HashMap<&str, &Vec<String>> = input
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), &task.outputs))
        .collect();
    for task in &input.tasks {
        if task.id.is_empty()
            || task.id.len() > 80
            || !task
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(anyhow!("任务 ID 仅允许字母、数字、横线和下划线"));
        }
        // 分流节点不选择专家、不产出文件；角色与产物校验只针对专家任务，
        // 分流自身的条件与分支规则统一在 validate_route_rules 中检查。
        let is_route = task.kind == ROUTE_KIND;
        if is_route {
            if task.brief.trim().is_empty() || task.brief.len() > 24000 {
                return Err(anyhow!("分流节点需要名称说明: {}", task.id));
            }
        } else {
            validate_role(&task.role)?;
            if task.brief.trim().is_empty()
                || task.brief.len() > 24000
                || task.outputs.is_empty()
                || task.outputs.len() > 30
            {
                return Err(anyhow!("每个任务需要简报和 1–30 个产物路径"));
            }
        }
        if task.depends_on.iter().any(|d| !ids.contains(d)) {
            return Err(anyhow!("未知前置任务"));
        }
        if task
            .outputs
            .iter()
            .any(|p| !safe_relative(p) || !paths.insert(p))
        {
            return Err(anyhow!("产物路径越界或在多个任务间重复"));
        }
        if mode != "team"
            && !crate::local::research::workflows()
                .get(mode)
                .is_some_and(|w| w.allows_experiments)
            && task.role == "as-experiment-operator"
        {
            return Err(anyhow!(
                "所选流程不运行实验；需要真实复现请新建论文复现流程"
            ));
        }
        if task.inputs.iter().any(|path| !safe_relative(path)) {
            return Err(anyhow!("任务 {} 的输入路径越界", task.id));
        }
        if task.inputs.iter().collect::<HashSet<_>>().len() != task.inputs.len() {
            return Err(anyhow!("任务 {} 的输入存在重复路径", task.id));
        }
        let dep_outputs = task
            .depends_on
            .iter()
            .flat_map(|dep| outputs_by_id[dep.as_str()].iter())
            .collect::<HashSet<_>>();
        if let Some(missing) = task.inputs.iter().find(|path| !dep_outputs.contains(path)) {
            return Err(anyhow!(
                "任务 {} 的输入必须来自直接前置任务的产物: {missing}",
                task.id
            ));
        }
        if task.gate_downstream {
            if task.role == "as-experiment-operator" {
                return Err(anyhow!("实验执行任务不支持结论把关: {}", task.id));
            }
            if task.depends_on.is_empty() {
                return Err(anyhow!("结论把关任务需要至少一个前置任务: {}", task.id));
            }
        }
        if task.max_rework > MAX_REWORK {
            return Err(anyhow!(
                "任务 {} 的返工上限不能超过 {MAX_REWORK} 轮",
                task.id
            ));
        }
        if task.max_rework > 0 && !task.gate_downstream {
            return Err(anyhow!("任务 {} 设置返工上限需要同时开启结论把关", task.id));
        }
    }
    validate_route_rules(&input.tasks)?;
    let mut visited = HashSet::new();
    loop {
        let before = visited.len();
        for task in &input.tasks {
            if task.depends_on.iter().all(|d| visited.contains(d)) {
                visited.insert(task.id.clone());
            }
        }
        if visited.len() == ids.len() {
            break;
        }
        if before == visited.len() {
            return Err(anyhow!("任务依赖存在循环"));
        }
    }
    for task in &input.tasks {
        if matches!(
            task.role.as_str(),
            "as-independent-reviewer"
                | "as-quality-citation-auditor"
                | "as-research-package-curator"
        ) {
            let mut ancestors: HashSet<String> = task.depends_on.iter().cloned().collect();
            loop {
                let before = ancestors.len();
                for candidate in &input.tasks {
                    if ancestors.contains(&candidate.id) {
                        ancestors.extend(candidate.depends_on.iter().cloned());
                    }
                }
                if ancestors.len() == before {
                    break;
                }
            }
            for upstream in &input.tasks {
                let required = match task.role.as_str() {
                    "as-independent-reviewer" => !matches!(
                        upstream.role.as_str(),
                        "as-independent-reviewer"
                            | "as-quality-citation-auditor"
                            | "as-research-package-curator"
                    ),
                    "as-quality-citation-auditor" => upstream.role == "as-independent-reviewer",
                    _ => upstream.role == "as-quality-citation-auditor",
                };
                if required && !ancestors.contains(&upstream.id) {
                    return Err(anyhow!(
                        "审查任务必须依赖待审材料，归档必须依赖审查: {} -> {}",
                        upstream.id,
                        task.id
                    ));
                }
            }
        }
    }
    if let Some(profile) = crate::local::research::workflows().get(mode) {
        for required in &profile.required_roles {
            if !input.tasks.iter().any(|t| &t.role == required) {
                return Err(anyhow!("{} 计划缺少预设专家: {required}", profile.title));
            }
        }
        for task in &input.tasks {
            if profile.forbidden_roles.contains(&task.role) {
                return Err(anyhow!("{} 跳过专家: {}", profile.title, task.role));
            }
            let mut ancestors: HashSet<&str> = task.depends_on.iter().map(String::as_str).collect();
            loop {
                let before = ancestors.len();
                for candidate in &input.tasks {
                    if ancestors.contains(candidate.id.as_str()) {
                        ancestors.extend(candidate.depends_on.iter().map(String::as_str));
                    }
                }
                if ancestors.len() == before {
                    break;
                }
            }
            for [before, after] in &profile.dependencies {
                if &task.role == after
                    && input
                        .tasks
                        .iter()
                        .filter(|t| &t.role == before)
                        .any(|t| !ancestors.contains(t.id.as_str()))
                {
                    return Err(anyhow!(
                        "{} 预设依赖缺失: {before} -> {after}",
                        profile.title
                    ));
                }
            }
        }
    }
    // 专家团自动编排以独立审稿+引用审计兜底；用户显式提交的方法按其编排执行（W1 契约另行约束）。
    if (mode == "team" && !explicit_method) || mode == "review" {
        for required in ["as-independent-reviewer", "as-quality-citation-auditor"] {
            if !input.tasks.iter().any(|t| t.role == required) {
                return Err(anyhow!("计划必须包含独立审稿和引用审计"));
            }
        }
    }
    Ok(())
}

/// 条件分流与汇合的共享规则：草稿保存与计划提交共用同一套校验，
/// 保证画布保存、提交计划与引擎执行对分支拓扑的理解一致。
pub fn validate_route_rules(tasks: &[TaskSpec]) -> Result<()> {
    for task in tasks {
        match task.kind.as_str() {
            "" | "agent" => {
                if task.route.is_some() {
                    return Err(anyhow!("任务 {} 不是分流节点，不能配置分流条件", task.id));
                }
            }
            "route" => {
                if !task.role.is_empty() {
                    return Err(anyhow!("分流节点 {} 不选择专家", task.id));
                }
                if !task.outputs.is_empty() {
                    return Err(anyhow!("分流节点 {} 不产出文件", task.id));
                }
                if !task.inputs.is_empty() {
                    return Err(anyhow!("分流节点 {} 不读取输入产物", task.id));
                }
                if task.requires_approval || task.gate_downstream || task.max_rework > 0 {
                    return Err(anyhow!(
                        "分流节点 {} 不支持完成后确认、结论把关或返工",
                        task.id
                    ));
                }
                if task.depends_on.is_empty() {
                    return Err(anyhow!(
                        "分流节点 {} 还没有前置任务：先从上游连一条线进来",
                        task.id
                    ));
                }
                let Some(route) = task.route.as_ref() else {
                    return Err(anyhow!("分流节点 {} 缺少分流条件", task.id));
                };
                match route.on.as_str() {
                    "verdict" => {
                        if route.verdict_is != "pass" && route.verdict_is != "blocked" {
                            return Err(anyhow!(
                                "分流节点 {} 的结论条件只允许「通过」或「有问题」",
                                task.id
                            ));
                        }
                        let owner = tasks.iter().find(|candidate| {
                            candidate
                                .outputs
                                .iter()
                                .any(|output| output == &route.source)
                        });
                        let Some(owner) = owner else {
                            return Err(anyhow!(
                                "分流节点 {} 的条件来源 {} 不是任何任务的产物",
                                task.id,
                                route.source
                            ));
                        };
                        if !task.depends_on.contains(&owner.id) {
                            return Err(anyhow!(
                                "分流节点 {} 的条件来源必须来自直接前置任务的产物",
                                task.id
                            ));
                        }
                        if !owner.gate_downstream {
                            return Err(anyhow!(
                                "产物 {} 所在任务 {} 未开启结论把关，分流没有可读取的结论",
                                route.source,
                                owner.id
                            ));
                        }
                    }
                    "failure" => {
                        if !route.source.is_empty() || !route.verdict_is.is_empty() {
                            return Err(anyhow!(
                                "分流节点 {} 的「上游失败」条件不需要选择来源产物或结论值",
                                task.id
                            ));
                        }
                    }
                    other => {
                        return Err(anyhow!("分流节点 {} 的条件类型无效: {other}", task.id));
                    }
                }
            }
            other => {
                return Err(anyhow!("任务 {} 的节点类型无效: {other}", task.id));
            }
        }
        match task.wait_for.as_str() {
            "" | "all" => {}
            "any" => {
                if task.depends_on.len() < 2 {
                    return Err(anyhow!(
                        "任务 {} 的汇合策略「任一完成」需要至少两条前置连线",
                        task.id
                    ));
                }
            }
            other => {
                return Err(anyhow!("任务 {} 的汇合策略无效: {other}", task.id));
            }
        }
        if !matches!(task.route_branch.as_str(), "" | "then" | "else") {
            return Err(anyhow!(
                "任务 {} 的分支标记无效: {}",
                task.id,
                task.route_branch
            ));
        }
        if !task.route_branch.is_empty()
            && !task.depends_on.iter().any(|dep| {
                tasks
                    .iter()
                    .any(|candidate| candidate.id == *dep && candidate.kind == ROUTE_KIND)
            })
        {
            return Err(anyhow!(
                "任务 {} 标记了分支，但它的前置里没有分流节点",
                task.id
            ));
        }
    }
    // 分支拓扑：每个分流节点的两条分支都要有后续任务，「不成立」即默认出口，必须显式存在。
    for route in tasks.iter().filter(|task| task.kind == ROUTE_KIND) {
        let children = tasks
            .iter()
            .filter(|candidate| candidate.depends_on.iter().any(|dep| dep == &route.id))
            .collect::<Vec<_>>();
        let (mut then, mut otherwise) = (false, false);
        for child in &children {
            match child.route_branch.as_str() {
                "then" => then = true,
                "else" => otherwise = true,
                _ => {
                    return Err(anyhow!(
                        "任务 {} 连在分流节点 {} 上，但还没有标记走「成立」还是「不成立」分支",
                        child.id,
                        route.id
                    ));
                }
            }
        }
        if children.is_empty() || !then || !otherwise {
            return Err(anyhow!(
                "分流节点 {} 需要「成立」和「不成立」两条分支都有后续任务",
                route.id
            ));
        }
    }
    Ok(())
}

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS research_studies (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, document TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS research_studies_project ON research_studies(project_id);
        CREATE TABLE IF NOT EXISTS research_sessions (session_id TEXT PRIMARY KEY, study_id TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_activity_spans (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE, started_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, ended_at INTEGER, complete INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS chat_activity_spans_open ON chat_activity_spans(message_id) WHERE ended_at IS NULL;
        CREATE INDEX IF NOT EXISTS chat_activity_spans_session ON chat_activity_spans(session_id);
        CREATE TABLE IF NOT EXISTS research_experiments (experiment_id TEXT PRIMARY KEY, study_id TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS research_project_cleanup AFTER DELETE ON local_projects BEGIN
        DELETE FROM research_sessions WHERE study_id IN (SELECT id FROM research_studies WHERE project_id=OLD.id);
        DELETE FROM research_experiments WHERE study_id IN (SELECT id FROM research_studies WHERE project_id=OLD.id);
        DELETE FROM research_studies WHERE project_id=OLD.id; END;")?;
    claims::migrate(conn)?;
    material_citations::migrate(conn)?;
    metric_citations::migrate(conn)?;
    delivery::migrate(conn)?;
    archive_retention::migrate(conn)?;
    conn.execute_batch(&format!(
        "CREATE INDEX IF NOT EXISTS idx_research_studies_active ON research_studies(id) WHERE {ACTIVE_STUDY_FILTER}"
    ))?;
    Ok(())
}
impl Store {
    pub fn research_study(&self, id: &str) -> Result<Study> {
        let text: String = self
            .conn
            .query_row(
                "SELECT document FROM research_studies WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| anyhow!("研究不存在: {id}"))?;
        serde_json::from_str(&text).map_err(|error| {
            let context = format!("研究 {id} 数据解析失败：{error}");
            crate::error::Error::new(error).context(context)
        })
    }
    pub fn research_for_session(&self, session: &str) -> Result<Option<Study>> {
        let id: Option<String> = self.conn.query_row("WITH RECURSIVE lineage(id,depth) AS (SELECT ?1,0 UNION ALL SELECT COALESCE(s.side_parent_session_id,s.parent_session_id),l.depth+1 FROM chat_sessions s JOIN lineage l ON s.id=l.id WHERE l.depth<16 AND COALESCE(s.side_parent_session_id,s.parent_session_id) IS NOT NULL) SELECT id FROM research_studies WHERE session_id IN (SELECT id FROM lineage) UNION SELECT study_id FROM research_sessions WHERE session_id IN (SELECT id FROM lineage) LIMIT 1", [session], |r| r.get(0)).optional()?;
        id.map(|id| self.research_study(&id)).transpose()
    }
    pub fn research_session_task(&self, session: &str) -> Result<Option<(String, u32)>> {
        Ok(self
            .conn
            .query_row(
                "SELECT task_id,version FROM research_sessions WHERE session_id=?1",
                [session],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
    pub fn research_save(&self, study: &Study) -> Result<()> {
        self.conn.execute(
            "UPDATE research_studies SET document=?2 WHERE id=?1",
            params![study.id, serde_json::to_string(study)?],
        )?;
        Ok(())
    }
    pub(crate) fn research_update_in_tx<T>(
        &self,
        id: &str,
        update: impl FnOnce(&mut Study) -> Result<T>,
    ) -> Result<T> {
        let mut study = self.research_study(id)?;
        let before = study.clone();
        let value = update(&mut study)?;
        let changed = !study.same_document(&before);
        // Release the comparison snapshot before allocating the serialized write.
        drop(before);
        if changed {
            study.updated_at = now_ms();
            self.research_save(&study)?;
        }
        Ok(value)
    }
    pub fn research_update<T>(
        &self,
        id: &str,
        update: impl FnOnce(&mut Study) -> Result<T>,
    ) -> Result<T> {
        let tx = self.begin_immediate()?;
        let value = self.research_update_in_tx(id, update)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn research_create(&self, session: &str, mode: &str, objective: &str) -> Result<Study> {
        if !(mode == "team" || crate::local::research::workflows().contains_key(mode))
            || objective.trim().is_empty()
            || objective.len() > 24000
        {
            return Err(anyhow!("请选择研究模式并填写目标"));
        }
        let chat = self
            .get_chat_session(session)?
            .ok_or_else(|| anyhow!("会话不存在"))?;
        if chat.parent_session_id.is_some() || chat.side_parent_session_id.is_some() {
            return Err(anyhow!("研究需要独立主会话"));
        }
        let study = Study {
            id: format!("study_{}", uuid::Uuid::new_v4()),
            project_id: chat.project_id,
            session_id: session.into(),
            mode: mode.into(),
            objective: objective.trim().into(),
            status: "active".into(),
            plans: vec![],
            decisions: vec![],
            claims: vec![],
            claim_revision: None,
            material_citation_revision: None,
            metric_citation_revision: None,
            delivery_error: None,
            delivery_snapshot: None,
            created_at: now_ms(),
            updated_at: now_ms(),
        };
        self.conn.execute(
            "INSERT INTO research_studies(id,project_id,session_id,document) VALUES(?1,?2,?3,?4)",
            params![
                study.id,
                study.project_id,
                study.session_id,
                serde_json::to_string(&study)?
            ],
        )?;
        Ok(study)
    }
    pub fn research_log_path(&self, run_id: &str) -> Result<PathBuf> {
        if !run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(anyhow!("Run ID 无效"));
        }
        let database = self.conn.path().ok_or_else(|| anyhow!("需要持久数据库"))?;
        Ok(Path::new(database)
            .parent()
            .ok_or_else(|| anyhow!("数据库目录无效"))?
            .join("run-logs")
            .join(format!("{run_id}.log")))
    }
    pub fn research_root(&self, study: &Study) -> Result<PathBuf> {
        let project = self
            .get_local_project(&study.project_id)?
            .ok_or_else(|| anyhow!("项目不存在"))?;
        let database = self
            .conn
            .path()
            .ok_or_else(|| anyhow!("研究需要持久数据库"))?;
        let root = Path::new(database)
            .parent()
            .ok_or_else(|| anyhow!("数据库目录无效"))?;
        Ok(root
            .join("files")
            .join(&project.slug)
            .join("research")
            .join(&study.id))
    }
    /// Called inside the same transaction that creates the native helper.
    pub fn research_bind_task(&self, study_id: &str, task_id: &str, session: &str) -> Result<()> {
        let mut study = self.research_study(study_id)?;
        // 派发前先求值就绪的分流节点：分支放行与 skipped 传播要在就绪判定之前完成。
        study.resolve_routes()?;
        study.ready(task_id)?;
        let root = self.research_root(&study)?;
        for dependency in &study.task(task_id)?.spec.depends_on {
            for artifact in &study.task(dependency)?.artifacts {
                if inspect_artifact(&root, &artifact.path)?.sha256 != artifact.sha256 {
                    return Err(anyhow!("前置产物已变化，需要重新验收: {}", artifact.path));
                }
            }
        }
        let version = study.plan()?.version;
        let task = study.task_mut(task_id)?;
        if task.state != "pending" {
            return Err(anyhow!("任务已派发；请读取已有会话"));
        }
        let mut baseline = Vec::new();
        for path in &study.task(task_id)?.spec.outputs {
            match inspect_artifact(&root, path) {
                Ok(artifact) => baseline.push(artifact),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        let evidence_digest = self.research_evidence(&study)?.digest()?;
        let task = study.task_mut(task_id)?;
        task.output_baseline = Some(baseline);
        task.summary = None;
        task.evidence_digest = Some(evidence_digest);
        task.state = "running".into();
        task.session_id = Some(session.into());
        self.conn.execute(
            "INSERT INTO research_sessions VALUES(?1,?2,?3,?4)",
            params![session, study.id, task_id, version],
        )?;
        self.research_save(&study)
    }
    pub fn research_prepare(&self, id: &str, task_id: &str, contract: RunContract) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            study.require_gate("G1", &study.plan_scope()?)?;
            let version = study.plan()?.version;
            let task = study.task(task_id)?;
            if task.spec.role != "as-experiment-operator"
                || !matches!(task.state.as_str(), "pending" | "failed")
            {
                return Err(anyhow!("只能为待执行或失败待重试的实验执行任务准备运行"));
            }
            for run_id in &task.run_ids {
                if self
                    .get_run(run_id)?
                    .is_some_and(|r| !crate::local::is_terminal(&r.status))
                {
                    return Err(anyhow!("仍有运行中的实验，请先等待或取消"));
                }
            }
            let exp = self
                .get_local_experiment(&contract.experiment_id)?
                .ok_or_else(|| anyhow!("实验不存在"))?;
            if exp.project_id != study.project_id {
                return Err(anyhow!("实验属于其他项目"));
            }
            let existing: Option<(String, String, u32)> = self
                .conn
                .query_row(
                    "SELECT study_id,task_id,version FROM research_experiments WHERE experiment_id=?1",
                    [&exp.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if existing
                .as_ref()
                .is_some_and(|(sid, tid, v)| sid != id || (*v == version && tid != task_id))
            {
                return Err(anyhow!("实验已绑定其他研究任务；变更请修订计划"));
            }
            let old_scope = task.run_gate_scope().ok();
            let has_rejected_or_consumed = old_scope.as_ref().is_some_and(|s| {
                let h = digest(s.as_bytes());
                study.decisions.iter().any(|d| {
                    d.version == version
                        && matches!(d.gate.as_str(), "G2" | "G3")
                        && d.scope_hash == h
                        && d.status == "rejected"
                })
            }) || !task.run_ids.is_empty()
                || task.session_id.is_some()
                || task.state == "failed";
            if task.state == "pending"
                && task.run_contract.as_ref() == Some(&contract)
                && !has_rejected_or_consumed
            {
                return Ok(());
            }
            let had_prior_attempt = task.run_contract.is_some()
                || !task.run_ids.is_empty()
                || !task.previous_run_ids.is_empty()
                || task.session_id.is_some()
                || !task.previous_sessions.is_empty()
                || task.state == "failed"
                || has_rejected_or_consumed;
            if let Some(old_s) = old_scope {
                let old_hash = digest(old_s.as_bytes());
                for d in &mut study.decisions {
                    if d.version == version
                        && matches!(d.gate.as_str(), "G2" | "G3")
                        && d.scope_hash == old_hash
                        && d.status != "superseded"
                    {
                        d.status = "superseded".into();
                    }
                }
            }
            self.conn.execute(
                "INSERT INTO research_experiments VALUES(?1,?2,?3,?4) ON CONFLICT(experiment_id) DO UPDATE SET task_id=excluded.task_id,version=excluded.version",
                params![exp.id, id, task_id, version],
            )?;
            let task = study.task_mut(task_id)?;
            if let Some(old_session) = task.session_id.take() {
                task.previous_sessions.push(old_session);
            }
            if !task.run_ids.is_empty() {
                task.previous_run_ids.append(&mut task.run_ids);
            }
            if had_prior_attempt {
                task.contract_batch += 1;
                task.attempts += 1;
            }
            task.pending_nudge = None;
            task.pending_nudge_turn_id = None;
            task.state = "pending".into();
            task.summary = None;
            task.run_contract = Some(contract);
            let scope = task.run_gate_scope()?;
            study.request_gate("G2", scope.clone())?;
            study.request_gate("G3", scope)
        })
    }
    pub fn research_nudge_task(
        &self,
        id: &str,
        task_id: &str,
        session_id: &str,
        prompt: String,
    ) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            let task = study.task_mut(task_id)?;
            if task.state != "running" || task.session_id.as_deref() != Some(session_id) {
                return Err(anyhow!("仅能提醒正在执行当前任务的专家会话"));
            }
            if task.pending_nudge.is_none() {
                task.attempts += 1;
            }
            task.pending_nudge = Some(prompt);
            task.pending_nudge_turn_id = None;
            Ok(())
        })
    }
    pub(crate) fn research_bind_nudge_turn_in_tx(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<()> {
        let Some((task_id, version)) = self.research_session_task(session_id)? else {
            return Ok(());
        };
        let Some(study) = self.research_for_session(session_id)? else {
            return Ok(());
        };
        if study.plan().map_or(true, |p| p.version != version) {
            return Ok(());
        }
        self.research_update_in_tx(&study.id, |s| {
            let task = s.task_mut(&task_id)?;
            if task.session_id.as_deref() == Some(session_id) && task.pending_nudge.is_some() {
                task.pending_nudge_turn_id = Some(turn_id.to_string());
            }
            Ok(())
        })
    }
    pub(crate) fn research_confirm_turn_started_in_tx(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<()> {
        self.reopen_chat_spawn(session_id, Some(turn_id))?;
        let Some((task_id, version)) = self.research_session_task(session_id)? else {
            return Ok(());
        };
        let Some(study) = self.research_for_session(session_id)? else {
            return Ok(());
        };
        if study.plan().map_or(true, |p| p.version != version) {
            return Ok(());
        }
        self.research_update_in_tx(&study.id, |s| {
            let task = s.task_mut(&task_id)?;
            if task.session_id.as_deref() == Some(session_id) {
                task.pending_nudge = None;
                task.pending_nudge_turn_id = None;
            }
            Ok(())
        })
    }
    pub fn research_mark_nudge_delivered(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<()> {
        let Some((task_id, version)) = self.research_session_task(session_id)? else {
            return Ok(());
        };
        let Some(study) = self.research_for_session(session_id)? else {
            return Ok(());
        };
        if study.plan().map_or(true, |p| p.version != version) {
            return Ok(());
        }
        if let Some(tid) = turn_id {
            let unstarted: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_turns WHERE id=?1 AND session_id=?2 AND state='preparing' AND attempt_count=0)",
                params![tid, session_id],
                |r| r.get(0),
            )?;
            if unstarted {
                return self.research_update(&study.id, |s| {
                    let task = s.task_mut(&task_id)?;
                    if task.session_id.as_deref() == Some(session_id)
                        && task.pending_nudge.is_some()
                    {
                        task.pending_nudge_turn_id = Some(tid.to_string());
                    }
                    Ok(())
                });
            }
        }
        self.research_update(&study.id, |s| {
            let task = s.task_mut(&task_id)?;
            if task.session_id.as_deref() == Some(session_id) {
                task.pending_nudge = None;
                task.pending_nudge_turn_id = None;
                self.reopen_chat_spawn(session_id, turn_id)?;
            }
            Ok(())
        })
    }
    pub fn reopen_chat_spawn(&self, session_id: &str, turn_id: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_spawns SET finished_at=NULL
             WHERE session_id=?1
               AND (?2 IS NULL OR NOT EXISTS(
                   SELECT 1 FROM chat_turns
                   WHERE id=?2 AND session_id=?1
                     AND (state IN ('completed', 'failed', 'interrupted')
                          OR (state = 'preparing' AND attempt_count = 0))
               ))",
            params![session_id, turn_id],
        )?;
        Ok(())
    }
    pub fn research_retry_task(&self, id: &str, task_id: &str) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            let version = study.plan()?.version;
            let task = study.task(task_id)?;
            if task.state == "completed" {
                return Err(anyhow!(
                    "任务已通过验收，无需重试；如需重做请在计划中设置 forceRerun"
                ));
            }
            if task.state == "pending" && task.session_id.is_none() {
                return Ok(());
            }
            if task.state == "running" {
                let finished = if let Some(sid) = task.session_id.as_deref() {
                    !self.chat_turn_leased(sid)?
                        && self
                            .conn
                            .query_row(
                                "SELECT EXISTS(SELECT 1 FROM chat_spawns WHERE session_id=?1 AND (state='done' OR finished_at IS NOT NULL))",
                                [sid],
                                |r| r.get::<_, bool>(0),
                            )?
                } else {
                    false
                };
                if !finished {
                    return Err(anyhow!("专家会话仍在执行中，请等待其结束后再重试"));
                }
            }
            let runs = task.run_ids.iter().map(|run_id| {
                self.get_run(run_id)?.ok_or_else(|| anyhow!("研究 {id} 的 Run 记录缺失: {run_id}"))
            }).collect::<Result<Vec<_>>>()?;
            if runs.iter().any(|run| !crate::local::is_terminal(&run.status)) {
                return Err(anyhow!("仍有运行中的实验，请先等待或取消"));
            }
            let has_succeeded_run = task.spec.role == "as-experiment-operator"
                && !runs.is_empty() && runs.iter().all(|run| run.status == "done");
            if !has_succeeded_run {
                if let Ok(old_s) = task.run_gate_scope() {
                    let old_hash = digest(old_s.as_bytes());
                    for d in &mut study.decisions {
                        if d.version == version
                            && matches!(d.gate.as_str(), "G2" | "G3")
                            && d.scope_hash == old_hash
                            && d.status != "superseded"
                        {
                            d.status = "superseded".into();
                        }
                    }
                }
            }
            let task = study.task_mut(task_id)?;
            if let Some(old_session) = task.session_id.take() {
                task.previous_sessions.push(old_session);
            }
            if !has_succeeded_run {
                if !task.run_ids.is_empty() {
                    task.previous_run_ids.append(&mut task.run_ids);
                }
                if task.spec.role == "as-experiment-operator" {
                    task.run_contract = None;
                }
            }
            task.attempts += 1;
            task.pending_nudge = None;
            task.pending_nudge_turn_id = None;
            task.state = "pending".into();
            task.summary = None;
            Ok(())
        })
    }
    pub fn research_session_has_active_runs(&self, session: &str) -> Result<bool> {
        let Some((study_id, task_id, version)) = self
            .conn
            .query_row(
                "SELECT study_id,task_id,version FROM research_sessions WHERE session_id=?1",
                [session],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u32>(2)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(false);
        };
        let study = self.research_study(&study_id)?;
        if study.status != "active" {
            return Ok(false);
        }
        if study.plan()?.version != version {
            return Ok(false);
        }
        let task = study.task(&task_id)?;
        if task.session_id.as_deref() != Some(session) {
            return Ok(false);
        }
        for run_id in &task.run_ids {
            let run = self
                .get_run(run_id)?
                .ok_or_else(|| anyhow!("研究 {study_id} 的 Run 记录缺失: {run_id}"))?;
            if !crate::local::is_terminal(&run.status) {
                return Ok(true);
            }
            if run.status != "cancelled"
                && self.get_chat_session(session)?.is_some()
                && self.conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM chat_run_wakeups WHERE run_id=?1 AND chat_session_id=?2 AND state!='delivered')",
                        params![run_id, session],
                        |r| r.get::<_, bool>(0),
                )?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// End scheduling without cancelling experiments or removing research history.
    /// The writer serializes this check with task binding and durable turn admission.
    pub fn research_end(&self, id: &str, version: u32, busy_sessions: &[String]) -> Result<()> {
        self.research_update(id, |study| {
            if study.plans.last().map_or(0, |plan| plan.version) != version {
                return Err(anyhow!("研究计划已变化，请刷新后再结束"));
            }
            if study.status == "stopped" {
                return Ok(());
            }
            if study.status != "paused" {
                study.ensure_active()?;
            }
            if study.plan().is_ok_and(|plan| plan.tasks.iter().any(|task| task.state == "running")) {
                return Err(anyhow!("仍有执行中或待验收的专家任务，请先完成或停止任务"));
            }
            if self.research_runs(study)?.iter().any(|run| !crate::local::is_terminal(&run.status)) {
                return Err(anyhow!("仍有未结束的实验，请先等待或取消实验"));
            }
            let mut statement = self.conn.prepare(&format!("{RESEARCH_MEMBERS_CTE} SELECT id FROM members"))?;
            let sessions = statement.query_map(params![study.id, study.session_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for session in sessions {
                let pending: bool = self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_turn_leases WHERE chat_session_id=?1 AND heartbeat_at>=?2)
                     OR EXISTS(SELECT 1 FROM chat_queued_messages WHERE session_id=?1)
                     OR EXISTS(SELECT 1 FROM chat_spawns WHERE session_id=?1 AND state!='done')
                     OR EXISTS(SELECT 1 FROM chat_steering_requests WHERE session_id=?1 AND state='registered')",
                    params![session, now_ms() - super::CHAT_TURN_LEASE_TTL_MS],
                    |row| row.get(0),
                )?;
                if pending || busy_sessions.contains(&session) {
                    return Err(anyhow!("研究会话仍在处理或等待发送，请先停止回复或处理队列后再结束"));
                }
            }
            study.status = "stopped".into();
            Ok(())
        })
    }

    /// Pause an active study: block auto-dispatch and soft-return running expert
    /// tasks to pending without consuming attempts; running experiments keep
    /// running. Returns the bound expert sessions so the caller can interrupt
    /// them after the state flip — their settlement then retires silently.
    pub fn research_pause(&self, id: &str, version: u32) -> Result<Vec<String>> {
        let mut sessions = Vec::new();
        self.research_update(id, |study| {
            if study.plans.last().map_or(0, |plan| plan.version) != version {
                return Err(anyhow!("研究计划已变化，请刷新后再操作"));
            }
            if study.status == "paused" {
                return Ok(());
            }
            study.ensure_active()?;
            let plan = study.plan_mut()?;
            for task in plan.tasks.iter_mut() {
                if task.state == "running" {
                    if let Some(session) = task.session_id.take() {
                        sessions.push(session);
                    }
                    task.state = "pending".into();
                    task.pending_nudge = None;
                    task.pending_nudge_turn_id = None;
                }
            }
            study.status = "paused".into();
            Ok(())
        })?;
        Ok(sessions)
    }

    /// Resume a paused study; dispatching is left to the caller or the
    /// background reconcile, which picks the study back up once it is active.
    pub fn research_resume(&self, id: &str, version: u32) -> Result<()> {
        self.research_update(id, |study| {
            if study.plans.last().map_or(0, |plan| plan.version) != version {
                return Err(anyhow!("研究计划已变化，请刷新后再操作"));
            }
            if study.status == "active" {
                return Ok(());
            }
            if study.status != "paused" {
                return Err(anyhow!("研究已停止，无法继续"));
            }
            study.status = "active".into();
            Ok(())
        })
    }

    pub fn research_active_studies(&self) -> Result<Vec<Study>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT document FROM research_studies WHERE {ACTIVE_STUDY_FILTER}"
        ))?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut studies = Vec::new();
        for row in rows {
            if let Ok(study) = serde_json::from_str::<Study>(&row?) {
                if study.status == "active" {
                    studies.push(study);
                }
            }
        }
        Ok(studies)
    }
    /// 项目内已通过交付确认的研究，按更新时间倒序，供项目研究成果页列举。
    pub fn research_delivered_studies(&self, project_id: &str) -> Result<Vec<Study>> {
        let mut stmt = self
            .conn
            .prepare("SELECT document FROM research_studies WHERE project_id=?1")?;
        let rows = stmt.query_map([project_id], |r| r.get::<_, String>(0))?;
        let mut studies = Vec::new();
        for row in rows {
            if let Ok(study) = serde_json::from_str::<Study>(&row?) {
                if study.delivery_approved() {
                    studies.push(study);
                }
            }
        }
        // updated_at 只存在于文档 JSON 内，不是表列，须在反序列化后排序。
        studies.sort_by_key(|study| std::cmp::Reverse(study.updated_at));
        Ok(studies)
    }
    pub fn research_requires_gate(&self, experiment: &str, session: Option<&str>) -> Result<bool> {
        let bound: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM research_experiments WHERE experiment_id=?1)",
            [experiment],
            |r| r.get(0),
        )?;
        if bound
            || session
                .map(|s| self.research_for_session(s))
                .transpose()?
                .flatten()
                .is_some()
        {
            return Ok(true);
        }
        let creator = self
            .get_local_experiment(experiment)?
            .and_then(|e| e.chat_session_id);
        Ok(creator
            .map(|s| self.research_for_session(&s))
            .transpose()?
            .flatten()
            .is_some())
    }
    pub fn research_check_run(
        &self,
        experiment: &str,
        session: Option<&str>,
        contract: &RunContract,
        reserve: Option<&str>,
    ) -> Result<()> {
        let binding: Option<(String, String, u32)> = self
            .conn
            .query_row(
                "SELECT study_id,task_id,version FROM research_experiments WHERE experiment_id=?1",
                [experiment],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let session_study = session
            .map(|s| self.research_for_session(s))
            .transpose()?
            .flatten();
        let Some((id, task_id, version)) = binding else {
            let exp = self.get_local_experiment(experiment)?;
            let created_in_study = exp
                .and_then(|e| e.chat_session_id)
                .map(|s| self.research_for_session(&s))
                .transpose()?
                .flatten()
                .is_some();
            if session_study.is_some() || created_in_study {
                return Err(anyhow!("专家团实验必须先 prepare-run 并通过 G2/G3"));
            }
            return Ok(());
        };
        let mut study = self.research_study(&id)?;
        study.ready(&task_id)?;
        if study.plan()?.version != version {
            return Err(anyhow!("运行批准已过期"));
        }
        if session_study.as_ref().is_some_and(|s| s.id != id) {
            return Err(anyhow!("运行不属于当前研究"));
        }
        let task = study.task_mut(&task_id)?;
        if task.run_contract.as_ref() != Some(contract) {
            return Err(anyhow!("代码、命令或资源已变化，请修订计划并重新批准"));
        }
        if task.state != "running" || task.session_id.as_deref() != session {
            return Err(anyhow!("请由获批任务的执行专家启动运行"));
        }
        if !task.run_ids.is_empty() {
            return Err(anyhow!(
                "该任务已提交运行，请检查已记录 Run；重试需要新计划"
            ));
        }
        if let Some(run_id) = reserve {
            task.run_ids.push(run_id.into());
            if let Some(sid) = session {
                if self
                    .get_run(run_id)?
                    .is_none_or(|r| !crate::local::is_terminal(&r.status))
                {
                    let _ = self.register_run_wakeup(run_id, sid);
                }
            }
            self.research_save(&study)?;
        }
        Ok(())
    }
    pub fn research_finish(
        &self,
        id: &str,
        task_id: &str,
        success: bool,
        summary: String,
    ) -> Result<()> {
        self.research_finish_checked(id, task_id, success, summary, false)
    }

    pub(crate) fn research_auto_finish(
        &self,
        id: &str,
        task_id: &str,
        summary: String,
    ) -> Result<()> {
        self.research_finish_checked(id, task_id, true, summary, true)
    }

    fn research_finish_checked(
        &self,
        id: &str,
        task_id: &str,
        success: bool,
        summary: String,
        automatic: bool,
    ) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            let root = self.research_root(study)?;
            let task = study.task_mut(task_id)?;
            if task.state != "running" || task.session_id.is_none() {
                return Err(anyhow!("仅能验收已经派发的任务"));
            }
            if summary.trim().is_empty() {
                return Err(anyhow!("需要验收摘要或失败原因"));
            }
            let runs = task
                .run_ids
                .iter()
                .map(|id| self.get_run(id)?.ok_or_else(|| anyhow!("Run 不存在")))
                .collect::<Result<Vec<_>>>()?;
            if runs.iter().any(|r| !crate::local::is_terminal(&r.status)) {
                return Err(anyhow!("仍有运行中的实验，请先等待或取消"));
            }
            // 逐项任务的一次 finish 只验收当前迭代的产物；普通任务验收全部声明产物。
            let foreach_step = foreach_current_step(task)?;
            if success {
                if task.spec.role == "as-experiment-operator" && runs.is_empty() {
                    return Err(anyhow!("实验任务尚无真实 Run"));
                }
                let accepted: Vec<Artifact> = match &foreach_step {
                    Some((item, item_path)) => {
                        let artifact = inspect_artifact(&root, item_path)?;
                        if artifact.bytes == 0 {
                            return Err(anyhow!("产物为空: {item_path}"));
                        }
                        if automatic && task.output_baseline.as_ref().is_none_or(|baseline| {
                            baseline.iter().any(|old| old.path == *item_path && old.sha256 == artifact.sha256)
                        }) {
                            return Err(anyhow!("产物尚未登记为本轮结果: {item_path}；请核查后执行 orx research finish 显式登记"));
                        }
                        vec![artifact]
                    }
                    None => task
                        .spec
                        .outputs
                        .iter()
                        .map(|path| {
                            let artifact = inspect_artifact(&root, path)?;
                            if artifact.bytes == 0 {
                                return Err(anyhow!("产物为空: {path}"));
                            }
                            let sha256 = &artifact.sha256;
                            if automatic && task.output_baseline.as_ref().is_none_or(|baseline| {
                                baseline.iter().any(|old| old.path == *path && old.sha256 == *sha256)
                            }) {
                                return Err(anyhow!("产物尚未登记为本轮结果: {path}；请核查后执行 orx research finish 显式登记"));
                            }
                            Ok(artifact)
                        })
                        .collect::<Result<Vec<_>>>()?,
                };
                if let Some((item, _)) = &foreach_step {
                    let session = task.session_id.clone().unwrap_or_default();
                    task.foreach_runs.push(ForeachRun {
                        item_id: item.id.clone(),
                        item_title: item.title.clone(),
                        session_id: session,
                        artifact: accepted.first().cloned(),
                        ok: true,
                        summary: Some(summary.clone()),
                    });
                } else {
                    task.artifacts = accepted;
                }
            }
            task.pending_nudge = None;
            task.pending_nudge_turn_id = None;
            task.rework_feedback = None;
            if let Some(for_each) = task.spec.for_each.as_ref() {
                // 逐项任务按迭代推进：失败按策略暂停或跳过，全部项到达终态后收束。
                if !success {
                    let (item, item_path) = foreach_step.clone().ok_or_else(|| anyhow!("逐项任务缺少当前迭代"))?;
                    let session = task.session_id.clone().unwrap_or_default();
                    task.foreach_runs.push(ForeachRun {
                        item_id: item.id.clone(),
                        item_title: item.title.clone(),
                        session_id: session,
                        artifact: None,
                        ok: false,
                        summary: Some(summary.clone()),
                    });
                    if for_each.on_failure != "skip" {
                        task.state = "failed".into();
                        task.summary = Some(format!(
                            "第 {} 项「{}」执行失败：{}。逐项任务已暂停，可 `orx research retry {}` 重跑该项。",
                            task.foreach_runs.len(),
                            item.title,
                            summary,
                            task.spec.id
                        ));
                        study.resolve_routes()?;
                        return Ok(());
                    }
                }
                let total = task.foreach_items.as_ref().map(|items| items.len()).unwrap_or(0);
                let done = task.foreach_runs.len();
                if done < total {
                    // 还有剩余项：回到待派发，由后台推进下一项。
                    task.session_id = None;
                    task.output_baseline = None;
                    task.state = "pending".into();
                    task.summary = Some(format!("逐项处理进行中（{done}/{total}）。"));
                    study.resolve_routes()?;
                    return Ok(());
                }
                let succeeded = task.foreach_runs.iter().filter(|run| run.ok).count();
                task.artifacts = task
                    .foreach_runs
                    .iter()
                    .filter_map(|run| run.artifact.clone())
                    .collect();
                task.state = "completed".into();
                task.summary = Some(format!("逐项处理完成（成功 {succeeded}/{total}）。"));
                study.resolve_routes()?;
                return Ok(());
            }
            task.state = if success { "completed" } else { "failed" }.into();
            task.summary = Some(summary);
            task.verdict = None;
            if success && task.spec.gate_downstream && !task.spec.outputs.is_empty() {
                let sidecar = verdict_path_for(&task.spec.outputs[0]);
                let (canonical, mut source) = files::open_artifact(&root, &sidecar)?;
                let sha256 = source.hash()?;
                let bytes = std::fs::read(&canonical)?;
                task.verdict = Some(parse_verdict(&sidecar, sha256, &bytes)?);
            }
            if !success {
                // 失败也是失败分流谓词的触发条件：验收落定后立即求值分流节点。
                study.resolve_routes()?;
                return Ok(());
            }
            // 先汇总本轮验收结果，结束任务的可变借用后再执行编排动作。
            let verdict = task.verdict.clone();
            let (requires_approval, count, max) =
                (task.spec.requires_approval, task.rework_count, task.spec.max_rework);
            if requires_approval {
                let scope = study.task_gate_scope(task_id)?;
                study.request_gate(&Study::task_gate_id(task_id), scope)?;
            }
            let blocked = verdict.as_ref().is_some_and(|v| v.status == "blocked");
            if !blocked {
                study.resolve_routes()?;
                return Ok(());
            }
            if max > 0 && count < max {
                let reasons = verdict.map(|v| v.reasons).unwrap_or_default();
                rework_upstream_tasks(study, task_id, &reasons)?;
                study.resolve_routes()?;
                return Ok(());
            }
            let note = if max > 0 {
                format!("返工上限（{max} 轮）已用完，结论仍为阻塞：需主理人修订计划（对相关任务设置 forceRerun）后重新审阅。")
            } else {
                "结论为阻塞：下游任务已暂停，需主理人修订计划（对相关任务设置 forceRerun）后重新审阅。".to_string()
            };
            let task = study.task_mut(task_id)?;
            if let Some(text) = task.summary.as_mut() {
                if !text.contains(&note) {
                    text.push('\n');
                    text.push_str(&note);
                }
            }
            study.resolve_routes()?;
            Ok(())
        })
    }
    #[cfg(test)]
    pub fn research_package_scope(&self, study: &Study) -> Result<String> {
        let plan = study.plan()?;
        if plan
            .tasks
            .iter()
            .any(|t| !matches!(t.state.as_str(), "completed" | "skipped"))
        {
            return Err(anyhow!("全部计划任务必须通过验收后才能申请交付确认"));
        }
        let evidence = self.research_evidence(study)?;
        let evidence_digest = evidence.digest()?;
        for claim in &evidence.claims {
            self.research_validate_material_claim(study, claim)?;
        }
        if !evidence.changes.is_empty() || study.metric_citation_revision.is_some() {
            claims::require_review_roles(plan.tasks.iter().map(|task| task.spec.role.as_str()))?;
        }
        for task in &plan.tasks {
            if matches!(
                task.spec.role.as_str(),
                "as-independent-reviewer" | "as-quality-citation-auditor"
            ) && task.evidence_digest.as_deref() != Some(&evidence_digest)
            {
                return Err(anyhow!("审查后证据已变化，请修订计划并重新审查"));
            }
        }
        let root = self.research_root(study)?;
        for artifact in plan.tasks.iter().flat_map(|t| &t.artifacts) {
            if inspect_artifact(&root, &artifact.path)?.sha256 != artifact.sha256 {
                return Err(anyhow!("产物变化，需要重新审查: {}", artifact.path));
            }
        }
        // Delivery cites the current task attempts and every explicit claim
        // reference. Past plans/attempts remain in research_runs for lifecycle
        // protection and accounting; their uncited logs are not deliverables.
        let delivery_ids: HashSet<&str> = plan
            .tasks
            .iter()
            .flat_map(|task| task.run_ids.iter().map(String::as_str))
            .chain(
                evidence
                    .claims
                    .iter()
                    .filter_map(|claim| claim.input.run_id.as_deref()),
            )
            .collect();
        let runs = self.research_runs(study)?;
        if runs
            .iter()
            .any(|run| !crate::local::is_terminal(&run.status))
        {
            return Err(anyhow!("仍有未结束的运行"));
        }
        let mut provenance = Vec::new();
        for run in runs
            .into_iter()
            .filter(|run| delivery_ids.contains(run.id.as_str()))
        {
            let mut log = files::FileSource::open(&self.research_log_path(&run.id)?, "实验日志")?;
            let log_hash = log.hash()?;
            for claim in &evidence.claims {
                if claim.input.support == "experiment"
                    && claim.input.run_id.as_deref() == Some(&run.id)
                    && claim.log_sha256.as_ref() != Some(&log_hash)
                {
                    return Err(anyhow!("证据日志已变化，需要重新审查"));
                }
            }
            let backend = crate::jobs::BackendDescriptor::parse(&run.backend_json)?;
            provenance.push(serde_json::json!({"id":run.id,"commit":run.commit_sha,"status":run.status,"logHash":log_hash,"sourceHash":backend.source_digest}));
        }
        provenance.sort_by_key(|r| r["id"].as_str().unwrap_or_default().to_string());
        let mut scope = serde_json::json!({"plan":plan,"claims":evidence.claims,"runs":provenance});
        if !evidence.changes.is_empty() {
            scope["claimChanges"] = serde_json::to_value(&evidence.changes)?;
        }
        Ok(serde_json::to_string(&scope)?)
    }
    pub fn research_decide(
        &self,
        id: &str,
        decision: &str,
        hash: &str,
        approved: bool,
        reason: String,
    ) -> Result<()> {
        let initial = self.research_study(id)?;
        let is_delivery = initial
            .decisions
            .iter()
            .find(|d| d.id == decision)
            .is_some_and(|d| {
                d.gate == crate::local::research::delivery_gate(initial.workflow_mode())
            });
        let prepared = if approved && is_delivery {
            Some(self.research_prepare_delivery(&initial)?)
        } else {
            None
        };
        self.research_commit_decision(id, decision, hash, approved, reason, prepared)
    }

    pub(super) fn research_commit_decision(
        &self,
        id: &str,
        decision: &str,
        hash: &str,
        approved: bool,
        reason: String,
        prepared: Option<PreparedDelivery>,
    ) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            let version = study.plan()?.version;
            let gate = study
                .decisions
                .iter()
                .find(|d| d.id == decision)
                .ok_or_else(|| anyhow!("闸门不存在"))?
                .gate
                .clone();
            if approved && gate == crate::local::research::delivery_gate(study.workflow_mode()) {
                study.require_gate("G1", &study.plan_scope()?)?;
                let prepared = prepared
                    .as_ref()
                    .ok_or_else(|| anyhow!("交付流程已变化，请刷新后确认"))?;
                self.research_apply_delivery(study, prepared)?;
                if digest(prepared.scope.as_bytes()) != hash {
                    return Err(anyhow!("交付内容已变化，请重新申请确认"));
                }
            }
            let d = study
                .decisions
                .iter_mut()
                .find(|d| d.id == decision)
                .ok_or_else(|| anyhow!("闸门不存在"))?;
            if d.version != version || d.scope_hash != hash {
                return Err(anyhow!("批准针对旧版本，请刷新后确认"));
            }
            let target = if approved { "approved" } else { "rejected" };
            if d.status == target {
                return Ok(());
            }
            if d.status != "pending" {
                return Err(anyhow!("决策已经完成"));
            }
            d.status = target.into();
            d.approver = Some("dashboard-user".into());
            d.reason = Some(reason);
            d.decided_at = Some(now_ms());
            Ok(())
        })
    }
    pub fn research_runs(&self, study: &Study) -> Result<Vec<StoredRun>> {
        let ids: HashSet<_> = study
            .plans
            .iter()
            .flat_map(|p| &p.tasks)
            .flat_map(|t| t.run_ids.iter().chain(t.previous_run_ids.iter()))
            .chain(study.claims.iter().filter_map(|c| c.input.run_id.as_ref()))
            .collect();
        ids.into_iter()
            .map(|id| {
                self.get_run(id)?
                    .ok_or_else(|| anyhow!("研究 Run 记录缺失: {id}"))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::model::{LocalExperiment, LocalProject};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("orx-research-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn setup() -> (TestDir, Store, Study) {
        let dir = TestDir::new();
        let store = Store::open_at(dir.path().to_path_buf()).unwrap();
        store
            .create_local_project(&LocalProject {
                id: "project".into(),
                name: "test".into(),
                slug: "test".into(),
                github_owner: "".into(),
                github_repo: "".into(),
                github_sync_enabled: false,
                baseline_branch: "main".into(),
                repo_path: dir.path().to_string_lossy().into(),
                run_command: Some("python3 main.py".into()),
                paper_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('lead','project','codex',1,1)",[]).unwrap();
        let study = store.research_create("lead", "team", "test study").unwrap();
        (dir, store, study)
    }
    fn spec(id: &str, role: &str, deps: &[&str]) -> TaskSpec {
        TaskSpec {
            id: id.into(),
            role: role.into(),
            brief: format!("produce {id}"),
            depends_on: deps.iter().map(|d| (*d).into()).collect(),
            outputs: vec![format!("{id}.md")],
            force_rerun: false,
            inputs: vec![],
            requires_approval: false,
            gate_downstream: false,
            max_rework: 0,
            kind: String::new(),
            route: None,
            route_branch: String::new(),
            wait_for: String::new(),
        }
    }
    fn plan() -> PlanInput {
        PlanInput {
            workflow: None,
            summary: "baseline comparison, CPU only, one run".into(),
            tasks: vec![
                spec("design", "as-experiment-designer", &[]),
                spec("review", "as-independent-reviewer", &["design"]),
                spec("audit", "as-quality-citation-auditor", &["review"]),
            ],
        }
    }
    fn saved_literature_workflow(store: &Store) -> crate::workflow::WorkflowDraft {
        let profile = &crate::local::research::workflows()["literature"];
        let tasks = profile
            .required_roles
            .iter()
            .map(|role| {
                let deps: Vec<_> = profile
                    .dependencies
                    .iter()
                    .filter(|edge| &edge[1] == role)
                    .map(|edge| edge[0].as_str())
                    .collect();
                spec(role, role, &deps)
            })
            .collect();
        store
            .create_workflow_draft(
                "",
                crate::workflow::WorkflowDraftInput {
                    name: "Saved evidence review".into(),
                    objective: String::new(),
                    summary: String::new(),
                    workflow: "literature".into(),
                    tasks,
                    positions: std::collections::HashMap::new(),
                    viewport: None,
                    frames: Vec::new(),
                },
            )
            .unwrap()
    }

    #[test]
    fn workflow_attaches_to_normal_chat_with_history_and_keeps_versioned_approval() {
        let (dir, store, _) = setup();
        store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('normal','project','codex',1,1)", []).unwrap();
        store.conn.execute("INSERT INTO chat_messages(id,session_id,role,parts_json,created_at) VALUES('existing-message','normal','user','[]',1)", []).unwrap();
        let draft = saved_literature_workflow(&store);
        let (id, version, duplicate) = store
            .research_use_workflow("normal", &draft.id, "Compare evidence")
            .unwrap();
        assert_eq!(version, 1);
        assert!(!duplicate);
        let study = store.research_study(&id).unwrap();
        assert_eq!(study.session_id, "normal");
        assert_eq!(store.list_chat_messages("normal").unwrap().len(), 1);
        assert_eq!(
            study.plan().unwrap().workflow_source.as_ref().unwrap().id,
            draft.id
        );
        let task_id = &study.plan().unwrap().tasks[0].spec.id;
        assert!(study.ready(task_id).is_err());
        assert_eq!(store.count_live_chat_spawns("normal").unwrap(), 0);
        assert_eq!(
            store
                .research_use_workflow("normal", &draft.id, "Compare evidence")
                .unwrap(),
            (id.clone(), 1, true)
        );
        approve(&store, &study, "G1");
        assert!(store.research_study(&id).unwrap().ready(task_id).is_ok());
        let old = store.research_study(&id).unwrap().decisions[0].clone();
        assert_eq!(
            store
                .research_use_workflow("normal", &draft.id, "A different goal")
                .unwrap()
                .1,
            2
        );
        let changed = store.research_study(&id).unwrap();
        assert_eq!(changed.objective, "A different goal");
        assert!(changed.ready(task_id).is_err());
        assert!(store
            .research_decide(&id, &old.id, &old.scope_hash, true, String::new())
            .is_err());
        store.delete_workflow_draft(&draft.id).unwrap();
        drop(store);
        let reopened = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert_eq!(
            reopened
                .research_study(&id)
                .unwrap()
                .plan()
                .unwrap()
                .workflow_source
                .as_ref()
                .unwrap()
                .name,
            "Saved evidence review"
        );
    }

    #[test]
    fn custom_workflow_drafts_register_without_preset_roles() {
        let (_dir, store, _) = setup();
        store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('normal','project','codex',1,1)", []).unwrap();
        // 只有两位专家的小 DAG：custom 流程不要求 W1 必需专家队伍。
        let input = crate::workflow::WorkflowDraftInput {
            name: "Custom pipeline".into(),
            objective: String::new(),
            summary: String::new(),
            workflow: "custom".into(),
            frames: Vec::new(),
            tasks: vec![
                spec("strategy", "as-literature-strategist", &[]),
                spec("evidence", "as-paper-evidence-analyst", &["strategy"]),
            ],
            positions: HashMap::new(),
            viewport: None,
        };
        let draft = store.create_workflow_draft("", input).unwrap();
        let (study_id, version, deduplicated) = store
            .research_use_workflow("normal", &draft.id, "只查文献证据")
            .unwrap();
        assert_eq!(version, 1);
        assert!(!deduplicated);
        let study = store.research_study(&study_id).unwrap();
        // custom 提交为 workflow:null 的专家团动态计划，不套用模板契约。
        assert!(study.plan().unwrap().workflow.is_none());
        assert_eq!(study.plan().unwrap().tasks.len(), 2);
    }

    #[test]
    fn invalid_workflows_and_child_chats_cannot_create_studies_or_bypass_gates() {
        let (_dir, store, _) = setup();
        store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('normal','project','codex',1,1)", []).unwrap();
        let draft = saved_literature_workflow(&store);
        let mut invalid = draft.input.clone();
        assert!(crate::local::research::turn_context(&store, "normal")
            .unwrap()
            .unwrap()
            .contains("orx research workflow list"));
        assert!(store.research_for_session("normal").unwrap().is_none());
        invalid.tasks.clear();
        let invalid = store.create_workflow_draft("", invalid).unwrap();
        assert!(store
            .research_use_workflow("normal", &invalid.id, "Goal")
            .is_err());
        assert!(store.research_for_session("normal").unwrap().is_none());
        assert!(store
            .research_use_workflow("normal", &draft.id, " ")
            .is_err());
        assert!(store
            .research_use_workflow("normal", "missing", "Goal")
            .is_err());
        store
            .conn
            .execute(
                "UPDATE chat_sessions SET parent_session_id='lead' WHERE id='normal'",
                [],
            )
            .unwrap();
        assert!(store
            .research_use_workflow("normal", &draft.id, "Goal")
            .is_err());
        let direct: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM research_studies WHERE session_id='normal'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(direct, 0);
    }

    #[test]
    fn workflow_goal_changes_do_not_inherit_outputs_for_the_previous_question() {
        let (_dir, store, _) = setup();
        let draft = saved_literature_workflow(&store);
        let (id, _, _) = store
            .research_use_workflow("lead", &draft.id, "First goal")
            .unwrap();
        let study = store.research_study(&id).unwrap();
        approve(&store, &study, "G1");
        let task = &study.plan().unwrap().tasks[0].spec.id;
        bind(&store, &study, task, "expert-attempt");
        finish(&store, &study, task);
        assert_eq!(
            store.research_study(&id).unwrap().task(task).unwrap().state,
            "completed"
        );
        store
            .research_use_workflow("lead", &draft.id, "Second goal")
            .unwrap();
        let changed = store.research_study(&id).unwrap();
        assert_eq!(changed.task(task).unwrap().state, "pending");
        assert!(changed.task(task).unwrap().artifacts.is_empty());
    }
    fn approve(store: &Store, study: &Study, gate: &str) {
        let study = store.research_study(&study.id).unwrap();
        let decision = study
            .decisions
            .iter()
            .rev()
            .find(|d| d.gate == gate)
            .unwrap();
        store
            .research_decide(
                &study.id,
                &decision.id,
                &decision.scope_hash,
                true,
                "test user approval".into(),
            )
            .unwrap();
    }
    fn bind(store: &Store, study: &Study, task: &str, session: &str) {
        let tx = store.begin_immediate().unwrap();
        store.research_bind_task(&study.id, task, session).unwrap();
        tx.commit().unwrap();
    }
    fn finish(store: &Store, study: &Study, task: &str) {
        let root = store.research_root(study).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(format!("{task}.md")),
            format!("# {task}\nreal output"),
        )
        .unwrap();
        store
            .research_finish(&study.id, task, true, "checked".into())
            .unwrap();
    }
    fn preset_plan(mode: &str) -> PlanInput {
        let profile = &crate::local::research::workflows()[mode];
        PlanInput {
            workflow: None,
            summary: format!("{}: actual scope and evidence", profile.title),
            tasks: profile
                .required_roles
                .iter()
                .enumerate()
                .map(|(index, role)| {
                    let dependencies: Vec<&str> = profile.required_roles[..index]
                        .iter()
                        .map(String::as_str)
                        .collect();
                    spec(role, role, &dependencies)
                })
                .collect(),
        }
    }
    #[test]
    fn automatic_team_routes_are_versioned_and_validate_the_selected_preset() {
        let (_dir, store, study) = setup();
        let context = crate::local::research::turn_context(&store, "lead")
            .unwrap()
            .unwrap();
        assert!(context.contains("自动判断模式") && context.contains("不要求用户选择工作流"));
        for code in ["W1", "W2", "W3", "W4"] {
            assert!(context.contains(code));
        }
        for mode in ["literature", "reproduction", "analysis", "proposal"] {
            let mut input = preset_plan(mode);
            input.workflow = Some(mode.into());
            assert!(validate_plan(&input, "team").is_ok());
            let mut missing = input.clone();
            missing.tasks.pop();
            assert!(validate_plan(&missing, "team").is_err());
            store.research_set_plan(&study.id, input).unwrap();
            let saved = store.research_study(&study.id).unwrap();
            assert_eq!(saved.mode, "team");
            assert_eq!(saved.workflow_mode(), mode);
            assert!(saved
                .plan_scope()
                .unwrap()
                .contains(&format!("\"workflow\":\"{mode}\"")));
            assert_eq!(
                crate::local::research::delivery_gate(saved.workflow_mode()),
                if mode == "proposal" { "G3" } else { "G4" }
            );
        }
        let mut input = preset_plan("proposal");
        input.workflow = Some("proposal".into());
        assert!(validate_plan(&input, "literature").is_err());
        input.workflow = Some("unknown".into());
        assert!(validate_plan(&input, "team").is_err());
        // Composite research is still supported; it need not fit a preset.
        store.research_set_plan(&study.id, plan()).unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.workflow_mode(), "team");
        assert_eq!(saved.plans.len(), 5);
    }
    #[test]
    fn older_plans_keep_their_approval_scope_without_a_routed_workflow() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert!(!saved.plan_scope().unwrap().contains("workflow"));
        let legacy_json = serde_json::to_value(saved.plan().unwrap()).unwrap();
        assert!(legacy_json.get("workflow").is_none());
        let decoded: ResearchPlan = serde_json::from_value(legacy_json).unwrap();
        assert!(decoded.workflow.is_none());
    }
    #[test]
    fn original_presets_enforce_roles_dependencies_and_execution_boundaries() {
        for mode in ["literature", "reproduction", "analysis", "proposal"] {
            let p = preset_plan(mode);
            assert!(validate_plan(&p, mode).is_ok(), "{mode}");
            let mut missing = p.clone();
            missing.tasks.pop();
            assert!(
                validate_plan(&missing, mode).is_err(),
                "{mode}: missing role"
            );
            let mut unordered = p.clone();
            unordered.tasks[1].depends_on.clear();
            assert!(
                validate_plan(&unordered, mode).is_err(),
                "{mode}: missing dependency"
            );
            if mode != "reproduction" {
                let mut execution = p.clone();
                execution
                    .tasks
                    .push(spec("run", "as-experiment-operator", &[]));
                assert!(
                    validate_plan(&execution, mode).is_err(),
                    "{mode}: no execution"
                );
            }
        }
        let mut parallel = preset_plan("literature");
        parallel.tasks.push(spec(
            "second-paper",
            "as-paper-evidence-analyst",
            &["as-literature-researcher"],
        ));
        assert!(validate_plan(&parallel, "literature").is_err());
        for task in &mut parallel.tasks {
            if matches!(
                task.role.as_str(),
                "as-research-synthesizer" | "as-independent-reviewer"
            ) {
                task.depends_on.push("second-paper".into());
            }
        }
        assert!(validate_plan(&parallel, "literature").is_ok());
        let mut literature = preset_plan("literature");
        literature
            .tasks
            .insert(0, spec("method", "as-methodology-designer", &[]));
        assert!(validate_plan(&literature, "literature").is_err());
    }
    #[test]
    fn proposal_delivery_uses_g3_and_rejects_changed_artifacts() {
        let (_dir, store, mut study) = setup();
        study.mode = "proposal".into();
        store.research_save(&study).unwrap();
        let p = preset_plan("proposal");
        let ids: Vec<_> = p.tasks.iter().map(|t| t.id.clone()).collect();
        store.research_set_plan(&study.id, p).unwrap();
        approve(&store, &study, "G1");
        for (index, id) in ids.iter().enumerate() {
            bind(&store, &study, id, &format!("expert-{index}"));
            finish(&store, &study, id);
        }
        let study = store.research_study(&study.id).unwrap();
        let scope = store.research_package_scope(&study).unwrap();
        store
            .research_update(&study.id, |s| s.request_gate("G3", scope.clone()))
            .unwrap();
        approve(&store, &study, "G3");
        let study = store.research_study(&study.id).unwrap();
        assert!(study.require_gate("G3", &scope).is_ok());
        assert!(!study.decisions.iter().any(|d| d.gate == "G4"));
        let context = crate::local::research::turn_context(&store, "lead")
            .unwrap()
            .unwrap();
        assert!(context.contains("W4") && context.contains("Experiment Plan"));
        std::fs::write(
            store
                .research_root(&study)
                .unwrap()
                .join(format!("{}.md", ids.last().unwrap())),
            "changed plan",
        )
        .unwrap();
        assert!(store.research_package_scope(&study).is_err());
        assert!(store
            .research_decide(
                &study.id,
                &study.decisions.last().unwrap().id,
                &digest(scope.as_bytes()),
                true,
                String::new()
            )
            .is_err());
    }
    #[test]
    fn presets_are_persisted_and_legacy_studies_remain_readable() {
        let (_dir, store, study) = setup();
        assert_eq!(store.research_study(&study.id).unwrap().mode, "team");
        for mode in ["literature", "reproduction", "analysis", "proposal"] {
            let id = format!("lead-{mode}");
            store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES(?1,'project','codex',1,1)", [&id]).unwrap();
            let created = store.research_create(&id, mode, "topic").unwrap();
            assert_eq!(store.research_for_session(&id).unwrap().unwrap().mode, mode);
            assert!(crate::local::research::turn_context(&store, &id)
                .unwrap()
                .unwrap()
                .contains(&crate::local::research::workflows()[mode].code));
            assert!(store.research_study(&created.id).unwrap().plans.is_empty());
        }
        for mode in ["design", "diagnosis", "review"] {
            assert!(store.research_create("lead", mode, "topic").is_err());
        }
    }
    #[test]
    fn plan_rejects_cycles_unknown_experts_and_early_review() {
        let mut p = plan();
        assert!(validate_plan(&p, "team").is_ok());
        p.tasks[0].depends_on = vec!["audit".into()];
        assert!(validate_plan(&p, "team").is_err());
        p = plan();
        p.tasks[0].role = "invented".into();
        assert!(validate_plan(&p, "team").is_err());
        p = plan();
        p.tasks[1].depends_on.clear();
        assert!(validate_plan(&p, "team").is_err());
        p = plan();
        p.tasks[0].outputs = vec!["../outside".into()];
        assert!(validate_plan(&p, "team").is_err());
    }
    #[test]
    fn decisions_survive_reopen_and_stale_plan_approval_is_rejected() {
        let (dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .ready("design")
            .is_err());
        approve(&store, &study, "G1");
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .ready("design")
            .is_ok());
        let old = store.research_study(&study.id).unwrap().decisions[0].clone();
        store.research_set_plan(&study.id, plan()).unwrap();
        assert!(store
            .research_decide(&study.id, &old.id, &old.scope_hash, true, String::new())
            .is_err());
        drop(store);
        let store = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert_eq!(store.research_study(&study.id).unwrap().plans.len(), 2);
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .ready("design")
            .is_err());
    }
    #[test]
    fn artifacts_dependencies_and_confirmation_are_verified() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");
        assert!(store
            .research_bind_task(&study.id, "review", "reviewer")
            .is_err());
        assert!(store
            .research_finish(&study.id, "design", true, "fake completion".into())
            .is_err());
        bind(&store, &study, "design", "designer");
        assert!(store
            .research_finish(&study.id, "design", true, "missing output".into())
            .is_err());
        finish(&store, &study, "design");
        bind(&store, &study, "review", "reviewer");
        finish(&store, &study, "review");
        bind(&store, &study, "audit", "auditor");
        finish(&store, &study, "audit");
        let study = store.research_study(&study.id).unwrap();
        let scope = store.research_package_scope(&study).unwrap();
        assert!(study.require_gate("G4", &scope).is_err());
        store
            .research_update(&study.id, |s| s.request_gate("G4", scope.clone()))
            .unwrap();
        approve(&store, &study, "G4");
        let study = store.research_study(&study.id).unwrap();
        assert!(study.require_gate("G4", &scope).is_ok());
        std::fs::write(
            store.research_root(&study).unwrap().join("design.md"),
            "changed after review",
        )
        .unwrap();
        assert!(store.research_package_scope(&study).is_err());
    }
    #[test]
    fn changing_evidence_after_review_requires_new_review() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");
        for (task, session) in [("design", "a"), ("review", "b"), ("audit", "c")] {
            bind(&store, &study, task, session);
            finish(&store, &study, task);
        }
        store
            .research_add_claim(
                &study.id,
                ClaimInput {
                    text: "uncertain claim".into(),
                    support: "inference".into(),
                    source: "hypothesis".into(),
                    location: None,
                    run_id: None,
                    line_start: None,
                    line_end: None,
                    material_read_id: None,
                    metric: None,
                },
            )
            .unwrap();
        assert!(store
            .research_package_scope(&store.research_study(&study.id).unwrap())
            .is_err());
    }
    #[test]
    fn run_gates_bind_revision_resources_identity_and_single_submission() {
        let (_dir, store, study) = setup();
        let mut p = plan();
        p.tasks
            .insert(1, spec("execute", "as-experiment-operator", &["design"]));
        p.tasks[2].depends_on.push("execute".into());
        store.research_set_plan(&study.id, p).unwrap();
        approve(&store, &study, "G1");
        bind(&store, &study, "design", "designer");
        finish(&store, &study, "design");
        store
            .create_local_experiment(&LocalExperiment {
                id: "exp".into(),
                project_id: "project".into(),
                parent_experiment_id: None,
                slug: "exp".into(),
                branch_name: "main".into(),
                title: None,
                description: None,
                run_command: "python3 main.py".into(),
                agent_status: "idle".into(),
                created_at: 1,
                updated_at: 1,
                chat_session_id: Some("lead".into()),
                archived: false,
            })
            .unwrap();
        let contract = RunContract {
            experiment_id: "exp".into(),
            revision: "abc".into(),
            command: "python3 main.py".into(),
            options: serde_json::json!({"backend":"local"}),
        };
        assert!(store
            .research_check_run("exp", Some("lead"), &contract, None)
            .is_err());
        store
            .research_prepare(&study.id, "execute", contract.clone())
            .unwrap();
        assert!(store
            .research_bind_task(&study.id, "execute", "operator")
            .is_err());
        approve(&store, &study, "G2");
        assert!(store
            .research_bind_task(&study.id, "execute", "operator")
            .is_err());
        approve(&store, &study, "G3");
        bind(&store, &study, "execute", "operator");
        assert!(store
            .research_check_run("exp", None, &contract, None)
            .is_err());
        let mut changed = contract.clone();
        changed.revision = "def".into();
        assert!(store
            .research_check_run("exp", Some("operator"), &changed, None)
            .is_err());
        changed = contract.clone();
        changed.options = serde_json::json!({"backend":"ssh"});
        assert!(store
            .research_check_run("exp", Some("operator"), &changed, None)
            .is_err());
        assert!(store
            .research_check_run("exp", Some("operator"), &contract, None)
            .is_ok());
        for (key, value) in [
            ("cpus", serde_json::json!(8)),
            ("mem", serde_json::json!("32G")),
        ] {
            let mut changed = contract.clone();
            changed.options[key] = value;
            assert!(store
                .research_check_run("exp", Some("operator"), &changed, None)
                .is_err());
        }
        {
            let _tx = store.begin_immediate().unwrap();
            store
                .research_check_run("exp", Some("operator"), &contract, Some("rolled-back"))
                .unwrap();
        }
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .task("execute")
            .unwrap()
            .run_ids
            .is_empty());
        {
            let tx = store.begin_immediate().unwrap();
            store
                .research_check_run("exp", Some("operator"), &contract, Some("real-run"))
                .unwrap();
            tx.commit().unwrap();
        }
        assert!(store
            .research_check_run("exp", Some("operator"), &contract, None)
            .is_err());
    }
    #[test]
    fn stop_prevents_new_work_and_claims_require_real_runs() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");
        assert!(store
            .research_add_claim(
                &study.id,
                ClaimInput {
                    text: "invented metric".into(),
                    support: "experiment".into(),
                    source: "made up".into(),
                    location: None,
                    run_id: Some("missing".into()),
                    line_start: Some(1),
                    line_end: Some(1),
                    material_read_id: None,
                    metric: None,
                }
            )
            .is_err());
        store
            .research_update(&study.id, |s| {
                s.status = "stopped".into();
                Ok(())
            })
            .unwrap();
        assert!(store
            .research_bind_task(&study.id, "design", "helper")
            .is_err());
    }
    #[test]
    fn artifact_paths_reject_absolute_traversal_and_symlink_escape() {
        assert!(!safe_relative("/tmp/out"));
        assert!(!safe_relative("../out"));
        assert!(!safe_relative("C:\\out"));
        let dir = TestDir::new();
        let external = TestDir::new();
        std::fs::write(external.path().join("outside"), "secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(external.path().join("outside"), dir.path().join("escape"))
                .unwrap();
            assert!(inspect_artifact(dir.path(), "escape").is_err());
        }
        std::fs::write(dir.path().join("ok.md"), "ok").unwrap();
        let artifact = inspect_artifact(dir.path(), "ok.md").unwrap();
        assert_eq!(artifact.sha256, digest(b"ok"));
        assert_eq!(artifact.bytes, 2);
    }
    #[test]
    fn research_metrics_union_activity_and_scope_real_token_usage() {
        let (_dir, store, mut study) = setup();
        study.created_at = 1000;
        for session in ["expert", "unrelated"] {
            store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at,parent_session_id) VALUES(?1,'project','opencode',1000,5000,?2)",params![session,if session=="expert" {Some("lead")} else {None}]).unwrap();
        }
        store.conn.execute("INSERT INTO research_sessions(session_id,study_id,task_id,version) VALUES('expert',?1,'task',1)",[&study.id]).unwrap();
        for (session, input, output) in [
            ("lead", 100, 10),
            ("expert", 200, 20),
            ("unrelated", 10000, 10000),
        ] {
            let message = format!("message-{session}");
            let turn = format!("turn-{session}");
            store.conn.execute("INSERT INTO chat_messages(id,session_id,role,parts_json,created_at,completed_at) VALUES(?1,?2,'assistant','[]',1000,5000)",params![message,session]).unwrap();
            store.conn.execute("INSERT INTO chat_turns(id,session_id,assistant_message_id,client_turn_id,request_hash,prepared_input,settings_json,state,delivery_state,created_at,updated_at) VALUES(?1,?2,?3,?1,'hash','input','{}','completed','accepted',1000,5000)",params![turn,session,message]).unwrap();
            store.conn.execute("INSERT INTO chat_usage_executions(execution_id,turn_id,harness,report_id,suppressed) VALUES(?1,?1,'opencode',?1,1)",[&turn]).unwrap();
            store.conn.execute("INSERT INTO chat_usage_samples(execution_id,sample_id,harness,usage_json,complete) VALUES(?1,?1,'opencode',?2,1)",params![turn,serde_json::json!({"inputTokens":input,"outputTokens":output,"cacheReadTokens":50}).to_string()]).unwrap();
        }
        for (session, start, end, observed) in [
            ("lead", 1000, Some(2000), 2000),
            ("expert", 1500, Some(2500), 2500),
            ("lead", 3500, None, 4000),
            ("unrelated", 1000, Some(6000), 6000),
        ] {
            store.conn.execute("INSERT INTO chat_activity_spans(message_id,session_id,started_at,ended_at,observed_at,complete) VALUES(?1,?2,?3,?4,?5,1)",params![format!("message-{session}"),session,start,end,observed]).unwrap();
        }
        let metrics = store
            .research_metrics(&study, &["lead".into()], 5000)
            .unwrap();
        assert_eq!(metrics.active_duration_ms, Some(3000));
        assert!(metrics.active_duration_complete);
        assert_eq!(metrics.token_count, Some(330));
        assert!(metrics.token_count_complete);
        assert!(metrics.running);
        // A disconnected host stops at the last checkpoint, not server restart time.
        assert_eq!(
            store
                .research_metrics(&study, &[], 5000)
                .unwrap()
                .active_duration_ms,
            Some(2000)
        );
        study.status = "stopped".into();
        study.updated_at = 4200;
        let stopped = store
            .research_metrics(&study, &["lead".into()], 9000)
            .unwrap();
        assert_eq!(stopped.active_duration_ms, Some(2200));
        assert!(!stopped.running);
        store
            .conn
            .execute(
                "UPDATE chat_usage_samples SET complete=0 WHERE execution_id='turn-expert'",
                [],
            )
            .unwrap();
        assert!(
            !store
                .research_metrics(&study, &[], 9000)
                .unwrap()
                .token_count_complete
        );
        store
            .conn
            .execute(
                "DELETE FROM chat_activity_spans WHERE session_id='expert'",
                [],
            )
            .unwrap();
        let partial = store.research_metrics(&study, &[], 9000).unwrap();
        assert_eq!(partial.active_duration_ms, Some(1500));
        assert!(!partial.active_duration_complete);
        assert_eq!(partial.token_count, Some(330));
        // Missing historical timing must not erase newer measurements or be
        // fabricated from message timestamps (which include prompt holds).
        store
            .conn
            .execute("DELETE FROM chat_activity_spans", [])
            .unwrap();
        let historical = store.research_metrics(&study, &[], 9000).unwrap();
        assert_eq!(historical.active_duration_ms, None);
        assert!(!historical.active_duration_complete);
        assert_eq!(historical.token_count, Some(330));
    }
    #[test]
    fn research_metrics_include_background_experiments_without_agent_turns() {
        let (_dir, store, mut study) = setup();
        study.created_at = 1000;
        study.plans.push(ResearchPlan {
            workflow_source: None,
            version: 1,
            material_ids: None,
            workflow: None,
            summary: "test".into(),
            tasks: vec![ResearchTask {
                spec: spec("execute", "as-experiment-operator", &[]),
                state: "running".into(),
                session_id: None,
                previous_sessions: vec![],
                attempts: 0,
                contract_batch: 0,
                pending_nudge: None,
                pending_nudge_turn_id: None,
                summary: None,
                artifacts: vec![],
                output_baseline: None,
                run_contract: None,
                run_ids: vec!["run".into()],
                previous_run_ids: vec![],
                evidence_digest: None,
                agent: None,
                verdict: None,
                rework_count: 0,
                rework_feedback: None,
                route_decision: None,
            }],
        });
        store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('run','exp','project','running','{}',2000,2500)",[]).unwrap();
        let metrics = store.research_metrics(&study, &[], 3000).unwrap();
        assert_eq!(metrics.active_duration_ms, Some(1000));
        assert!(metrics.running);
        study.status = "stopped".into();
        study.updated_at = 3500;
        let stopped = store.research_metrics(&study, &[], 9000).unwrap();
        assert_eq!(stopped.active_duration_ms, Some(1500));
        assert!(!stopped.running);
    }
    #[test]
    fn plan_revision_inherits_completed_tasks_unless_force_rerun() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");
        bind(&store, &study, "design", "designer");
        finish(&store, &study, "design");

        let mut v2 = plan();
        v2.summary = "revised review instructions without redoing design".into();
        v2.tasks[1].brief = "updated review brief".into();
        store.research_set_plan(&study.id, v2).unwrap();

        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.plan().unwrap().version, 2);
        assert_eq!(saved.task("design").unwrap().state, "completed");
        assert_eq!(
            saved.task("design").unwrap().session_id.as_deref(),
            Some("designer")
        );
        assert_eq!(saved.task("review").unwrap().state, "pending");

        approve(&store, &study, "G1");
        let saved = store.research_study(&study.id).unwrap();
        // Because `design` was inherited as completed, `review` is immediately ready!
        assert!(saved.ready("review").is_ok());

        // When forceRerun is explicitly set on `design`, neither `design` nor its downstream can be inherited.
        let mut v3 = plan();
        v3.tasks[0].force_rerun = true;
        store.research_set_plan(&study.id, v3).unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.task("design").unwrap().state, "pending");
    }
    #[test]
    fn task_retry_and_in_place_prepare_run_preserve_plan_version() {
        let (_dir, store, study) = setup();
        let mut p = plan();
        p.tasks
            .insert(1, spec("execute", "as-experiment-operator", &["design"]));
        p.tasks[2].depends_on.push("execute".into());
        store.research_set_plan(&study.id, p).unwrap();
        approve(&store, &study, "G1");
        bind(&store, &study, "design", "designer-1");
        store
            .research_finish(&study.id, "design", false, "transient failure".into())
            .unwrap();

        store.research_retry_task(&study.id, "design").unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.plan().unwrap().version, 1);
        assert_eq!(saved.task("design").unwrap().state, "pending");
        assert_eq!(saved.task("design").unwrap().attempts, 1);
        assert_eq!(
            saved.task("design").unwrap().previous_sessions,
            vec!["designer-1".to_string()]
        );
        assert!(saved.ready("design").is_ok());
        bind(&store, &study, "design", "designer-2");
        finish(&store, &study, "design");

        store
            .create_local_experiment(&LocalExperiment {
                id: "exp".into(),
                project_id: "project".into(),
                parent_experiment_id: None,
                slug: "exp".into(),
                branch_name: "main".into(),
                title: None,
                description: None,
                run_command: "python3 main.py".into(),
                agent_status: "idle".into(),
                created_at: 1,
                updated_at: 1,
                chat_session_id: Some("lead".into()),
                archived: false,
            })
            .unwrap();
        let contract1 = RunContract {
            experiment_id: "exp".into(),
            revision: "commit-1".into(),
            command: "python3 main.py".into(),
            options: serde_json::json!({"backend":"local"}),
        };
        store
            .research_prepare(&study.id, "execute", contract1)
            .unwrap();
        let contract2 = RunContract {
            experiment_id: "exp".into(),
            revision: "commit-2".into(),
            command: "python3 main.py".into(),
            options: serde_json::json!({"backend":"local"}),
        };
        // Updating the revision before running does not require a new plan version.
        store
            .research_prepare(&study.id, "execute", contract2.clone())
            .unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.plan().unwrap().version, 1);
        assert_eq!(
            saved.task("execute").unwrap().run_contract.as_ref(),
            Some(&contract2)
        );
    }
    #[test]
    fn auto_dispatch_and_reconcile_advance_dag_waves_automatically() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");

        // Wave 1: `design` is automatically dispatched upon G1 approval.
        let wave1 =
            crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
        assert_eq!(wave1.len(), 1);
        assert_eq!(wave1[0].0, "design");
        let design_session = &wave1[0].1;

        // Write `design.md` without calling `orx research finish` manually;
        // `on_research_spawn_finished` auto-finishes `design` and auto-dispatches `review`!
        let root = store.research_root(&study).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("design.md"), "# design\nverified").unwrap();
        let action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            design_session,
            false,
            Some("design completed".into()),
            false,
        )
        .unwrap();
        assert!(matches!(
            action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::RetireSilently)
        ));
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.task("design").unwrap().state, "completed");
        assert_eq!(saved.task("review").unwrap().state, "running");
        let review_session = saved.task("review").unwrap().session_id.clone().unwrap();

        // Wave 2: `review` writes output and finishes -> auto-dispatches `audit`!
        std::fs::write(root.join("review.md"), "# review\nverified").unwrap();
        let action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &review_session,
            false,
            Some("review completed".into()),
            false,
        )
        .unwrap();
        assert!(matches!(
            action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::RetireSilently)
        ));
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.task("review").unwrap().state, "completed");
        assert_eq!(saved.task("audit").unwrap().state, "running");
        let audit_session = saved.task("audit").unwrap().session_id.clone().unwrap();

        // Wave 3: `audit` finishes -> all tasks completed -> G4 is requested automatically and lead is woken!
        std::fs::write(root.join("audit.md"), "# audit\nverified").unwrap();
        let action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &audit_session,
            false,
            Some("audit completed".into()),
            false,
        )
        .unwrap();
        assert!(matches!(
            action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::WakeLead(text))
                if text.contains("全部任务均已完成或跳过") && text.contains("G4")
        ));
        let saved = store.research_study(&study.id).unwrap();
        assert!(saved
            .decisions
            .iter()
            .any(|d| d.gate == "G4" && d.status == "pending"));
    }
    #[test]
    fn experiment_retry_requires_fresh_approval_for_identical_contract_and_recovers_from_rejection()
    {
        let (_dir, store, study) = setup();
        let mut p = plan();
        p.tasks
            .insert(1, spec("execute", "as-experiment-operator", &["design"]));
        p.tasks[2].depends_on.push("execute".into());
        store.research_set_plan(&study.id, p).unwrap();
        approve(&store, &study, "G1");
        bind(&store, &study, "design", "designer");
        finish(&store, &study, "design");

        store
            .create_local_experiment(&LocalExperiment {
                id: "exp".into(),
                project_id: "project".into(),
                parent_experiment_id: None,
                slug: "exp".into(),
                branch_name: "main".into(),
                title: None,
                description: None,
                run_command: "python3 main.py".into(),
                agent_status: "idle".into(),
                created_at: 1,
                updated_at: 1,
                chat_session_id: Some("lead".into()),
                archived: false,
            })
            .unwrap();
        let contract = RunContract {
            experiment_id: "exp".into(),
            revision: "commit-same".into(),
            command: "python3 main.py".into(),
            options: serde_json::json!({"backend":"local"}),
        };
        store
            .research_prepare(&study.id, "execute", contract.clone())
            .unwrap();

        // Reject G2 on first batch, then re-prepare with the exact same contract:
        // must mark the rejected decision as "superseded" (preserving audit history) and create a new pending G2/G3!
        let saved = store.research_study(&study.id).unwrap();
        let g2 = saved
            .decisions
            .iter()
            .find(|d| d.gate == "G2" && d.status == "pending")
            .unwrap();
        store
            .research_decide(&study.id, &g2.id, &g2.scope_hash, false, "rejected".into())
            .unwrap();
        store
            .research_prepare(&study.id, "execute", contract.clone())
            .unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert!(saved
            .decisions
            .iter()
            .any(|d| d.gate == "G2" && d.status == "pending"));
        assert!(!saved.decisions.iter().any(|d| d.status == "rejected"));
        assert!(saved.decisions.iter().any(|d| d.gate == "G2"
            && d.status == "superseded"
            && d.reason.as_deref() == Some("rejected")));

        // Approve G2 and G3 for this batch, run the experiment, and fail the task.
        approve(&store, &study, "G2");
        approve(&store, &study, "G3");
        bind(&store, &study, "execute", "op-1");
        store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('run-1','exp','project','failed','{}',1,2)",[]).unwrap();
        store
            .research_check_run("exp", Some("op-1"), &contract, Some("run-1"))
            .unwrap();
        store
            .research_finish(&study.id, "execute", false, "transient gpu failure".into())
            .unwrap();

        // Re-prepare with the EXACT SAME contract: must NOT reuse the old G2/G3 approval!
        store
            .research_prepare(&study.id, "execute", contract.clone())
            .unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert!(saved.ready("execute").is_err());
        assert!(saved
            .decisions
            .iter()
            .any(|d| d.gate == "G2" && d.status == "pending"));
        assert!(saved
            .decisions
            .iter()
            .any(|d| d.gate == "G3" && d.status == "pending"));

        // Only after approving the new batch's G2/G3 does `execute` become ready again.
        approve(&store, &study, "G2");
        approve(&store, &study, "G3");
        let saved = store.research_study(&study.id).unwrap();
        assert!(saved.ready("execute").is_ok());

        // When a run succeeds (`status = 'done'`) and only the operator report is missing,
        // `research_retry_task` preserves `run_contract`, `run_ids`, and the approved G2/G3!
        bind(&store, &study, "execute", "op-2");
        store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('run-2','exp','project','starting','{}',3,4)",[]).unwrap();
        store
            .research_check_run("exp", Some("op-2"), &contract, Some("run-2"))
            .unwrap();
        // Verify automatic `chat_run_wakeups` registration for live experiment run!
        let has_wakeup: bool = store
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_run_wakeups WHERE run_id='run-2' AND chat_session_id='op-2' AND state='pending')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(has_wakeup);
        store
            .conn
            .execute("UPDATE runs SET status='done' WHERE id='run-2'", [])
            .unwrap();
        store
            .research_finish(&study.id, "execute", false, "crashed before report".into())
            .unwrap();
        store.research_retry_task(&study.id, "execute").unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.task("execute").unwrap().run_ids, vec!["run-2"]);
        assert!(saved.task("execute").unwrap().run_contract.is_some());
        assert!(saved.ready("execute").is_ok());

        // Multi-experiment isolation: a plan with two experiment tasks (`execute` and `execute-b`)
        // must NOT supersede `execute`'s G2/G3 when `execute-b` runs `prepare-run`!
        let mut two_exp_plan = plan();
        two_exp_plan
            .tasks
            .insert(1, spec("execute", "as-experiment-operator", &["design"]));
        two_exp_plan
            .tasks
            .insert(2, spec("execute-b", "as-experiment-operator", &["design"]));
        two_exp_plan.tasks[3].depends_on =
            vec!["design".into(), "execute".into(), "execute-b".into()];
        store.research_set_plan(&study.id, two_exp_plan).unwrap();
        approve(&store, &study, "G1");
        store
            .create_local_experiment(&LocalExperiment {
                id: "exp-b".into(),
                project_id: "project".into(),
                parent_experiment_id: None,
                slug: "exp-b".into(),
                branch_name: "main".into(),
                title: None,
                description: None,
                run_command: "python3 eval.py".into(),
                agent_status: "idle".into(),
                created_at: 2,
                updated_at: 2,
                chat_session_id: Some("lead".into()),
                archived: false,
            })
            .unwrap();
        let contract_b = RunContract {
            experiment_id: "exp-b".into(),
            revision: "commit-b".into(),
            command: "python3 eval.py".into(),
            options: serde_json::json!({"backend":"local"}),
        };
        store
            .research_prepare(&study.id, "execute", contract.clone())
            .unwrap();
        approve(&store, &study, "G2");
        approve(&store, &study, "G3");
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .ready("execute")
            .is_ok());

        // Preparing `execute-b` must leave `execute`'s approved G2/G3 intact!
        store
            .research_prepare(&study.id, "execute-b", contract_b.clone())
            .unwrap();
        let saved = store.research_study(&study.id).unwrap();
        assert!(saved.ready("execute").is_ok());
        assert!(saved.ready("execute-b").is_err());
    }
    #[test]
    fn stale_session_cannot_finish_or_fail_rebound_task_and_active_session_blocks_retry() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");

        let wave1 =
            crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
        let first_session = wave1[0].1.clone();

        // While `first_session` is still an active unfinished spawn, manual retry is rejected.
        assert!(store
            .research_retry_task(&study.id, "design")
            .unwrap_err()
            .to_string()
            .contains("仍在执行中"));

        // 1st normal completion without writing `design.md` -> triggers L1 In-Session Nudge (`NudgeHelper`),
        // keeping `first_session` bound to the task and persisting `pending_nudge`.
        let nudge_action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &first_session,
            false,
            Some("forgot to write file".into()),
            false,
        )
        .unwrap();
        assert!(matches!(
            nudge_action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::NudgeHelper(ref text))
                if text.contains("design.md")
        ));
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(
            saved.task("design").unwrap().session_id.as_deref(),
            Some(first_session.as_str())
        );
        assert!(saved.task("design").unwrap().pending_nudge.is_some());
        assert_eq!(saved.task("design").unwrap().attempts, 1);

        // Simulate a process crash/restart AFTER persisting `pending_nudge` and BEFORE sending the message
        // (even if `interrupted = true` is passed on restart): must resume delivering `NudgeHelper`
        // without failing the task or incrementing `attempts`!
        let restart_action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &first_session,
            true,
            None,
            false,
        )
        .unwrap();
        assert!(matches!(
            restart_action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::NudgeHelper(ref text))
                if text.contains("design.md")
        ));
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.task("design").unwrap().state, "running");
        assert_eq!(saved.task("design").unwrap().attempts, 1);

        // Deterministic crash window test ("准入后、后台任务真正启动前崩溃重启"):
        // 1. Nudge turn `turn-nudge-1` is admitted (`state = 'preparing'`, `attempt_count = 0`),
        //    binding `pending_nudge_turn_id = Some("turn-nudge-1")` in the same transaction,
        //    while keeping `pending_nudge` intact and `finished_at` non-null until execution actually begins.
        store
            .admit_chat_turn(
                None,
                &crate::store::StoredChatTurn {
                    id: "turn-nudge-1".into(),
                    session_id: first_session.clone(),
                    user_message_id: None,
                    assistant_message_id: "msg-nudge-1".into(),
                    client_turn_id: "ct-nudge-1".into(),
                    request_hash: "hash-nudge-1".into(),
                    prepared_input: "nudge".into(),
                    settings_json: "{}".into(),
                    state: "preparing".into(),
                    delivery_state: "not_sent".into(),
                    attempt_count: 0,
                    next_retry_at: None,
                    error_kind: None,
                    error_message: None,
                    recovery_action: None,
                    recovered_by_turn_id: None,
                    created_at: 10,
                    updated_at: 10,
                },
            )
            .unwrap();
        // Even if `research_mark_nudge_delivered` runs while `turn-nudge-1` is still in `preparing` (`attempt_count = 0`),
        // it must NOT clear `pending_nudge` or `finished_at` before the turn actually starts executing!
        store
            .research_mark_nudge_delivered(&first_session, Some("turn-nudge-1"))
            .unwrap();
        assert!(store
            .get_chat_spawn(&first_session)
            .unwrap()
            .unwrap()
            .finished_at
            .is_some());
        let saved = store.research_study(&study.id).unwrap();
        assert!(saved.task("design").unwrap().pending_nudge.is_some());
        assert_eq!(
            saved
                .task("design")
                .unwrap()
                .pending_nudge_turn_id
                .as_deref(),
            Some("turn-nudge-1")
        );

        // Simulate crash & startup reconciliation before `turn-nudge-1` ever started running:
        store.reconcile_unfinished_chat_turns().unwrap();
        let interrupted_after_admit_crash = store
            .get_chat_spawn(&first_session)
            .unwrap()
            .is_some_and(|row| row.finished_at.is_none());
        assert!(!interrupted_after_admit_crash);
        let recover_action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &first_session,
            interrupted_after_admit_crash,
            None,
            true,
        )
        .unwrap();
        assert!(matches!(
            recover_action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::NudgeHelper(ref text))
                if text.contains("design.md")
        ));
        assert_eq!(
            store
                .research_study(&study.id)
                .unwrap()
                .task("design")
                .unwrap()
                .attempts,
            1
        );

        // Deterministic race test ("轮次真正开始执行后确认投递 + 新轮次先结束、投递确认后执行"):
        // 2. Re-admitted nudge turn `turn-nudge-2` actually starts executing (`update_chat_turn_progress`),
        //    which atomically clears `pending_nudge` and sets `finished_at = NULL` in one transaction.
        store
            .admit_chat_turn(
                None,
                &crate::store::StoredChatTurn {
                    id: "turn-nudge-2".into(),
                    session_id: first_session.clone(),
                    user_message_id: None,
                    assistant_message_id: "msg-nudge-2".into(),
                    client_turn_id: "ct-nudge-2".into(),
                    request_hash: "hash-nudge-2".into(),
                    prepared_input: "nudge".into(),
                    settings_json: "{}".into(),
                    state: "preparing".into(),
                    delivery_state: "not_sent".into(),
                    attempt_count: 0,
                    next_retry_at: None,
                    error_kind: None,
                    error_message: None,
                    recovery_action: None,
                    recovered_by_turn_id: None,
                    created_at: 20,
                    updated_at: 20,
                },
            )
            .unwrap();
        store
            .update_chat_turn_progress("turn-nudge-2", "running", "not_sent", 1, None)
            .unwrap();
        assert!(store
            .get_chat_spawn(&first_session)
            .unwrap()
            .unwrap()
            .finished_at
            .is_none());
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .task("design")
            .unwrap()
            .pending_nudge
            .is_none());

        // 3. `turn-nudge-2` finishes quickly (`state = 'completed'`) and stamps `finished_at`
        //    BEFORE the caller's post-await `research_mark_nudge_delivered` / `reopen_chat_spawn` runs.
        store.complete_chat_turn("turn-nudge-2").unwrap();
        store.mark_chat_spawn_finished(&first_session).unwrap();
        assert!(store
            .get_chat_spawn(&first_session)
            .unwrap()
            .unwrap()
            .finished_at
            .is_some());

        // 4. Late delivery confirmations arrive for `turn-nudge-2`: they must NOT wipe `finished_at`!
        store
            .research_mark_nudge_delivered(&first_session, Some("turn-nudge-2"))
            .unwrap();
        store
            .reopen_chat_spawn(&first_session, Some("turn-nudge-2"))
            .unwrap();
        let interrupted_after_late_confirm = store
            .get_chat_spawn(&first_session)
            .unwrap()
            .is_some_and(|row| row.finished_at.is_none());
        assert!(!interrupted_after_late_confirm);

        // 5. Next watcher check sees `interrupted == false` and escalates to L2 retry (`second_session`).
        let action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &first_session,
            interrupted_after_late_confirm,
            Some("still forgot to write file".into()),
            false,
        )
        .unwrap();
        assert!(matches!(
            action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::RetireSilently)
        ));
        let saved = store.research_study(&study.id).unwrap();
        let second_session = saved.task("design").unwrap().session_id.clone().unwrap();
        assert_ne!(first_session, second_session);
        assert_eq!(saved.task("design").unwrap().state, "running");

        // Now a late/duplicate callback for `first_session` arrives: it must retire silently
        // without failing or finishing `second_session`'s running task!
        let stale_action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &first_session,
            false,
            Some("stale failure".into()),
            true,
        )
        .unwrap();
        assert!(matches!(
            stale_action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::RetireSilently)
        ));
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(saved.task("design").unwrap().state, "running");
        assert_eq!(
            saved.task("design").unwrap().session_id.as_deref(),
            Some(second_session.as_str())
        );
    }
    #[test]
    fn delivery_package_validation_failure_reports_error_instead_of_claiming_gate_requested() {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        approve(&store, &study, "G1");
        let root = store.research_root(&study).unwrap();
        std::fs::create_dir_all(&root).unwrap();

        let wave1 =
            crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
        std::fs::write(root.join("design.md"), "# design\nv1").unwrap();
        crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &wave1[0].1,
            false,
            Some("done".into()),
            false,
        )
        .unwrap();

        let review_session = store
            .research_study(&study.id)
            .unwrap()
            .task("review")
            .unwrap()
            .session_id
            .clone()
            .unwrap();
        std::fs::write(root.join("review.md"), "# review\nv1").unwrap();
        crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &review_session,
            false,
            Some("done".into()),
            false,
        )
        .unwrap();

        let audit_session = store
            .research_study(&study.id)
            .unwrap()
            .task("audit")
            .unwrap()
            .session_id
            .clone()
            .unwrap();
        std::fs::write(root.join("audit.md"), "# audit\nv1").unwrap();

        // First let `audit` finish cleanly so a valid pending G4 decision is created.
        let clean_action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &audit_session,
            false,
            Some("done".into()),
            false,
        )
        .unwrap();
        assert!(matches!(
            clean_action,
            Some(crate::commands::research_dispatch::ResearchWakeAction::WakeLead(ref text))
                if text.contains("系统已自动发起 G4 交付确认申请")
        ));
        assert!(store
            .research_study(&study.id)
            .unwrap()
            .decisions
            .iter()
            .any(|d| d.gate == "G4" && d.status == "pending"));

        // Now tamper with `design.md` AFTER the pending G4 decision already exists!
        std::fs::write(root.join("design.md"), "# design\ntampered after G4").unwrap();

        let action = crate::commands::research_dispatch::on_research_spawn_finished(
            &store,
            &audit_session,
            false,
            Some("done".into()),
            false,
        )
        .unwrap();
        match action {
            Some(crate::commands::research_dispatch::ResearchWakeAction::WakeLead(text)) => {
                assert!(text.contains("最终交付校验未通过"));
                assert!(text.contains("产物变化，需要重新审查: design.md"));
                assert!(text.contains("forceRerun"));
                assert!(!text.contains("系统已自动发起 G4 交付确认申请"));
            }
            other => panic!("expected WakeLead with validation error, got {other:?}"),
        }
        let saved = store.research_study(&study.id).unwrap();
        assert!(!saved
            .decisions
            .iter()
            .any(|d| d.gate == "G4" && matches!(d.status.as_str(), "pending" | "approved")));
        assert!(saved
            .decisions
            .iter()
            .any(|d| d.gate == "G4" && d.status == "superseded"));
    }

    include!("research_debt_tests.rs");
    include!("research_plan_tests.rs");
    include!("research_evidence_tests.rs");
    include!("research_claim_tests.rs");
    include!("material_read_event_tests.rs");
    include!("research_material_citation_tests.rs");
    include!("research_metric_citation_tests.rs");
    include!("research_delivery_tests.rs");
    include!("research_delivery_snapshot_tests.rs");
    include!("research_archive_retention_tests.rs");
    include!("research_material_tests.rs");
    include!("research_lifecycle_tests.rs");
    include!("research_file_tests.rs");
    include!("research_aggregate_tests.rs");
    include!("research_settlement_tests.rs");
    include!("research_orchestration_tests.rs");
}
