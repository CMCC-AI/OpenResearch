use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{anyhow, Result};
use crate::store::research::{PlanInput, TaskSpec};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub version: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub prompt: String,
}

impl From<&AgentDefinition> for AgentSnapshot {
    fn from(agent: &AgentDefinition) -> Self {
        Self {
            id: agent.id.clone(),
            name: agent.name.clone(),
            version: agent.version,
            prompt: agent.prompt.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt: String,
}

pub fn validate_agent(input: &AgentInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.len() > 120 {
        return Err(anyhow!("Agent 名称需要为 1–120 个字符"));
    }
    if input.description.len() > 2048 {
        return Err(anyhow!("Agent 说明不能超过 2048 个字符"));
    }
    if input.prompt.trim().is_empty() || input.prompt.len() > 24000 {
        return Err(anyhow!("Agent 提示词需要为 1–24000 个字符"));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDraftInput {
    pub name: String,
    #[serde(default)]
    pub objective: String,
    #[serde(default)]
    pub summary: String,
    pub workflow: String,
    #[serde(default)]
    pub tasks: Vec<TaskSpec>,
    #[serde(default)]
    pub positions: HashMap<String, FlowPoint>,
    #[serde(default)]
    pub viewport: Option<FlowViewport>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDraft {
    pub id: String,
    pub project_id: String,
    #[serde(flatten)]
    pub input: WorkflowDraftInput,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 计划摘要在提交时由研究目标与任务拓扑确定性生成，相同提交得到相同摘要，
/// 从而在 `research_plan_equivalent` 的逐字段比对下保持去重语义。
pub fn plan_summary(workflow: &str, objective: &str, task_count: usize) -> String {
    let goal = objective.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut excerpt: String = goal.chars().take(160).collect();
    if excerpt.chars().count() < goal.chars().count() {
        excerpt.push('…');
    }
    let flow = if workflow == "literature" {
        "W1 系统文献综述"
    } else {
        "研究工作流"
    };
    let scope = if workflow == "literature" {
        "；仅文献任务，不运行实验"
    } else {
        ""
    };
    format!("围绕目标「{excerpt}」，按「{flow}」流程执行 {task_count} 个专家任务，各任务按依赖顺序登记产物，最终整理为可追溯的研究包{scope}。")
}

impl WorkflowDraftInput {
    pub fn into_plan(self, objective: &str) -> PlanInput {
        PlanInput {
            workflow: Some(self.workflow.clone()),
            summary: plan_summary(&self.workflow, objective, self.tasks.len()),
            tasks: self.tasks,
        }
    }
}

pub fn validate_draft(input: &WorkflowDraftInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.len() > 200 {
        return Err(anyhow!("工作流名称需要为 1–200 个字符"));
    }
    if input.objective.len() > 24000 || input.summary.len() > 24000 {
        return Err(anyhow!("研究目标与计划摘要不能超过 24000 个字符"));
    }
    if input.workflow != "literature" {
        return Err(anyhow!("当前版本支持系统文献综述（W1）工作流"));
    }
    if input.tasks.len() > 40 || input.positions.len() > 40 {
        return Err(anyhow!("工作流最多包含 40 个任务"));
    }
    if input
        .positions
        .values()
        .any(|point| !point.x.is_finite() || !point.y.is_finite())
        || input.viewport.as_ref().is_some_and(|viewport| {
            !viewport.x.is_finite()
                || !viewport.y.is_finite()
                || !viewport.zoom.is_finite()
                || viewport.zoom <= 0.0
        })
    {
        return Err(anyhow!("工作流画布坐标无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_summary_is_deterministic_and_tracks_objective() {
        let first = plan_summary("literature", "系统综述图神经网络在药物发现中的应用", 9);
        // 首尾空白在摘要中折叠，同一目标的不同排版得到同一摘要，保持去重稳定。
        let second = plan_summary("literature", "  系统综述图神经网络在药物发现中的应用  ", 9);
        assert_eq!(first, second);
        assert!(first.contains("围绕目标「系统综述图神经网络在药物发现中的应用」"));
        assert!(first.contains("9 个专家任务"));
        assert!(first.ends_with("仅文献任务，不运行实验。"));
        assert_ne!(
            first,
            plan_summary("literature", "综述蛋白质结构预测的进展", 9)
        );
    }

    #[test]
    fn plan_summary_truncates_on_char_boundaries() {
        let goal = "药".repeat(400);
        let summary = plan_summary("literature", &goal, 1);
        let excerpt = goal.chars().take(160).collect::<String>();
        assert!(summary.contains(&excerpt));
        assert!(summary.contains("…"));
        assert!(summary.chars().count() < 260);
    }
}
