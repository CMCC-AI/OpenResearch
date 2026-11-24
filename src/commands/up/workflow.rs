use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::*;
use crate::workflow::{AgentDefinition, AgentInput, WorkflowDraftInput};

/// 生成中的正文快照节流间隔：足够让画布逐步长出节点，又不至于塞满事件总线。
const DELTA_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);

/// 随 handler future 一起丢弃：客户端断开时取消还在跑的生成。
struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

fn agent_json(
    agent: &AgentDefinition,
    built_in: bool,
    mcp_ids: &[String],
    skill_names: &[String],
) -> Value {
    json!({
        "id": agent.id,
        "name": agent.name,
        "description": agent.description,
        "prompt": agent.prompt,
        "mcpServers": mcp_ids,
        "userSkills": skill_names,
        "version": agent.version,
        "builtIn": built_in,
        "createdAt": agent.created_at,
        "updatedAt": agent.updated_at,
    })
}

/// 挂载技能的存在性校验：与 MCP 一致，在 API/CLI 入口做，store 只负责持久化。
fn validate_user_skill_refs(skill_names: &[String]) -> crate::error::Result<()> {
    let uploaded = crate::local::user_skills::list_uploaded();
    for name in skill_names {
        if !uploaded.iter().any(|skill| &skill.name == name) {
            return Err(crate::error::anyhow!("未知技能: {name}"));
        }
    }
    Ok(())
}

fn built_in_agents() -> Vec<Value> {
    let skills = crate::local::agent_skills::skills(crate::local::agent_skills::SkillSet::Local)
        .into_iter()
        .map(|skill| json!({"name":skill.name,"description":skill.description}))
        .collect::<Vec<_>>();
    crate::local::research::ROLES
        .iter()
        .map(|(id, prompt)| {
            let (name, description) = crate::local::research::role_brief(id, prompt);
            // 内置角色的提示词由核心调优维护，不在 API 结果中下发；派发侧经 role_for_store 内部解析。
            json!({
                "id": id,
                "name": name,
                "description": description,
                "mcpServers": [],
                "userSkills": [],
                "toolPermissions": [
                    "实际工具权限由主会话和 Agent 引擎决定，不设置角色独立白名单",
                    "禁止自行派生其他专家",
                    "实验必须通过受管的 orx exp run，不得用 Bash 直接启动训练或评测",
                    "不得自行批准 G1–G4",
                ],
                "skills": skills.clone(),
                "version": 0,
                "builtIn": true,
                "createdAt": 0,
                "updatedAt": 0,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_agents_expose_role_configuration() {
        let agents = built_in_agents();
        let skill_count =
            crate::local::agent_skills::skills(crate::local::agent_skills::SkillSet::Local).len();
        assert_eq!(agents.len(), crate::local::research::ROLES.len());
        for (agent, (id, _)) in agents.iter().zip(crate::local::research::ROLES) {
            // 内置角色的提示词是核心调优内容，API 结果不得携带。
            assert!(
                agent.get("prompt").is_none(),
                "内置角色 {id} 不应下发 prompt"
            );
            assert_ne!(agent["description"], agent["name"]);
            assert_eq!(agent["skills"].as_array().map(Vec::len), Some(skill_count));
            // 内置角色不挂 MCP 服务：挂载是自定义专家的能力。
            assert_eq!(agent["mcpServers"].as_array().map(Vec::len), Some(0));
            // 内置角色同样不挂用户技能。
            assert_eq!(agent["userSkills"].as_array().map(Vec::len), Some(0));
            assert!(agent["toolPermissions"]
                .as_array()
                .is_some_and(|permissions| !permissions.is_empty()));
        }
    }
}

pub(super) async fn agents() -> ApiResult {
    blocking_api(move || {
        let store = Store::open()?;
        let mut agents = built_in_agents();
        let attachments = store.list_workflow_agent_mcps()?;
        let skill_attachments = store.list_skill_bindings()?;
        for agent in store.list_workflow_agents()? {
            let mcps: Vec<String> = attachments
                .iter()
                .filter(|(id, _)| id == &agent.id)
                .map(|(_, mcp_id)| mcp_id.clone())
                .collect();
            let skills: Vec<String> = skill_attachments
                .iter()
                .filter(|(kind, id, _)| {
                    kind == crate::store::skills::SCOPE_AGENT && id == &agent.id
                })
                .map(|(_, _, name)| name.clone())
                .collect();
            agents.push(agent_json(&agent, false, &mcps, &skills));
        }
        Ok(Json(json!({"agents":agents})))
    })
    .await
}

pub(super) async fn create_agent(Json(input): Json<AgentInput>) -> ApiResult {
    blocking_api(move || {
        crate::local::mcp_registry::validate_mcp_refs(&input.mcp_servers).map_err(bad_request)?;
        validate_user_skill_refs(&input.user_skills).map_err(bad_request)?;
        let store = Store::open()?;
        let agent = store.create_workflow_agent(input).map_err(bad_request)?;
        let mcps = store.workflow_agent_mcp_ids(&agent.id)?;
        let skills =
            store.skill_bindings_for_scope(crate::store::skills::SCOPE_AGENT, &agent.id)?;
        Ok(Json(
            json!({"agent":agent_json(&agent,false,&mcps,&skills)}),
        ))
    })
    .await
}

pub(super) async fn update_agent(
    Path(id): Path<String>,
    Json(input): Json<AgentInput>,
) -> ApiResult {
    blocking_api(move || {
        crate::local::mcp_registry::validate_mcp_refs(&input.mcp_servers).map_err(bad_request)?;
        validate_user_skill_refs(&input.user_skills).map_err(bad_request)?;
        let store = Store::open()?;
        let agent = store
            .update_workflow_agent(&id, input)
            .map_err(bad_request)?;
        let mcps = store.workflow_agent_mcp_ids(&agent.id)?;
        let skills =
            store.skill_bindings_for_scope(crate::store::skills::SCOPE_AGENT, &agent.id)?;
        Ok(Json(
            json!({"agent":agent_json(&agent,false,&mcps,&skills)}),
        ))
    })
    .await
}

pub(super) async fn delete_agent(Path(id): Path<String>) -> ApiResult {
    blocking_api(move || {
        if !Store::open()?.delete_workflow_agent(&id)? {
            return Err(not_found("custom agent"));
        }
        Ok(Json(json!({"ok":true})))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftGenerationRequest {
    pub intent: String,
    #[serde(default)]
    pub locale: String,
    /// 前端生成的请求标识：阶段事件原样回传，多标签页只推进自己的过程清单。
    #[serde(default)]
    pub request_id: String,
}

/// 一句话生成自定义 Agent 草稿：一次 headless 模型调用（最长 300s），
/// 产出直接可进创建接口的 AgentInput；引用只来自本机库存，内置提示词不出库。
/// 等待期借 `/api/events` 广播 `agentDraft.progress` 阶段事件（datadir.move 同款
/// 管道），前端右侧按真实动作推进过程清单。
pub(super) async fn generate_agent_draft(
    State(state): State<AppState>,
    Json(req): Json<DraftGenerationRequest>,
) -> ApiResult {
    let request_id = req.request_id.trim().to_string();
    let (intent, locale) = draft_intent(req)?;
    let chat = state.chat.clone();
    let progress = move |stage: local::agent_draft::DraftStage| {
        chat.emit_event(
            "agentDraft.progress",
            json!({ "requestId": request_id, "stage": stage.as_str() }),
        );
    };
    let inventories =
        tokio::task::spawn_blocking(move || local::agent_draft::inventories(&Store::open()?))
            .await
            .map_err(|e| ApiError::from(anyhow!("agent draft task failed: {e}")))?
            .map_err(ApiError::from)?;
    progress(local::agent_draft::DraftStage::Inventory);
    let agent = local::agent_draft::generate(&intent, &locale, &inventories, progress)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(json!({
        "agent": {
            "name": agent.name,
            "description": agent.description,
            "prompt": agent.prompt,
            "mcpServers": agent.mcp_servers,
            "userSkills": agent.user_skills,
        }
    })))
}

/// 一句话生成整张工作流草稿：同样一次 headless 模型调用；产出只含 agent 任务，
/// 已消毒为可通过结构校验的 DAG，坐标由前端按依赖分层补齐。等待期按真实节点
/// 广播 `workflowDraft.progress`，前端和 AI 建专家一样有过程清单。
pub(super) async fn generate_workflow_draft(
    State(state): State<AppState>,
    Json(req): Json<DraftGenerationRequest>,
) -> ApiResult {
    let request_id = req.request_id.trim().to_string();
    let (intent, locale) = draft_intent(req)?;
    let chat = state.chat.clone();
    let progress = {
        let (chat, request_id) = (chat.clone(), request_id.clone());
        move |stage: local::draft_support::DraftStage| {
            chat.emit_event(
                "workflowDraft.progress",
                json!({ "requestId": request_id, "stage": stage.as_str() }),
            );
        }
    };
    // 客户端断开时 handler future 被丢弃，guard 随即取消生成；否则一次 300s 的
    // 模型调用会在后台白跑。
    let cancel = CancellationToken::new();
    let _cancel_guard = CancelOnDrop(cancel.clone());
    let sink = local::harness::OneShotSink {
        on_text: std::sync::Arc::new({
            let (chat, request_id) = (chat.clone(), request_id.clone());
            // 正文快照按 ~150ms 节流：事件总线只有 16 个槽位，逐 token 发会丢事件。
            let last = std::sync::Arc::new(std::sync::Mutex::new(None::<Instant>));
            move |text: &str| {
                let mut last = last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if last.is_some_and(|at| at.elapsed() < DELTA_INTERVAL) {
                    return;
                }
                *last = Some(Instant::now());
                chat.emit_event(
                    "workflowDraft.delta",
                    json!({ "requestId": request_id, "text": text }),
                );
            }
        }),
        cancel: Some(cancel.clone()),
    };
    let agents =
        tokio::task::spawn_blocking(
            move || local::workflow_draft::agent_inventory(&Store::open()?),
        )
        .await
        .map_err(|e| ApiError::from(anyhow!("workflow draft task failed: {e}")))?
        .map_err(ApiError::from)?;
    progress(local::draft_support::DraftStage::Inventory);
    let draft = local::workflow_draft::generate(&intent, &locale, &agents, progress, Some(sink))
        .await
        .map_err(ApiError::from)?;
    Ok(Json(json!({
        "draft": {
            "name": draft.name,
            "objective": "",
            "summary": "",
            "workflow": "custom",
            "tasks": draft.tasks,
        }
    })))
}

fn draft_intent(req: DraftGenerationRequest) -> std::result::Result<(String, String), ApiError> {
    let intent = req.intent.trim().to_string();
    if intent.is_empty() {
        return Err(bad_request("请先用一句话描述要生成的内容"));
    }
    if intent.chars().count() > local::draft_support::INTENT_CHARS {
        return Err(bad_request(format!(
            "描述请控制在 {} 字以内",
            local::draft_support::INTENT_CHARS
        )));
    }
    let locale = if req.locale.trim().is_empty() {
        "en".to_string()
    } else {
        req.locale.trim().to_string()
    };
    Ok((intent, locale))
}

/// 能力中心的技能视图：内置 orx-* 模块与用户技能（上传 + 镜像）合并成一份只读列表，
/// 用户技能附带生效范围（legacy 全局标记 + 项目/专家绑定摘要）。上传与删除继续走
/// `/api/user-skills`，绑定走 `/api/skill-bindings`，这里只负责工作流场景的统一展示。
pub(super) async fn skills() -> ApiResult {
    blocking_api(move || {
        let builtin =
            crate::local::agent_skills::skills(crate::local::agent_skills::SkillSet::Local)
                .into_iter()
                .map(|skill| {
                    json!({
                        "name": skill.name,
                        "description": skill.description,
                        "source": "builtin",
                        "origin": Value::Null,
                        "bytes": Value::Null,
                        "updatedAt": Value::Null,
                    })
                })
                .collect::<Vec<_>>();
        let store = Store::open()?;
        let legacy: std::collections::HashSet<String> =
            store.legacy_global_skills()?.into_iter().collect();
        let bindings = store.list_skill_bindings()?;
        let summarize = |name: &str, kind: &str| -> Vec<String> {
            bindings
                .iter()
                .filter(|(scope_kind, _, skill)| scope_kind == kind && skill == name)
                .map(|(_, scope_id, _)| scope_id.clone())
                .collect()
        };
        let user = crate::local::user_skills::list_uploaded()
            .into_iter()
            .map(|skill| {
                json!({
                    "name": skill.name,
                    "description": Value::Null,
                    "source": "user",
                    "origin": skill.origin,
                    "bytes": skill.bytes,
                    "updatedAt": skill.updated_at,
                    "legacyGlobal": legacy.contains(&skill.name),
                    "boundProjects": summarize(&skill.name, crate::store::skills::SCOPE_PROJECT),
                    "boundAgents": summarize(&skill.name, crate::store::skills::SCOPE_AGENT),
                })
            })
            .collect::<Vec<_>>();
        let mut skills = builtin;
        skills.extend(user);
        Ok(Json(json!({"skills": skills})))
    })
    .await
}

/// The workflow library is shared: every project lists and runs every draft,
/// `projectId` only records where a workflow was created ("" = globally).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateWorkflow {
    #[serde(flatten)]
    input: WorkflowDraftInput,
    #[serde(default)]
    project_id: String,
}

pub(super) async fn list_workflows() -> ApiResult {
    blocking_api(move || {
        let drafts = Store::open()?.list_workflow_drafts()?;
        Ok(Json(json!({"drafts":drafts})))
    })
    .await
}

pub(super) async fn create_workflow(Json(request): Json<CreateWorkflow>) -> ApiResult {
    blocking_api(move || {
        let draft = Store::open()?
            .create_workflow_draft(&request.project_id, request.input)
            .map_err(bad_request)?;
        Ok(Json(json!({"draft":draft})))
    })
    .await
}

pub(super) async fn get_workflow(Path(id): Path<String>) -> ApiResult {
    blocking_api(move || {
        let draft = Store::open()?
            .workflow_draft_by_id(&id)?
            .ok_or_else(|| not_found("workflow"))?;
        Ok(Json(json!({"draft":draft})))
    })
    .await
}

pub(super) async fn save_workflow(
    Path(id): Path<String>,
    Json(input): Json<WorkflowDraftInput>,
) -> ApiResult {
    blocking_api(move || {
        let draft = Store::open()?
            .save_workflow_draft_by_id(&id, input)
            .map_err(bad_request)?;
        Ok(Json(json!({"draft":draft})))
    })
    .await
}

pub(super) async fn delete_workflow(Path(id): Path<String>) -> ApiResult {
    blocking_api(move || {
        if !Store::open()?.delete_workflow_draft(&id)? {
            return Err(not_found("workflow"));
        }
        Ok(Json(json!({"ok":true})))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SubmitDraft {
    draft_id: String,
    #[serde(default)]
    objective: String,
}

pub(super) async fn submit_draft(
    Path(session_id): Path<String>,
    Json(request): Json<SubmitDraft>,
) -> ApiResult {
    blocking_api(move || {
        let objective = request.objective.trim();
        if objective.is_empty() {
            return Err(bad_request("请填写研究目标"));
        }
        if objective.len() > 24000 {
            return Err(bad_request("研究目标不能超过 24000 个字符"));
        }
        let store = Store::open()?;
        let (study_id, version, deduplicated) = store
            .research_use_workflow(&session_id, &request.draft_id, objective)
            .map_err(bad_request)?;
        Ok(Json(json!({
            "studyId": study_id,
            "sessionId": session_id,
            "version": version,
            "deduplicated": deduplicated,
        })))
    })
    .await
}
