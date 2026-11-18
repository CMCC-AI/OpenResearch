//! User-registered MCP servers that custom experts can mount, persisted as
//! `config_dir()/mcp.json` with owner-only permissions. Entries carry the
//! launch configuration (stdio command or HTTP URL plus env/headers), so this
//! file is the only place secrets live: nothing here lands in SQLite or the
//! session worktree, and plan snapshots freeze ids and names only.

use crate::error::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Transport a harness understands natively. `stdio` servers spawn as child
/// processes; `http` servers are remote endpoints (Claude and OpenCode only —
/// Codex skips them).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    /// The key each harness config uses (`mcpServers.<name>`). Restricted to
    /// `[A-Za-z0-9_-]+`: dots would break Codex's dotted `-c` overrides, and
    /// `orx` is reserved for the permission bridge.
    pub name: String,
    pub transport: McpTransport,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerInput {
    pub name: String,
    pub transport: McpTransport,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub enabled: bool,
}

pub fn validate_mcp_server(input: &McpServerInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.len() > 120 {
        return Err(anyhow!("服务名称需要为 1–120 个字符"));
    }
    if !input
        .name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(anyhow!(
            "服务名称只能包含字母、数字、下划线和连字符（各引擎把它用作配置键）"
        ));
    }
    if input.name.eq_ignore_ascii_case("orx") {
        return Err(anyhow!("服务名称 orx 为权限网关保留"));
    }
    if input.description.len() > 2048 {
        return Err(anyhow!("服务说明不能超过 2048 个字符"));
    }
    match input.transport {
        McpTransport::Stdio => {
            if input.command.trim().is_empty() {
                return Err(anyhow!("本地命令型服务需要填写启动命令"));
            }
        }
        McpTransport::Http => {
            if !input.url.starts_with("http://") && !input.url.starts_with("https://") {
                return Err(anyhow!("远程服务地址需要以 http:// 或 https:// 开头"));
            }
        }
    }
    if input.env.keys().any(|key| key.trim().is_empty()) {
        return Err(anyhow!("环境变量名不能为空"));
    }
    if input.headers.keys().any(|key| key.trim().is_empty()) {
        return Err(anyhow!("请求头名称不能为空"));
    }
    Ok(())
}

fn registry_path() -> PathBuf {
    crate::config::config_dir().join("mcp.json")
}

/// 校验一组 MCP 引用都存在于注册表；agent 挂载入口（HTTP/CLI）共用。
pub fn validate_mcp_refs(ids: &[String]) -> Result<()> {
    for id in ids {
        if server(id).is_none() {
            return Err(anyhow!(
                "未知 MCP 服务: {id}（需要先在界面登记，或用 orx mcp propose 提案并经用户批准）"
            ));
        }
    }
    Ok(())
}

fn input_from_entry(entry: &serde_json::Value) -> Option<McpServerInput> {
    let obj = entry.as_object()?;
    let url = obj
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let explicit_type = obj
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let transport = if !url.is_empty() || explicit_type == "http" || explicit_type == "sse" {
        McpTransport::Http
    } else {
        McpTransport::Stdio
    };
    let string_map = |key: &str| -> BTreeMap<String, String> {
        obj.get(key)
            .and_then(|value| value.as_object())
            .map(|map| {
                map.iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| (key.clone(), value.to_string()))
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default()
    };
    // 兼容 Claude/Cursor 的 `type: stdio` 命令对象与 Codex 的 command/args。
    let command = obj
        .get("command")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let args = obj
        .get("args")
        .and_then(|value| value.as_array())
        .map(|args| {
            args.iter()
                .filter_map(|arg| arg.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if matches!(transport, McpTransport::Stdio) && command.is_empty() {
        return None;
    }
    Some(McpServerInput {
        name: obj
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        transport,
        command,
        args,
        env: string_map("env"),
        url,
        headers: string_map("headers"),
        description: obj
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        enabled: true,
    })
}

/// 把用户从各客户端文档复制来的 MCP 配置解析成服务列表，支持三种常见形态：
/// Claude/Cursor 的 `{"mcpServers": {…}}` JSON、单个服务对象（含 `{"名称": {…}}`）、
/// Codex 的 `[mcp_servers.名称]` TOML 段。名称取配置里的键，空则留待用户补填。
pub fn parse_config_text(text: &str) -> Result<Vec<(String, McpServerInput)>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("请粘贴配置内容"));
    }
    // Claude/Cursor 系 JSON：{"mcpServers": {...}} 或单服务对象。
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let entries: Vec<(String, &serde_json::Value)> = if let Some(map) =
            value.get("mcpServers").and_then(|v| v.as_object())
        {
            map.iter().map(|(k, v)| (k.clone(), v)).collect()
        } else if value
            .as_object()
            .is_some_and(|map| map.keys().any(|key| key == "command" || key == "url"))
        {
            vec![(String::new(), &value)]
        } else if let Some(map) = value.as_object() {
            // {"服务名": {…}} 的形态；多服务也逐个接受。
            map.iter()
                .filter(|(_, entry)| entry.get("command").is_some() || entry.get("url").is_some())
                .map(|(k, v)| (k.clone(), v))
                .collect()
        } else {
            Vec::new()
        };
        let parsed = entries
            .iter()
            .filter_map(|(name, entry)| {
                let mut input = input_from_entry(entry)?;
                if input.name.is_empty() {
                    input.name = name.clone();
                }
                Some((name.clone(), input))
            })
            .collect::<Vec<_>>();
        if parsed.is_empty() {
            return Err(anyhow!(
                "没有识别到 MCP 服务配置（需要 command 或 url 字段）"
            ));
        }
        return Ok(parsed);
    }
    // Codex TOML：[mcp_servers.名称] 段。
    if let Ok(value) = toml::from_str::<toml::Value>(trimmed) {
        if let Some(map) = value.get("mcp_servers").and_then(|v| v.as_table()) {
            let parsed = map
                .iter()
                .filter_map(|(name, entry)| {
                    let entry = serde_json::to_value(entry).ok()?;
                    let mut input = input_from_entry(&entry)?;
                    if input.name.is_empty() {
                        input.name = name.clone();
                    }
                    Some((name.clone(), input))
                })
                .collect::<Vec<_>>();
            if !parsed.is_empty() {
                return Ok(parsed);
            }
        }
        return Err(anyhow!("TOML 里没有找到 [mcp_servers.…] 服务段"));
    }
    Err(anyhow!(
        "无法识别的配置格式（支持 JSON 的 mcpServers 或 Codex 的 TOML）"
    ))
}

// Registry writes happen only inside the running `orx up` server (CLI `orx mcp
// propose` lands as a pending proposal; the dashboard's approval writes the
// registry), so a process-global mutex is enough to serialize read-modify-write.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    #[serde(default)]
    servers: Vec<McpServer>,
}

fn read_registry_in(path: &Path) -> RegistryFile {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return RegistryFile::default();
    };
    match serde_json::from_str(&raw) {
        Ok(registry) => registry,
        Err(error) => {
            // 解析失败说明文件损坏（多半是旧版非原子写入留下的半截 JSON）：
            // 先把坏文件改名保留，避免下一次写入把用户配置整体覆盖掉。
            let backup =
                path.with_extension(format!("json.corrupt-{}", uuid::Uuid::new_v4().simple()));
            if std::fs::rename(path, &backup).is_ok() {
                eprintln!(
                    "orx: mcp.json 无法解析（{error}），原文件已保留为 {}",
                    backup.display()
                );
            }
            RegistryFile::default()
        }
    }
}

fn write_registry_in(path: &Path, registry: &RegistryFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(registry)?;
    // 同目录临时文件 + rename 原子替换：中断不会留下半截 JSON 被下次读取
    // 当成空注册表；临时文件一步按 0600 创建，密钥全程不放宽权限。
    let temp = path.with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4().simple()));
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?
            .write_all(format!("{body}\n").as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&temp, format!("{body}\n"))?;
    }
    std::fs::rename(&temp, path)?;
    Ok(())
}

fn registry_path_for_test() -> PathBuf {
    std::env::temp_dir().join(format!("orx-mcp-registry-{}", uuid::Uuid::new_v4()))
}

pub fn list_servers() -> Vec<McpServer> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_registry_in(&registry_path()).servers
}

pub fn server(id: &str) -> Option<McpServer> {
    list_servers().into_iter().find(|server| server.id == id)
}

pub fn create_server(input: McpServerInput) -> Result<McpServer> {
    create_server_in(&registry_path(), input)
}

/// 导入语义：同名服务直接覆盖（保留 id 与挂载关系），否则新建。
/// 提案批准仍走 [`create_server`]（重名报错），只有显式导入允许覆盖。
pub fn upsert_server(input: McpServerInput) -> Result<(McpServer, bool)> {
    upsert_server_in(&registry_path(), input)
}

pub fn update_server(id: &str, input: McpServerInput) -> Result<McpServer> {
    update_server_in(&registry_path(), id, input)
}

pub fn delete_server(id: &str) -> Result<bool> {
    delete_server_in(&registry_path(), id)
}

fn create_server_in(path: &Path, input: McpServerInput) -> Result<McpServer> {
    validate_mcp_server(&input)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry_in(path);
    if registry
        .servers
        .iter()
        .any(|server| server.name.eq_ignore_ascii_case(input.name.trim()))
    {
        return Err(anyhow!("已存在同名服务「{}」", input.name.trim()));
    }
    let now = now_ms();
    let server = McpServer {
        id: format!("mcp-{}", uuid::Uuid::new_v4().simple()),
        name: input.name.trim().to_string(),
        transport: input.transport,
        command: input.command.trim().to_string(),
        args: input.args,
        env: input.env,
        url: input.url.trim().to_string(),
        headers: input.headers,
        description: input.description,
        enabled: input.enabled,
        created_at: now,
        updated_at: now,
    };
    registry.servers.push(server.clone());
    write_registry_in(path, &registry)?;
    Ok(server)
}

fn upsert_server_in(path: &Path, input: McpServerInput) -> Result<(McpServer, bool)> {
    validate_mcp_server(&input)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry_in(path);
    let now = now_ms();
    let existing = registry
        .servers
        .iter_mut()
        .find(|server| server.name.eq_ignore_ascii_case(input.name.trim()));
    if let Some(previous) = existing {
        previous.transport = input.transport;
        previous.command = input.command.trim().to_string();
        previous.args = input.args;
        previous.env = input.env;
        previous.url = input.url.trim().to_string();
        previous.headers = input.headers;
        previous.description = input.description;
        previous.enabled = input.enabled;
        previous.updated_at = now;
        let updated = previous.clone();
        write_registry_in(path, &registry)?;
        return Ok((updated, false));
    }
    let server = McpServer {
        id: format!("mcp-{}", uuid::Uuid::new_v4().simple()),
        name: input.name.trim().to_string(),
        transport: input.transport,
        command: input.command.trim().to_string(),
        args: input.args,
        env: input.env,
        url: input.url.trim().to_string(),
        headers: input.headers,
        description: input.description,
        enabled: input.enabled,
        created_at: now,
        updated_at: now,
    };
    registry.servers.push(server.clone());
    write_registry_in(path, &registry)?;
    Ok((server, true))
}

fn update_server_in(path: &Path, id: &str, input: McpServerInput) -> Result<McpServer> {
    validate_mcp_server(&input)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry_in(path);
    if !registry.servers.iter().any(|server| server.id == id) {
        return Err(anyhow!("MCP 服务不存在"));
    }
    if registry
        .servers
        .iter()
        .any(|server| server.id != id && server.name.eq_ignore_ascii_case(input.name.trim()))
    {
        return Err(anyhow!("已存在同名服务「{}」", input.name.trim()));
    }
    let previous = registry
        .servers
        .iter_mut()
        .find(|server| server.id == id)
        .ok_or_else(|| anyhow!("MCP 服务不存在"))?;
    previous.name = input.name.trim().to_string();
    previous.transport = input.transport;
    previous.command = input.command.trim().to_string();
    previous.args = input.args;
    previous.env = input.env;
    previous.url = input.url.trim().to_string();
    previous.headers = input.headers;
    previous.description = input.description;
    previous.enabled = input.enabled;
    previous.updated_at = now_ms();
    let updated = previous.clone();
    write_registry_in(path, &registry)?;
    Ok(updated)
}

fn delete_server_in(path: &Path, id: &str) -> Result<bool> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry_in(path);
    let before = registry.servers.len();
    registry.servers.retain(|server| server.id != id);
    let deleted = registry.servers.len() < before;
    if deleted {
        write_registry_in(path, &registry)?;
    }
    Ok(deleted)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_input(name: &str) -> McpServerInput {
        McpServerInput {
            name: name.into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                "/tmp".into(),
            ],
            env: BTreeMap::from([("API_KEY".into(), "secret".into())]),
            url: String::new(),
            headers: BTreeMap::new(),
            description: "文件系统访问".into(),
            enabled: true,
        }
    }

    #[test]
    fn registry_round_trips_and_enforces_name_rules() {
        let path = registry_path_for_test();
        let created = create_server_in(&path, stdio_input("codegraph")).unwrap();
        assert!(created.id.starts_with("mcp-"));
        assert!(created.enabled);
        // 0600：密钥只留在本机。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // 同名拒绝；orx 保留名拒绝；非法键字符拒绝。
        assert!(create_server_in(&path, stdio_input("CodeGraph")).is_err());
        let reserved = stdio_input("orx");
        assert!(validate_mcp_server(&reserved).is_err());
        let dotted = stdio_input("my.server");
        assert!(validate_mcp_server(&dotted).is_err());
        // stdio 必须有命令；http 必须是合法 URL。
        let mut no_command = stdio_input("broken");
        no_command.command = String::new();
        assert!(validate_mcp_server(&no_command).is_err());
        let mut http = stdio_input("remote");
        http.transport = McpTransport::Http;
        http.url = "not-a-url".into();
        assert!(validate_mcp_server(&http).is_err());
        http.url = "https://mcp.example.com/v1".into();
        assert!(validate_mcp_server(&http).is_ok());

        // 导入语义：同名覆盖（id 不变），不存在则新建。
        let (upserted, created_now) = upsert_server_in(&path, stdio_input("codegraph")).unwrap();
        assert!(!created_now);
        assert_eq!(upserted.id, created.id);
        let (fresh, created_now) = upsert_server_in(&path, stdio_input("fresh-one")).unwrap();
        assert!(created_now);
        assert_eq!(list_servers_in(&path).len(), 2);
        assert!(delete_server_in(&path, &fresh.id).unwrap());
        let updated = update_server_in(&path, &created.id, {
            let mut input = stdio_input("codegraph");
            input.enabled = false;
            input
        })
        .unwrap();
        assert_eq!(list_servers_in(&path).len(), 1);
        assert!(!updated.enabled);
        assert!(update_server_in(&path, "mcp-missing", stdio_input("x")).is_err());
        assert!(delete_server_in(&path, &created.id).unwrap());
        assert!(!delete_server_in(&path, &created.id).unwrap());
        assert!(list_servers_in(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    fn list_servers_in(path: &Path) -> Vec<McpServer> {
        read_registry_in(path).servers
    }

    #[test]
    fn parses_configs_pasted_from_other_clients() {
        // Claude/Cursor 的 mcpServers JSON。
        let claude = r#"{
            "mcpServers": {
                "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]},
                "remote": {"type": "http", "url": "https://mcp.example.com/v1", "headers": {"Authorization": "Bearer t"}}
            }
        }"#;
        let parsed = parse_config_text(claude).unwrap();
        assert_eq!(parsed.len(), 2);
        let (name, stdio) = &parsed[0];
        assert_eq!(name, "filesystem");
        // 键名填入服务名称：粘贴导入直接可保存，无需手动补名。
        assert_eq!(stdio.name, "filesystem");
        assert_eq!(stdio.transport, McpTransport::Stdio);
        assert_eq!(stdio.command, "npx");
        assert_eq!(stdio.args.len(), 3);
        let (_, http) = &parsed[1];
        assert_eq!(http.transport, McpTransport::Http);
        assert_eq!(
            http.headers.get("Authorization").map(String::as_str),
            Some("Bearer t")
        );
        // Codex 的 config.toml 段。
        let codex = r#"
            [mcp_servers.seek]
            command = "npx"
            args = ["-y", "seek-mcp"]
            env = { "API_KEY" = "k" }
        "#;
        let parsed = parse_config_text(codex).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "seek");
        assert_eq!(
            parsed[0].1.env.get("API_KEY").map(String::as_str),
            Some("k")
        );
        // 单服务对象与 {"名称": {…}} 形态。
        let single = r#"{"command": "uvx", "args": ["mcp-thing"]}"#;
        assert_eq!(parse_config_text(single).unwrap().len(), 1);
        let keyed = r#"{"my-server": {"command": "node", "args": ["x.js"]}}"#;
        let parsed = parse_config_text(keyed).unwrap();
        assert_eq!(parsed[0].0, "my-server");
        // 空文本与无 command/url 的对象报错。
        assert!(parse_config_text("").is_err());
        assert!(parse_config_text(r#"{"foo": "bar"}"#).is_err());
    }
}
