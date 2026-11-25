use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{anyhow, Result};
use crate::store::research::{PlanInput, TaskSpec, ROUTE_KIND};

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
    /// 计划批准时冻结的 MCP 服务（仅 id/名称，不含命令与环境变量密钥）；
    /// 内置角色为空。旧计划没有该字段，读取按空处理。
    #[serde(default)]
    pub mcp_servers: Vec<McpServerSnapshot>,
    /// 计划批准时冻结的上传技能名；会话注入时已删除的技能自然跳过。
    /// 旧计划没有该字段，读取按空处理。
    #[serde(default)]
    pub user_skills: Vec<String>,
}

impl From<&AgentDefinition> for AgentSnapshot {
    fn from(agent: &AgentDefinition) -> Self {
        Self {
            id: agent.id.clone(),
            name: agent.name.clone(),
            version: agent.version,
            prompt: agent.prompt.clone(),
            mcp_servers: Vec::new(),
            user_skills: Vec::new(),
        }
    }
}

/// 冻结进计划的 MCP 服务引用；命令与环境变量在派发时从活注册表解析。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSnapshot {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt: String,
    /// 挂载的 MCP 服务 id 列表；内置专家不可挂载。
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// 挂载的上传技能名列表；内置专家不可挂载。派发该专家的会话自动携带
    /// 这些技能；未绑定技能的会话不受影响。
    #[serde(default)]
    pub user_skills: Vec<String>,
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

/// 阶段分组框：纯展示，只占画布空间，不进入执行计划，也不参与批准与等价比对。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowFrame {
    pub id: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<FlowFrame>,
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
    let routes = tasks.iter().filter(|t| t.kind == ROUTE_KIND).count();
    let joins = tasks.iter().filter(|t| t.wait_for == "any").count();
    let foreach = tasks.iter().filter(|t| t.kind == "foreach").count();
    let humans = tasks.iter().filter(|t| t.kind == "human").count();
    let experiments = tasks.iter().filter(|t| t.kind == "experiment").count();
    let waits = tasks.iter().filter(|t| t.kind == "wait").count();
    let mut controls = Vec::new();
    if approvals > 0 {
        controls.push(format!("{approvals} 项完成后需你确认"));
    }
    if gates > 0 {
        controls.push(format!("{gates} 项启用结论把关"));
    }
    if rework > 0 {
        controls.push(format!("自动返工上限共 {rework} 轮"));
    }
    if routes > 0 {
        controls.push(format!("包含 {routes} 个条件分流"));
    }
    if joins > 0 {
        controls.push(format!("{joins} 项按任一完成汇合"));
    }
    if foreach > 0 {
        controls.push(format!("包含 {foreach} 个逐项处理"));
    }
    if humans > 0 {
        controls.push(format!("{humans} 项等你完成"));
    }
    if experiments > 0 {
        controls.push(format!("{experiments} 个实验节点（G2/G3 批准后自动运行）"));
    }
    if waits > 0 {
        controls.push(format!("{waits} 个事件等待"));
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
        // 画布草稿一律按自定义编排提交（workflow:null）：专家与依赖由研究负责人自由组合，
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
    // 画布草稿允许暂时不完整（例如分流刚拖入、还没连两条分支）：自动保存
    // 不应因此失败，把工作卡死在编辑器里。跨任务拓扑在提交计划时由
    // validate_plan_with_roles / validate_route_rules 统一把关。
    // 40 个任务、每任务最多一个确认检查点，以及输入、G1、G4、交付。
    // 展示节点只占布局空间，不消耗专家任务名额，也不进入 PlanInput。
    if input.positions.len() > 84 {
        return Err(anyhow!("工作流最多保存 84 个节点坐标"));
    }
    // 阶段分组框只占画布空间：上限独立于任务与坐标，超限拒绝保存。
    if input.frames.len() > 12 {
        return Err(anyhow!("工作流最多包含 12 个阶段分组"));
    }
    for frame in &input.frames {
        if frame.id.is_empty()
            || frame.id.len() > 80
            || !frame
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(anyhow!("阶段分组 ID 仅允许字母、数字、横线和下划线"));
        }
        if frame.title.trim().is_empty() || frame.title.len() > 60 {
            return Err(anyhow!("阶段分组名称需要为 1–60 个字符"));
        }
        if !frame.x.is_finite()
            || !frame.y.is_finite()
            || !frame.width.is_finite()
            || !frame.height.is_finite()
            || frame.width < 160.0
            || frame.height < 120.0
            || frame.width > 6000.0
            || frame.height > 6000.0
        {
            return Err(anyhow!("阶段分组尺寸无效"));
        }
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
            kind: String::new(),
            route: None,
            route_branch: String::new(),
            wait_for: String::new(),
            for_each: None,
            wait_step: None,
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
            frames: Vec::new(),
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
        assert!(!first.contains("需你确认"));
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
        assert!(first.contains("（1 项完成后需你确认，1 项启用结论把关，自动返工上限共 2 轮）"));
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
    #[test]
    fn plan_summary_mentions_routes_and_joins_deterministically() {
        let mut tasks = vec![
            summary_task("design"),
            summary_task("review"),
            summary_task("audit"),
        ];
        tasks[1].kind = "route".into();
        tasks[1].role = String::new();
        tasks[1].outputs = vec![];
        tasks[1].route = Some(crate::store::research::RouteSpec {
            on: "verdict".into(),
            source: "design/result.md".into(),
            verdict_is: "blocked".into(),
            default_branch: String::new(),
        });
        tasks[1].depends_on = vec!["design".into()];
        tasks[2].wait_for = "any".into();
        tasks[2].depends_on = vec!["review".into(), "design".into()];
        let first = plan_summary("custom", "综述目标", &tasks);
        let second = plan_summary("custom", "综述目标", &tasks);
        assert_eq!(first, second);
        assert!(first.contains("包含 1 个条件分流"));
        assert!(first.contains("1 项按任一完成汇合"));
        // 逐项与人工任务同样计入摘要，配置变化会生成新版本重新确认 G1。
        let mut with_steps = tasks.clone();
        with_steps[2].kind = "human".into();
        assert!(plan_summary("custom", "综述目标", &with_steps).contains("1 项等你完成"));
        // 分流条件属于 spec 字段：计划等价比对按 spec 逐字段比较（TaskSpec PartialEq），
        // verdict 变化会判定为不同计划并生成新版本重新确认 G1；摘要只承担可读性与计数。
        let mut flipped = tasks.clone();
        flipped[1].route.as_mut().unwrap().verdict_is = "pass".into();
        assert_ne!(tasks[1], flipped[1]);
    }

    #[test]
    fn draft_frames_are_capped_and_validated() {
        let mut draft = WorkflowDraftInput {
            name: "Frames".into(),
            objective: String::new(),
            summary: String::new(),
            workflow: "custom".into(),
            tasks: vec![summary_task("task-1")],
            positions: HashMap::new(),
            viewport: None,
            frames: vec![FlowFrame {
                id: "stage-1".into(),
                title: "检索阶段".into(),
                x: 0.0,
                y: 0.0,
                width: 480.0,
                height: 360.0,
            }],
        };
        validate_draft(&draft).unwrap();
        // 名称过长、尺寸过小、数量超限都要被拒绝。
        draft.frames[0].title = String::new();
        assert!(validate_draft(&draft).is_err());
        draft.frames[0].title = "检索阶段".into();
        draft.frames[0].width = 100.0;
        assert!(validate_draft(&draft).is_err());
        draft.frames[0].width = 480.0;
        for index in 1..=12 {
            draft.frames.push(FlowFrame {
                id: format!("stage-{index}"),
                title: format!("阶段 {index}"),
                x: 0.0,
                y: 0.0,
                width: 480.0,
                height: 360.0,
            });
        }
        assert!(validate_draft(&draft).is_err());
        draft.frames.truncate(11);
        validate_draft(&draft).unwrap();
    }

    #[test]
    fn draft_route_tasks_save_but_validate_topology_on_submit() {
        let mut design = summary_task("design");
        design.gate_downstream = true;
        let mut route = summary_task("route-1");
        route.kind = "route".into();
        route.role = String::new();
        route.outputs = vec![];
        route.brief = "分流".into();
        route.depends_on = vec!["design".into()];
        route.route = Some(crate::store::research::RouteSpec {
            on: "verdict".into(),
            source: "design/result.md".into(),
            verdict_is: "blocked".into(),
            default_branch: String::new(),
        });
        let mut fix = summary_task("fix");
        fix.route_branch = "then".into();
        fix.depends_on = vec!["route-1".into()];
        let mut redo = summary_task("redo");
        redo.route_branch = "else".into();
        redo.depends_on = vec!["route-1".into()];
        let draft = WorkflowDraftInput {
            name: "Routed".into(),
            objective: String::new(),
            summary: String::new(),
            workflow: "custom".into(),
            tasks: vec![design, route, fix, redo],
            positions: HashMap::new(),
            viewport: None,
            frames: Vec::new(),
        };
        validate_draft(&draft).unwrap();
        // 画布自动保存允许半成品分流；提交计划时才拒绝缺分支或未开结论把关。
        let mut missing_else = draft.clone();
        missing_else.tasks[3].route_branch = "then".into();
        assert!(validate_draft(&missing_else).is_ok());
        assert!(crate::store::research::validate_route_rules(&missing_else.tasks).is_err());
        let mut ungated = draft.clone();
        ungated.tasks[0].gate_downstream = false;
        assert!(validate_draft(&ungated).is_ok());
        assert!(crate::store::research::validate_route_rules(&ungated.tasks).is_err());
    }
}
