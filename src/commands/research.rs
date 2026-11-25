//! Native CLI for research orchestration. Deliberately no approval command.
use crate::error::{anyhow, Result};
use crate::store::{
    research::{ClaimAmendmentInput, ClaimInput, PlanInput},
    Store,
};
use clap::{Args, Subcommand};
use serde::Deserialize;
use std::io::Read;

#[derive(Args, Debug)]
pub struct ResearchArgs {
    #[command(subcommand)]
    pub command: ResearchCommand,
}
#[derive(Subcommand, Debug)]
pub enum ResearchCommand {
    Status,
    Roles,
    /// Inspect saved methods or use one in the current conversation.
    Workflow {
        #[command(subcommand)]
        command: WorkflowCommand,
    },
    /// Manage custom agents in the capability library (usable without a study).
    Agent {
        #[command(subcommand)]
        command: CapabilityCommand,
    },
    Plan {
        #[arg(long)]
        file: String,
    },
    Dispatch {
        task: String,
    },
    Retry {
        task: String,
    },
    PrepareRun {
        task: String,
        #[command(flatten)]
        args: Box<crate::ExpRunArgs>,
    },
    Finish {
        #[arg(long)]
        task: Option<String>,
        #[arg(long)]
        file: String,
    },
    Claim {
        #[arg(long)]
        file: String,
    },
    /// Explicitly withdraw or replace a claim; original evidence stays in history.
    AmendClaim {
        claim: String,
        #[arg(long)]
        file: String,
    },
    Package,
    /// Stream the approved immutable research ZIP to stdout.
    Export,
}
#[derive(Subcommand, Debug)]
pub enum WorkflowCommand {
    List,
    Show {
        id: String,
    },
    Use {
        id: String,
        #[arg(long)]
        objective: String,
    },
}
/// 能力库（自定义 Agent）管理子命令；与工作流一样在会话门外处理。
#[derive(Subcommand, Debug)]
pub enum CapabilityCommand {
    Create {
        #[arg(long)]
        file: String,
    },
    List,
    Remove {
        id: String,
    },
}
#[derive(Clone, Copy, Debug)]
enum CapabilityKind {
    Agent,
}

impl CapabilityKind {
    fn label(self) -> &'static str {
        match self {
            CapabilityKind::Agent => "Agent",
        }
    }
}

/// 能力库登记入口：研究负责人在对话里用它扩充自定义专家，无需已启用研究。
/// 只触自定义表，内置 20 角色不受影响；已在跑的研究按冻结快照继续。
/// MCP 服务引用必须在登记前已存在（走 `orx mcp propose` 并经用户批准）。
fn capability_command(
    store: &Store,
    command: &CapabilityCommand,
    kind: CapabilityKind,
) -> Result<()> {
    let value = match command {
        CapabilityCommand::Create { file } => {
            let input: crate::workflow::AgentInput = read(file)?;
            crate::local::mcp_registry::validate_mcp_refs(&input.mcp_servers)?;
            let uploaded = crate::local::user_skills::list_uploaded();
            for name in &input.user_skills {
                if !uploaded.iter().any(|skill| &skill.name == name) {
                    return Err(anyhow!("未知技能: {name}"));
                }
            }
            let agent = store.create_workflow_agent(input)?;
            let mcps = store.workflow_agent_mcp_ids(&agent.id)?;
            let skills =
                store.skill_bindings_for_scope(crate::store::skills::SCOPE_AGENT, &agent.id)?;
            serde_json::json!({
                "agent": {
                    "id": agent.id,
                    "name": agent.name,
                    "version": agent.version,
                    "mcpServers": mcps,
                    "userSkills": skills,
                },
                "next": "已登记到自定义 Agent 库。在 orx research plan 的 role 字段使用该 id；等待用户批准后再派发。",
            })
        }
        CapabilityCommand::List => {
            let attachments = store.list_workflow_agent_mcps()?;
            let skill_attachments = store.list_skill_bindings()?;
            serde_json::to_value(
                store
                    .list_workflow_agents()?
                    .iter()
                    .map(|agent| {
                        let mcps: Vec<&String> = attachments
                            .iter()
                            .filter(|(id, _)| id == &agent.id)
                            .map(|(_, mcp_id)| mcp_id)
                            .collect();
                        let skills: Vec<&String> = skill_attachments
                            .iter()
                            .filter(|(kind, id, _)| {
                                kind == crate::store::skills::SCOPE_AGENT && id == &agent.id
                            })
                            .map(|(_, _, name)| name)
                            .collect();
                        serde_json::json!({
                            "id": agent.id,
                            "name": agent.name,
                            "description": agent.description,
                            "version": agent.version,
                            "mcpServers": mcps,
                            "userSkills": skills,
                            "updatedAt": agent.updated_at,
                        })
                    })
                    .collect::<Vec<_>>(),
            )?
        }
        CapabilityCommand::Remove { id } => {
            let deleted = match kind {
                CapabilityKind::Agent => store.delete_workflow_agent(id)?,
            };
            if !deleted {
                return Err(anyhow!("{} {id} 不存在", kind.label()));
            }
            serde_json::json!({"ok": true, "removed": id, "note": "已在跑的研究使用登记时的冻结快照，不受删除影响。"})
        }
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finish {
    success: bool,
    summary: String,
}
fn read<T: serde::de::DeserializeOwned>(file: &str) -> Result<T> {
    read_request(std::fs::File::open(file)?)
}
fn read_request<T: serde::de::DeserializeOwned>(reader: impl Read) -> Result<T> {
    let mut bytes = Vec::new();
    reader.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err(anyhow!("研究请求超过 256 KiB"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn run(args: ResearchArgs) -> Result<()> {
    let store = Store::open()?;
    if let ResearchCommand::Workflow { command } = args.command {
        let value = match command {
            WorkflowCommand::List => serde_json::to_value(store.list_workflow_drafts()?.iter().map(|draft| {
                serde_json::json!({"id":draft.id,"name":draft.input.name,"updatedAt":draft.updated_at,"workflow":draft.input.workflow,"taskCount":draft.input.tasks.len()})
            }).collect::<Vec<_>>())?,
            WorkflowCommand::Show { id } => serde_json::to_value(
                store
                    .workflow_draft_by_id(&id)?
                    .ok_or_else(|| anyhow!("工作流不存在"))?,
            )?,
            WorkflowCommand::Use { id, objective } => {
                let session = crate::local::chat::launching_chat_session()
                    .ok_or_else(|| anyhow!("请在当前主聊天中使用工作流"))?;
                let (study_id, version, deduplicated) =
                    store.research_use_workflow(&session, &id, &objective)?;
                serde_json::json!({"studyId": study_id, "sessionId": session, "version": version, "deduplicated": deduplicated, "next": "在当前聊天等待用户确认研究范围；不要自行批准或提前派发。"})
            }
        };
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    if matches!(args.command, ResearchCommand::Roles) {
        for (id, prompt) in crate::local::research::ROLES {
            println!("{}: {}", id, prompt.lines().next().unwrap_or(id));
        }
        for agent in store.list_workflow_agents()? {
            println!("{}: {} (custom v{})", agent.id, agent.name, agent.version);
        }
        return Ok(());
    }
    if let ResearchCommand::Agent { command } = &args.command {
        return capability_command(&store, command, CapabilityKind::Agent);
    }
    let session = crate::local::chat::launching_chat_session()
        .ok_or_else(|| anyhow!("请在本地研究会话内使用 orx research"))?;
    let study = store
        .research_for_session(&session)?
        .ok_or_else(|| anyhow!("该会话未启用科研专家模式"))?;
    let lead = study.session_id == session;
    match args.command {
        ResearchCommand::Status => {
            println!(
                "{}",
                serde_json::to_string_pretty(&store.research_study_view(&study)?)?
            );
        }
        ResearchCommand::Roles => unreachable!(),
        ResearchCommand::Workflow { .. } => unreachable!(),
        ResearchCommand::Agent { .. } => unreachable!(),
        ResearchCommand::Plan { file } => {
            require_lead(lead)?;
            store.research_set_plan(&study.id, read::<PlanInput>(&file)?)?;
            println!("计划已登记。等待用户在研究面板批准 G1，结束本轮即可。");
        }
        ResearchCommand::Dispatch { task } => {
            require_lead(lead)?;
            let entry = study.task(&task)?;
            let prompt =
                crate::commands::research_dispatch::task_dispatch_prompt(&store, &study, entry)?;
            crate::commands::research_dispatch::spawn(
                &store,
                crate::commands::research_dispatch::SpawnRequest {
                    task: Some(prompt),
                    stdin: false,
                    title: Some(format!("{} · {}", entry.spec.role, task)),
                    harness: None,
                    model: None,
                    wake_parent: true,
                    research_task: Some(task),
                },
            )
            .await?;
        }
        ResearchCommand::Retry { task } => {
            require_lead(lead)?;
            store.research_retry_task(&study.id, &task)?;
            let dispatched =
                crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id)?;
            if let Some((_, sid)) = dispatched.iter().find(|(tid, _)| tid == &task) {
                println!("任务 {task} 已重置并自动重新派发专家会话 {sid}。");
            } else {
                println!("任务 {task} 已重置为待执行（实验任务请先执行 prepare-run 绑定契约并确认 G2/G3）。");
            }
        }
        ResearchCommand::PrepareRun { task, mut args } => {
            require_lead(lead)?;
            crate::local::apply_compute_default(&mut args.backend, &mut args.flavor);
            if args.backend.is_none() {
                args.backend = Some("local".into());
            }
            crate::compute::validate_run_args(&args)?;
            let contract = crate::local::research::run_contract(&store, &args)?;
            store.research_prepare(&study.id, &task, contract)?;
            println!("运行契约已登记，等待用户批准 G2/G3。");
        }
        ResearchCommand::Finish { task, file } => {
            let own = store.research_session_task(&session)?;
            let id = task
                .or_else(|| own.as_ref().map(|(id, _)| id.clone()))
                .ok_or_else(|| anyhow!("研究负责人验收需要 --task"))?;
            if !lead
                && (own.as_ref().is_none_or(|(task, version)| {
                    task != &id || study.plan().map_or(true, |p| p.version != *version)
                }) || study
                    .task(&id)
                    .map_or(true, |t| t.session_id.as_deref() != Some(session.as_str())))
            {
                return Err(anyhow!("不能完成其他专家的任务"));
            }
            let result = read::<Finish>(&file)?;
            store.research_finish(&study.id, &id, result.success, result.summary)?;
            if result.success {
                let _ = crate::commands::research_dispatch::auto_dispatch_ignoring_session(
                    &store,
                    &study.id,
                    if lead { None } else { Some(&session) },
                );
            }
            println!("任务产物已验收登记。");
        }
        ResearchCommand::Claim { file } => {
            store.research_add_claim(&study.id, read::<ClaimInput>(&file)?)?;
            println!("证据声明已登记；科学有效性仍需独立审查。");
        }
        ResearchCommand::AmendClaim { claim, file } => {
            require_lead(lead)?;
            let receipt = store.research_amend_claim(
                &study.id,
                &session,
                &claim,
                read::<ClaimAmendmentInput>(&file)?,
            )?;
            println!("{}", serde_json::to_string_pretty(&receipt)?);
            eprintln!("声明修订已登记；请修订计划并重新完成独立审查与交付确认。");
        }
        ResearchCommand::Export => {
            require_lead(lead)?;
            let (mut archive, snapshot) = store.research_download_package(&study.id)?;
            let written = std::io::copy(&mut archive, &mut std::io::stdout().lock())?;
            if written != snapshot.archive.bytes {
                return Err(anyhow!("导出未完成，不能使用该研究包"));
            }
        }
        ResearchCommand::Package => {
            require_lead(lead)?;
            store.research_request_package(&study.id)?;
            println!(
                "已封存研究包并申请 {} 人工确认；确认后可运行 orx research export 导出 ZIP。",
                crate::local::research::delivery_gate(study.workflow_mode())
            );
        }
    }
    Ok(())
}
fn require_lead(lead: bool) -> Result<()> {
    if !lead {
        return Err(anyhow!("此操作仅允许研究负责人执行"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_amendment_cli_requires_target_and_file_without_approval_verb() {
        use clap::Parser;
        assert!(crate::Cli::try_parse_from([
            "orx",
            "research",
            "amend-claim",
            "claim-id",
            "--file",
            "request.json"
        ])
        .is_ok());
        for args in [
            vec!["orx", "research", "amend-claim", "--file", "request.json"],
            vec!["orx", "research", "amend-claim", "claim-id"],
            vec!["orx", "research", "approve"],
        ] {
            assert!(crate::Cli::try_parse_from(args).is_err());
        }
        assert!(require_lead(false).is_err());
    }

    #[test]
    fn research_request_reader_stops_at_size_limit_and_accepts_boundary() {
        struct Counted(usize);
        impl Read for Counted {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.0 += buffer.len();
                buffer.fill(b' ');
                Ok(buffer.len())
            }
        }
        let mut huge = Counted(0);
        let error = read_request::<serde_json::Value>(&mut huge).unwrap_err();
        assert!(error.to_string().contains("256 KiB"));
        assert_eq!(huge.0, 256 * 1024 + 1);
        let boundary =
            std::io::Cursor::new(b"null").chain(std::io::repeat(b' ').take(256 * 1024 - 4));
        assert_eq!(
            read_request::<serde_json::Value>(boundary).unwrap(),
            serde_json::Value::Null
        );
        assert!(read_request::<serde_json::Value>(&b"invalid"[..]).is_err());
    }
}
