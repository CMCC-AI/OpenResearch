import { useRef, useState } from "react";
import { Button } from "../components/ui";
import { caseWrite } from "./featuredCasesApi";

interface Model {
  id: string; name?: string; providerId?: string; providerName?: string;
  model: string; baseUrl: string; contextTokens: number; maxOutputTokens: number;
  outputParameter?: string; opencode?: Record<string, unknown>; hasApiKey?: boolean;
}
export interface QuotaModels { enabled: boolean; backend: "quota"; revision: string; models: Model[] }
const empty: Model = { id: "", name: "", providerId: "mobilesci", model: "", baseUrl: "", contextTokens: 131072, maxOutputTokens: 8192 };
export function AdminQuotaModels({ settings, base }: { settings: QuotaModels; base: string }) {
  const editor = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState(settings);
  const [draft, setDraft] = useState<Model>(settings.models[0] || empty);
  const [apiKey, setApiKey] = useState("");
  const [capabilities, setCapabilities] = useState(JSON.stringify(draft.opencode || {}, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selected = saved.models.find((m) => m.id === draft.id);
  const inputClass = "min-w-0 rounded-lg border border-border bg-background p-2 text-text";
  function choose(model: Model) {
    setDraft(model); setApiKey(""); setCapabilities(JSON.stringify(model.opencode || {}, null, 2)); setMessage(""); setError("");
  }
  function edit(model: Model) {
    choose(model);
    requestAnimationFrame(() => editor.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  async function write(action?: "remove" | "default", id = draft.id) {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = action ? { action, id } : { ...draft, apiKey, opencode: JSON.parse(capabilities) as unknown };
      const result = await caseWrite<QuotaModels>(base, "admin/opencode", { ...data, revision: saved.revision });
      setSaved(result);
      choose(result.models.find((m) => m.id === draft.id) || result.models[0]);
      setMessage("网关模型清单已保存，后续调用使用新接口配置，移除的模型停止接受新调用。新模型和默认模型在私人空间下次唤醒后更新；用户额度及已有用量保持不变。");
    } catch (cause) { setError(cause instanceof SyntaxError ? "模型能力必须为有效 JSON 对象" : cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }
  const providers = [...new Map([
    { id: "openai", name: "OpenAI" }, { id: "deepseek", name: "DeepSeek" },
    { id: "moonshotai-cn", name: "Kimi / Moonshot" }, { id: "zhipuai", name: "智谱 GLM" },
    ...saved.models.map((m) => ({ id: m.providerId || "mobilesci", name: m.providerName || m.providerId || "自定义供应商" })),
  ].map((provider) => [provider.id, provider])).values()];
  return <div className="flex max-w-4xl flex-col gap-6">
    <section className="flex flex-col gap-4" aria-label="已接入模型">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">已接入模型（{saved.models.length}）</h2><Button type="button" disabled={busy} onClick={() => edit(empty)}>接入其他模型</Button></div>
      <p className="text-sm text-subtext">当前默认：{saved.models[0]?.name || saved.models[0]?.id}。可分别编辑各模型的 API Key，或直接设为平台默认模型。</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{saved.models.map((model, i) => <article key={model.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background p-4" aria-label={model.name || model.id}>
        <div className="flex flex-wrap items-center gap-2"><h3 className="break-all text-sm font-medium">{model.name || model.id}</h3>{i === 0 && <span className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">默认模型</span>}</div>
        <p className="break-all text-xs text-subtext">{model.providerId || "mobilesci"} / {model.model}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={() => edit(model)}>编辑接入 / API Key</Button><Button type="button" disabled={busy || i === 0} onClick={() => void write("default", model.id)}>{i === 0 ? "当前默认" : "设为默认"}</Button></div>
      </article>)}</div>
    </section>
    <form ref={editor} className="flex max-w-2xl scroll-mt-6 flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void write(); }}>
    <h2 className="text-base font-semibold">{selected ? `编辑模型：${selected.name || selected.id}` : "接入其他模型"}</h2>
    <p className="text-sm text-subtext">额度模式已启用。管理员在此配置平台供给模型，用户调用仍经过额度网关；真实密钥仅保存在平台。</p>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
      <label className="flex flex-col gap-2 text-sm">选择模型<select className={inputClass} value={selected?.id || ""} onChange={(event) => choose(saved.models.find((m) => m.id === event.target.value) || empty)}>
        {saved.models.map((m, i) => <option key={m.id} value={m.id}>{m.name || m.id}{i === 0 ? "（默认）" : ""}</option>)}<option value="">接入新模型</option>
      </select></label>
      <label className="flex flex-col gap-2 text-sm">模型别名<input className={inputClass} required readOnly={!!selected} pattern="[a-zA-Z0-9_.:-]+" maxLength={100} value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /><span className="text-xs text-subtext">保存后别名固定，用于用户选择模型与用量记录。</span></label>
      <label className="flex flex-col gap-2 text-sm">显示名称<input className={inputClass} maxLength={200} value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="flex flex-col gap-2 text-sm">选择供应商<select className={inputClass} value={providers.some((p) => p.id === draft.providerId) ? draft.providerId : ""} onChange={(e) => {
        const id = e.target.value || "mobilesci";
        const existing = saved.models.find((m) => m.providerId === id);
        setDraft({ ...draft, providerId: id, baseUrl: existing?.baseUrl || "" }); setApiKey("");
      }}><option value="">自定义 OpenAI 兼容服务</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><span className="text-xs text-subtext">可接入其他供应商的 OpenAI 兼容接口；选择供应商后填写服务地址、API Key 和模型 ID。</span></label>
      <label className="flex flex-col gap-2 text-sm">供应商 ID<input className={inputClass} required pattern="[a-zA-Z0-9_-]+" maxLength={100} value={draft.providerId || "mobilesci"} onChange={(e) => setDraft({ ...draft, providerId: e.target.value })} /></label>
      <label className="flex flex-col gap-2 text-sm">服务地址（OpenAI 兼容 Base URL）<input className={inputClass} type="url" required maxLength={2048} value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
      <label className="flex flex-col gap-2 text-sm">API Key<input className={inputClass} type="password" autoComplete="new-password" required={!selected?.hasApiKey} maxLength={8192} placeholder={selected?.hasApiKey ? "已配置，留空保留原凭据" : "填写此模型的 API Key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
      <label className="flex flex-col gap-2 text-sm">上游模型 ID<input className={inputClass} required maxLength={200} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">真实上下文上限<input className={inputClass} type="number" required min={1} max={10000000} step={1} value={draft.contextTokens} onChange={(e) => setDraft({ ...draft, contextTokens: Number(e.target.value) })} /></label>
        <label className="flex flex-col gap-2 text-sm">最大输出 Token<input className={inputClass} type="number" required min={1} max={draft.contextTokens} step={1} value={draft.maxOutputTokens} onChange={(e) => setDraft({ ...draft, maxOutputTokens: Number(e.target.value) })} /></label>
      </div>
      <p className="text-xs text-subtext">上下文上限须与供应商实际限制一致，网关按上下文加最大输出预占额度，完成后按实际用量结算。</p>
      <label className="flex flex-col gap-2 text-sm">输出限制参数<select className={inputClass} value={draft.outputParameter || "max_tokens"} onChange={(e) => setDraft({ ...draft, outputParameter: e.target.value })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
      <details><summary className="cursor-pointer text-sm">高级模型能力</summary><label className="mt-3 flex flex-col gap-2 text-sm">公开能力（JSON）<textarea className={inputClass} rows={8} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} /><span className="text-xs text-subtext">配置工具、思考、多模态及 variants；保存时校验公开能力字段。已有私有请求头保留且不显示。</span></label></details>
    </fieldset>
    {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}
    {message && <p role="status" className="text-sm text-subtext">{message}</p>}
    <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存模型接入"}</Button><Button type="button" disabled={busy || !selected || selected.id === saved.models[0]?.id} onClick={() => void write("default")}>设为默认模型</Button><Button type="button" variant="danger" disabled={busy || !selected || saved.models.length <= 1} onClick={() => void write("remove")}>移除此模型</Button></div>
  </form></div>;
}
