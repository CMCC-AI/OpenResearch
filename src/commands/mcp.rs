//! MCP registry access from the chat. The lead files proposals (`orx mcp
//! propose`) that the user confirms from a chat card before anything reaches
//! the registry; `orx mcp list` shows what is enabled and mountable.
use crate::error::{anyhow, Result};
use crate::store::{mcp::McpProposalInput, Store};
use crate::{McpArgs, McpCommand};

pub fn run(args: McpArgs) -> Result<()> {
    match args.command {
        McpCommand::List => {
            let servers: Vec<_> = crate::local::mcp_registry::list_servers()
                .into_iter()
                .filter(|server| server.enabled)
                .map(|server| {
                    serde_json::json!({
                        "id": server.id,
                        "name": server.name,
                        "transport": server.transport,
                        "command": server.command,
                        "url": server.url,
                        "description": server.description,
                    })
                })
                .collect();
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({"servers": servers}))?
            );
            Ok(())
        }
        McpCommand::Propose { file } => {
            let session = crate::local::chat::launching_chat_session()
                .ok_or_else(|| anyhow!("请在研究聊天会话内使用 orx mcp propose"))?;
            let input: McpProposalInput = read_request(std::fs::File::open(&file)?)?;
            let proposal = Store::open()?.create_mcp_proposal(&session, &input)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "proposalId": proposal.id,
                    "name": proposal.name,
                    "next": "提案已提交，等待用户在聊天确认卡片中批准；批准后服务才会登记并生效，不要重复提案。",
                }))?
            );
            Ok(())
        }
    }
}

fn read_request(reader: impl std::io::Read) -> Result<McpProposalInput> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err(anyhow!("MCP 提案超过 256 KiB"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
