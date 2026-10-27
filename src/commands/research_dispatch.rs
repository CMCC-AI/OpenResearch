//! Product-only expert dispatch, separate from upstream independent chats.
use crate::error::{anyhow, Result};
use crate::local::harness::PermissionMode;
use crate::store::{now_ms, ChatSpawn, Store, StoredChatSession};
use std::io::Read;
const MAX_LIVE_SPAWNS: i64 = 5;

fn task_text(task: Option<String>, stdin: bool) -> Result<String> {
    if stdin {
        if task.is_some() {
            return Err(anyhow!(
                "Pass the task as an argument or --stdin, not both."
            ));
        }
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| anyhow!("Could not read the task from stdin: {e}"))?;
        return non_empty(buf);
    }
    non_empty(task.unwrap_or_default())
}

fn non_empty(text: String) -> Result<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(anyhow!(
            "Describe the task for the spawned agent: `orx agent spawn \"<task>\"`."
        ));
    }
    Ok(trimmed.to_string())
}

/// Why this session may not spawn right now, if it may not. Depth and breadth
/// are the two ways one request becomes an unbounded tree of paid sessions, and
/// nothing downstream of here bounds either.
fn spawn_refusal(parent: &StoredChatSession, live: i64) -> Option<String> {
    if parent.parent_session_id.is_some() {
        return Some(
            "This session was itself spawned by another agent, and spawned agents cannot spawn \
             their own. Do the task here, or report back so the session that spawned you can \
             delegate it."
                .to_string(),
        );
    }
    (live >= MAX_LIVE_SPAWNS).then(|| {
        format!(
            "You already have {live} agents in flight, the most one session may run at once. \
             Wait for one to report back before spawning another."
        )
    })
}

/// Refuse a helper the resident `orx up` cannot launch: this command only queues
/// it, so otherwise the caller hears "spawned" and the failure lands later.
async fn ensure_installed(harness: &str) -> Result<()> {
    // Any failure to ask falls back to queueing.
    let Ok(Some(port)) = crate::local::chat::trusted_up_port() else {
        return Ok(());
    };
    let Ok(install) = crate::commands::up::harness_install_via_up(port, harness).await else {
        return Ok(());
    };
    match install_refusal(harness, &install) {
        Some(refusal) => Err(anyhow!(refusal)),
        None => Ok(()),
    }
}

fn install_refusal(harness: &str, install: &crate::commands::up::HarnessInstall) -> Option<String> {
    (!install.installed).then(|| {
        format!(
            "The OpenResearch server (the desktop app or `orx up`) cannot find {}, so no agent \
             was spawned. Spawn on this session's own harness by omitting `--harness {harness}`, \
             or ask the user to install it and restart OpenResearch.",
            install.name
        )
    })
}

/// Reserve the writer before checking capacity, and hold it through insertion.
fn reserve_spawn<'a>(
    store: &'a Store,
    parent: &StoredChatSession,
) -> Result<rusqlite::Transaction<'a>> {
    reserve_spawn_ignoring(store, parent, None)
}

fn reserve_spawn_ignoring<'a>(
    store: &'a Store,
    parent: &StoredChatSession,
    ignore_session: Option<&str>,
) -> Result<rusqlite::Transaction<'a>> {
    let tx = store.begin_immediate()?;
    let mut live = store.count_live_chat_spawns(&parent.id)?;
    if let Some(ignore) = ignore_session {
        if store
            .get_chat_spawn(ignore)?
            .is_some_and(|s| s.parent_session_id == parent.id)
        {
            live = (live - 1).max(0);
        }
    }
    if let Some(refusal) = spawn_refusal(parent, live) {
        return Err(anyhow!(refusal));
    }
    Ok(tx)
}

#[derive(Debug)]
pub(crate) enum ResearchWakeAction {
    RetireSilently,
    NudgeHelper(String),
    WakeLead(String),
}

pub(crate) fn dispatch_study_task_sync(
    store: &Store,
    study_id: &str,
    task_id: &str,
    ignore_session: Option<&str>,
) -> Result<Option<String>> {
    let study = store.research_study(study_id)?;
    study.ready(task_id)?;
    let entry = study.task(task_id)?;
    if entry.state != "pending" || entry.session_id.is_some() {
        return Ok(None);
    }
    let parent = store
        .get_chat_session(&study.session_id)?
        .ok_or_else(|| anyhow!("The current chat session no longer exists."))?;
    let existing_runs_note = if entry.spec.role == "as-experiment-operator"
        && !entry.run_ids.is_empty()
    {
        format!(
                "\n注意：该任务的真实实验运行已完成（Run ID: {}），请勿重复执行 `orx exp run`；请直接读取已有运行日志与结果并生成上述声明产物文件。",
                entry.run_ids.join(", ")
            )
    } else {
        String::new()
    };
    let prompt = format!(
        "执行研究任务 {}。独立完成角色职责，读取声明的依赖产物，全部输出写入 {}（必须生成以下相对路径文件：{}），完成后调用 `orx research finish --file <json-path>` 登记验收。{}\n{}\n{}",
        task_id,
        store.research_root(&study)?.display(),
        entry.spec.outputs.join("、"),
        existing_runs_note,
        entry.spec.brief,
        crate::local::research::role(&entry.spec.role)?
    );
    let harness = parent.harness.clone();
    let plan_permission =
        crate::local::harness::permission_id_for_mode(&harness, PermissionMode::Plan);
    let session = StoredChatSession {
        id: format!("chat_{}", uuid::Uuid::new_v4()),
        project_id: parent.project_id.clone(),
        harness,
        native_session_id: None,
        title_source: Some("user".to_string()),
        title: Some(format!("{} · {}", entry.spec.role, task_id)),
        model: parent.model.clone(),
        service_tier: parent.service_tier.clone(),
        permission_mode: parent
            .permission_mode
            .clone()
            .filter(|mode| Some(mode) != plan_permission.as_ref()),
        plan_mode: false,
        plan_reset_pending: false,
        reasoning_level: parent.reasoning_level.clone(),
        archived: false,
        context_usage_json: None,
        bootstrap_context: Some(crate::local::materials::session_context(store, &parent.id)?),
        goal: None,
        autonomy: None,
        active_leaf_id: None,
        parent_session_id: Some(parent.id.clone()),
        side_parent_session_id: None,
        side_parent_leaf_id: None,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    let tx = reserve_spawn_ignoring(store, &parent, ignore_session)?;
    store.create_chat_session(&session)?;
    store.research_bind_task(&study.id, task_id, &session.id)?;
    store.create_chat_spawn(&ChatSpawn {
        session_id: session.id.clone(),
        parent_session_id: parent.id,
        prompt,
        wake_parent: true,
        attempts: 0,
        finished_at: None,
    })?;
    tx.commit()?;
    Ok(Some(session.id))
}

pub(crate) fn auto_dispatch_sync(store: &Store, study_id: &str) -> Result<Vec<(String, String)>> {
    auto_dispatch_ignoring_session(store, study_id, None)
}

pub(crate) fn auto_dispatch_ignoring_session(
    store: &Store,
    study_id: &str,
    ignore_session: Option<&str>,
) -> Result<Vec<(String, String)>> {
    let study = store.research_study(study_id)?;
    if study.status != "active" {
        return Ok(Vec::new());
    }
    let Ok(plan) = study.plan() else {
        return Ok(Vec::new());
    };
    let ready_ids: Vec<String> = plan
        .tasks
        .iter()
        .filter(|t| t.state == "pending" && study.ready(&t.spec.id).is_ok())
        .map(|t| t.spec.id.clone())
        .collect();
    let mut dispatched = Vec::new();
    for task_id in ready_ids {
        match dispatch_study_task_sync(store, study_id, &task_id, ignore_session) {
            Ok(Some(session_id)) => dispatched.push((task_id, session_id)),
            Ok(None) => {}
            Err(_) => break,
        }
    }
    Ok(dispatched)
}

pub(crate) fn reconcile_active_studies(store: &Store) -> Result<()> {
    for study in store.research_active_studies()? {
        let _ = auto_dispatch_sync(store, &study.id);
        let Ok(updated) = store.research_study(&study.id) else {
            continue;
        };
        if updated
            .plan()
            .is_ok_and(|p| !p.tasks.is_empty() && p.tasks.iter().all(|t| t.state == "completed"))
        {
            let gate = crate::local::research::delivery_gate(updated.workflow_mode()).to_string();
            match store.research_package_scope(&updated) {
                Ok(scope) => {
                    let _ = store.research_update(&updated.id, |s| s.request_gate(&gate, scope));
                }
                Err(_) => {
                    let _ = store.research_update(&updated.id, |s| s.supersede_gate(&gate));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn on_research_spawn_finished(
    store: &Store,
    session_id: &str,
    interrupted: bool,
    reply: Option<String>,
    failed: bool,
) -> Result<Option<ResearchWakeAction>> {
    let Some((task_id, version)) = store.research_session_task(session_id)? else {
        return Ok(None);
    };
    let Some(mut study) = store.research_for_session(session_id)? else {
        return Ok(None);
    };
    let study_id = study.id.clone();
    if study.status != "active"
        || study.plan().map_or(true, |p| p.version != version)
        || study
            .task(&task_id)
            .map_or(true, |t| t.session_id.as_deref() != Some(session_id))
    {
        return Ok(Some(ResearchWakeAction::RetireSilently));
    }
    if !interrupted {
        let _ = store.mark_chat_spawn_finished(session_id);
    }
    if study.task(&task_id)?.state == "running" {
        let summary = reply
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("已完成任务 {task_id}"));
        let auto_finished = !interrupted
            && !failed
            && store
                .research_finish(&study_id, &task_id, true, summary)
                .is_ok();
        if !auto_finished {
            let current = store.research_study(&study_id)?;
            let task = current.task(&task_id)?;
            if let Some(pending) = task.pending_nudge.clone() {
                return Ok(Some(ResearchWakeAction::NudgeHelper(pending)));
            }
            let attempts = task.attempts;
            if !interrupted && !failed && attempts == 0 {
                let root = store.research_root(&current)?;
                let missing: Vec<String> = task
                    .spec
                    .outputs
                    .iter()
                    .filter(|p| {
                        crate::store::research::read_artifact(&root, p)
                            .map(|b| b.is_empty())
                            .unwrap_or(true)
                    })
                    .cloned()
                    .collect();
                let missing_desc = if missing.is_empty() {
                    task.spec.outputs.join("、")
                } else {
                    missing.join("、")
                };
                let nudge = if task.spec.role == "as-experiment-operator"
                    && !task.run_ids.is_empty()
                {
                    format!(
                        "[orx 研究编排] 实验运行（Run: {}）已结束，但当前任务 `{}` 尚未生成全部声明产物（缺失或为空：{}）。请勿重新启动实验运行；请直接基于已有运行日志写入上述产物文件，并执行 `orx research finish --file <json-path>`。",
                        task.run_ids.join(", "),
                        task_id,
                        missing_desc
                    )
                } else {
                    format!(
                        "[orx 研究编排] 当前专家任务 `{}` 尚未完成验收（缺失或为空的声明产物：{}）。请在当前会话中立即补齐上述文件并执行 `orx research finish --file <json-path>`。",
                        task_id, missing_desc
                    )
                };
                if store
                    .research_nudge_task(&study_id, &task_id, session_id, nudge.clone())
                    .is_ok()
                {
                    return Ok(Some(ResearchWakeAction::NudgeHelper(nudge)));
                }
            }
            if !interrupted
                && attempts <= 1
                && store.research_retry_task(&study_id, &task_id).is_ok()
            {
            } else {
                let reason = reply
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "专家会话结束但未生成全部声明产物".into());
                let _ = store.research_finish(&study_id, &task_id, false, reason);
            }
        }
    }
    let dispatched = auto_dispatch_ignoring_session(store, &study_id, Some(session_id))?;
    study = store.research_study(&study_id)?;
    let mut package_error = None;
    let mut valid_package_hash = None;
    if study
        .plan()
        .is_ok_and(|p| !p.tasks.is_empty() && p.tasks.iter().all(|t| t.state == "completed"))
    {
        let gate = crate::local::research::delivery_gate(study.workflow_mode()).to_string();
        match store.research_package_scope(&study) {
            Ok(scope) => {
                valid_package_hash = Some(crate::store::research::digest(scope.as_bytes()));
                let _ = store.research_update(&study_id, |s| s.request_gate(&gate, scope));
                study = store.research_study(&study_id)?;
            }
            Err(err) => {
                let _ = store.research_update(&study_id, |s| s.supersede_gate(&gate));
                study = store.research_study(&study_id)?;
                package_error = Some(err.to_string());
            }
        }
    }
    let plan = study.plan()?;
    let any_running = plan.tasks.iter().any(|t| t.state == "running") || !dispatched.is_empty();
    let any_failed = plan.tasks.iter().any(|t| t.state == "failed");
    if any_running && !any_failed {
        return Ok(Some(ResearchWakeAction::RetireSilently));
    }
    Ok(Some(ResearchWakeAction::WakeLead(research_wakeup_text(
        &study,
        package_error.as_deref(),
        valid_package_hash.as_deref(),
    )?)))
}

fn research_wakeup_text(
    study: &crate::store::research::Study,
    package_error: Option<&str>,
    valid_package_hash: Option<&str>,
) -> Result<String> {
    let plan = study.plan()?;
    let total = plan.tasks.len();
    let completed: Vec<&str> = plan
        .tasks
        .iter()
        .filter(|t| t.state == "completed")
        .map(|t| t.spec.id.as_str())
        .collect();
    let failed: Vec<String> = plan
        .tasks
        .iter()
        .filter(|t| t.state == "failed")
        .map(|t| {
            format!(
                "{} ({})",
                t.spec.id,
                t.summary.as_deref().unwrap_or("未通过验收")
            )
        })
        .collect();
    if !failed.is_empty() {
        return Ok(format!(
            "[orx 研究编排] 专家任务未通过验收：{}。已完成任务（{}/{}）：[{}]。若仅需原地重跑失败任务，请执行 `orx research retry <task-id>`；若需根据审稿或诊断反馈调整计划，请执行 `orx research plan --file <path>`（已完成且产物未变动的任务会自动继承，无需重跑）。",
            failed.join("；"),
            completed.len(),
            total,
            completed.join(", ")
        ));
    }
    if completed.len() == total {
        let gate = crate::local::research::delivery_gate(study.workflow_mode());
        if let Some(err) = package_error {
            return Ok(format!(
                "[orx 研究编排] 当前计划（v{}）全部 {} 个专家任务均已完成，但最终交付校验未通过（原因：{}），未能发起有效的 {} 确认申请。请执行 `orx research plan --file <path>` 提交修订计划，对受影响的任务及独立审稿/引用审计节点设置 `\"forceRerun\": true` 重新执行与审查（未受影响且产物完好的前置任务会自动继承）。",
                plan.version, total, err, gate
            ));
        }
        let has_matching_delivery_gate = valid_package_hash.is_some_and(|hash| {
            study.decisions.iter().any(|d| {
                d.version == plan.version
                    && d.gate == gate
                    && d.scope_hash == hash
                    && matches!(d.status.as_str(), "pending" | "approved")
            })
        });
        if !has_matching_delivery_gate {
            return Ok(format!(
                "[orx 研究编排] 当前计划（v{}）全部 {} 个专家任务均已完成，但尚未生成匹配当前交付范围的 {} 确认申请。请执行 `orx research package` 检查交付范围，若存在证据或产物变更请通过 `orx research plan --file <path>` 设置 `\"forceRerun\": true` 重新执行受影响任务。",
                plan.version, total, gate
            ));
        }
        return Ok(format!(
            "[orx 研究编排] 当前计划（v{}）全部 {} 个专家任务均已完成并通过产物 SHA-256 验收，系统已自动发起 {} 交付确认申请。请直接向用户总结本次研究的核心结论、证据状态与局限性，并提示用户在人工确认页面处理 {}，在产物页面查看和下载文件；请勿重新调用 `orx research plan` 或派发任务。",
            plan.version, total, gate, gate
        ));
    }
    if let Some(exp_task) = plan.tasks.iter().find(|t| {
        t.state == "pending"
            && t.spec.role == "as-experiment-operator"
            && t.run_contract.is_none()
            && t.spec
                .depends_on
                .iter()
                .all(|d| study.task(d).is_ok_and(|dep| dep.state == "completed"))
    }) {
        return Ok(format!(
            "[orx 研究编排] 前置专家任务已自动完成并验收（进度 {}/{}）。下一环节实验执行任务 `{}` 需要绑定运行契约。请检查代码分支并提交实验代码后，立即执行 `orx research prepare-run {} <experiment-id> --backend <backend>` 申请 G2/G3 审批；请勿重新调用 `orx research plan`。",
            completed.len(),
            total,
            exp_task.spec.id,
            exp_task.spec.id
        ));
    }
    Ok(format!(
        "[orx 研究编排] 阶段任务已更新（已完成 {}/{}：[{}]）。请查看当前研究状态并继续推进剩余步骤；严禁无故调用 `orx research plan` 重置已有进度。",
        completed.len(),
        total,
        completed.join(", ")
    ))
}

pub(crate) struct SpawnRequest {
    pub task: Option<String>,
    pub stdin: bool,
    pub title: Option<String>,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub wake_parent: bool,
    pub research_task: Option<String>,
}

pub(crate) async fn spawn(store: &Store, request: SpawnRequest) -> Result<()> {
    let SpawnRequest {
        task,
        stdin,
        title,
        harness,
        model,
        wake_parent,
        research_task,
    } = request;
    if !crate::local::chat::in_local_session() {
        return Err(anyhow!(
            "`orx agent spawn` is only available inside a local `orx up` agent session."
        ));
    }
    let parent_id = crate::local::chat::launching_chat_session()
        .ok_or_else(|| anyhow!("This agent session has no chat id to spawn from."))?;
    let parent = store
        .get_chat_session(&parent_id)?
        .ok_or_else(|| anyhow!("The current chat session no longer exists."))?;
    let research = store.research_for_session(&parent_id)?;
    if research.is_none() || research_task.is_none() {
        return Err(anyhow!("专家团请使用 orx research dispatch 登记任务"));
    }
    if let (Some(study), Some(task_id)) = (&research, &research_task) {
        if study.session_id != parent_id {
            return Err(anyhow!("只有主理人可派发专家任务"));
        }
        let task = study.task(task_id)?;
        if let Some(session) = &task.session_id {
            println!("Existing expert session: {session}");
            return Ok(());
        }
        study.ready(task_id)?;
    }
    let prompt = task_text(task, stdin)?;
    let harness = harness.unwrap_or_else(|| parent.harness.clone());
    if !crate::local::harness::is_chat_harness(&harness) {
        return Err(anyhow!("unknown harness: {harness}"));
    }
    // Settings only carry over when the child runs the same harness; a model or
    // permission-mode id from one CLI is meaningless to another.
    let inherits = harness == parent.harness;
    // The parent is already running on its own harness, so only a switch needs checking.
    if !inherits {
        ensure_installed(&harness).await?;
    }
    let changes_model = model
        .as_deref()
        .is_some_and(|model| parent.model.as_deref() != Some(model));
    // Claude activates Plan through its permission mode, not the plan axis, so
    // clearing `plan_mode` alone would still hand a planning parent's helper a
    // mode that only ever produces a plan.
    let plan_permission =
        crate::local::harness::permission_id_for_mode(&harness, PermissionMode::Plan);
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let session = StoredChatSession {
        id: format!("chat_{}", uuid::Uuid::new_v4()),
        project_id: parent.project_id.clone(),
        harness,
        native_session_id: None,
        // "user" = explicitly chosen, so auto-titling leaves it alone.
        title_source: title.is_some().then(|| "user".to_string()),
        title,
        model: model.or_else(|| inherits.then(|| parent.model.clone()).flatten()),
        service_tier: (inherits && !changes_model)
            .then(|| parent.service_tier.clone())
            .flatten(),
        permission_mode: inherits
            .then(|| parent.permission_mode.clone())
            .flatten()
            .filter(|mode| Some(mode) != plan_permission.as_ref()),
        plan_mode: false,
        plan_reset_pending: false,
        reasoning_level: inherits.then(|| parent.reasoning_level.clone()).flatten(),
        archived: false,
        context_usage_json: None,
        // Freeze only material references; never copy the author's conversation to reviewers.
        bootstrap_context: Some(crate::local::materials::session_context(store, &parent_id)?),
        goal: None,
        // Copilot asks the user before acting; a helper has no user to ask.
        autonomy: None,
        active_leaf_id: None,
        parent_session_id: Some(parent_id.clone()),
        side_parent_session_id: None,
        side_parent_leaf_id: None,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    // One transaction: a session row without its spawn row is an empty session
    // in the user's sidebar that nothing will ever start.
    // No network awaits inside the writer reservation.
    let tx = reserve_spawn(store, &parent)?;
    store.create_chat_session(&session)?;
    if let (Some(study), Some(task)) = (&research, &research_task) {
        store.research_bind_task(&study.id, task, &session.id)?;
    }
    store.create_chat_spawn(&ChatSpawn {
        session_id: session.id.clone(),
        parent_session_id: parent_id,
        prompt,
        wake_parent,
        attempts: 0,
        finished_at: None,
    })?;
    tx.commit()?;
    println!("Spawned agent session {}.", session.id);
    println!("It starts within a few seconds and works in its own git worktree.");
    if wake_parent {
        println!("This chat will be resumed with its result when it finishes.");
    } else {
        println!("You will NOT be told when it finishes; check its session yourself.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{install_refusal, spawn_refusal, task_text, MAX_LIVE_SPAWNS};
    use crate::commands::up::HarnessInstall;
    use crate::store::StoredChatSession;

    fn parent(parent_session_id: Option<&str>) -> StoredChatSession {
        StoredChatSession {
            id: "chat_parent".into(),
            project_id: "p1".into(),
            harness: "codex".into(),
            native_session_id: None,
            title: None,
            title_source: None,
            model: None,
            service_tier: None,
            permission_mode: None,
            plan_mode: false,
            plan_reset_pending: false,
            reasoning_level: None,
            archived: false,
            context_usage_json: None,
            bootstrap_context: None,
            goal: None,
            autonomy: None,
            active_leaf_id: None,
            parent_session_id: parent_session_id.map(str::to_string),
            side_parent_session_id: None,
            side_parent_leaf_id: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn concurrent_dispatches_cannot_consume_the_same_last_slot() {
        use super::{reserve_spawn, ChatSpawn, Store};
        use std::sync::{Arc, Barrier};
        let dir = std::env::temp_dir().join(format!("orx-spawn-cap-{}", uuid::Uuid::new_v4()));
        let store = Store::open_at(dir.clone()).unwrap();
        let spawn = |id: String| ChatSpawn {
            session_id: id,
            parent_session_id: "chat_parent".into(),
            prompt: "task".into(),
            wake_parent: true,
            attempts: 0,
            finished_at: None,
        };
        for i in 0..MAX_LIVE_SPAWNS - 1 {
            store
                .create_chat_spawn(&spawn(format!("existing-{i}")))
                .unwrap();
        }
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|i| {
                let dir = dir.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let store = Store::open_at(dir).unwrap();
                    barrier.wait();
                    let Ok(tx) = reserve_spawn(&store, &parent(None)) else {
                        return false;
                    };
                    store.create_chat_spawn(&spawn(format!("new-{i}"))).unwrap();
                    tx.commit().unwrap();
                    true
                })
            })
            .collect();
        let admitted = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(admitted, 1);
        assert_eq!(
            store.count_live_chat_spawns("chat_parent").unwrap(),
            MAX_LIVE_SPAWNS
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_spawned_session_may_not_spawn_its_own() {
        let refusal = spawn_refusal(&parent(Some("chat_grandparent")), 0)
            .expect("a spawned session must be refused");
        assert!(refusal.contains("cannot spawn"), "{refusal}");
        // Depth is refused regardless of how few helpers are in flight.
        assert!(spawn_refusal(&parent(None), 0).is_none());
    }

    #[test]
    fn one_session_may_only_run_so_many_helpers_at_once() {
        assert!(spawn_refusal(&parent(None), MAX_LIVE_SPAWNS - 1).is_none());
        let refusal =
            spawn_refusal(&parent(None), MAX_LIVE_SPAWNS).expect("the cap must refuse one more");
        assert!(refusal.contains("in flight"), "{refusal}");
    }

    #[test]
    fn a_task_is_required_and_comes_from_one_place() {
        assert_eq!(
            task_text(Some("  Sweep the literature  ".into()), false).unwrap(),
            "Sweep the literature"
        );
        assert!(task_text(None, false).is_err());
        assert!(task_text(Some("   ".into()), false).is_err());
        // --stdin and a positional together are ambiguous, so neither is used.
        assert!(task_text(Some("from the args".into()), true).is_err());
    }

    #[test]
    fn install_refusal_only_for_a_missing_harness() {
        let info = |installed| HarnessInstall {
            name: "Codex".into(),
            installed,
        };
        assert_eq!(install_refusal("codex", &info(true)), None);
        let missing = install_refusal("codex", &info(false)).unwrap();
        assert!(missing.contains("cannot find Codex"), "{missing}");
        assert!(missing.contains("`--harness codex`"), "{missing}");
    }
}
