//! Prepare inherited artifact hashes without a SQLite writer, then revalidate
//! the aggregate and current eligibility in the short plan revision transaction.
use std::collections::HashMap;

use super::files::PreparedArtifact;
use super::*;
use crate::workflow::AgentSnapshot;

pub(super) struct PreparedPlan {
    study: Study,
    input: PlanInput,
    artifacts: HashMap<String, Vec<PreparedArtifact>>,
    agents: HashMap<String, AgentSnapshot>,
    deduplicate: bool,
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
    pub fn research_set_plan(&self, id: &str, input: PlanInput) -> Result<()> {
        let prepared =
            self.research_prepare_plan_with_inspector(id, input, PreparedArtifact::inspect)?;
        self.research_commit_plan(prepared).map(|_| ())
    }

    pub fn research_set_plan_idempotent(&self, id: &str, input: PlanInput) -> Result<(u32, bool)> {
        let study = self.research_study(id)?;
        let agents = self.research_agent_snapshots(&input)?;
        if self.research_plan_equivalent(&study, &input, &agents)? {
            return Ok((study.plan()?.version, true));
        }
        let mut prepared =
            self.research_prepare_plan_with_inspector(id, input, PreparedArtifact::inspect)?;
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
                agents.insert(task.role.clone(), AgentSnapshot::from(&agent));
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

    fn research_validate_plan_revision(&self, study: &Study, input: &PlanInput) -> Result<()> {
        study.ensure_active()?;
        validate_plan_with_roles(input, &study.mode, |role| {
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
    ) -> Result<PreparedPlan> {
        let study = self.research_study(id)?;
        self.research_validate_plan_revision(&study, &input)?;
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
        Ok(PreparedPlan {
            study,
            input,
            artifacts,
            agents,
            deduplicate: false,
        })
    }

    pub(super) fn research_commit_plan(&self, prepared: PreparedPlan) -> Result<(u32, bool)> {
        let mut submission = None;
        self.research_update(&prepared.study.id, |study| {
            if !study.same_document(&prepared.study) {
                return Err(anyhow!("研究状态在产物核验期间发生变化，请刷新后重新提交计划"));
            }
            if prepared.deduplicate
                && self.research_plan_equivalent(study, &prepared.input, &prepared.agents)?
            {
                submission = Some((study.plan()?.version, true));
                return Ok(());
            }
            let input = prepared.input;
            let agents = prepared.agents;
            self.research_validate_plan_revision(study, &input)?;
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
                });
            }
            study.delivery_error = None;
            study.plans.push(ResearchPlan {
                version,
                material_ids: Some(material_ids),
                workflow: input.workflow,
                summary: input.summary,
                tasks,
            });
            study.request_gate("G1", study.plan_scope()?)?;
            submission = Some((version, false));
            Ok(())
        })?;
        Ok(submission.expect("research plan update must return a submission"))
    }
}
