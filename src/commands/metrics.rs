//! Scientific observations are separate from chat usage and require explicit provenance.
use clap::{Args, Subcommand};

use crate::error::{anyhow, Result};
use crate::store::Store;

#[derive(Debug, Args)]
pub struct MetricsArgs {
    #[command(subcommand)]
    command: MetricsCommand,
}

#[derive(Debug, Subcommand)]
enum MetricsCommand {
    /// Verify a bounded JSON report under this run's project artifacts directory.
    Inspect {
        run: String,
        #[arg(long)]
        file: String,
        /// Required outside an agent session; never inferred from the working directory.
        #[arg(long)]
        project: Option<String>,
    },
}

pub async fn run(args: MetricsArgs) -> Result<()> {
    let MetricsCommand::Inspect { run, file, project } = args.command;
    let store = Store::open()?;
    let session = crate::local::chat::launching_chat_session();
    let session_project = session
        .map(|id| {
            store
                .get_chat_session(&id)?
                .map(|session| session.project_id)
                .ok_or_else(|| anyhow!("agent session not found"))
        })
        .transpose()?;
    if session_project.is_some() && project.is_some() && session_project != project {
        return Err(anyhow!("不能跨项目检查科学指标"));
    }
    let project = session_project
        .or(project)
        .ok_or_else(|| anyhow!("请提供 --project 或在 agent 会话中运行"))?;
    let result = crate::scientific_metrics::inspect(&store, &project, &run, &file)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
