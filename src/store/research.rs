//! Durable research orchestration. One versioned aggregate is updated under a
//! SQLite write transaction; native chats, experiments and runs remain canonical.
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{now_ms, Store, StoredRun};
use crate::error::{anyhow, Result};

mod evidence;

#[derive(Clone, Debug, Serialize, Deserialize)]
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
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    pub summary: String,
    pub tasks: Vec<TaskSpec>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
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
}
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPlan {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    pub summary: String,
    pub tasks: Vec<ResearchTask>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimInput {
    pub text: String,
    pub support: String,
    pub source: String,
    pub location: Option<String>,
    pub run_id: Option<String>,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceClaim {
    pub id: String,
    #[serde(flatten)]
    pub input: ClaimInput,
    pub commit_sha: Option<String>,
    pub log_sha256: Option<String>,
    pub excerpt: Option<String>,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
    pub delivery_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
impl Study {
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
            return Err(anyhow!("研究已停止"));
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
    pub fn plan_scope(&self) -> Result<String> {
        let plan = self.plan()?;
        let mut scope = serde_json::json!({"objective":self.objective,"version":plan.version,"summary":plan.summary,"tasks":plan.tasks.iter().map(|t| &t.spec).collect::<Vec<_>>()});
        // Preserve existing approval hashes when deserializing older plans.
        if let Some(workflow) = &plan.workflow {
            scope["workflow"] = serde_json::json!(workflow);
        }
        Ok(serde_json::to_string(&scope)?)
    }
    pub fn ready(&self, id: &str) -> Result<()> {
        self.ensure_active()?;
        self.require_gate("G1", &self.plan_scope()?)?;
        let task = self.task(id)?;
        for dep in &task.spec.depends_on {
            if self.task(dep)?.state != "completed" {
                return Err(anyhow!("前置任务 {dep} 未通过产物验收"));
            }
        }
        if task.spec.role == "as-experiment-operator" {
            let scope = task.run_gate_scope()?;
            self.require_gate("G2", &scope)?;
            self.require_gate("G3", &scope)?;
        }
        Ok(())
    }
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
pub fn read_artifact(root: &Path, relative: &str) -> Result<Vec<u8>> {
    if !safe_relative(relative) {
        return Err(anyhow!("产物路径必须为目录内的相对路径"));
    }
    let root = root.canonicalize()?;
    let path = root.join(relative).canonicalize()?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(anyhow!("产物路径越界或不是文件"));
    }
    if path.metadata()?.len() > 32 * 1024 * 1024 {
        return Err(anyhow!("单个研究包产物超过 32 MiB"));
    }
    Ok(std::fs::read(path)?)
}
pub fn validate_plan(input: &PlanInput, mode: &str) -> Result<()> {
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
        crate::local::research::role(&task.role)?;
        if task.brief.trim().is_empty()
            || task.brief.len() > 24000
            || task.outputs.is_empty()
            || task.outputs.len() > 30
        {
            return Err(anyhow!("每个任务需要简报和 1–30 个产物路径"));
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
    }
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
    if matches!(mode, "team" | "review") {
        for required in ["as-independent-reviewer", "as-quality-citation-auditor"] {
            if !input.tasks.iter().any(|t| t.role == required) {
                return Err(anyhow!("计划必须包含独立审稿和引用审计"));
            }
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
            .ok_or_else(|| anyhow!("研究不存在"))?;
        Ok(serde_json::from_str(&text)?)
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
        let before = serde_json::to_vec(&study)?;
        let value = update(&mut study)?;
        if serde_json::to_vec(&study)? != before {
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
            delivery_error: None,
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
    pub fn research_set_plan(&self, id: &str, input: PlanInput) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            validate_plan(&input, &study.mode)?;
            if self.count_live_chat_spawns(&study.session_id)? > 0
                || self
                    .research_runs(study)?
                    .iter()
                    .any(|r| !crate::local::is_terminal(&r.status))
            {
                return Err(anyhow!("请先等待当前专家会话和实验结束，再修订计划"));
            }
            if study
                .plans
                .last()
                .is_some_and(|p| p.tasks.iter().any(|t| t.state == "running"))
            {
                return Err(anyhow!("请先结束或停止当前任务，再修订计划"));
            }
            let version = study.plans.last().map_or(1, |p| p.version + 1);
            // Compare effective routes: legacy manual plans may omit workflow,
            // while a team plan may select a different research contract.
            let same_workflow =
                input.workflow.as_deref().unwrap_or(&study.mode) == study.workflow_mode();
            let root = self.research_root(study).ok();
            let evidence_digest = digest(&serde_json::to_vec(&study.claims)?);
            let prev_tasks: std::collections::HashMap<String, ResearchTask> = study
                .plans
                .last()
                .map(|p| {
                    p.tasks
                        .iter()
                        .cloned()
                        .map(|t| (t.spec.id.clone(), t))
                        .collect()
                })
                .unwrap_or_default();
            let mut inherited_ids = HashSet::new();
            loop {
                let before = inherited_ids.len();
                for spec in &input.tasks {
                    if !same_workflow || inherited_ids.contains(&spec.id) || spec.force_rerun {
                        continue;
                    }
                    let Some(prev) = prev_tasks.get(&spec.id) else {
                        continue;
                    };
                    if prev.state != "completed"
                        || prev.spec.role != spec.role
                        || prev.spec.brief != spec.brief
                        || prev.spec.outputs != spec.outputs
                        || prev.spec.depends_on != spec.depends_on
                        || !spec.depends_on.iter().all(|d| inherited_ids.contains(d))
                    {
                        continue;
                    }
                    if matches!(
                        spec.role.as_str(),
                        "as-independent-reviewer" | "as-quality-citation-auditor"
                    ) && prev.evidence_digest.as_deref() != Some(evidence_digest.as_str())
                    {
                        continue;
                    }
                    let artifacts_valid = root.as_ref().is_some_and(|root_dir| {
                        !prev.artifacts.is_empty()
                            && prev.artifacts.iter().all(|a| {
                                read_artifact(root_dir, &a.path)
                                    .is_ok_and(|bytes| digest(&bytes) == a.sha256)
                            })
                    });
                    if artifacts_valid {
                        inherited_ids.insert(spec.id.clone());
                    }
                }
                if inherited_ids.len() == before {
                    break;
                }
            }
            let mut tasks = Vec::with_capacity(input.tasks.len());
            for spec in input.tasks {
                if inherited_ids.contains(&spec.id) {
                    if let Some(prev) = prev_tasks.get(&spec.id) {
                        if let Some(sid) = &prev.session_id {
                            self.conn.execute(
                                "UPDATE research_sessions SET version=?1 WHERE session_id=?2 AND study_id=?3",
                                params![version, sid, study.id],
                            )?;
                        }
                        if let Some(contract) = &prev.run_contract {
                            self.conn.execute(
                                "UPDATE research_experiments SET version=?1 WHERE experiment_id=?2 AND study_id=?3",
                                params![version, contract.experiment_id, study.id],
                            )?;
                        }
                        tasks.push(ResearchTask {
                            spec,
                            state: "completed".into(),
                            session_id: prev.session_id.clone(),
                            previous_sessions: prev.previous_sessions.clone(),
                            attempts: prev.attempts,
                            contract_batch: prev.contract_batch,
                            pending_nudge: None,
                            pending_nudge_turn_id: None,
                            summary: prev.summary.clone(),
                            artifacts: prev.artifacts.clone(),
                            output_baseline: prev.output_baseline.clone(),
                            run_contract: prev.run_contract.clone(),
                            run_ids: prev.run_ids.clone(),
                            previous_run_ids: prev.previous_run_ids.clone(),
                            evidence_digest: prev.evidence_digest.clone(),
                        });
                        continue;
                    }
                }
                tasks.push(ResearchTask {
                    spec,
                    state: "pending".into(),
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
                    run_ids: vec![],
                    previous_run_ids: vec![],
                    evidence_digest: None,
                });
            }
            study.delivery_error = None;
            study.plans.push(ResearchPlan {
                version,
                workflow: input.workflow,
                summary: input.summary,
                tasks,
            });
            study.request_gate("G1", study.plan_scope()?)
        })
    }
    /// Called inside the same transaction that creates the native helper.
    pub fn research_bind_task(&self, study_id: &str, task_id: &str, session: &str) -> Result<()> {
        let mut study = self.research_study(study_id)?;
        study.ready(task_id)?;
        let root = self.research_root(&study)?;
        for dependency in &study.task(task_id)?.spec.depends_on {
            for artifact in &study.task(dependency)?.artifacts {
                if digest(&read_artifact(&root, &artifact.path)?) != artifact.sha256 {
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
            match read_artifact(&root, path) {
                Ok(bytes) => baseline.push(Artifact {
                    path: path.clone(),
                    sha256: digest(&bytes),
                    bytes: bytes.len() as u64,
                }),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        let evidence_digest = digest(&serde_json::to_vec(&study.claims)?);
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
                let finished = task.session_id.as_deref().is_some_and(|sid| {
                    !self.chat_turn_leased(sid).unwrap_or(true)
                        && self
                            .conn
                            .query_row(
                                "SELECT EXISTS(SELECT 1 FROM chat_spawns WHERE session_id=?1 AND (state='done' OR finished_at IS NOT NULL))",
                                [sid],
                                |r| r.get::<_, bool>(0),
                            )
                            .unwrap_or(false)
                });
                if !finished {
                    return Err(anyhow!("专家会话仍在执行中，请等待其结束后再重试"));
                }
            }
            for run_id in &task.run_ids {
                if self
                    .get_run(run_id)?
                    .is_some_and(|r| !crate::local::is_terminal(&r.status))
                {
                    return Err(anyhow!("仍有运行中的实验，请先等待或取消"));
                }
            }
            let has_succeeded_run = task.spec.role == "as-experiment-operator"
                && !task.run_ids.is_empty()
                && task.run_ids.iter().all(|run_id| {
                    self.get_run(run_id)
                        .ok()
                        .flatten()
                        .is_some_and(|r| r.status == "done")
                });
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
        let Ok(study) = self.research_study(&study_id) else {
            return Ok(false);
        };
        if study.status != "active" || study.plan().map_or(true, |p| p.version != version) {
            return Ok(false);
        }
        let Ok(task) = study.task(&task_id) else {
            return Ok(false);
        };
        if task.session_id.as_deref() != Some(session) {
            return Ok(false);
        }
        for run_id in &task.run_ids {
            if let Some(run) = self.get_run(run_id)? {
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
        }
        Ok(false)
    }
    pub fn research_active_studies(&self) -> Result<Vec<Study>> {
        let mut stmt = self.conn.prepare("SELECT document FROM research_studies")?;
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
            if success {
                if task.spec.role == "as-experiment-operator" && runs.is_empty() {
                    return Err(anyhow!("实验任务尚无真实 Run"));
                }
                task.artifacts = task
                    .spec
                    .outputs
                    .iter()
                    .map(|path| {
                        let bytes = read_artifact(&root, path)?;
                        if bytes.is_empty() {
                            return Err(anyhow!("产物为空: {path}"));
                        }
                        let sha256 = digest(&bytes);
                        if automatic && task.output_baseline.as_ref().is_none_or(|baseline| {
                            baseline.iter().any(|old| old.path == *path && old.sha256 == sha256)
                        }) {
                            return Err(anyhow!("产物尚未登记为本轮结果: {path}；请核查后执行 orx research finish 显式登记"));
                        }
                        Ok(Artifact {
                            path: path.clone(),
                            sha256,
                            bytes: bytes.len() as u64,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
            }
            task.pending_nudge = None;
            task.pending_nudge_turn_id = None;
            task.state = if success { "completed" } else { "failed" }.into();
            task.summary = Some(summary);
            Ok(())
        })
    }
    pub fn research_package_scope(&self, study: &Study) -> Result<String> {
        let plan = study.plan()?;
        if plan.tasks.iter().any(|t| t.state != "completed") {
            return Err(anyhow!("全部计划任务必须通过验收后才能申请交付确认"));
        }
        let evidence_digest = digest(&serde_json::to_vec(&study.claims)?);
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
            if digest(&read_artifact(&root, &artifact.path)?) != artifact.sha256 {
                return Err(anyhow!("产物变化，需要重新审查: {}", artifact.path));
            }
        }
        let mut provenance = Vec::new();
        for run in self.research_runs(study)? {
            if !crate::local::is_terminal(&run.status) {
                return Err(anyhow!("仍有未结束的运行"));
            }
            let mut log = std::fs::File::open(self.research_log_path(&run.id)?)?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let count = std::io::Read::read(&mut log, &mut buffer)?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            let log_hash = format!("{:x}", hasher.finalize());
            for claim in &study.claims {
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
        Ok(serde_json::to_string(
            &serde_json::json!({"plan":plan,"claims":study.claims,"runs":provenance}),
        )?)
    }
    pub fn research_decide(
        &self,
        id: &str,
        decision: &str,
        hash: &str,
        approved: bool,
        reason: String,
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
            if gate == crate::local::research::delivery_gate(study.workflow_mode()) {
                study.require_gate("G1", &study.plan_scope()?)?;
                let scope = self.research_package_scope(study)?;
                if digest(scope.as_bytes()) != hash {
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
            .map(|id| self.get_run(id)?.ok_or_else(|| anyhow!("研究 Run 丢失")))
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
                    line_end: Some(1)
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
            assert!(read_artifact(dir.path(), "escape").is_err());
        }
        std::fs::write(dir.path().join("ok.md"), "ok").unwrap();
        assert_eq!(read_artifact(dir.path(), "ok.md").unwrap(), b"ok");
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
            version: 1,
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
                if text.contains("全部 3 个专家任务均已完成") && text.contains("G4")
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
    include!("research_evidence_tests.rs");
}
