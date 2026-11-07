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
    /// Persist a newly verified observation without overwriting previous evidence.
    Register {
        run: String,
        #[arg(long)]
        file: String,
        #[arg(long)]
        project: Option<String>,
    },
    /// List bounded evidence summaries for a Run, including deleted historical Runs.
    List {
        run: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long, default_value_t = 0)]
        after: i64,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Read an immutable historical observation; does not recheck live files.
    Show {
        id: String,
        #[arg(long)]
        project: Option<String>,
    },
}

pub async fn run(args: MetricsArgs) -> Result<()> {
    let project = match &args.command {
        MetricsCommand::Inspect { project, .. }
        | MetricsCommand::Register { project, .. }
        | MetricsCommand::List { project, .. }
        | MetricsCommand::Show { project, .. } => project.clone(),
    };
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
    let result = match args.command {
        MetricsCommand::Inspect { run, file, .. } => serde_json::to_value(
            crate::scientific_metrics::inspect(&store, &project, &run, &file)?,
        )?,
        MetricsCommand::Register { run, file, .. } => serde_json::to_value(
            crate::scientific_metrics::register(&store, &project, &run, &file)?,
        )?,
        MetricsCommand::List {
            run, after, limit, ..
        } => store.metric_evidence_list(&project, &run, after, limit)?,
        MetricsCommand::Show { id, .. } => {
            serde_json::to_value(store.metric_evidence(&project, &id)?)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
