//! Durable research orchestration. One versioned aggregate is updated under a
//! SQLite write transaction; native chats, experiments and runs remain canonical.
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{now_ms, Store, StoredRun};
use crate::error::{anyhow, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSpec {
    pub id: String,
    pub role: String,
    pub brief: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub outputs: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanInput {
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
    pub summary: Option<String>,
    pub artifacts: Vec<Artifact>,
    pub run_contract: Option<RunContract>,
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub evidence_digest: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPlan {
    pub version: u32,
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
        if self
            .decisions
            .iter()
            .any(|d| d.version == version && d.gate == gate && d.scope_hash == hash)
        {
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
    pub fn plan_scope(&self) -> Result<String> {
        let plan = self.plan()?;
        Ok(serde_json::to_string(
            &serde_json::json!({"objective":self.objective,"version":plan.version,"summary":plan.summary,"tasks":plan.tasks.iter().map(|t| &t.spec).collect::<Vec<_>>()}),
        )?)
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
            let contract = task
                .run_contract
                .as_ref()
                .ok_or_else(|| anyhow!("先用 prepare-run 绑定真实实验"))?;
            let scope = serde_json::to_string(contract)?;
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
        if mode != "team" && task.role == "as-experiment-operator" {
            return Err(anyhow!("会诊模式仅分析材料；运行实验请发起专家团研究"));
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
    pub fn research_update<T>(
        &self,
        id: &str,
        update: impl FnOnce(&mut Study) -> Result<T>,
    ) -> Result<T> {
        let tx = self.begin_immediate()?;
        let mut study = self.research_study(id)?;
        let value = update(&mut study)?;
        study.updated_at = now_ms();
        self.research_save(&study)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn research_create(&self, session: &str, mode: &str, objective: &str) -> Result<Study> {
        if !["team", "design", "diagnosis", "review"].contains(&mode)
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
                .iter()
                .flat_map(|p| &p.tasks)
                .any(|t| t.state == "running")
            {
                return Err(anyhow!("请先结束或停止当前任务，再修订计划"));
            }
            let version = study.plans.last().map_or(1, |p| p.version + 1);
            study.plans.push(ResearchPlan {
                version,
                summary: input.summary,
                tasks: input
                    .tasks
                    .into_iter()
                    .map(|spec| ResearchTask {
                        spec,
                        state: "pending".into(),
                        session_id: None,
                        summary: None,
                        artifacts: vec![],
                        run_contract: None,
                        run_ids: vec![],
                        evidence_digest: None,
                    })
                    .collect(),
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
        let evidence_digest = digest(&serde_json::to_vec(&study.claims)?);
        let task = study.task_mut(task_id)?;
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
        self.research_update(id,|study| {
            study.ensure_active()?;
            study.require_gate("G1",&study.plan_scope()?)?;
            let task=study.task(task_id)?;
            if task.spec.role!="as-experiment-operator" || task.state!="pending" { return Err(anyhow!("只能为尚未派发的实验执行任务准备运行")); }
            let exp=self.get_local_experiment(&contract.experiment_id)?.ok_or_else(||anyhow!("实验不存在"))?;
            if exp.project_id!=study.project_id {return Err(anyhow!("实验属于其他项目"));}
            let existing:Option<(String,u32)>=self.conn.query_row("SELECT study_id,version FROM research_experiments WHERE experiment_id=?1",[&exp.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if existing.as_ref().is_some_and(|(sid,v)|sid!=id || *v==study.plan().map_or(0,|p|p.version)) {
                if task.run_contract.as_ref()==Some(&contract) {return Ok(());}
                return Err(anyhow!("实验已绑定研究任务；变更请修订计划"));
            }
            let scope=serde_json::to_string(&contract)?;
            self.conn.execute("INSERT INTO research_experiments VALUES(?1,?2,?3,?4) ON CONFLICT(experiment_id) DO UPDATE SET task_id=excluded.task_id,version=excluded.version",params![exp.id,id,task_id,study.plan()?.version])?;
            study.task_mut(task_id)?.run_contract=Some(contract);
            study.request_gate("G2",scope.clone())?;
            study.request_gate("G3",scope)
        })
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
                        Ok(Artifact {
                            path: path.clone(),
                            sha256: digest(&bytes),
                            bytes: bytes.len() as u64,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
            }
            task.state = if success { "completed" } else { "failed" }.into();
            task.summary = Some(summary);
            Ok(())
        })
    }
    pub fn research_add_claim(&self, id: &str, input: ClaimInput) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            if input.text.trim().is_empty()
                || input.source.trim().is_empty()
                || !["paper", "experiment", "inference"].contains(&input.support.as_str())
            {
                return Err(anyhow!("结论需要文本、来源及明确的证据类型"));
            }
            let mut claim = EvidenceClaim {
                id: uuid::Uuid::new_v4().to_string(),
                input,
                commit_sha: None,
                log_sha256: None,
                excerpt: None,
                created_at: now_ms(),
            };
            if claim.input.support == "experiment" {
                let run = self
                    .get_run(
                        claim
                            .input
                            .run_id
                            .as_deref()
                            .ok_or_else(|| anyhow!("实验结论需要 runId"))?,
                    )?
                    .ok_or_else(|| anyhow!("Run 不存在"))?;
                if run.project_id != study.project_id || !crate::local::is_terminal(&run.status) {
                    return Err(anyhow!("结论必须关联本项目已结束的 Run"));
                }
                let bytes = std::fs::read(self.research_log_path(&run.id)?)?;
                let text = String::from_utf8_lossy(&bytes);
                let lines: Vec<_> = text.lines().collect();
                let start = claim.input.line_start.unwrap_or(0);
                let end = claim.input.line_end.unwrap_or(0);
                if start == 0 || end < start || end > lines.len() || end - start > 200 {
                    return Err(anyhow!("需要有效日志行范围（最多 201 行）"));
                }
                claim.excerpt = Some(lines[start - 1..end].join("\n"));
                claim.log_sha256 = Some(digest(&bytes));
                claim.commit_sha = run.commit_sha;
            } else if claim.input.support == "paper"
                && claim
                    .input
                    .location
                    .as_ref()
                    .is_none_or(|v| v.trim().is_empty())
            {
                return Err(anyhow!("论文声明需要页码或章节位置"));
            }
            study.claims.push(claim);
            Ok(())
        })
    }
    pub fn research_package_scope(&self, study: &Study) -> Result<String> {
        let plan = study.plan()?;
        if plan.tasks.iter().any(|t| t.state != "completed") {
            return Err(anyhow!("全部计划任务必须通过验收后才能申请 G4"));
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
            let log = std::fs::read(self.research_log_path(&run.id)?)?;
            let log_hash = digest(&log);
            for claim in &study.claims {
                if claim.input.run_id.as_deref() == Some(&run.id)
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
            if gate == "G4" {
                study.require_gate("G1", &study.plan_scope()?)?;
                let scope = self.research_package_scope(study)?;
                if digest(scope.as_bytes()) != hash {
                    return Err(anyhow!("交付内容已变化，请重新申请 G4"));
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
            .flat_map(|t| &t.run_ids)
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
        }
    }
    fn plan() -> PlanInput {
        PlanInput {
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
    fn artifacts_dependencies_and_package_are_verified() {
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
        assert!(crate::local::research::export_package(&store, &study, true).is_err());
        store
            .research_update(&study.id, |s| s.request_gate("G4", scope))
            .unwrap();
        approve(&store, &study, "G4");
        let study = store.research_study(&study.id).unwrap();
        let bytes = crate::local::research::export_package(&store, &study, true).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(zip.by_name("artifacts/review.md").is_ok());
        assert!(zip.by_name("research-package-manifest.json").is_ok());
        std::fs::write(
            store.research_root(&study).unwrap().join("design.md"),
            "changed after review",
        )
        .unwrap();
        assert!(crate::local::research::export_package(&store, &study, true).is_err());
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
}
