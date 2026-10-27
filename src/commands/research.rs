//! Native CLI for research orchestration. Deliberately no approval command.
use crate::error::{anyhow, Result};
use crate::store::{
    research::{ClaimInput, PlanInput},
    Store,
};
use clap::{Args, Subcommand};
use serde::Deserialize;

#[derive(Args, Debug)]
pub struct ResearchArgs {
    #[command(subcommand)]
    pub command: ResearchCommand,
}
#[derive(Subcommand, Debug)]
pub enum ResearchCommand {
    Status,
    Roles,
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
    Package,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finish {
    success: bool,
    summary: String,
}
fn read<T: serde::de::DeserializeOwned>(file: &str) -> Result<T> {
    let bytes = std::fs::read(file)?;
    if bytes.len() > 256 * 1024 {
        return Err(anyhow!("研究请求超过 256 KiB"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn run(args: ResearchArgs) -> Result<()> {
    if matches!(args.command, ResearchCommand::Roles) {
        for (id, prompt) in crate::local::research::ROLES {
            println!("{}: {}", id, prompt.lines().next().unwrap_or(id));
        }
        return Ok(());
    }
    let store = Store::open()?;
    let session = crate::local::chat::launching_chat_session()
        .ok_or_else(|| anyhow!("请在本地研究会话内使用 orx research"))?;
    let study = store
        .research_for_session(&session)?
        .ok_or_else(|| anyhow!("该会话未启用科研专家模式"))?;
    let lead = study.session_id == session;
    match args.command {
        ResearchCommand::Status => {
            println!("{}", serde_json::to_string_pretty(&study)?);
        }
        ResearchCommand::Roles => unreachable!(),
        ResearchCommand::Plan { file } => {
            require_lead(lead)?;
            store.research_set_plan(&study.id, read::<PlanInput>(&file)?)?;
            println!("计划已登记。等待用户在研究面板批准 G1，结束本轮即可。");
        }
        ResearchCommand::Dispatch { task } => {
            require_lead(lead)?;
            let entry = study.task(&task)?;
            let prompt = format!(
                "执行研究任务 {}。独立完成角色职责，读取声明的依赖产物，全部输出写入 {}。\n{}\n{}",
                task,
                store.research_root(&study)?.display(),
                entry.spec.brief,
                crate::local::research::role(&entry.spec.role)?
            );
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
                .ok_or_else(|| anyhow!("主理人验收需要 --task"))?;
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
        ResearchCommand::Package => {
            require_lead(lead)?;
            store.research_update(&study.id, |study| {
                study.ensure_active()?;
                let scope = store.research_package_scope(study)?;
                study.request_gate(
                    crate::local::research::delivery_gate(study.workflow_mode()),
                    scope,
                )
            })?;
            println!(
                "已申请 {} 人工确认；用户可在人工确认页面查看内容，并在产物页面查看和下载文件。",
                crate::local::research::delivery_gate(study.workflow_mode())
            );
        }
    }
    Ok(())
}
fn require_lead(lead: bool) -> Result<()> {
    if !lead {
        return Err(anyhow!("此操作仅允许研究主理人执行"));
    }
    Ok(())
}
