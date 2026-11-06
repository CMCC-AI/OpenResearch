//! Project-scoped observations and explicitly reviewed, operator-only reclamation.
use crate::{
    error::{anyhow, Result},
    store::{research::ArchiveGcWindow, Store},
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
    /// List the permanent delivery archive catalog (unknown files stay protected).
    Archives {
        #[arg(long)]
        study: String,
        #[arg(long, default_value_t = 0)]
        after: i64,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// Preview unused preparation archives. Apply requires the same cutoff/token.
    ArchiveGc {
        #[arg(long)]
        study: String,
        /// Fixed Unix millisecond cutoff, at least 24 hours in the past.
        #[arg(long)]
        before: Option<i64>,
        /// Resume after this catalog cursor; keep the preview's fixed window.
        #[arg(long, default_value_t = 0)]
        after: i64,
        /// Inclusive catalog horizon returned by the first preview.
        #[arg(long)]
        through: Option<i64>,
        /// Apply the exact previewHash; operator CLI only, never an agent tool.
        #[arg(long, requires = "before")]
        apply: Option<String>,
    },
    /// Resolve interrupted GC intents without deleting any file (operator only).
    ArchiveRecover {
        #[arg(long)]
        study: String,
    },
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
        StorageCommand::Archives {
            study,
            after,
            limit,
        } => println!(
            "{}",
            serde_json::to_string_pretty(
                &store.research_archives(&project, &study, after, limit)?
            )?
        ),
        StorageCommand::ArchiveGc {
            study,
            before,
            after,
            through,
            apply,
        } => {
            let before = before.unwrap_or_else(|| crate::store::now_ms() - 7 * 86_400_000);
            let window = ArchiveGcWindow {
                before,
                after,
                through,
            };
            if let Some(token) = apply {
                if session.is_some() {
                    return Err(anyhow!("Agent 会话不能执行归档回收，请使用独立操作员终端"));
                }
                let result = store.research_archive_gc_apply(&project, &study, window, &token)?;
                println!("{}", serde_json::to_string_pretty(&result)?);
                if !result.failed.is_empty() {
                    return Err(anyhow!("部分归档回收失败，请检查 failed 并重新预览当前页"));
                }
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &store.research_archive_gc_preview(&project, &study, window)?
                    )?
                );
            }
        }
        StorageCommand::ArchiveRecover { study } => {
            if session.is_some() {
                return Err(anyhow!("Agent 会话不能执行归档恢复，请使用独立操作员终端"));
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&store.research_archive_recover(&project, &study)?)?
            );
        }
    }
    Ok(())
}
