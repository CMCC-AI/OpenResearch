use super::*;
use crate::workflow::{AgentDefinition, AgentInput, WorkflowDraftInput};

fn agent_json(agent: &AgentDefinition, built_in: bool) -> Value {
    json!({
        "id": agent.id,
        "name": agent.name,
        "description": agent.description,
        "prompt": agent.prompt,
        "version": agent.version,
        "builtIn": built_in,
        "createdAt": agent.created_at,
        "updatedAt": agent.updated_at,
    })
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
        agents.extend(
            store
                .list_workflow_agents()?
                .iter()
                .map(|agent| agent_json(agent, false)),
        );
        Ok(Json(json!({"agents":agents})))
    })
    .await
}

pub(super) async fn create_agent(Json(input): Json<AgentInput>) -> ApiResult {
    blocking_api(move || {
        let agent = Store::open()?.create_workflow_agent(input)?;
        Ok(Json(json!({"agent":agent_json(&agent,false)})))
    })
    .await
}

pub(super) async fn update_agent(
    Path(id): Path<String>,
    Json(input): Json<AgentInput>,
) -> ApiResult {
    blocking_api(move || {
        let agent = Store::open()?
            .update_workflow_agent(&id, input)
            .map_err(bad_request)?;
        Ok(Json(json!({"agent":agent_json(&agent,false)})))
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

pub(super) async fn global_draft() -> ApiResult {
    blocking_api(move || {
        let draft =
            Store::open()?.workflow_draft(crate::store::workflow::GLOBAL_WORKFLOW_DRAFT_PROJECT)?;
        Ok(Json(json!({"draft":draft})))
    })
    .await
}

pub(super) async fn save_global_draft(Json(input): Json<WorkflowDraftInput>) -> ApiResult {
    blocking_api(move || {
        let draft = Store::open()?
            .save_workflow_draft(crate::store::workflow::GLOBAL_WORKFLOW_DRAFT_PROJECT, input)
            .map_err(bad_request)?;
        Ok(Json(json!({"draft":draft})))
    })
    .await
}

pub(super) async fn draft(Path(project): Path<String>) -> ApiResult {
    blocking_api(move || {
        let store = Store::open()?;
        store
            .get_local_project(&project)?
            .ok_or_else(|| not_found("project"))?;
        Ok(Json(json!({"draft":store.workflow_draft(&project)?})))
    })
    .await
}

pub(super) async fn save_draft(
    Path(project): Path<String>,
    Json(input): Json<WorkflowDraftInput>,
) -> ApiResult {
    blocking_api(move || {
        let draft = Store::open()?
            .save_workflow_draft(&project, input)
            .map_err(bad_request)?;
        Ok(Json(json!({"draft":draft})))
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
        let study = store
            .research_for_session(&session_id)?
            .ok_or_else(|| bad_request("该会话未启用科研专家模式"))?;
        let draft = store
            .workflow_draft_by_id(&request.draft_id)?
            .ok_or_else(|| not_found("workflow draft"))?;
        let draft = if draft.project_id == crate::store::workflow::GLOBAL_WORKFLOW_DRAFT_PROJECT {
            store
                .save_workflow_draft(&study.project_id, draft.input)
                .map_err(bad_request)?
        } else {
            if draft.project_id != study.project_id {
                return Err(bad_request("工作流草稿属于其他项目"));
            }
            draft
        };
        let (version, deduplicated) = store
            .research_set_plan_idempotent(&study.id, draft.input.into_plan(objective))
            .map_err(bad_request)?;
        Ok(Json(json!({
            "studyId": study.id,
            "sessionId": study.session_id,
            "version": version,
            "deduplicated": deduplicated,
        })))
    })
    .await
}
