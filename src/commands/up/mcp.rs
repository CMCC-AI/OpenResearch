//! MCP 服务登记与提案 API：注册表落 `config_dir()/mcp.json`（0600，密钥只留本机），
//! 提案走 SQLite 等用户确认。`/api/mcp/test` 对未保存的配置做一次连通性探测，
//! 避免坏配置拖死专家会话的启动（各引擎会在 MCP 启动上阻塞）。
use super::*;
use crate::error::{anyhow, Result};
use crate::local::mcp_registry::{self, McpServer, McpServerInput, McpTransport};
use crate::store::mcp::McpProposal;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn server_json(server: &McpServer) -> Value {
    json!({
        "id": server.id,
        "name": server.name,
        "transport": server.transport,
        "command": server.command,
        "args": server.args,
        "env": server.env,
        "url": server.url,
        "headers": server.headers,
        "description": server.description,
        "enabled": server.enabled,
        "createdAt": server.created_at,
        "updatedAt": server.updated_at,
    })
}

fn proposal_json(proposal: &McpProposal) -> Value {
    json!({
        "id": proposal.id,
        "sessionId": proposal.session_id,
        "name": proposal.name,
        "payload": serde_json::from_str::<Value>(&proposal.payload).unwrap_or(Value::Null),
        "rationale": proposal.rationale,
        "status": proposal.status,
        "createdAt": proposal.created_at,
        "decidedAt": proposal.decided_at,
    })
}

pub(super) async fn servers() -> ApiResult {
    blocking_api(move || {
        let servers = mcp_registry::list_servers()
            .iter()
            .map(server_json)
            .collect::<Vec<_>>();
        Ok(Json(json!({"servers": servers})))
    })
    .await
}

pub(super) async fn create_server(Json(input): Json<McpServerInput>) -> ApiResult {
    blocking_api(move || {
        let server = mcp_registry::create_server(input).map_err(bad_request)?;
        Ok(Json(json!({"server": server_json(&server)})))
    })
    .await
}

pub(super) async fn update_server(
    Path(id): Path<String>,
    Json(input): Json<McpServerInput>,
) -> ApiResult {
    blocking_api(move || {
        let server = mcp_registry::update_server(&id, input).map_err(bad_request)?;
        Ok(Json(json!({"server": server_json(&server)})))
    })
    .await
}

pub(super) async fn delete_server(Path(id): Path<String>) -> ApiResult {
    blocking_api(move || {
        let store = Store::open()?;
        if !mcp_registry::delete_server(&id).map_err(bad_request)? {
            return Err(not_found("mcp server"));
        }
        // 注册表删除后清理所有专家的挂载引用；旧计划的快照只留 id/名称，不受影响。
        store.delete_agent_mcp_refs(&id)?;
        Ok(Json(json!({"ok": true})))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DecideProposal {
    pub approve: bool,
}

pub(super) async fn decide_proposal(
    Path(id): Path<String>,
    Json(request): Json<DecideProposal>,
) -> ApiResult {
    blocking_api(move || {
        let store = Store::open()?;
        // 批准路径先登记再消费提案：登记失败（如同名冲突）时提案保持待确认，
        // 卡片不消失，用户处理完冲突后可以再次批准。
        let server = if request.approve {
            let pending = match store.mcp_proposal(&id)? {
                Some(proposal) if proposal.status == "pending" => proposal,
                Some(proposal) => {
                    return Err(bad_request(format!("提案已被处理（{}）", proposal.status)))
                }
                None => return Err(bad_request("提案不存在")),
            };
            let input: McpServerInput = serde_json::from_str(&pending.payload)
                .map_err(|error| bad_request(format!("提案配置无法解析: {error}")))?;
            // 批准即登记并启用；同名冲突时如实报错，提案保持待定可重试。
            Some(mcp_registry::create_server(input).map_err(bad_request)?)
        } else {
            None
        };
        let proposal = store
            .decide_mcp_proposal(&id, request.approve)
            .map_err(bad_request)?;
        Ok(Json(json!({
            "proposal": proposal_json(&proposal),
            "server": server.as_ref().map(server_json),
        })))
    })
    .await
}

pub(super) async fn proposals(Path(session_id): Path<String>) -> ApiResult {
    blocking_api(move || {
        let store = Store::open()?;
        let proposals = store
            .pending_mcp_proposals(&session_id)?
            .iter()
            .map(proposal_json)
            .collect::<Vec<_>>();
        Ok(Json(json!({"proposals": proposals})))
    })
    .await
}

/// 粘贴导入：解析（Claude/Cursor JSON、单服务对象、Codex TOML）并批量落库。
/// 同名服务覆盖更新（挂载关系保留），其余新建；解析失败的条目跳过并如实报告。
pub(super) async fn import_config(Json(request): Json<ParseConfig>) -> ApiResult {
    blocking_api(move || {
        let parsed = mcp_registry::parse_config_text(&request.text).map_err(bad_request)?;
        let mut created = 0usize;
        let mut updated = 0usize;
        let mut names = Vec::new();
        let mut errors = Vec::new();
        for (name, input) in parsed {
            match mcp_registry::upsert_server(input) {
                Ok((server, is_new)) => {
                    if is_new {
                        created += 1;
                    } else {
                        updated += 1;
                    }
                    names.push(server.name);
                }
                Err(error) => errors.push(format!(
                    "{}：{}",
                    if name.is_empty() {
                        "（未命名）"
                    } else {
                        &name
                    },
                    error
                )),
            }
        }
        if created + updated == 0 {
            return Err(bad_request(errors.join("；")));
        }
        Ok(Json(json!({
            "created": created,
            "updated": updated,
            "names": names,
            "errors": errors,
        })))
    })
    .await
}

/// 解析用户粘贴的 MCP 配置（Claude/Cursor JSON、单服务对象、Codex TOML），
/// 返回带键名的服务列表供表单预填；不落库。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ParseConfig {
    pub text: String,
}

pub(super) async fn parse_config(Json(request): Json<ParseConfig>) -> ApiResult {
    blocking_api(move || {
        let parsed = mcp_registry::parse_config_text(&request.text).map_err(bad_request)?;
        let servers = parsed
            .into_iter()
            .map(|(name, server)| {
                json!({"name": name, "server": serde_json::to_value(&server).unwrap_or(Value::Null)})
            })
            .collect::<Vec<_>>();
        Ok(Json(json!({"servers": servers})))
    })
    .await
}

/// 对未保存的配置做一次 initialize + tools/list 探测，返回工具名或错误说明。
pub(super) async fn test_server(Json(input): Json<McpServerInput>) -> ApiResult {
    mcp_registry::validate_mcp_server(&input).map_err(bad_request)?;
    let result = match input.transport {
        McpTransport::Stdio => tokio::task::spawn_blocking(move || test_stdio(&input))
            .await
            .map_err(|error| anyhow!("探测任务失败: {error}"))
            .and_then(|inner| inner),
        McpTransport::Http => test_http(&input).await,
    };
    match result {
        Ok(tools) => Ok(Json(json!({"ok": true, "tools": tools}))),
        Err(error) => Ok(Json(json!({"ok": false, "error": error.to_string()}))),
    }
}

const MCP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn test_stdio(input: &McpServerInput) -> Result<Vec<String>> {
    use std::sync::mpsc;
    let mut command = Command::new(&input.command);
    command
        .args(&input.args)
        .envs(&input.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 孤儿进程会在管道关闭后自然退出；完全不给它存活超过探测时限的机会。
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| anyhow!("无法启动「{}」: {error}", input.command))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("无法接入服务 stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("无法读取服务 stdout"))?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let deadline = std::time::Instant::now() + MCP_TIMEOUT;
    let mut send = |payload: &str| -> Result<()> {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!("连接超时（{} 秒）", MCP_TIMEOUT.as_secs()));
        }
        stdin
            .write_all(payload.as_bytes())
            .map_err(|error| anyhow!("服务已退出: {error}"))?;
        stdin.flush()?;
        Ok(())
    };
    send("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"orx\",\"version\":\"0.2\"}}}\n")?;
    send("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")?;
    send("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n")?;
    let mut tools = None;
    while std::time::Instant::now() < deadline {
        let line = match rx.recv_timeout(
            MCP_TIMEOUT.min(deadline.saturating_duration_since(std::time::Instant::now())),
        ) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => continue,
        };
        if message.get("id").and_then(Value::as_i64) == Some(2) {
            tools = Some(message);
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let message = tools.ok_or_else(|| {
        anyhow!(
            "连接超时（{} 秒）或服务未响应 tools/list",
            MCP_TIMEOUT.as_secs()
        )
    })?;
    if let Some(error) = message.get("error") {
        return Err(anyhow!("服务返回错误: {error}"));
    }
    let names = message
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(names)
}

async fn test_http(input: &McpServerInput) -> Result<Vec<String>> {
    let client = crate::net::remote_client()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(MCP_TIMEOUT)
        .build()
        .map_err(|error| anyhow!("无法构建 HTTP 客户端: {error}"))?;
    let mut request = client
        .post(&input.url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream");
    for (key, value) in &input.headers {
        request = request.header(key.as_str(), value.as_str());
    }
    let response = request
        .body(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "orx", "version": "0.2"}},
            })
            .to_string(),
        )
        .send()
        .await
        .map_err(|error| anyhow!("连接失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    // Streamable HTTP 可能返回 SSE 帧；取 data: 行里第一个 JSON。
    let payload = if body.trim_start().starts_with("event:") || body.contains("\ndata:") {
        body.lines()
            .find_map(|line| line.strip_prefix("data:").map(str::to_string))
            .unwrap_or(body)
    } else {
        body
    };
    let message: Value = serde_json::from_str(payload.trim())
        .map_err(|error| anyhow!("响应不是合法 JSON（HTTP {status}）: {error}"))?;
    if let Some(error) = message.get("error") {
        return Err(anyhow!("服务返回错误: {error}"));
    }
    let server_name = message
        .pointer("/result/serverInfo/name")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    Ok(vec![format!(
        "initialize 成功（{server_name}）；工具列表需会话内确认"
    )])
}
