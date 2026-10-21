import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui";
import { useCasesBase } from "./FeaturedCases";
import { caseRequest, caseWrite } from "./featuredCasesApi";

interface Provider { id: string; name: string; npm: string; baseUrl: string; hasApiKey: boolean; connected: boolean; models: string[] }
interface Settings { enabled: boolean; backend?: string; providerId?: string; npm?: string; baseUrl?: string; modelId?: string; hasApiKey?: boolean; providers?: Provider[] }
interface Draft { providerId: string; npm: string; baseUrl: string; modelId: string; apiKey: string }
const interfaces = [
  ["@ai-sdk/openai-compatible", "OpenAI 兼容接口"], ["@ai-sdk/openai", "OpenAI"],
  ["@ai-sdk/anthropic", "Anthropic"], ["@ai-sdk/google", "Google Gemini"],
];
function ModelForm({ settings, base }: { settings: Settings; base: string }) {
  const [saved, setSaved] = useState(settings);
  const [draft, setDraft] = useState<Draft>({ providerId: settings.providerId || "openresearch", npm: settings.npm || "@ai-sdk/openai-compatible", baseUrl: settings.baseUrl || "", modelId: settings.modelId || "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const providers = saved.providers || [];
  const selected = providers.find((provider) => provider.id === draft.providerId);
  const hasApiKey = selected?.hasApiKey || (draft.providerId === saved.providerId && saved.hasApiKey);
  const inputClass = "rounded-lg border border-border bg-background p-2 text-text";
  function chooseProvider(id: string) {
    const provider = providers.find((item) => item.id === id);
    setDraft({ providerId: id || "openresearch", npm: provider?.npm || "@ai-sdk/openai-compatible", baseUrl: provider?.baseUrl || "", modelId: id === saved.providerId ? saved.modelId || "" : "", apiKey: "" });
    setError(""); setMessage("");
  }
  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await caseWrite<Settings>(base, "admin/opencode", draft);
      setSaved(result); setDraft((value) => ({ ...value, apiKey: "" }));
      setMessage("模型配置已统一保存，所有科研空间的新 OpenCode 进程自动使用。正在运行的对话保留当前配置；回到工作台重新检测以刷新模型列表。保存不代表模型调用已验证成功。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }
  return <form className="flex max-w-2xl flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy} className="flex flex-col gap-5">
      {providers.length > 0 && <label className="flex flex-col gap-2 text-sm">选择供应商<select className={inputClass} value={selected ? selected.id : ""} onChange={(event) => chooseProvider(event.target.value)}>
        <option value="">自定义模型服务</option>
        {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.connected ? "（已连接）" : ""}</option>)}
      </select><span className="text-xs text-subtext">供应商与模型目录来自 OpenCode，已有连接无需重复输入密钥。</span></label>}
      <label className="flex flex-col gap-2 text-sm">接口类型<select className={inputClass} value={draft.npm} onChange={(event) => setDraft({ ...draft, npm: event.target.value })}>
        {interfaces.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        {!interfaces.some(([id]) => id === draft.npm) && <option value={draft.npm} disabled>当前类型不支持网页编辑，请选择接口类型</option>}
      </select></label>
      <label className="flex flex-col gap-2 text-sm">供应商 ID<input className={inputClass} required maxLength={100} pattern="[a-zA-Z0-9_-]+" value={draft.providerId} onChange={(event) => setDraft({ ...draft, providerId: event.target.value, apiKey: "" })} /><span className="text-xs text-subtext">用于标识 OpenCode 供应商，例如 openresearch。</span></label>
      <label className="flex flex-col gap-2 text-sm">服务地址（Base URL）<input className={inputClass} type="url" required={draft.npm === "@ai-sdk/openai-compatible"} maxLength={2048} placeholder={draft.npm === "@ai-sdk/openai-compatible" ? "https://api.example.com/v1" : "留空使用供应商默认地址"} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
      <label className="flex flex-col gap-2 text-sm">API Key<input className={inputClass} type="password" autoComplete="new-password" maxLength={8192} placeholder={hasApiKey || selected?.connected ? "已连接，留空保留原凭据" : "填写 API Key，无需认证的服务可留空"} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><span className="text-xs text-subtext">保存后不显示原始密钥，所有私人空间自动使用管理员配置。</span></label>
      <label className="flex flex-col gap-2 text-sm">默认模型<input className={inputClass} required list="opencode-provider-models" maxLength={256} placeholder="选择或输入供应商提供的模型 ID" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /><datalist id="opencode-provider-models">{selected?.models.map((id) => <option key={id} value={id} />)}</datalist><span className="text-xs text-subtext">用户可在工作台选择其他可用模型，无需各自配置密钥。</span></label>
    </fieldset>
    {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}
    {message && <p role="status" className="text-sm text-subtext">{message}</p>}
    <div><Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存模型接入"}</Button></div>
  </form>;
}
export function AdminOpenCodePage() {
  const base = useCasesBase();
  const query = useQuery({ queryKey: ["admin-opencode", base], queryFn: () => caseRequest<Settings>(base, "admin/opencode"), retry: false });
  return <main className="flex-1 overflow-auto p-6"><h1 className="mb-2 text-xl font-semibold">OpenCode 模型接入</h1><p className="mb-6 text-sm text-subtext">管理员统一配置模型服务，所有私人科研空间自动使用；文件、对话与运行环境保持独立。</p>
    {query.isPending ? <p role="status">正在读取配置…</p> : query.isError ? <p role="alert">{query.error.message}</p> : !query.data.enabled ? <p role="alert">服务器尚未启用模型配置服务，请联系部署管理员。</p> : <ModelForm settings={query.data} base={base} />}
  </main>;
}
