//! Project-scoped capacity observations; deliberately no cleanup operation.
use crate::{
    error::{anyhow, Result},
    store::Store,
};
use clap::{Args, Subcommand};

#[derive(Args, Debug)]
pub struct StorageArgs {
    #[arg(long)]
    pub project: Option<String>,
    #[command(subcommand)]
    pub command: StorageCommand,
}
#[derive(Subcommand, Debug)]
pub enum StorageCommand {
    /// Observe logical bytes, metadata growth and retained delivery bundles.
    Usage,
}
pub async fn run(args: StorageArgs) -> Result<()> {
    let store = Store::open()?;
    let session = crate::local::chat::launching_chat_session();
    let session_project = session
        .as_ref()
        .map(|id| -> Result<String> {
            Ok(store
                .get_chat_session(id)?
                .ok_or_else(|| anyhow!("agent session not found"))?
                .project_id)
        })
        .transpose()?;
    if let (Some(session), Some(requested)) = (&session_project, &args.project) {
        if session != requested {
            return Err(anyhow!("不能跨项目查询容量"));
        }
    }
    let project = session_project
        .or(args.project)
        .ok_or_else(|| anyhow!("请提供 --project 或在 agent 会话中运行"))?;
    match args.command {
        StorageCommand::Usage => println!(
            "{}",
            serde_json::to_string_pretty(&store.project_storage_usage(&project)?)?
        ),
    }
    Ok(())
}
