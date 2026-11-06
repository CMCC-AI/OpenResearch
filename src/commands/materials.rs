//! Common material reader for every coding-agent harness.
use crate::store::material_reads::ReadFilter;
use crate::{
    error::{anyhow, Result},
    local::materials,
    store::Store,
};
use clap::{Args, Subcommand};
use std::io::Write;
#[derive(Args, Debug)]
pub struct MaterialsArgs {
    /// Project id for use outside an agent session.
    #[arg(long)]
    pub project: Option<String>,
    #[command(subcommand)]
    pub command: MaterialsCommand,
}
#[derive(Subcommand, Debug)]
pub enum MaterialsCommand {
    /// Locate a confirmed selection; verify its original and returned-content hashes.
    Locate { event: String },
    /// Query bounded reading receipts; these do not assert model understanding.
    Events {
        #[arg(long)]
        package: Option<String>,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        study: Option<String>,
        #[arg(long, default_value_t = 0)]
        after: i64,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Union confirmed ranges within each task, plan, source and parser view.
    Coverage {
        #[arg(long)]
        package: String,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        study: Option<String>,
    },
    /// Preview abandoned unsealed uploads; sealed inputs are always retained.
    Gc {
        #[arg(long, default_value_t = 7)]
        days: u32,
        /// Remove only the reported abandoned uploads (unavailable inside agent sessions).
        #[arg(long)]
        apply: bool,
    },
    /// List immutable sources, versions and parsing limitations.
    List {
        package: String,
        #[arg(long, default_value_t = 1)]
        offset: usize,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// Read bounded text with provenance; PDF reads require a page number.
    Read {
        package: String,
        source: String,
        #[arg(long, default_value_t = 1)]
        offset: usize,
        #[arg(long, default_value_t = 200)]
        limit: usize,
        #[arg(long)]
        page: Option<u32>,
    },
}
pub async fn run(args: MaterialsArgs) -> Result<()> {
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
            return Err(anyhow!("不能跨项目读取材料"));
        }
    }
    let project = session_project
        .or(args.project)
        .ok_or_else(|| anyhow!("请提供 --project 或在 agent 会话中运行"))?;
    if !matches!(&args.command, MaterialsCommand::Gc { .. }) {
        store
            .get_local_project(&project)?
            .ok_or_else(|| anyhow!("project not found"))?;
    }
    let result = match args.command {
        MaterialsCommand::Locate { event } => {
            materials::locate(&store, &project, session.as_deref(), &event).await?
        }
        MaterialsCommand::Events {
            package,
            source,
            session,
            study,
            after,
            limit,
        } => store.material_read_events(
            &project,
            &ReadFilter {
                package,
                source,
                session,
                study,
            },
            after,
            limit,
        )?,
        MaterialsCommand::Coverage {
            package,
            source,
            session,
            study,
        } => store.material_read_coverage(
            &project,
            &ReadFilter {
                package: Some(package),
                source,
                session,
                study,
            },
        )?,
        MaterialsCommand::Gc { days, apply } => {
            if apply && crate::local::chat::launching_chat_session().is_some() {
                return Err(anyhow!(
                    "Agent 会话不能删除材料；请由用户在终端检查清单后执行"
                ));
            }
            serde_json::to_value(materials::collect_abandoned(&project, days, apply)?)?
        }
        MaterialsCommand::List {
            package,
            offset,
            limit,
        } => {
            if offset == 0 || limit == 0 || limit > 200 {
                return Err(anyhow!("offset 从 1 开始，limit 为 1–200"));
            }
            let manifest = materials::get(&package, &project)?;
            if !manifest.ready {
                return Err(anyhow!("材料尚未上传完成"));
            }
            let files: Vec<_> = manifest.files.iter().skip(offset - 1).take(limit).collect();
            serde_json::json!({"id":manifest.id,"projectId":manifest.project_id,"totalFiles":manifest.files.len(),"nextOffset":(offset + files.len() <= manifest.files.len()).then_some(offset + files.len()),"files":files})
        }
        MaterialsCommand::Read {
            package,
            source,
            offset,
            limit,
            page,
        } => {
            let context = store.material_read_context(&project, session.as_deref(), &package)?;
            materials::read_recorded(
                &store,
                context,
                materials::ReadRequest {
                    package,
                    source,
                    offset,
                    limit,
                    page,
                },
            )
            .await?
        }
    };
    write_result(&store, &project, &result, std::io::stdout().lock())
}

pub(crate) fn write_result(
    store: &Store,
    project: &str,
    result: &serde_json::Value,
    mut writer: impl Write,
) -> Result<()> {
    let output = format!("{}\n", serde_json::to_string_pretty(result)?);
    let written = writer
        .write_all(output.as_bytes())
        .and_then(|_| writer.flush());
    if let Some(event) = result["readEventId"].as_str() {
        store.material_read_output(
            project,
            event,
            written
                .as_ref()
                .err()
                .map(|error| error.to_string())
                .as_deref(),
        )?;
    }
    written?;
    Ok(())
}
