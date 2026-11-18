use super::*;
use crate::workflow::{AgentDefinition, AgentInput, WorkflowDraftInput};

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
            let name = prompt
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or(id)
                .trim_start_matches('#')
                .trim();
            let description = prompt
                .lines()
                .map(str::trim)
                .skip(1)
                .find(|line| !line.is_empty())
                .unwrap_or(name);
            json!({
                "id": id,
                "name": name,
                "description": description,
                "prompt": prompt,
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
        for (agent, (_, prompt)) in agents.iter().zip(crate::local::research::ROLES) {
            assert_eq!(agent["prompt"].as_str(), Some(*prompt));
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

pub(super) async fn copy_workflow(Path(id): Path<String>) -> ApiResult {
    blocking_api(move || {
        let draft = Store::open()?
            .copy_workflow_draft(&id)
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
