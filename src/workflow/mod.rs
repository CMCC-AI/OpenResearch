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
    /// "literature" 按系统文献综述模板计划提交；"custom" 提交为 workflow:null 的专家团动态计划。
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSource {
    pub id: String,
    pub name: String,
    pub updated_at: i64,
}

/// 计划摘要在提交时由研究目标与任务拓扑确定性生成，相同提交得到相同摘要，
/// 从而在 `research_plan_equivalent` 的逐字段比对下保持去重语义。
/// 任务确认、结论把关与返工上限属于人工确认的范围预算，按配置确定性写入。
pub fn plan_summary(workflow: &str, objective: &str, tasks: &[TaskSpec]) -> String {
    let task_count = tasks.len();
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
    let approvals = tasks.iter().filter(|t| t.requires_approval).count();
    let gates = tasks.iter().filter(|t| t.gate_downstream).count();
    let rework: u32 = tasks.iter().map(|t| t.max_rework).sum();
    let mut controls = Vec::new();
    if approvals > 0 {
        controls.push(format!("{approvals} 项完成后需主理人确认"));
    }
    if gates > 0 {
        controls.push(format!("{gates} 项启用结论把关"));
    }
    if rework > 0 {
        controls.push(format!("自动返工上限共 {rework} 轮"));
    }
    let controls = if controls.is_empty() {
        String::new()
    } else {
        format!("（{}）", controls.join("，"))
    };
    format!("围绕目标「{excerpt}」，按「{flow}」流程执行 {task_count} 个专家任务{controls}，各任务按依赖顺序登记产物，最终整理为可追溯的研究成果{scope}。")
}

impl WorkflowDraftInput {
    pub fn into_plan(self, objective: &str) -> PlanInput {
        // 画布草稿一律按自定义编排提交（workflow:null）：专家与依赖由主理人自由组合，
        // 不套用预设契约。W1–W4 预设只由聊天自动路由登记，workflow 字段仅作旧数据兼容。
        let summary = plan_summary("custom", objective, &self.tasks);
        PlanInput {
            workflow: None,
            summary,
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
    if input.workflow != "literature" && input.workflow != "custom" {
        return Err(anyhow!(
            "流程必须是系统文献综述（W1）或自定义编排（custom）"
        ));
    }
    if input.tasks.len() > 40 {
        return Err(anyhow!("工作流最多包含 40 个任务"));
    }
    // 40 个任务、每任务最多一个确认检查点，以及输入、G1、G4、交付。
    // 展示节点只占布局空间，不消耗专家任务名额，也不进入 PlanInput。
    if input.positions.len() > 84 {
        return Err(anyhow!("工作流最多保存 84 个节点坐标"));
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

    fn summary_task(id: &str) -> TaskSpec {
        TaskSpec {
            id: id.into(),
            role: "as-literature-strategist".into(),
            brief: "简报".into(),
            depends_on: vec![],
            outputs: vec![format!("{id}/result.md")],
            force_rerun: false,
            inputs: vec![],
            requires_approval: false,
            gate_downstream: false,
            max_rework: 0,
        }
    }

    #[test]
    fn system_layout_does_not_consume_task_budget_or_enter_plan() {
        let tasks: Vec<_> = (0..40)
            .map(|i| summary_task(&format!("task-{i}")))
            .collect();
        let mut positions = HashMap::new();
        for task in &tasks {
            positions.insert(task.id.clone(), FlowPoint { x: 0.0, y: 0.0 });
            positions.insert(
                format!(":system:G5:{}", task.id),
                FlowPoint { x: 0.0, y: 200.0 },
            );
        }
        for id in ["input", "G1", "G4", "output"] {
            positions.insert(format!(":system:{id}"), FlowPoint { x: -320.0, y: 0.0 });
        }
        let mut draft = WorkflowDraftInput {
            name: "Layout budget".into(),
            objective: String::new(),
            summary: String::new(),
            workflow: "literature".into(),
            tasks: tasks.clone(),
            positions,
            viewport: None,
        };
        validate_draft(&draft).unwrap();
        assert_eq!(draft.clone().into_plan("Goal").tasks, tasks);
        draft
            .positions
            .insert("extra".into(), FlowPoint { x: 0.0, y: 0.0 });
        assert!(validate_draft(&draft).is_err());
        draft.positions.remove("extra");
        draft.positions.get_mut(":system:G1").unwrap().x = f64::NAN;
        assert!(validate_draft(&draft).is_err());
        draft.positions.get_mut(":system:G1").unwrap().x = 0.0;
        draft.tasks.push(summary_task("task-41"));
        assert!(validate_draft(&draft).is_err());
    }

    #[test]
    fn plan_summary_is_deterministic_and_tracks_objective() {
        let tasks: Vec<TaskSpec> = (0..9)
            .map(|index| summary_task(&format!("task-{index}")))
            .collect();
        let first = plan_summary("literature", "系统综述图神经网络在药物发现中的应用", &tasks);
        // 首尾空白在摘要中折叠，同一目标的不同排版得到同一摘要，保持去重稳定。
        let second = plan_summary(
            "literature",
            "  系统综述图神经网络在药物发现中的应用  ",
            &tasks,
        );
        assert_eq!(first, second);
        assert!(first.contains("围绕目标「系统综述图神经网络在药物发现中的应用」"));
        assert!(first.contains("9 个专家任务"));
        assert!(!first.contains("需主理人确认"));
        assert!(first.ends_with("仅文献任务，不运行实验。"));
        assert_ne!(
            first,
            plan_summary("literature", "综述蛋白质结构预测的进展", &tasks,)
        );
    }

    #[test]
    fn plan_summary_includes_control_budgets_deterministically() {
        let mut tasks = vec![summary_task("task-1"), summary_task("task-2")];
        tasks[0].requires_approval = true;
        tasks[1].gate_downstream = true;
        tasks[1].max_rework = 2;
        let first = plan_summary("literature", "综述研究目标", &tasks);
        let second = plan_summary("literature", "综述研究目标", &tasks);
        assert_eq!(first, second);
        assert!(first.contains("（1 项完成后需主理人确认，1 项启用结论把关，自动返工上限共 2 轮）"));
        // 配置变化必须改变摘要，从而让计划比对生成新版本并重新确认 G1。
        tasks[1].max_rework = 3;
        assert_ne!(first, plan_summary("literature", "综述研究目标", &tasks));
    }

    #[test]
    fn plan_summary_truncates_on_char_boundaries() {
        let goal = "药".repeat(400);
        let tasks = vec![summary_task("task-1")];
        let summary = plan_summary("literature", &goal, &tasks);
        let excerpt = goal.chars().take(160).collect::<String>();
        assert!(summary.contains(&excerpt));
        assert!(summary.contains("…"));
        assert!(summary.chars().count() < 260);
    }
}
