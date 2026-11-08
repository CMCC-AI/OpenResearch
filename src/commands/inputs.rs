//! Explicit snapshot preparation; never dispatches a Run or acknowledges reading.
use crate::{
    error::{anyhow, Result},
    input_sets,
    store::Store,
};
use clap::{Args, Subcommand};
use std::{io::Read, path::PathBuf};
#[derive(Debug, Args)]
pub struct InputsArgs {
    #[arg(long, global = true)]
    pub project: Option<String>,
    #[command(subcommand)]
    pub command: InputsCommand,
}
#[derive(Debug, Subcommand)]
pub enum InputsCommand {
    /// Operator-only input-pool quota. No default limit or change to other pools.
    Quota {
        #[arg(long)]
        bytes: Option<u64>,
    },
    /// Copy explicitly selected registered sources into a retained byte snapshot.
    /// Frozen sets cannot yet be deleted and block deletion of their project.
    Freeze {
        #[arg(long)]
        file: PathBuf,
    },
    /// List bounded immutable identities and uncommitted/cancelled reservations.
    List {
        #[arg(long, default_value_t = 0)]
        after: i64,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Read the recorded identity; does not revalidate files or claim execution.
    Show { id: String },
    /// Rehash retained copies, without querying their live originals.
    Verify { id: String },
    /// Inspect a Run's fixed input delivery; optionally rehash its copies/code.
    Run {
        id: String,
        #[arg(long)]
        verify: bool,
    },
    /// Operator-only preview/recovery of an abandoned uncommitted reservation.
    Recover {
        id: String,
        #[arg(long)]
        apply: bool,
    },
    /// Operator-only recovery of an uncommitted per-Run input delivery.
    RecoverRun {
        id: String,
        #[arg(long)]
        apply: bool,
    },
}
pub async fn run(args: InputsArgs) -> Result<()> {
    let store = Store::open()?;
    let session = crate::local::chat::launching_chat_session();
    if matches!(
        args.command,
        InputsCommand::Quota { .. }
            | InputsCommand::Recover { .. }
            | InputsCommand::RecoverRun { .. }
    ) && session.is_some()
    {
        return Err(anyhow!("输入池配额和预约恢复仅限操作者，不能由 Agent 执行"));
    }
    if let InputsCommand::Quota { bytes } = args.command {
        if args.project.is_some() {
            return Err(anyhow!("配额作用于整个冻结输入池，不能指定项目"));
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&store.input_budget(bytes)?)?
        );
        return Ok(());
    }
    let session_project = session
        .map(|id| {
            store
                .get_chat_session(&id)?
                .map(|s| s.project_id)
                .ok_or_else(|| anyhow!("agent session not found"))
        })
        .transpose()?;
    if session_project.is_some() && args.project.is_some() && session_project != args.project {
        return Err(anyhow!("不能跨项目访问冻结输入"));
    }
    let project = session_project
        .or(args.project)
        .ok_or_else(|| anyhow!("请提供 --project 或在 Agent 会话中运行"))?;
    store
        .get_local_project(&project)?
        .ok_or_else(|| anyhow!("project not found"))?;
    let value = match args.command {
        InputsCommand::Freeze { file } => {
            if !std::fs::metadata(&file)?.is_file() {
                return Err(anyhow!("输入清单必须为普通文件"));
            }
            let mut json = Vec::new();
            std::fs::File::open(file)?
                .take(input_sets::MAX_MANIFEST + 1)
                .read_to_end(&mut json)?;
            if json.len() as u64 > input_sets::MAX_MANIFEST {
                return Err(anyhow!("输入清单超过 128 KiB"));
            }
            input_sets::freeze(&store, &project, serde_json::from_slice(&json)?)?
        }
        InputsCommand::List { after, limit } => store.input_list(&project, after, limit)?,
        InputsCommand::Show { id } => serde_json::to_value(store.input_record(&project, &id)?)?,
        InputsCommand::Verify { id } => input_sets::verify(&store, &project, &id)?,
        InputsCommand::Run { id, verify } => {
            if verify {
                input_sets::delivery::verify(&store, &project, &id)?
            } else {
                input_sets::delivery::show(&store, &project, &id)?
            }
        }
        InputsCommand::Recover { id, apply } => input_sets::recover(&store, &project, &id, apply)?,
        InputsCommand::RecoverRun { id, apply } => {
            input_sets::delivery::recover(&store, &project, &id, apply)?
        }
        InputsCommand::Quota { .. } => unreachable!(),
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
