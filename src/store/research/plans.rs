//! Prepare inherited artifact hashes without a SQLite writer, then revalidate
//! the aggregate and current eligibility in the short plan revision transaction.
use std::collections::HashMap;

use super::files::PreparedArtifact;
use super::*;
use crate::workflow::{AgentSnapshot, McpServerSnapshot};

pub(super) struct PreparedPlan {
    study: Study,
    input: PlanInput,
    artifacts: HashMap<String, Vec<PreparedArtifact>>,
    agents: HashMap<String, AgentSnapshot>,
    deduplicate: bool,
    source: Option<crate::workflow::WorkflowSource>,
    objective: Option<String>,
    /// 计划来自用户显式提交的方法草稿：按用户编排执行，免专家团自动编排的审稿+审计兜底。
    explicit_method: bool,
}

fn same_agent(
    previous: &ResearchTask,
    role: &str,
    agents: &HashMap<String, AgentSnapshot>,
) -> bool {
    match agents.get(role) {
        Some(agent) => previous.agent.as_ref() == Some(agent),
        None => previous.agent.is_none(),
    }
}

impl Store {
    /// Bind a saved method to this conversation without creating another chat.
    /// Invalid drafts are rejected before a normal chat becomes a study.
    pub fn research_use_workflow(
        &self,
        session_id: &str,
        draft_id: &str,
        objective: &str,
    ) -> Result<(String, u32, bool)> {
        let objective = objective.trim();
        if objective.is_empty() || objective.len() > 24000 {
            return Err(anyhow!("请在对话中明确研究目标（最多 24000 字节）"));
        }
        let session = self
            .get_chat_session(session_id)?
            .ok_or_else(|| anyhow!("会话不存在"))?;
        if session.parent_session_id.is_some() || session.side_parent_session_id.is_some() {
            return Err(anyhow!("请在主聊天中使用工作流"));
        }
        let draft = self
            .workflow_draft_by_id(draft_id)?
            .ok_or_else(|| anyhow!("工作流不存在"))?;
        crate::workflow::validate_draft(&draft.input)?;
        let draft_id = draft.id.clone();
        let source = crate::workflow::WorkflowSource {
            id: draft.id,
            name: draft.input.name.clone(),
            updated_at: draft.updated_at,
        };
        // 工作流绑定后给新会话一个稳定标题：否则标题生成器可能拿后续的
        // 编排唤醒文案当标题（例如“G3通过后执行实验任务”）。已有用户标题
        // 保持不动。
        let workflow_name = source.name.clone();
        let input = draft.input.into_plan(objective);
        let existing = self.research_for_session(session_id)?;
        // 先检查绑定锁定，再校验新草稿：已经绑定了别的工作流的会话应看到
        // “不能更换”，而不是新草稿自身的一条结构校验错误。
        if let Some(study) = &existing {
            study.ensure_active()?;
            // 绑定锁定：会话已经用过别的工作流就不再换绑；同一工作流的迭代提交
            // （G1 范围确认后调整目标重发）保持放行，否则确认流程会被卡死。
            if let Some(bound) = study
                .plans
                .last()
                .and_then(|plan| plan.workflow_source.as_ref())
            {
                if bound.id != draft_id {
                    return Err(anyhow!("该对话已绑定工作流「{}」，不能更换", bound.name));
                }
            }
        }
        validate_plan_with_roles(
            &input,
            existing.as_ref().map_or("team", |s| s.mode.as_str()),
            true,
            |role| crate::local::research::role_for_store(self, role).map(|_| ()),
        )?;
        let study = match existing {
            Some(study) => study,
            None => self.research_create(session_id, "team", objective)?,
        };
        let agents = self.research_agent_snapshots(&input)?;
        if study.objective == objective
            && study
                .plans
                .last()
                .is_some_and(|plan| plan.workflow_source.as_ref() == Some(&source))
            && self.research_plan_equivalent(&study, &input, &agents)?
        {
            self.set_chat_session_title_if_placeholder(session_id, &workflow_name)?;
            return Ok((study.id.clone(), study.plan()?.version, true));
        }
        let mut prepared = self.research_prepare_plan_with_inspector(
            &study.id,
            input,
            PreparedArtifact::inspect,
            true,
        )?;
        if study.objective != objective {
            prepared.artifacts.clear();
        }
        prepared.source = Some(source);
        prepared.objective = Some(objective.to_owned());
        prepared.deduplicate = true;
        let (version, deduplicated) = self.research_commit_plan(prepared)?;
        self.set_chat_session_title_if_placeholder(session_id, &workflow_name)?;
        Ok((study.id, version, deduplicated))
    }
    pub fn research_set_plan(&self, id: &str, input: PlanInput) -> Result<()> {
        let prepared =
            self.research_prepare_plan_with_inspector(id, input, PreparedArtifact::inspect, false)?;
        self.research_commit_plan(prepared).map(|_| ())
    }

    #[cfg(test)]
    pub fn research_set_plan_idempotent(&self, id: &str, input: PlanInput) -> Result<(u32, bool)> {
        let study = self.research_study(id)?;
        let agents = self.research_agent_snapshots(&input)?;
        if self.research_plan_equivalent(&study, &input, &agents)? {
            return Ok((study.plan()?.version, true));
        }
        let mut prepared =
            self.research_prepare_plan_with_inspector(id, input, PreparedArtifact::inspect, false)?;
        prepared.deduplicate = true;
        self.research_commit_plan(prepared)
    }

    fn research_agent_snapshots(
        &self,
        input: &PlanInput,
    ) -> Result<HashMap<String, AgentSnapshot>> {
        let mut agents = HashMap::new();
        for task in &input.tasks {
            if let Some(agent) = self.workflow_agent(&task.role)? {
                let mut snapshot = AgentSnapshot::from(&agent);
                // MCP 挂载随 agent 一起冻结（仅 id，名称 best-effort，不含命令与密钥）。
                // 注册表里的配置与存在性在派发注入时从活注册表解析，删掉的服务跳过。
                snapshot.mcp_servers = self
                    .workflow_agent_mcp_ids(&agent.id)?
                    .into_iter()
                    .map(|mcp_id| McpServerSnapshot {
                        name: crate::local::mcp_registry::server(&mcp_id)
                            .map(|server| server.name)
                            .unwrap_or_else(|| mcp_id.clone()),
                        id: mcp_id,
                    })
                    .collect();
                // 技能挂载只冻结名字；派发的会话注入时已删除的技能自然跳过。
                snapshot.user_skills =
                    self.skill_bindings_for_scope(crate::store::skills::SCOPE_AGENT, &agent.id)?;
                agents.insert(task.role.clone(), snapshot);
            }
        }
        Ok(agents)
    }

    fn research_plan_equivalent(
        &self,
        study: &Study,
        input: &PlanInput,
        agents: &HashMap<String, AgentSnapshot>,
    ) -> Result<bool> {
        let Ok(plan) = study.plan() else {
            return Ok(false);
        };
        let material_ids = crate::local::materials::session_ids(self, &study.session_id)?;
        Ok(plan.summary == input.summary
            && plan.workflow == input.workflow
            && plan.material_ids.as_ref() == Some(&material_ids)
            && plan.tasks.len() == input.tasks.len()
            && plan.tasks.iter().zip(&input.tasks).all(|(previous, spec)| {
                previous.spec == *spec && same_agent(previous, &spec.role, agents)
            }))
    }

    fn research_validate_plan_revision(
        &self,
        study: &Study,
        input: &PlanInput,
        explicit_method: bool,
    ) -> Result<()> {
        study.ensure_active()?;
        validate_plan_with_roles(input, &study.mode, explicit_method, |role| {
            crate::local::research::role_for_store(self, role).map(|_| ())
        })?;
        if study.claim_revision.is_some() || study.metric_citation_revision.is_some() {
            claims::require_review_roles(input.tasks.iter().map(|task| task.role.as_str()))?;
        }
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
        Ok(())
    }

    pub(super) fn research_prepare_plan_with_inspector(
        &self,
        id: &str,
        input: PlanInput,
        mut inspect: impl FnMut(&Path, &str) -> Result<PreparedArtifact>,
        explicit_method: bool,
    ) -> Result<PreparedPlan> {
        let study = self.research_study(id)?;
        self.research_validate_plan_revision(&study, &input, explicit_method)?;
        let agents = self.research_agent_snapshots(&input)?;
        let mut artifacts = HashMap::new();
        if input.workflow.as_deref().unwrap_or(&study.mode) == study.workflow_mode() {
            if let (Some(previous), Ok(root)) = (study.plans.last(), self.research_root(&study)) {
                for spec in &input.tasks {
                    let Some(prev) = previous.tasks.iter().find(|task| task.spec.id == spec.id)
                    else {
                        continue;
                    };
                    if spec.force_rerun
                        || prev.state != "completed"
                        || prev.artifacts.is_empty()
                        || prev.spec.role != spec.role
                        || prev.spec.brief != spec.brief
                        || prev.spec.outputs != spec.outputs
                        || prev.spec.depends_on != spec.depends_on
                        || prev.spec.kind != spec.kind
                        || prev.spec.route != spec.route
                        || prev.spec.route_branch != spec.route_branch
                        || prev.spec.wait_for != spec.wait_for
                        || prev.spec.for_each != spec.for_each
                        || prev.spec.wait_step != spec.wait_step
                        || !same_agent(prev, &spec.role, &agents)
                    {
                        continue;
                    }
                    // Missing, changed, oversized or unsafe outputs keep the old
                    // behavior: this task and its dependents start pending.
                    let verified = prev
                        .artifacts
                        .iter()
                        .map(|expected| {
                            let current = inspect(&root, &expected.path).ok()?;
                            (current.artifact.sha256 == expected.sha256).then_some(current)
                        })
                        .collect::<Option<Vec<_>>>();
                    if let Some(verified) = verified {
                        artifacts.insert(spec.id.clone(), verified);
                    }
                }
            }
        }
        // 计划修订保留会话已经绑定的工作流；绑定锁不允许换绑，修订也不应静默解绑。
        // `research_use_workflow` 仍会在准备完成后用显式 source 覆盖。
        let source = study
            .plans
            .last()
            .and_then(|plan| plan.workflow_source.clone());
        Ok(PreparedPlan {
            study,
            input,
            artifacts,
            agents,
            deduplicate: false,
            source,
            objective: None,
            explicit_method,
        })
    }

    pub(super) fn research_commit_plan(&self, prepared: PreparedPlan) -> Result<(u32, bool)> {
        let mut submission = None;
        self.research_update(&prepared.study.id, |study| {
            if !study.same_document(&prepared.study) {
                return Err(anyhow!("研究状态在产物核验期间发生变化，请刷新后重新提交计划"));
            }
            if prepared.deduplicate
                && prepared.objective.as_ref().is_none_or(|objective| objective == &study.objective)
                && prepared.source.as_ref().is_none_or(|source| study.plans.last().is_some_and(|plan| plan.workflow_source.as_ref() == Some(source)))
                && self.research_plan_equivalent(study, &prepared.input, &prepared.agents)?
            {
                submission = Some((study.plan()?.version, true));
                return Ok(());
            }
            let input = prepared.input;
            let agents = prepared.agents;
            self.research_validate_plan_revision(study, &input, prepared.explicit_method)?;
            let version = study.plans.last().map_or(1, |p| p.version + 1);
            // Compare effective routes: legacy manual plans may omit workflow,
            // while a team plan may select a different research contract.
            let same_workflow =
                input.workflow.as_deref().unwrap_or(&study.mode) == study.workflow_mode();
            let root = self.research_root(study).ok();
            let evidence_digest = self.research_evidence(study)?.digest()?;
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
            // Material packages are immutable. Their IDs already identify the
            // source/hash snapshot; do not re-read every original under this write lock.
            let material_ids = crate::local::materials::session_ids(self, &study.session_id)?;
            let same_materials = match study.plans.last().and_then(|plan| plan.material_ids.as_ref()) {
                Some(previous) => previous == &material_ids,
                None if material_ids.is_empty() => {
                    // Retain ordinary legacy no-material plans, but never infer
                    // that an old expert's known material inputs were also empty.
                    let mut had_materials = false;
                    for task in prev_tasks.values() {
                        if let Some(session) = &task.session_id {
                            if self.get_chat_session(session)?.and_then(|s| s.bootstrap_context)
                                .is_some_and(|context| context.contains("<research-materials>")) {
                                had_materials = true;
                                break;
                            }
                        }
                    }
                    !had_materials
                }
                None => false, // No recorded baseline for a legacy material plan.
            };
            let mut inherited_ids = HashSet::new();
            loop {
                let before = inherited_ids.len();
                for spec in &input.tasks {
                    if !same_workflow || !same_materials || inherited_ids.contains(&spec.id) || spec.force_rerun {
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
                        || prev.spec.inputs != spec.inputs
                        || prev.spec.kind != spec.kind
                        || prev.spec.route != spec.route
                        || prev.spec.route_branch != spec.route_branch
                        || prev.spec.wait_for != spec.wait_for
                        || prev.spec.for_each != spec.for_each
                        || prev.spec.wait_step != spec.wait_step
                        || !same_agent(prev, &spec.role, &agents)
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
                        prepared.artifacts.get(&spec.id).is_some_and(|artifacts| {
                            // No file body reads occur in this transaction. A race
                            // after preparation rejects the entire stale update.
                            artifacts.iter().all(|a| a.check_unchanged(root_dir).is_ok())
                        })
                    });
                    if prepared.artifacts.contains_key(&spec.id) && !artifacts_valid {
                        return Err(anyhow!("研究产物核验后发生变化，请重新提交计划"));
                    }
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
                            agent: prev.agent.clone(),
                            verdict: prev.verdict.clone(),
                            rework_count: prev.rework_count,
                            rework_feedback: prev.rework_feedback.clone(),
                            route_decision: prev.route_decision.clone(),
                            foreach_items: prev.foreach_items.clone(),
                            foreach_runs: prev.foreach_runs.clone(),
                            wait_started_at: None,
                        });
                        continue;
                    }
                }
                let agent = agents.get(&spec.role).cloned();
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
                    agent,
                    verdict: None,
                    rework_count: 0,
                    rework_feedback: None,
                    route_decision: None,
                    foreach_items: None,
                    foreach_runs: vec![],
                    wait_started_at: None,
                });
            }
            study.delivery_error = None;
            if let Some(objective) = prepared.objective { study.objective = objective; }
            study.plans.push(ResearchPlan {
                version,
                workflow_source: prepared.source,
                material_ids: Some(material_ids),
                workflow: input.workflow,
                summary: input.summary,
                tasks,
            });
            study.request_gate("G1", study.plan_scope()?)?;
            // 继承下来的需确认任务在新版本下重新生成任务确认门，随 G1 一起出现在人工确认页。
            let approval_ids: Vec<String> = study
                .plan()?
                .tasks
                .iter()
                .filter(|task| {
                    task.state == "completed"
                        && task.spec.requires_approval
                        && !task.artifacts.is_empty()
                })
                .map(|task| task.spec.id.clone())
                .collect();
            for task_id in &approval_ids {
                let scope = study.task_gate_scope(task_id)?;
                study.request_gate(&Study::task_gate_id(task_id), scope)?;
            }
            submission = Some((version, false));
            Ok(())
        })?;
        let study = self.research_study(&prepared.study.id)?;
        self.research_ensure_objective_message(&study)?;
        Ok(submission.expect("research plan update must return a submission"))
    }
}
