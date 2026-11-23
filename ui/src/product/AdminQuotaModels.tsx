import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Gift,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { Badge, Button, Input, Switch } from "../components/ui";
import { caseWrite } from "./featuredCasesApi";
import {
  buildModelAlias,
  capabilityLabels,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  findCatalogProvider,
  formatTokenCount,
  normalizeOpenCodeFreeModelId,
  QUOTA_PROVIDERS,
  resolveConnectedProviders,
  resolveOpenCodeFreeModels,
  type QuotaModel,
  type QuotaModels,
  type ResolvedProvider,
  type ResolvedProviderModel,
  type SessionProviderState,
} from "./quotaProviderCatalog";

export type { QuotaModels };

type ActiveTab = "providers" | "models" | "free";

interface ProviderConnectDraft {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isNewCustom: boolean;
  hasExistingKey: boolean;
}

interface ModelEditorDraft {
  key: string;
  providerId: string;
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextTokens: number;
  maxOutputTokens: number;
  outputParameter: "max_tokens" | "max_completion_tokens";
  capabilitiesJson: string;
  isSaved: boolean;
  enableOnSave: boolean;
}

interface CustomModelDraft {
  providerId: string;
  model: string;
  name: string;
  contextTokens: number;
  maxOutputTokens: number;
  outputParameter: "max_tokens" | "max_completion_tokens";
}

function isQuotaModelsResponse(value: unknown): value is QuotaModels {
  return Boolean(value && typeof value === "object" && "models" in value && Array.isArray((value as QuotaModels).models));
}

export function AdminQuotaModels({ settings, base }: { settings: QuotaModels; base: string }) {
  const [saved, setSaved] = useState<QuotaModels>(settings);
  const [sessionProviders, setSessionProviders] = useState<Record<string, SessionProviderState>>({});
  const [tab, setTab] = useState<ActiveTab>(settings.models.length > 0 ? "models" : "providers");
  const [providerQuery, setProviderQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [freeQuery, setFreeQuery] = useState("");
  const [customFreeId, setCustomFreeId] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const model of settings.models) {
      initial[model.providerId || "mobilesci"] = true;
    }
    return initial;
  });
  const [connectDraft, setConnectDraft] = useState<ProviderConnectDraft | null>(null);
  const [modelEditor, setModelEditor] = useState<ModelEditorDraft | null>(null);
  const [customModelDraft, setCustomModelDraft] = useState<CustomModelDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const connectDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = connectDialogRef.current;
    if (!dialog) return;
    if (connectDraft) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [connectDraft]);

  const connectedProviders = useMemo(
    () => resolveConnectedProviders(saved, sessionProviders),
    [saved, sessionProviders],
  );

  const connectedMap = useMemo(
    () => new Map(connectedProviders.map((provider) => [provider.id, provider])),
    [connectedProviders],
  );

  const freeModels = useMemo(() => resolveOpenCodeFreeModels(saved), [saved]);
  const enabledFreeModels = useMemo(() => freeModels.filter((m) => m.enabled), [freeModels]);

  const filteredFreeModels = useMemo(() => {
    const q = freeQuery.trim().toLowerCase();
    if (!q) return freeModels;
    return freeModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q),
    );
  }, [freeModels, freeQuery]);

  const filteredCatalogProviders = useMemo(() => {
    const q = providerQuery.trim().toLowerCase();
    if (!q) return QUOTA_PROVIDERS;
    return QUOTA_PROVIDERS.filter(
      (provider) =>
        provider.id.toLowerCase().includes(q) ||
        provider.name.toLowerCase().includes(q) ||
        provider.description.toLowerCase().includes(q),
    );
  }, [providerQuery]);

  const filteredConnectedProviders = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return connectedProviders;
    return connectedProviders
      .map((provider) => {
        const providerMatches = provider.name.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q);
        const models = providerMatches
          ? provider.models
          : provider.models.filter(
              (m) =>
                m.name.toLowerCase().includes(q) ||
                m.model.toLowerCase().includes(q) ||
                (m.savedModel?.id.toLowerCase().includes(q) ?? false),
            );
        return { ...provider, models };
      })
      .filter((provider) => provider.models.length > 0);
  }, [connectedProviders, modelQuery]);

  const defaultModel = saved.models[0];

  function clearFeedback() {
    setError("");
    setMessage("");
  }

  function openConnectForm(presetId?: string, existing?: ResolvedProvider) {
    clearFeedback();
    if (existing) {
      setConnectDraft({
        id: existing.id,
        name: existing.name,
        baseUrl: existing.baseUrl,
        apiKey: existing.sessionApiKey || "",
        isNewCustom: false,
        hasExistingKey: existing.hasApiKey,
      });
      return;
    }
    if (presetId) {
      const catalog = findCatalogProvider(presetId);
      const current = connectedMap.get(presetId);
      setConnectDraft({
        id: presetId,
        name: current?.name || catalog?.name || presetId,
        baseUrl: current?.baseUrl || catalog?.defaultBaseUrl || "",
        apiKey: current?.sessionApiKey || "",
        isNewCustom: false,
        hasExistingKey: Boolean(current?.hasApiKey),
      });
      return;
    }
    setConnectDraft({
      id: "",
      name: "",
      baseUrl: "",
      apiKey: "",
      isNewCustom: true,
      hasExistingKey: false,
    });
  }

  async function saveOpenCodeFreeModels(nextIds: string[], successMessage: string) {
    const normalized = [...new Set(nextIds.map(normalizeOpenCodeFreeModelId).filter(Boolean))];
    setBusy(true);
    clearFeedback();
    try {
      const result = await caseWrite<QuotaModels>(base, "admin/opencode", {
        action: "setOpenCodeFreeModels",
        models: normalized,
        revision: saved.revision,
      });
      if (isQuotaModelsResponse(result)) {
        setSaved({
          ...result,
          opencodeFreeModels: result.opencodeFreeModels ?? normalized,
        });
      } else {
        setSaved((prev) => ({ ...prev, opencodeFreeModels: normalized }));
      }
      setMessage(successMessage);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "保存 OpenCode 免费模型配置失败";
      if (msg.includes("不支持的模型配置操作")) {
        setError("当前服务端尚未启用 setOpenCodeFreeModels 接口，请同步更新平台后端（admin/opencode 与 runner/model-config）后保存生效。");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function probeOpenCodeFreeModels() {
    setBusy(true);
    clearFeedback();
    try {
      const result = await caseWrite<QuotaModels>(base, "admin/opencode", {
        action: "probeOpenCodeFreeModels",
      });
      if (isQuotaModelsResponse(result)) {
        setSaved(result);
        const count = result.availableOpenCodeFreeModels?.length ?? resolveOpenCodeFreeModels(result).length;
        setMessage(`已从 OpenCode 官方目录探测到 ${count} 个免费模型并更新缓存。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "探测 OpenCode 官方免费模型失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function submitProviderConnect(event: React.FormEvent) {
    event.preventDefault();
    if (!connectDraft) return;
    const id = connectDraft.id.trim();
    const baseUrl = connectDraft.baseUrl.trim();
    const apiKey = connectDraft.apiKey.trim();
    if (!id || !baseUrl) {
      setError("请填写供应商 ID 与服务地址（Base URL）。");
      return;
    }

    setBusy(true);
    clearFeedback();
    try {
      let discoveredModels: string[] = [];

      try {
        const result = await caseWrite<QuotaModels | { models?: string[] }>(base, "admin/opencode", {
          action: "connectProvider",
          providerId: id,
          providerName: connectDraft.name.trim() || id,
          baseUrl,
          apiKey,
          revision: saved.revision,
        });
        if (isQuotaModelsResponse(result)) {
          setSaved(result);
        }
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : "";
        if (!msg.includes("不支持的模型配置操作")) {
          throw cause;
        }
      }

      try {
        const probed = await caseWrite<{ models?: string[] }>(base, "admin/opencode", {
          action: "probeModels",
          providerId: id,
          baseUrl,
          apiKey,
        });
        if (Array.isArray(probed?.models)) {
          discoveredModels = probed.models;
        }
      } catch {
        // Optional probe endpoint; built-in catalog or manual model ID still works.
      }

      setSessionProviders((prev) => ({
        ...prev,
        [id]: {
          id,
          name: connectDraft.name.trim() || prev[id]?.name || findCatalogProvider(id)?.name || id,
          baseUrl,
          apiKey: apiKey || prev[id]?.apiKey || "",
          hasApiKey: Boolean(apiKey || connectDraft.hasExistingKey || prev[id]?.hasApiKey),
          discoveredModels: discoveredModels.length > 0 ? discoveredModels : (prev[id]?.discoveredModels || []),
        },
      }));
      setExpandedProviders((prev) => ({ ...prev, [id]: true }));
      setConnectDraft(null);
      setTab("models");
      setMessage(
        discoveredModels.length > 0
          ? `已连接 ${connectDraft.name.trim() || id}，并探测到 ${discoveredModels.length} 个可用模型。请在下方勾选需要向用户开放的模型。`
          : `已连接 ${connectDraft.name.trim() || id}。请在下方展开并启用需要向用户开放的模型（平台至少保留一个启用模型）。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接供应商失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function probeProviderModels(provider: ResolvedProvider) {
    setBusy(true);
    clearFeedback();
    try {
      const probed = await caseWrite<{ models?: string[] }>(base, "admin/opencode", {
        action: "probeModels",
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        apiKey: provider.sessionApiKey,
      });
      const list = Array.isArray(probed?.models) ? probed.models : [];
      setSessionProviders((prev) => ({
        ...prev,
        [provider.id]: {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.sessionApiKey,
          hasApiKey: provider.hasApiKey,
          discoveredModels: list,
        },
      }));
      setExpandedProviders((prev) => ({ ...prev, [provider.id]: true }));
      setTab("models");
      setMessage(list.length > 0 ? `已从 ${provider.name} 探测到 ${list.length} 个模型。` : `${provider.name} 未返回额外模型，可直接添加自定义模型 ID。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `从 ${provider.name} 探测模型失败，请检查服务地址与 API Key。`);
    } finally {
      setBusy(false);
    }
  }

  async function disconnectProvider(provider: ResolvedProvider) {
    if (provider.enabledCount > 0 && saved.models.length - provider.enabledCount < 1) {
      setError("平台至少需要保留 1 个已启用网关模型，请先启用其他模型后再断开此供应商。");
      return;
    }
    setBusy(true);
    clearFeedback();
    try {
      let current = saved;
      try {
        const result = await caseWrite<QuotaModels>(base, "admin/opencode", {
          action: "disconnectProvider",
          providerId: provider.id,
          revision: current.revision,
        });
        if (isQuotaModelsResponse(result)) {
          current = result;
        }
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : "";
        if (!msg.includes("不支持的模型配置操作")) {
          throw cause;
        }
        const toRemove = current.models.filter((m) => (m.providerId || "mobilesci") === provider.id);
        for (const model of toRemove) {
          current = await caseWrite<QuotaModels>(base, "admin/opencode", {
            action: "remove",
            id: model.id,
            revision: current.revision,
          });
        }
      }
      setSaved(current);
      setSessionProviders((prev) => {
        const next = { ...prev };
        delete next[provider.id];
        return next;
      });
      setMessage(`已断开 ${provider.name}，其下属模型已停止接受新调用。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "断开供应商失败");
    } finally {
      setBusy(false);
    }
  }

  function openModelEditor(provider: ResolvedProvider, item: ResolvedProviderModel, enableOnSave = false) {
    clearFeedback();
    const alias = item.savedModel?.id || buildModelAlias(provider.id, item.model, saved.models);
    setModelEditor({
      key: item.key,
      providerId: provider.id,
      id: alias,
      name: item.name,
      model: item.model,
      baseUrl: item.baseUrl || provider.baseUrl,
      apiKey: provider.sessionApiKey || "",
      contextTokens: item.contextTokens,
      maxOutputTokens: item.maxOutputTokens,
      outputParameter: item.outputParameter,
      capabilitiesJson: JSON.stringify(item.opencode || {}, null, 2),
      isSaved: item.enabled,
      enableOnSave,
    });
  }

  async function writeModelPayload(payload: {
    id: string;
    name: string;
    providerId: string;
    providerName: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    contextTokens: number;
    maxOutputTokens: number;
    outputParameter: "max_tokens" | "max_completion_tokens";
    opencode: Record<string, unknown>;
  }) {
    const result = await caseWrite<QuotaModels>(base, "admin/opencode", {
      ...payload,
      revision: saved.revision,
    });
    setSaved(result);
    setModelEditor(null);
    setCustomModelDraft(null);
    setMessage("网关模型清单已保存，后续调用使用新配置；私人空间下次唤醒时刷新可用模型，用户额度与历史账本不变。");
  }

  async function toggleModel(provider: ResolvedProvider, item: ResolvedProviderModel) {
    clearFeedback();
    if (item.enabled && item.savedModel) {
      if (saved.models.length <= 1) {
        setError("平台至少需要保留 1 个可用网关模型。");
        return;
      }
      setBusy(true);
      try {
        const result = await caseWrite<QuotaModels>(base, "admin/opencode", {
          action: "remove",
          id: item.savedModel.id,
          revision: saved.revision,
        });
        setSaved(result);
        setMessage(`已关闭模型「${item.name}」，该模型已停止接受新调用。`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "关闭模型失败");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (item.needsLimitConfirmation || (!provider.sessionApiKey && !provider.hasApiKey) || !provider.baseUrl) {
      openModelEditor(provider, item, true);
      if (item.needsLimitConfirmation) {
        setMessage("该模型来自探测/自定义列表，请确认其真实上下文上限与最大输出 Token 后启用（用于额度预占）。");
      }
      return;
    }

    setBusy(true);
    try {
      await writeModelPayload({
        id: buildModelAlias(provider.id, item.model, saved.models),
        name: item.name,
        providerId: provider.id,
        providerName: provider.name,
        model: item.model,
        baseUrl: item.baseUrl || provider.baseUrl,
        apiKey: provider.sessionApiKey,
        contextTokens: item.contextTokens,
        maxOutputTokens: item.maxOutputTokens,
        outputParameter: item.outputParameter,
        opencode: item.opencode,
      });
    } catch (cause) {
      openModelEditor(provider, item, true);
      setError(cause instanceof Error ? cause.message : "启用模型失败，请检查参数或补充 API Key 后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function setDefaultModel(model: QuotaModel) {
    setBusy(true);
    clearFeedback();
    try {
      const result = await caseWrite<QuotaModels>(base, "admin/opencode", {
        action: "default",
        id: model.id,
        revision: saved.revision,
      });
      setSaved(result);
      setMessage(`已将「${model.name || model.id}」设为平台默认模型。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "设置默认模型失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitModelEditor(event: React.FormEvent) {
    event.preventDefault();
    if (!modelEditor) return;
    let parsedCapabilities: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(modelEditor.capabilitiesJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("高级模型能力必须为有效的 JSON 对象。");
        return;
      }
      parsedCapabilities = parsed as Record<string, unknown>;
    } catch {
      setError("高级模型能力必须为有效的 JSON 对象。");
      return;
    }

    const provider = connectedMap.get(modelEditor.providerId);
    setBusy(true);
    clearFeedback();
    try {
      await writeModelPayload({
        id: modelEditor.id.trim(),
        name: modelEditor.name.trim() || modelEditor.model.trim(),
        providerId: modelEditor.providerId,
        providerName: provider?.name || modelEditor.providerId,
        model: modelEditor.model.trim(),
        baseUrl: modelEditor.baseUrl.trim(),
        apiKey: modelEditor.apiKey.trim(),
        contextTokens: modelEditor.contextTokens,
        maxOutputTokens: modelEditor.maxOutputTokens,
        outputParameter: modelEditor.outputParameter,
        opencode: parsedCapabilities,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存模型参数失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitCustomModel(event: React.FormEvent, provider: ResolvedProvider) {
    event.preventDefault();
    if (!customModelDraft) return;
    const modelId = customModelDraft.model.trim();
    if (!modelId) return;

    setBusy(true);
    clearFeedback();
    try {
      await writeModelPayload({
        id: buildModelAlias(provider.id, modelId, saved.models),
        name: customModelDraft.name.trim() || modelId,
        providerId: provider.id,
        providerName: provider.name,
        model: modelId,
        baseUrl: provider.baseUrl,
        apiKey: provider.sessionApiKey,
        contextTokens: customModelDraft.contextTokens,
        maxOutputTokens: customModelDraft.maxOutputTokens,
        outputParameter: customModelDraft.outputParameter,
        opencode: { tool_call: true },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加自定义模型失败，请确认供应商凭据有效。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="模型接入概览" className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4 shadow-xs">
          <div className="min-w-0">
            <span className="block text-xs font-medium text-subtext">默认模型</span>
            <strong className="mt-1 block truncate text-sm font-semibold text-text">
              {defaultModel?.name || defaultModel?.id || "未配置"}
            </strong>
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <Sparkles size={16} />
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4 shadow-xs">
          <div className="min-w-0">
            <span className="block text-xs font-medium text-subtext">已开放网关模型</span>
            <strong className="mt-1 block text-xl font-semibold tabular-nums text-text">
              {saved.models.length}
            </strong>
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-blue-subtle text-accent-blue">
            <Cpu size={16} />
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4 shadow-xs">
          <div className="min-w-0">
            <span className="block text-xs font-medium text-subtext">已连接提供商</span>
            <strong className="mt-1 block text-xl font-semibold tabular-nums text-text">
              {connectedProviders.length}
            </strong>
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-subtext">
            <Server size={16} />
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4 shadow-xs">
          <div className="min-w-0">
            <span className="block text-xs font-medium text-subtext">OpenCode 免费模型</span>
            <strong className="mt-1 block text-xl font-semibold tabular-nums text-text">
              {enabledFreeModels.length}
            </strong>
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-green-subtle text-accent-green">
            <Gift size={16} />
          </span>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-1">
        <div role="tablist" aria-label="大模型接入视图" className="flex items-center gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "providers"}
            onClick={() => setTab("providers")}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === "providers"
                ? "text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"
                : "text-subtext hover:text-text"
            }`}
          >提供商</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "models"}
            onClick={() => setTab("models")}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === "models"
                ? "text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"
                : "text-subtext hover:text-text"
            }`}
          >模型</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "free"}
            onClick={() => setTab("free")}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === "free"
                ? "text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary"
                : "text-subtext hover:text-text"
            }`}
          >OpenCode 免费模型</button>
        </div>

        <p className="m-0 pb-2 text-xs text-subtext">
          网关模型经过额度预占与结算；OpenCode 免费模型不设额度限制。
        </p>
      </div>

      {error && (
        <p role="alert" className="m-0 rounded-xl border border-danger-notice-border bg-accent-red-subtle px-4 py-3 text-sm text-accent-red">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="m-0 rounded-xl border border-accent-green/40 bg-accent-green-subtle/60 px-4 py-3 text-sm text-text">
          {message}
        </p>
      )}

      {tab === "providers" && (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3" aria-label="已连接的提供商">
            <div className="flex items-center justify-between">
              <h2 className="m-0 text-sm font-semibold text-text">已连接的提供商（{connectedProviders.length}）</h2>
            </div>
            {connectedProviders.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-background/60 p-8 text-center">
                <Layers size={24} className="text-muted" />
                <p className="m-0 text-sm text-subtext">暂无已连接的提供商，请从下方选择一个 OpenAI 兼容供应商进行连接。</p>
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-border-variant rounded-xl border border-border bg-background shadow-xs">
                {connectedProviders.map((provider) => (
                  <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-text">{provider.name}</span>
                        {provider.hasApiKey && (
                          <Badge size="small" className="gap-1">
                            <KeyRound size={11} />
                            API 密钥
                          </Badge>
                        )}
                        <Badge size="small" variant="success">已开放 {provider.enabledCount} 个模型</Badge>
                      </div>
                      <p className="m-0 truncate font-mono text-xs text-subtext">
                        {provider.id} · {provider.baseUrl || "未配置地址"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="default" size="small" disabled={busy} onClick={() => openConnectForm(provider.id, provider)}>
                        更新密钥 / 地址
                      </Button>
                      <Button type="button" variant="default" size="small" disabled={busy} onClick={() => void probeProviderModels(provider)}>
                        <RefreshCw size={13} />
                        探测模型
                      </Button>
                      <Button
                        type="button"
                        variant="default"
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          setExpandedProviders((prev) => ({ ...prev, [provider.id]: true }));
                          setTab("models");
                        }}
                      >
                        管理模型
                      </Button>
                      <Button type="button" variant="danger" size="small" disabled={busy} onClick={() => void disconnectProvider(provider)}>
                        断开
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-label="可连接的提供商">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="m-0 text-sm font-semibold text-text">可连接的 OpenAI 兼容提供商</h2>
              <Button type="button" variant="default" size="small" disabled={busy} onClick={() => openConnectForm()}>
                <Plus size={14} />
                自定义 OpenAI 兼容服务
              </Button>
            </div>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                aria-label="搜索提供商"
                className="h-9 ps-9"
                placeholder="搜索 OpenAI 兼容提供商（如 DeepSeek、Kimi、OpenRouter）…"
                value={providerQuery}
                onChange={(e) => setProviderQuery(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              {filteredCatalogProviders.map((provider) => {
                const connected = connectedMap.get(provider.id);
                return (
                  <div
                    key={provider.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4 shadow-xs transition-colors hover:border-border-strong"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text">{provider.name}</span>
                        {connected && <Badge size="small" variant="success">已连接</Badge>}
                      </div>
                      <p className="m-0 truncate text-xs text-subtext">
                        {provider.description} · 内置 {provider.models.length} 个模型
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant={connected ? "default" : "primary"}
                      size="small"
                      disabled={busy}
                      onClick={() => openConnectForm(provider.id, connected)}
                    >
                      <Plus size={13} />
                      {connected ? "编辑" : "连接"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {tab === "models" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-60 flex-1">
              <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                aria-label="搜索模型"
                className="h-9 ps-9"
                placeholder="搜索模型名称、ID 或提供商…"
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
              />
            </div>
            <Button type="button" variant="default" disabled={busy} onClick={() => setTab("providers")}>
              <Plus size={14} />
              连接提供商
            </Button>
          </div>

          {filteredConnectedProviders.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-background/60 p-10 text-center">
              <Cpu size={28} className="text-muted" />
              <p className="m-0 text-sm text-subtext">
                {connectedProviders.length === 0 ? "尚未连接任何提供商。" : "没有匹配的模型。"}
              </p>
              {connectedProviders.length === 0 && (
                <Button type="button" variant="primary" onClick={() => setTab("providers")}>
                  前往连接提供商
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {filteredConnectedProviders.map((provider) => {
                const isExpanded = modelQuery.trim() !== "" || Boolean(expandedProviders[provider.id]);
                const isAddingCustom = customModelDraft?.providerId === provider.id;

                return (
                  <section
                    key={provider.id}
                    className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xs"
                    aria-label={provider.name}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 bg-surface/60 px-4 py-3">
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() => setExpandedProviders((prev) => ({ ...prev, [provider.id]: !isExpanded }))}
                        className="flex min-w-0 flex-1 items-center gap-2 text-start"
                      >
                        {isExpanded ? (
                          <ChevronDown size={16} className="shrink-0 text-subtext" />
                        ) : (
                          <ChevronRight size={16} className="shrink-0 text-subtext" />
                        )}
                        <span className="text-sm font-semibold text-text">{provider.name}</span>
                        <Badge size="small" variant={provider.enabledCount > 0 ? "success" : "default"}>
                          {provider.enabledCount}/{provider.models.length} 已开放
                        </Badge>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          setExpandedProviders((prev) => ({ ...prev, [provider.id]: true }));
                          setCustomModelDraft({
                            providerId: provider.id,
                            model: "",
                            name: "",
                            contextTokens: DEFAULT_CONTEXT_TOKENS,
                            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
                            outputParameter: "max_tokens",
                          });
                        }}
                      >
                        <Plus size={13} />
                        添加自定义模型
                      </Button>
                    </div>

                    {isExpanded && (
                      <div className="flex flex-col divide-y divide-border-variant">
                        {isAddingCustom && customModelDraft && (
                          <form onSubmit={(event) => void submitCustomModel(event, provider)} className="flex flex-col gap-3 bg-surface/40 p-4">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-text">为 {provider.name} 添加自定义模型</span>
                              <Button type="button" variant="ghost" size="small" onClick={() => setCustomModelDraft(null)}>
                                取消
                              </Button>
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                上游模型 ID
                                <Input
                                  required
                                  maxLength={200}
                                  placeholder="例如 gpt-4o-2024-11-20"
                                  value={customModelDraft.model}
                                  onChange={(e) => setCustomModelDraft({ ...customModelDraft, model: e.target.value })}
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                显示名称
                                <Input
                                  maxLength={200}
                                  placeholder="留空则使用模型 ID"
                                  value={customModelDraft.name}
                                  onChange={(e) => setCustomModelDraft({ ...customModelDraft, name: e.target.value })}
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                真实上下文上限
                                <Input
                                  type="number"
                                  required
                                  min={1}
                                  max={10000000}
                                  value={customModelDraft.contextTokens}
                                  onChange={(e) => setCustomModelDraft({ ...customModelDraft, contextTokens: Number(e.target.value) })}
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                最大输出 Token
                                <Input
                                  type="number"
                                  required
                                  min={1}
                                  max={customModelDraft.contextTokens}
                                  value={customModelDraft.maxOutputTokens}
                                  onChange={(e) => setCustomModelDraft({ ...customModelDraft, maxOutputTokens: Number(e.target.value) })}
                                />
                              </label>
                            </div>
                            <div className="flex gap-2">
                              <Button type="submit" size="small" variant="primary" disabled={busy}>
                                {busy ? "正在保存…" : "确认并启用"}
                              </Button>
                              <Button type="button" variant="default" size="small" onClick={() => setCustomModelDraft(null)}>
                                取消
                              </Button>
                            </div>
                          </form>
                        )}

                        {provider.models.length === 0 ? (
                          <div className="p-4 text-sm text-subtext">
                            该供应商暂无预设模型，请点击右上角「添加自定义模型」或前往「提供商」探测模型。
                          </div>
                        ) : (
                          provider.models.map((item) => {
                            const editingThis = modelEditor?.key === item.key;
                            const caps = capabilityLabels(item.opencode);

                            return (
                              <div key={item.key} className="flex flex-col">
                                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-hover-faint">
                                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-sm font-medium text-text">{item.name}</span>
                                      {item.isDefault && <Badge size="small" variant="success">默认模型</Badge>}
                                      {!item.enabled && item.source === "catalog" && <Badge size="small">内置目录</Badge>}
                                      {!item.enabled && item.source === "discovered" && (
                                        <Badge size="small" variant="warning">需确认上下文上限</Badge>
                                      )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-xs text-subtext">
                                      <span className="font-mono">{item.model}</span>
                                      {item.savedModel && item.savedModel.id !== item.model && (
                                        <span>· 别名 {item.savedModel.id}</span>
                                      )}
                                      <span className="tabular-nums">· {formatTokenCount(item.contextTokens)} 上下文</span>
                                      <span className="tabular-nums">· {formatTokenCount(item.maxOutputTokens)} 输出</span>
                                      {caps.map((cap) => (
                                        <span key={cap} className="rounded bg-surface px-1.5 py-0.5 text-xs text-subtext">
                                          {cap}
                                        </span>
                                      ))}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    {item.enabled && item.savedModel && !item.isDefault && (
                                      <Button
                                        type="button"
                                        variant="default"
                                        size="small"
                                        disabled={busy}
                                        onClick={() => void setDefaultModel(item.savedModel!)}
                                      >
                                        设为默认
                                      </Button>
                                    )}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="small"
                                      disabled={busy}
                                      aria-label={`编辑 ${item.name} 参数`}
                                      onClick={() => (editingThis ? setModelEditor(null) : openModelEditor(provider, item, !item.enabled))}
                                    >
                                      <SlidersHorizontal size={13} />
                                      参数
                                    </Button>
                                    <Switch
                                      checked={item.enabled}
                                      disabled={busy}
                                      aria-label={`${item.enabled ? "关闭" : "启用"}模型 ${item.name}`}
                                      onClick={() => void toggleModel(provider, item)}
                                    />
                                  </div>
                                </div>

                                {editingThis && modelEditor && (
                                  <form
                                    onSubmit={(event) => void submitModelEditor(event)}
                                    className="flex flex-col gap-4 border-t border-border-variant bg-surface/40 p-4"
                                  >
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                        模型别名（固定标识）
                                        <Input
                                          required
                                          readOnly={modelEditor.isSaved}
                                          pattern="[a-zA-Z0-9_.:-]+"
                                          maxLength={100}
                                          value={modelEditor.id}
                                          onChange={(e) => setModelEditor({ ...modelEditor, id: e.target.value })}
                                        />
                                      </label>
                                      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                        显示名称
                                        <Input
                                          maxLength={200}
                                          value={modelEditor.name}
                                          onChange={(e) => setModelEditor({ ...modelEditor, name: e.target.value })}
                                        />
                                      </label>
                                      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                        真实上下文上限（用于额度预占）
                                        <Input
                                          type="number"
                                          required
                                          min={1}
                                          max={10000000}
                                          value={modelEditor.contextTokens}
                                          onChange={(e) => setModelEditor({ ...modelEditor, contextTokens: Number(e.target.value) })}
                                        />
                                      </label>
                                      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                        最大输出 Token
                                        <Input
                                          type="number"
                                          required
                                          min={1}
                                          max={modelEditor.contextTokens}
                                          value={modelEditor.maxOutputTokens}
                                          onChange={(e) => setModelEditor({ ...modelEditor, maxOutputTokens: Number(e.target.value) })}
                                        />
                                      </label>
                                      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                        输出限制参数
                                        <select
                                          className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-text"
                                          value={modelEditor.outputParameter}
                                          onChange={(e) =>
                                            setModelEditor({
                                              ...modelEditor,
                                              outputParameter: e.target.value === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
                                            })
                                          }
                                        >
                                          <option value="max_tokens">max_tokens</option>
                                          <option value="max_completion_tokens">max_completion_tokens</option>
                                        </select>
                                      </label>
                                      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
                                        API Key{provider.hasApiKey || provider.sessionApiKey ? "（留空保留供应商凭据）" : "（必填）"}
                                        <Input
                                          type="password"
                                          autoComplete="new-password"
                                          required={!provider.hasApiKey && !provider.sessionApiKey}
                                          maxLength={8192}
                                          placeholder={provider.hasApiKey || provider.sessionApiKey ? "留空保留原凭据" : "填写 API Key"}
                                          value={modelEditor.apiKey}
                                          onChange={(e) => setModelEditor({ ...modelEditor, apiKey: e.target.value })}
                                        />
                                      </label>
                                    </div>
                                    <details>
                                      <summary className="cursor-pointer text-xs text-subtext">高级模型能力（JSON）</summary>
                                      <textarea
                                        className="mt-2 w-full rounded-lg border border-border bg-background p-2 font-mono text-xs text-text"
                                        rows={5}
                                        value={modelEditor.capabilitiesJson}
                                        onChange={(e) => setModelEditor({ ...modelEditor, capabilitiesJson: e.target.value })}
                                      />
                                    </details>
                                    <div className="flex gap-2">
                                      <Button type="submit" size="small" variant="primary" disabled={busy}>
                                        {busy ? "正在保存…" : modelEditor.enableOnSave ? "确认并启用模型" : "保存参数"}
                                      </Button>
                                      <Button type="button" variant="default" size="small" onClick={() => setModelEditor(null)}>
                                        取消
                                      </Button>
                                    </div>
                                  </form>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "free" && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-accent-green/35 bg-accent-green-subtle/40 p-4">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-green-subtle text-accent-green">
                <Gift size={16} />
              </span>
              <div className="min-w-0">
                <h2 className="m-0 text-sm font-semibold text-text">OpenCode 官方免费模型（免额度）</h2>
                <p className="mb-0 mt-1 text-xs text-subtext">
                  已启用的 OpenCode 免费模型（<code className="font-mono">opencode/*</code>）将直接出现在用户的模型选择器中，直连 OpenCode 官方免费通道，
                  <strong className="font-medium text-text">不经过平台额度网关，不扣减用户的月度 Token 额度</strong>。未勾选的模型保持隐藏。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="small"
                disabled={busy}
                onClick={() => void probeOpenCodeFreeModels()}
              >
                <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
                探测最新官方免费模型
              </Button>
              <Button
                type="button"
                size="small"
                disabled={busy || freeModels.every((m) => m.enabled)}
                onClick={() =>
                  void saveOpenCodeFreeModels(
                    freeModels.map((m) => m.id),
                    `已启用全部 ${freeModels.length} 个 OpenCode 免费模型（不限额度）。`,
                  )
                }
              >
                全部启用
              </Button>
              <Button
                type="button"
                size="small"
                disabled={busy || enabledFreeModels.length === 0}
                onClick={() =>
                  void saveOpenCodeFreeModels([], "已隐藏所有 OpenCode 免费模型。")
                }
              >
                全部隐藏
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-60 flex-1">
              <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                aria-label="搜索 OpenCode 免费模型"
                className="h-9 ps-9"
                placeholder="筛选 OpenCode 免费模型名称或 ID…"
                value={freeQuery}
                onChange={(e) => setFreeQuery(e.target.value)}
              />
            </div>

            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const id = normalizeOpenCodeFreeModelId(customFreeId);
                if (!id) return;
                const next = [...enabledFreeModels.map((m) => m.id), id];
                setCustomFreeId("");
                void saveOpenCodeFreeModels(next, `已添加并启用 OpenCode 免费模型「opencode/${id}」。`);
              }}
            >
              <Input
                aria-label="添加自定义 OpenCode 免费模型 ID"
                className="h-9 w-56 font-mono text-xs"
                placeholder="自定义模型 ID（如 big-pickle）"
                maxLength={120}
                value={customFreeId}
                onChange={(e) => setCustomFreeId(e.target.value)}
              />
              <Button type="submit" size="small" disabled={busy || !normalizeOpenCodeFreeModelId(customFreeId)}>
                <Plus size={13} />
                添加并启用
              </Button>
            </form>
          </div>

          <div className="flex flex-col divide-y divide-border-variant rounded-xl border border-border bg-background shadow-xs">
            {filteredFreeModels.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-hover-faint"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">{item.name}</span>
                    <Badge size="small" variant="success">免费 · 不限额度</Badge>
                    {item.isCustom && <Badge size="small">自定义</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-subtext">
                    <code className="font-mono text-text">opencode/{item.id}</code>
                    <span>· {item.description}</span>
                  </div>
                </div>
                <Switch
                  checked={item.enabled}
                  disabled={busy}
                  aria-label={`${item.enabled ? "隐藏" : "开放"} OpenCode 免费模型 ${item.name}`}
                  onClick={() => {
                    const current = enabledFreeModels.map((m) => m.id);
                    const next = item.enabled
                      ? current.filter((id) => id !== item.id)
                      : [...current, item.id];
                    void saveOpenCodeFreeModels(
                      next,
                      item.enabled
                        ? `已隐藏 OpenCode 免费模型「opencode/${item.id}」。`
                        : `已开放 OpenCode 免费模型「opencode/${item.id}」（不限额度）。`,
                    );
                  }}
                />
              </div>
            ))}
            {filteredFreeModels.length === 0 && (
              <div className="p-8 text-center text-sm text-subtext">
                没有匹配的 OpenCode 免费模型。
              </div>
            )}
          </div>
        </div>
      )}

      <dialog
        ref={connectDialogRef}
        aria-labelledby="provider-connect-dialog-title"
        onCancel={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          setConnectDraft(null);
        }}
        className="m-auto w-full max-w-xl rounded-2xl border border-border bg-background p-6 text-text shadow-modal backdrop:bg-modal-backdrop backdrop:backdrop-blur-xs"
      >
        {connectDraft && (
          <form onSubmit={(event) => void submitProviderConnect(event)} className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="provider-connect-dialog-title" className="m-0 text-lg font-semibold text-text">
                  {connectDraft.isNewCustom ? "连接自定义 OpenAI 兼容服务" : `连接供应商：${connectDraft.name}`}
                </h2>
                <p className="mb-0 mt-1 text-xs text-subtext">
                  输入一次 API Key 即可在该供应商下展开并开关多个模型；留空密钥将保留已保存凭据。
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭弹窗"
                disabled={busy}
                onClick={() => setConnectDraft(null)}
                className="rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-text disabled:opacity-45"
              >
                <X size={16} />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                供应商 ID
                <Input
                  autoFocus={connectDraft.isNewCustom}
                  required
                  readOnly={!connectDraft.isNewCustom}
                  pattern="[a-zA-Z0-9_-]+"
                  maxLength={100}
                  placeholder="例如 my-proxy"
                  value={connectDraft.id}
                  onChange={(e) => setConnectDraft({ ...connectDraft, id: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                显示名称
                <Input
                  maxLength={100}
                  placeholder="例如 内部模型网关"
                  value={connectDraft.name}
                  onChange={(e) => setConnectDraft({ ...connectDraft, name: e.target.value })}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
              服务地址（OpenAI 兼容 Base URL）
              <Input
                type="url"
                required
                maxLength={2048}
                placeholder="https://api.example.com/v1"
                value={connectDraft.baseUrl}
                onChange={(e) => setConnectDraft({ ...connectDraft, baseUrl: e.target.value })}
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
              API Key
              <Input
                autoFocus={!connectDraft.isNewCustom}
                type="password"
                autoComplete="new-password"
                required={!connectDraft.hasExistingKey}
                maxLength={8192}
                placeholder={connectDraft.hasExistingKey ? "已配置，留空保留原凭据" : "输入该供应商的 API Key"}
                value={connectDraft.apiKey}
                onChange={(e) => setConnectDraft({ ...connectDraft, apiKey: e.target.value })}
              />
            </label>

            <div className="flex justify-end gap-2.5 pt-2">
              <Button type="button" variant="default" disabled={busy} onClick={() => setConnectDraft(null)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? "正在连接…" : "保存连接并展开模型"}
              </Button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
