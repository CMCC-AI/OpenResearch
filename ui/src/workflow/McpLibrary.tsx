import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import {
  deleteMcpServer,
  importMcpConfig,
  listMcpServers,
  testMcpServer,
  updateMcpServer,
} from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { Badge, Button, showAlert } from "../components/ui";
import { CapabilityTile } from "./CapabilityTile";
import type { McpServer } from "./model";

/** MCP 服务库：从各客户端文档复制来的 mcpServers 配置（Claude/Cursor JSON、
 * Codex TOML）粘贴导入即完成登记，同名自动覆盖更新。挂到自定义专家上后，
 * 派发该专家的 OpenCode 会话由引擎原生加载这些服务。
 * 配置（含环境变量密钥）只存本机 config_dir/mcp.json（0600），不入库不进工作树。 */
export function McpLibrary() {
  const serversQuery = useQuery({
    queryKey: workspaceKey("mcpServers"),
    queryFn: ({ signal }) => listMcpServers(signal),
  });
  const servers = serversQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = servers.find((server) => server.id === selectedId) ?? null;
  const [pasteText, setPasteText] = useState("");
  const [importing, setImporting] = useState(false);
  const [pasteResult, setPasteResult] = useState<string | null>(null);

  async function importPaste() {
    setImporting(true);
    setPasteResult(null);
    try {
      const result = await importMcpConfig(pasteText);
      setPasteText("");
      void queryClient.invalidateQueries({ queryKey: workspaceKey("mcpServers") });
      const parts = [];
      if (result.created) parts.push(`新增 ${result.created} 个`);
      if (result.updated) parts.push(`更新 ${result.updated} 个`);
      setPasteResult(`已保存：${parts.join("，") || "无变化"}（${result.names.join("、")}）${result.errors.length ? `；失败：${result.errors.join("；")}` : ""}`);
    } catch (error) {
      setPasteResult(null);
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setImporting(false);
    }
  }

  async function toggle(server: McpServer) {
    try {
      await updateMcpServer(server.id, {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
        description: server.description,
        enabled: !server.enabled,
      });
      void queryClient.invalidateQueries({ queryKey: workspaceKey("mcpServers") });
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function remove(server: McpServer) {
    if (!window.confirm(`删除 MCP 服务“${server.name}”？挂载它的自定义专家会自动解除引用；已经在跑的研究不受影响。`)) return;
    try {
      await deleteMcpServer(server.id);
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: workspaceKey("mcpServers") });
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function test(server: McpServer) {
    const result = await testMcpServer({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      headers: server.headers,
      description: server.description,
      enabled: server.enabled,
    }).catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    showAlert(
      result.ok
        ? `「${server.name}」连接成功${result.tools?.length ? `，可用工具：${result.tools.join("、")}` : ""}`
        : `「${server.name}」连接失败：${result.error}`,
      result.ok ? "success" : "error",
    );
  }

  return <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
    <aside className="min-h-0 overflow-y-auto border-b border-border p-3 lg:border-b-0 lg:border-e">
      <Button className="mb-3 w-full" variant="primary" onClick={() => setSelectedId(null)}><Plus size={15} />添加服务</Button>
      {servers.length === 0 && <p className="m-0 text-xs leading-relaxed text-subtext">还没有登记 MCP 服务。从服务文档复制 mcpServers 配置粘贴到右侧即可，也可以在对话里让 AI 提议（你确认后才会登记）。</p>}
      <div className="flex flex-col gap-1" aria-label="MCP 服务列表">
        {servers.map((server) => <button key={server.id} type="button" aria-pressed={selectedId === server.id} onClick={() => setSelectedId(server.id)} className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-start ${selectedId === server.id ? "border-primary bg-surface" : "border-transparent hover:bg-surface"}`}>
          <CapabilityTile kind="mcp" name={server.name} hint={server.transport} />
          <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-normal text-text">{server.name}</strong><span className="block truncate text-xs text-subtext">{server.transport === "stdio" ? server.command : server.url}</span></span>
          {server.enabled ? <Badge size="small">启用</Badge> : <span className="text-xs text-subtext">停用</span>}
        </button>)}
      </div>
    </aside>
    <section className="min-h-0 overflow-y-auto p-5" aria-label="MCP 服务配置">
      {selected ? <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div><h2 className="m-0 text-lg font-normal">{selected.name}</h2><p className="mb-0 mt-1 text-sm text-subtext">{selected.description || "暂无说明"}</p></div>
        <section className="flex flex-col gap-1.5 text-sm" aria-label="服务配置">
          <h3 className="m-0 text-sm font-normal">配置</h3>
          <ul className="m-0 flex list-disc flex-col gap-1 ps-8 leading-relaxed text-text">
            <li>类型：{selected.transport === "stdio" ? "本地命令（stdio）" : "远程服务（HTTP）"}</li>
            {selected.transport === "stdio"
              ? <li className="break-all">命令：<code className="font-mono text-xs">{[selected.command, ...selected.args].join(" ")}</code></li>
              : <li className="break-all">地址：<code className="font-mono text-xs">{selected.url}</code></li>}
            {selected.transport === "stdio" && Object.keys(selected.env).length > 0 && <li>环境变量：{Object.keys(selected.env).join("、")}（值只存本机）</li>}
            {selected.transport === "http" && Object.keys(selected.headers).length > 0 && <li>请求头：{Object.keys(selected.headers).join("、")}（值只存本机）</li>}
            <li className="text-subtext">配置变更用左侧粘贴导入覆盖同名服务；删除服务会自动解除专家挂载。</li>
          </ul>
        </section>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.enabled} onChange={() => void toggle(selected)} />启用</label>
          <Button disabled={!selected.enabled} onClick={() => void test(selected)}>测试连接</Button>
          <Button variant="danger" onClick={() => void remove(selected)}><Trash2 size={14} />删除</Button>
        </div>
      </div> : <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div><h2 className="m-0 text-lg font-normal">添加 MCP 服务</h2><p className="mb-0 mt-1 text-sm text-subtext">从服务文档复制 mcpServers 配置粘贴到下面，保存即完成登记（同名服务自动覆盖更新）。挂到自定义专家上后，该专家工作时自动启用这些服务。</p></div>
        <textarea className="min-h-48 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-text outline-none focus:border-text" value={pasteText} placeholder={'{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}}}'} onChange={(event) => setPasteText(event.target.value)} />
        {pasteResult && <p role="status" className="m-0 text-sm leading-relaxed text-text">{pasteResult}</p>}
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={importing || !pasteText.trim()} onClick={() => void importPaste()}>导入并保存</Button>
          <span className="text-xs text-subtext">支持 Claude Code / Cursor 的 mcpServers JSON 与 Codex 的 TOML；环境变量值只存本机</span>
        </div>
      </div>}
    </section>
  </div>;
}
