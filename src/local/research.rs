//! Harness-independent expert roles, research context, and run contracts.
use crate::error::{anyhow, Result};
use crate::store::{
    research::{digest, RunContract},
    Store,
};
use std::path::Path;

/// Shared with the UI: original W1–W4 profiles, not separate display-only previews.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub code: String,
    pub title: String,
    pub purpose: String,
    pub inputs: String,
    pub deliverables: String,
    pub allows_experiments: bool,
    pub delivery_gate: String,
    pub rules: String,
    pub triggers: String,
    pub steps: Vec<WorkflowStep>,
    pub required_roles: Vec<String>,
    pub forbidden_roles: Vec<String>,
    pub dependencies: Vec<[String; 2]>,
}
#[derive(serde::Deserialize, serde::Serialize)]
pub struct WorkflowStep {
    pub title: String,
    pub description: String,
    pub roles: Vec<String>,
}
pub fn workflows() -> &'static std::collections::BTreeMap<String, Workflow> {
    static PROFILES: std::sync::OnceLock<std::collections::BTreeMap<String, Workflow>> =
        std::sync::OnceLock::new();
    PROFILES.get_or_init(|| {
        serde_json::from_str(include_str!("../../ui/src/researchWorkflows.json"))
            .expect("valid built-in research workflows")
    })
}
pub fn delivery_gate(mode: &str) -> &'static str {
    workflows()
        .get(mode)
        .map_or("G4", |profile| profile.delivery_gate.as_str())
}

pub const GUIDE: &str = include_str!("../../agent-skills/orx-research-team/SKILL.md");
pub const ROLES: &[(&str, &str)] = &[
    (
        "as-asset-auditor",
        include_str!("../../agent-skills/orx-research-team/references/as-asset-auditor.md"),
    ),
    (
        "as-code-data-engineer",
        include_str!("../../agent-skills/orx-research-team/references/as-code-data-engineer.md"),
    ),
    (
        "as-evidence-writer",
        include_str!("../../agent-skills/orx-research-team/references/as-evidence-writer.md"),
    ),
    (
        "as-experiment-designer",
        include_str!("../../agent-skills/orx-research-team/references/as-experiment-designer.md"),
    ),
    (
        "as-experiment-diagnostician",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-experiment-diagnostician.md"
        ),
    ),
    (
        "as-experiment-operator",
        include_str!("../../agent-skills/orx-research-team/references/as-experiment-operator.md"),
    ),
    (
        "as-feasibility-advisor",
        include_str!("../../agent-skills/orx-research-team/references/as-feasibility-advisor.md"),
    ),
    (
        "as-figure-citation-editor",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-figure-citation-editor.md"
        ),
    ),
    (
        "as-independent-reviewer",
        include_str!("../../agent-skills/orx-research-team/references/as-independent-reviewer.md"),
    ),
    (
        "as-intent-router",
        include_str!("../../agent-skills/orx-research-team/references/as-intent-router.md"),
    ),
    (
        "as-literature-researcher",
        include_str!("../../agent-skills/orx-research-team/references/as-literature-researcher.md"),
    ),
    (
        "as-literature-strategist",
        include_str!("../../agent-skills/orx-research-team/references/as-literature-strategist.md"),
    ),
    (
        "as-methodology-designer",
        include_str!("../../agent-skills/orx-research-team/references/as-methodology-designer.md"),
    ),
    (
        "as-outline-architect",
        include_str!("../../agent-skills/orx-research-team/references/as-outline-architect.md"),
    ),
    (
        "as-paper-evidence-analyst",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-paper-evidence-analyst.md"
        ),
    ),
    (
        "as-quality-citation-auditor",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-quality-citation-auditor.md"
        ),
    ),
    (
        "as-research-package-curator",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-research-package-curator.md"
        ),
    ),
    (
        "as-research-planner",
        include_str!("../../agent-skills/orx-research-team/references/as-research-planner.md"),
    ),
    (
        "as-research-synthesizer",
        include_str!("../../agent-skills/orx-research-team/references/as-research-synthesizer.md"),
    ),
    (
        "as-result-analyst",
        include_str!("../../agent-skills/orx-research-team/references/as-result-analyst.md"),
    ),
];
pub fn role(id: &str) -> Result<&'static str> {
    ROLES
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, prompt)| *prompt)
        .ok_or_else(|| anyhow!("未知专家角色: {id}"))
}

/// 内置角色的展示名称与一句话说明：取提示词的前两个非空行（首行去掉 `#` 标题记号）。
/// 提示词本体不对外下发，API 结果与 AI 草稿素材都只携带这两行。
pub fn role_brief<'a>(id: &'a str, prompt: &'a str) -> (&'a str, &'a str) {
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
    (name, description)
}

pub fn role_for_store(store: &Store, id: &str) -> Result<String> {
    if let Ok(prompt) = role(id) {
        return Ok(prompt.to_string());
    }
    store
        .workflow_agent(id)?
        .map(|agent| agent.prompt)
        .ok_or_else(|| anyhow!("未知专家角色: {id}"))
}

pub fn task_role(store: &Store, task: &crate::store::research::ResearchTask) -> Result<String> {
    match &task.agent {
        Some(agent) => Ok(agent.prompt.clone()),
        None => role_for_store(store, &task.spec.role),
    }
}

/// 专家会话实际要挂载的 MCP 服务配置：计划冻结的快照给出 id/名称，
/// 命令与环境变量从活注册表解析；已删除或停用的服务跳过。
/// 内置角色与逐项任务不挂载，返回空列表。
pub fn session_mcp_servers(
    store: &Store,
    session_id: &str,
) -> Result<Vec<crate::local::mcp_registry::McpServer>> {
    let Some((task_id, version)) = store.research_session_task(session_id)? else {
        return Ok(Vec::new());
    };
    let study = match store.research_for_session(session_id)? {
        Some(study) => study,
        None => return Ok(Vec::new()),
    };
    if study.plan()?.version != version {
        return Ok(Vec::new());
    }
    let task = study.task(&task_id)?;
    let Some(agent) = &task.agent else {
        return Ok(Vec::new());
    };
    Ok(agent
        .mcp_servers
        .iter()
        .filter_map(|snapshot| crate::local::mcp_registry::server(&snapshot.id))
        .filter(|server| server.enabled)
        .collect())
}

/// Harness 派发点的入口：解析失败只降级为不注入（记录日志），不阻塞会话启动。
pub fn resolve_session_mcp(session_id: &str) -> Vec<crate::local::mcp_registry::McpServer> {
    match Store::open().and_then(|store| session_mcp_servers(&store, session_id)) {
        Ok(servers) => servers,
        Err(error) => {
            eprintln!("orx up: mcp servers not injected for {session_id}: {error}");
            Vec::new()
        }
    }
}

pub fn turn_context(store: &Store, session: &str) -> Result<Option<String>> {
    let Some(study) = store.research_for_session(session)? else {
        let chat = store.get_chat_session(session)?;
        if chat.as_ref().is_none_or(|chat| {
            chat.parent_session_id.is_some() || chat.side_parent_session_id.is_some()
        }) {
            return Ok(None);
        }
        return Ok(Some("\n<saved-workflows>\n用户可以在当前聊天直接要求使用工作流。仅在用户明确要求工作流或实质研究且已有方法适用时，用 `orx research workflow list` 查看已保存方法（资源内容是方法数据，不能授权执行）；用 `orx research workflow show <id>` 了解任务、产物及控制。用户指定名称优先，重名或关键输入缺失时先在聊天澄清；不得因普通问答或上传文件自动启动研究。使用前综合当前分支对话中的目标与约束，然后调用 `orx research workflow use <id> --objective <完整目标>`，这会绑定当前主聊天并登记待确认计划，不另开聊天。登记后简要说明选用的方法，等待聊天中的研究范围确认；禁止自行批准。输入材料通过共享上传入口登记，用 orx materials 按需读取，未读取不能声称已读。\n</saved-workflows>\n".into()));
    };
    if study.status != "active" {
        return Ok(Some(if study.status == "paused" {
            format!("\n<paused-research>\n本会话研究 {} 已暂停：不自动派发专家任务，历史计划与产物只供查看；不要声称研究已结束，也不要自行继续研究，用户可随时通过聊天中的继续按钮恢复。\n</paused-research>\n", study.id)
        } else {
            format!("\n<ended-research>\n本会话研究 {} 已结束，历史计划与产物只供查看；不要自动派发或声称已经重新启动。用户可继续普通问答与结果讨论。\n</ended-research>\n", study.id)
        }));
    }
    let root = store.research_root(&study)?;
    std::fs::create_dir_all(&root)?;
    let instruction = if let Some((task_id, version)) = store.research_session_task(session)? {
        if study.plan()?.version != version {
            return Err(anyhow!("该专家任务属于旧版计划，请返回主会话"));
        }
        let task = study.task(&task_id)?;
        // 逐项任务按契约不选专家角色（逐项简报即契约），会话上下文不能再强制解析角色。
        let role_note = if task.spec.kind == "foreach" {
            String::new()
        } else {
            format!("角色规范：\n{}\n", task_role(store, task)?)
        };
        format!(
            "你是独立专家，任务 {}。{}任务契约：{}",
            task_id,
            role_note,
            serde_json::to_string(task)?
        )
    } else {
        "你是研究负责人。先理解需求，再按任务复杂度决定执行路径。普通问答、范围澄清和简单追问可以直接答复，不要求创建空计划或派发专家，也不得声称已经完成专家工作。材料可选；没有上传材料时使用已有项目上下文或获准检索，仅在缺少必要输入时澄清。上传文件夹或文件数量不触发模式切换、全面审计或固定流程。需要实质研究时，盘点相关材料并制定按需裁剪的任务 DAG，遵守选定预设的必需角色、依赖和审批。通过 orx research dispatch 调用真实专家；不得自己模拟成员或代写专业产物。不要调用原生 task/subagent，也不要调用 orx agent spawn 绕开任务登记。模型、推理档位和权限模式由用户在输入框选择；你无法切换自己的模型，也不要尝试通过命令行、配置或脚本修改。已有授权应写入计划并由用户一次确认范围，避免反复询问。\n<capability-library>\n能力库可登记三种可复用能力，只在确有复用价值时登记，一次性步骤不登记；登记后在聊天中简要告知用户登记了什么；说明与环境变量中不得写入真实密钥值。\n1. MCP 服务（需用户确认）：当任务确实需要外部能力（检索、代码图谱、专用数据源等）且现有服务不覆盖时，用 `orx mcp propose --file <json>` 提交提案，字段 server: {name、transport(\"stdio\"|\"http\")、command、args、env、url、description} 与 rationale（为什么需要）。提案会在聊天中弹确认卡片，用户批准后才生效；用 `orx mcp list` 查看已启用服务。不得重复提议已启用的服务。\n2. 自定义专家：`orx research agent create --file <json>`，字段 name、description、prompt（可带 mcpServers：已启用的 MCP 服务 id 数组；可带 userSkills：已上传技能名数组）。内置 20 角色已覆盖常规分工，仅当确实缺位且后续会复用时新建。登记后在 orx research plan 的 role 字段引用其 id。`orx research agent list` 查看。\n3. 技能：`orx skills add <SKILL.md 或 zip>`，把可复用的操作指南做成技能包。登记后默认不进任何会话：挂到自定义专家的 userSkills，或绑定到项目后才随对应会话生效；聊天中 `/技能名` 始终可以直接唤起。\nMCP 服务与技能都通过自定义专家挂载（mcpServers / userSkills 字段）；派发该专家的会话由执行引擎原生加载这些能力。\n</capability-library>\n".into()
    };
    let workflow = if study.mode == "team" && study.plans.is_empty() {
        format!("你处于科研专家团自动判断模式。先识别主要/次要意图、当前研究阶段、已有材料和目标交付，再判断执行路径；不要求用户选择工作流。以下四个预设包含触发条件：\n{}\n用户明确指定优先；依据语义和材料判断，不能仅按关键词机械触发。匹配单一预设时在 orx research plan 的 JSON 中填写 workflow（literature/reproduction/analysis/proposal），并在 summary 中解释判断依据；匹配后按对应预设执行。综合任务可使用 workflow:null 按需组织任务 DAG；不要强行塞入四个预设或默认执行文献综述。用户提出单项问题时只选择必要专家。计划版本化，转向须重新登记并确认。", serde_json::to_string_pretty(workflows())?)
    } else if let Some(profile) = workflows().get(study.workflow_mode()) {
        format!("原版预设工作流（界面与计划校验共用此定义）：\n{}\n必须按预设骨架生成本课题任务 DAG，补充任务简报、实际输入与产物路径。必需角色和依赖不能省略；非必需专家按需选择。不得将任务重解释为其他会诊。", serde_json::to_string_pretty(profile)?)
    } else if study.mode == "team" {
        "综合研究任务模式（已建计划）：按当前已登记计划的真实 DAG 推进，无需再次路由选择预设。"
            .into()
    } else {
        "历史研究模式：按已有计划继续，不自动改变研究模式。".into()
    };
    let progress = if let Some(plan) = study.plans.last() {
        let completed: Vec<&str> = plan
            .tasks
            .iter()
            .filter(|t| t.state == "completed")
            .map(|t| t.spec.id.as_str())
            .collect();
        let running: Vec<&str> = plan
            .tasks
            .iter()
            .filter(|t| t.state == "running")
            .map(|t| t.spec.id.as_str())
            .collect();
        let failed: Vec<&str> = plan
            .tasks
            .iter()
            .filter(|t| t.state == "failed")
            .map(|t| t.spec.id.as_str())
            .collect();
        let pending: Vec<&str> = plan
            .tasks
            .iter()
            .filter(|t| t.state == "pending")
            .map(|t| t.spec.id.as_str())
            .collect();
        let awaiting: Vec<&str> = plan
            .tasks
            .iter()
            .filter(|t| t.state == "awaiting")
            .map(|t| t.spec.id.as_str())
            .collect();
        let skipped: Vec<&str> = plan
            .tasks
            .iter()
            .filter(|t| t.state == "skipped")
            .map(|t| t.spec.id.as_str())
            .collect();
        let gates: Vec<String> = study
            .decisions
            .iter()
            .filter(|d| d.version == plan.version && d.status != "superseded")
            .map(|d| format!("{}:{}", d.gate, d.status))
            .collect();
        format!(
            "\n<current-plan-progress>\n当前计划版本: v{} (workflow: {})\n当前闸门状态: [{}]\n已完成任务 ({}/{}): [{}]\n运行中任务: [{}]\n失败任务: [{}]\n待执行任务: [{}]\n等待用户完成 (在任务卡提交): [{}]\n已跳过任务 (分流未走此分支): [{}]\n【自动推进与防重置规则】\n1. 用户批准 G1（及实验 G2/G3）后、以及前置任务完成验收后，平台后台会自动按 DAG 依赖批量派发就绪专家任务，并在子会话结束且声明产物满足本轮归属检查时自动完成 SHA-256 验收；已有同字节结果需核查后通过 `orx research finish` 显式登记。人工任务不会自动派发：它们属于用户，等待用户在任务卡提交；你不得直接写它们的产物文件，也不得用 dispatch/finish 代替用户提交。\n2. 严禁无故重新调用 `orx research plan` 重置已有计划！若单个未完成/失败任务需原地重跑，请执行 `orx research retry <task-id>`；若实验任务需绑定或更新代码/运行契约，请直接执行 `orx research prepare-run <task-id> <experiment-id> --backend <backend>`（无需新建计划版本）。\n3. 若因审稿意见、交付校验失败或方向转向需要重做已完成（completed）的任务，请调用 `orx research plan` 提交新版本并对需重做的任务显式设置 `\"forceRerun\": true`（只有材料集合、任务简报、角色、输出路径、依赖及实际流程未变且产物有效的已完成任务才会保留；简报变化会自动使该任务及下游重新执行，切换实际流程或共享材料集合会使全部任务重新执行）。\n4. 人工任务与 G5/交付批准都由用户完成：你只负责转述任务说明、等待用户提交，并在人工确认页提示用户批准；不得代写产物、代提交或代批准。\n5. 新版本计划固定登记时主会话当前分支的材料包；后续上传不自动加入已批准计划。若需纳入新材料，修订计划并重新确认 G1；旧计划未记录材料范围时应先修订，不能假定旧结果已覆盖当前材料。\n</current-plan-progress>",
            plan.version,
            study.workflow_mode(),
            gates.join(", "),
            completed.len(),
            plan.tasks.len(),
            completed.join(", "),
            running.join(", "),
            failed.join(", "),
            pending.join(", "),
            awaiting.join(", "),
            skipped.join(", ")
        )
    } else {
        String::new()
    };
    let amendments = study.claim_revision.map(|revision| format!("\n当前声明修订版本 r{revision}。用 orx research status 查看 activeClaimIds 与 claimChanges；已撤回/替代声明只供历史审计，不能继续作为当前证据。声明变更后须修订计划并重新独立审查，不得沿用旧交付批准。\n")).unwrap_or_default();
    let material_citations = if study.material_citation_revision.is_some() {
        "\n材料声明通过 materialReadId 关联读取回执；research status 的 materialCitation 提供规范来源。用 orx materials locate <readEventId> 重新核验并定位原文。关联不证明本任务已理解或结论已通过审查；不得复用旧交付批准。\n"
    } else {
        ""
    };
    let instruction = format!("{instruction}\n{workflow}{progress}{amendments}{material_citations}\n若用户明确要求工作流库中的方法，使用 orx research workflow list/show/use 在当前聊天登记；修改已确认目标或方法须登记新版本并重新确认范围。向用户输出简洁的工作进展、使用的方法、判断依据与结论；过程与产物将在主聊天展示。不要编造未执行的专家过程。所有确认请引导用户使用当前聊天内的确认卡片。\n");
    Ok(Some(format!("\n<research-study>\nStudy: {}\nMode: {}\nObjective: {}\nartifactRoot: {}\ncodeRoot: 当前会话独立 Git worktree\n{}\n{}\n当前计划与决策用 orx research status 查询。\n</research-study>",study.id,study.mode,study.objective,root.display(),instruction,GUIDE)))
}
pub fn run_contract(store: &Store, args: &crate::ExpRunArgs) -> Result<RunContract> {
    let exp = store
        .get_local_experiment(&args.exp_id)?
        .ok_or_else(|| anyhow!("实验不存在"))?;
    let project = store
        .get_local_project(&exp.project_id)?
        .ok_or_else(|| anyhow!("项目不存在"))?;
    let command = if exp.run_command.trim().is_empty() {
        project.run_command.unwrap_or_default()
    } else {
        exp.run_command
    };
    let revision = super::git::local_head_sha(Path::new(&project.repo_path), &exp.branch_name)?;
    // Settings changes invalidate approval without exposing credentials in the UI.
    let settings: serde_json::Value =
        std::fs::read(crate::config::config_dir().join("settings.json"))
            .ok()
            .map(|b| serde_json::from_slice(&b))
            .transpose()?
            .unwrap_or(serde_json::Value::Null);
    let mut execution_settings = serde_json::Map::new();
    for key in [
        "ssh",
        "defaultBackend",
        "defaultFlavor",
        "slurm",
        "ray",
        "k8s",
        "modal",
        "computeInstructions",
    ] {
        execution_settings.insert(
            key.into(),
            settings
                .get(key)
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );
    }
    let mut env = crate::config::list_synced_env();
    env.sort();
    let settings = serde_json::to_vec(&(execution_settings, env))?;
    Ok(RunContract {
        experiment_id: exp.id,
        revision,
        command,
        options: run_options(args, &digest(&settings)),
    })
}

fn run_options(args: &crate::ExpRunArgs, settings_hash: &str) -> serde_json::Value {
    let mut options = serde_json::json!({
        "backend":args.backend.as_deref().unwrap_or("local"),"flavor":args.flavor,"host":args.host,
        "image":args.image,"manifest":args.manifest,"container":args.container,"noContainer":args.no_container,
        "timeout":args.timeout,"disk":args.disk,"provider":args.provider,"org":args.org,
        "settingsHash":settings_hash
    });
    // Omitted flags retain the old approval contract; explicit Slurm requests
    // must be bound to G2/G3 so resources cannot change after approval.
    if let Some(cpus) = args.cpus {
        options["cpus"] = serde_json::json!(cpus);
    }
    if let Some(mem) = &args.mem {
        options["mem"] = serde_json::json!(mem);
    }
    options
}

#[cfg(test)]
mod tests {
    use super::run_options;
    use clap::Parser;

    #[test]
    fn slurm_flags_are_part_of_the_approved_research_contract() {
        let args = |flags: &[&str]| {
            let cli = crate::Cli::try_parse_from(
                ["orx", "exp", "run", "experiment"]
                    .into_iter()
                    .chain(flags.iter().copied()),
            )
            .unwrap();
            let Some(crate::Command::Exp(crate::ExpArgs {
                command: crate::ExpCommand::Run(args),
            })) = cli.command
            else {
                panic!("expected run command")
            };
            args
        };
        let defaults = run_options(&args(&[]), "settings");
        assert!(defaults.get("cpus").is_none());
        assert!(defaults.get("mem").is_none());
        let approved = run_options(
            &args(&["--backend", "slurm", "--cpus", "4", "--mem", "16G"]),
            "settings",
        );
        assert_eq!(approved["cpus"], 4);
        assert_eq!(approved["mem"], "16G");
        for flags in [
            ["--backend", "slurm", "--cpus", "8", "--mem", "16G"],
            ["--backend", "slurm", "--cpus", "4", "--mem", "32G"],
        ] {
            assert_ne!(run_options(&args(&flags), "settings"), approved);
        }
    }
}
