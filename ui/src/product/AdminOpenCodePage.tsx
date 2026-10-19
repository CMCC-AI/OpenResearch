import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui";
import { useCasesBase } from "./FeaturedCases";
import { caseRequest, caseWrite } from "./featuredCasesApi";

interface Settings { enabled: boolean; providerId?: string; npm?: string; baseUrl?: string; modelId?: string; hasApiKey?: boolean }
interface Draft { providerId: string; npm: string; baseUrl: string; modelId: string; apiKey: string }
function ModelForm({ settings, base }: { settings: Settings; base: string }) {
  const [draft, setDraft] = useState<Draft>({ providerId: settings.providerId || "openresearch", npm: settings.npm || "@ai-sdk/openai-compatible", baseUrl: settings.baseUrl || "", modelId: settings.modelId || "", apiKey: "" });
  const [hasApiKey, setHasApiKey] = useState(!!settings.hasApiKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const inputClass = "rounded-lg border border-border bg-background p-2 text-text";
  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await caseWrite<Settings>(base, "admin/opencode", draft);
      setHasApiKey(!!result.hasApiKey); setDraft((value) => ({ ...value, apiKey: "" }));
      setMessage("模型接入配置已保存。新启动的 OpenCode 进程会读取新配置；正在运行的对话不受影响。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }
  return <form className="flex max-w-2xl flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy} className="flex flex-col gap-5">
      <label className="flex flex-col gap-2 text-sm">接口类型<select className={inputClass} value={draft.npm} onChange={(event) => setDraft({ ...draft, npm: event.target.value })}>
        <option value="@ai-sdk/openai-compatible">OpenAI 兼容接口</option><option value="@ai-sdk/openai">OpenAI</option><option value="@ai-sdk/anthropic">Anthropic</option>
        {!["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"].includes(draft.npm) && <option value={draft.npm} disabled>当前类型不支持网页编辑，请选择接口类型</option>}
      </select></label>
      <label className="flex flex-col gap-2 text-sm">供应商 ID<input className={inputClass} required maxLength={100} pattern="[a-zA-Z0-9_-]+" value={draft.providerId} onChange={(event) => { setDraft({ ...draft, providerId: event.target.value }); setHasApiKey(event.target.value === settings.providerId && !!settings.hasApiKey); }} /><span className="text-xs text-subtext">用于标识 OpenCode 供应商，例如 openresearch。</span></label>
      <label className="flex flex-col gap-2 text-sm">服务地址（Base URL）<input className={inputClass} type="url" required maxLength={2048} placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
      <label className="flex flex-col gap-2 text-sm">API Key<input className={inputClass} type="password" autoComplete="new-password" maxLength={8192} placeholder={hasApiKey ? "已配置，留空保留原密钥" : "填写 API Key，无需认证的服务可留空"} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><span className="text-xs text-subtext">保存后不显示原始密钥。</span></label>
      <label className="flex flex-col gap-2 text-sm">模型 ID<input className={inputClass} required maxLength={256} placeholder="供应商提供的模型名称" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /><span className="text-xs text-subtext">保存为服务器 OpenCode 默认模型。</span></label>
    </fieldset>
    {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}
    {message && <p role="status" className="text-sm text-subtext">{message}</p>}
    <div><Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存模型接入"}</Button></div>
  </form>;
}
export function AdminOpenCodePage() {
  const base = useCasesBase();
  const query = useQuery({ queryKey: ["admin-opencode", base], queryFn: () => caseRequest<Settings>(base, "admin/opencode"), retry: false });
  return <main className="flex-1 overflow-auto p-6"><h1 className="mb-2 text-xl font-semibold">OpenCode 模型接入</h1><p className="mb-6 text-sm text-subtext">由系统管理员统一配置服务器上的模型服务。</p>
    {query.isPending ? <p role="status">正在读取配置…</p> : query.isError ? <p role="alert">{query.error.message}</p> : !query.data.enabled ? <p role="alert">服务器尚未启用网页模型配置，请配置共享目录后重新部署。</p> : <ModelForm settings={query.data} base={base} />}
  </main>;
}
