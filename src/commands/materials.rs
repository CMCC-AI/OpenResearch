//! Common material reader for every coding-agent harness.
use crate::{
    error::{anyhow, Result},
    local::materials,
    store::Store,
};
use clap::{Args, Subcommand};
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
    let session_project = crate::local::chat::launching_chat_session()
        .map(|id| store.get_chat_session(&id))
        .transpose()?
        .flatten()
        .map(|s| s.project_id);
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
        } => materials::read(&package, &project, &source, offset, limit, page).await?,
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
