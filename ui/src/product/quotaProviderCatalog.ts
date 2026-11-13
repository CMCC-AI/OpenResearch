export interface QuotaModel {
  id: string;
  name?: string;
  providerId?: string;
  providerName?: string;
  model: string;
  baseUrl: string;
  contextTokens: number;
  maxOutputTokens: number;
  outputParameter?: string;
  opencode?: Record<string, unknown>;
  hasApiKey?: boolean;
}

export interface QuotaBackendProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  discoveredModels?: string[];
}

export interface QuotaModels {
  enabled: boolean;
  backend: "quota";
  revision: string;
  providers?: QuotaBackendProvider[];
  models: QuotaModel[];
}

export interface CatalogModelPreset {
  model: string;
  name: string;
  contextTokens: number;
  maxOutputTokens: number;
  outputParameter?: "max_tokens" | "max_completion_tokens";
  opencode?: Record<string, unknown>;
}

export interface CatalogProvider {
  id: string;
  name: string;
  description: string;
  defaultBaseUrl: string;
  models: CatalogModelPreset[];
}

export interface SessionProviderState {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  discoveredModels: string[];
}

export interface ResolvedProvider {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  hasApiKey: boolean;
  sessionApiKey: string;
  isBuiltin: boolean;
  enabledCount: number;
  models: ResolvedProviderModel[];
}

export interface ResolvedProviderModel {
  key: string;
  providerId: string;
  model: string;
  name: string;
  baseUrl: string;
  contextTokens: number;
  maxOutputTokens: number;
  outputParameter: "max_tokens" | "max_completion_tokens";
  opencode: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
  source: "saved" | "catalog" | "discovered";
  needsLimitConfirmation: boolean;
  savedModel?: QuotaModel;
}

export const DEFAULT_CONTEXT_TOKENS = 131072;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export const QUOTA_PROVIDERS: CatalogProvider[] = [
  {
    id: "moonshotai-cn",
    name: "Kimi / Moonshot",
    description: "Moonshot AI 国内开放平台（OpenAI 兼容接口）",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    models: [
      { model: "kimi-k2.6", name: "Kimi K2.6", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
      { model: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true } },
      { model: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code HighSpeed", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true } },
      { model: "kimi-k3", name: "Kimi K3", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
      { model: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
      { model: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
      { model: "kimi-k2-0905-preview", name: "Kimi K2 0905 Preview", contextTokens: 262144, maxOutputTokens: 16384, opencode: { tool_call: true } },
      { model: "moonshot-v1-128k", name: "Moonshot V1 128K", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek 官方 OpenAI 兼容接口",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    models: [
      { model: "deepseek-chat", name: "DeepSeek Chat (V3)", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
      { model: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI Chat Completions 接口或兼容网关",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: [
      { model: "gpt-4.1", name: "GPT-4.1", contextTokens: 1047576, maxOutputTokens: 32768, outputParameter: "max_completion_tokens", opencode: { tool_call: true, attachment: true } },
      { model: "gpt-4.1-mini", name: "GPT-4.1 mini", contextTokens: 1047576, maxOutputTokens: 32768, outputParameter: "max_completion_tokens", opencode: { tool_call: true, attachment: true } },
      { model: "gpt-4o", name: "GPT-4o", contextTokens: 128000, maxOutputTokens: 16384, outputParameter: "max_completion_tokens", opencode: { tool_call: true, attachment: true } },
      { model: "gpt-4o-mini", name: "GPT-4o mini", contextTokens: 128000, maxOutputTokens: 16384, outputParameter: "max_completion_tokens", opencode: { tool_call: true, attachment: true } },
      { model: "o3-mini", name: "o3-mini", contextTokens: 200000, maxOutputTokens: 65536, outputParameter: "max_completion_tokens", opencode: { tool_call: true, reasoning: true } },
      { model: "o4-mini", name: "o4-mini", contextTokens: 200000, maxOutputTokens: 65536, outputParameter: "max_completion_tokens", opencode: { tool_call: true, reasoning: true, attachment: true } },
    ],
  },
  {
    id: "zhipuai",
    name: "智谱 GLM",
    description: "智谱开放平台 OpenAI 兼容接口",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [
      { model: "glm-4.5", name: "GLM-4.5", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
      { model: "glm-4.5-air", name: "GLM-4.5 Air", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
      { model: "glm-4-plus", name: "GLM-4 Plus", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
      { model: "glm-z1-plus", name: "GLM-Z1 Plus", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "通过 OpenRouter 统一路由多厂商 OpenAI 兼容模型",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: [
      { model: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", contextTokens: 200000, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true, attachment: true } },
      { model: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", contextTokens: 1048576, maxOutputTokens: 65536, opencode: { tool_call: true, reasoning: true, attachment: true } },
      { model: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", contextTokens: 1048576, maxOutputTokens: 65536, opencode: { tool_call: true, reasoning: true, attachment: true } },
      { model: "openai/gpt-4.1", name: "GPT-4.1 (OpenRouter)", contextTokens: 1047576, maxOutputTokens: 32768, opencode: { tool_call: true, attachment: true } },
      { model: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3 0324", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
    ],
  },
  {
    id: "dashscope",
    name: "阿里云百炼 / 通义千问",
    description: "DashScope OpenAI 兼容模式",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { model: "qwen-max", name: "Qwen Max", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
      { model: "qwen-plus", name: "Qwen Plus", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
      { model: "qwen-coder-plus", name: "Qwen Coder Plus", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
      { model: "qwq-plus", name: "QwQ Plus", contextTokens: 131072, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
    ],
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    description: "SiliconFlow OpenAI 兼容推理服务",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    models: [
      { model: "deepseek-ai/DeepSeek-V3", name: "DeepSeek-V3", contextTokens: 65536, maxOutputTokens: 8192, opencode: { tool_call: true } },
      { model: "deepseek-ai/DeepSeek-R1", name: "DeepSeek-R1", contextTokens: 65536, maxOutputTokens: 16384, opencode: { tool_call: true, reasoning: true } },
      { model: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5-72B-Instruct", contextTokens: 131072, maxOutputTokens: 8192, opencode: { tool_call: true } },
    ],
  },
];

export function findCatalogProvider(providerId: string): CatalogProvider | undefined {
  return QUOTA_PROVIDERS.find((provider) => provider.id === providerId);
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}K`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(tokens);
}

export function capabilityLabels(opencode?: Record<string, unknown>): string[] {
  if (!opencode) return [];
  const labels: string[] = [];
  if (opencode.tool_call) labels.push("工具");
  if (opencode.reasoning) labels.push("思考");
  if (opencode.attachment) labels.push("多模态");
  return labels;
}

export function sanitizeAliasFragment(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "model";
}

export function buildModelAlias(providerId: string, modelId: string, savedModels: QuotaModel[]): string {
  const existing = savedModels.find((m) => (m.providerId || "mobilesci") === providerId && m.model === modelId);
  if (existing) return existing.id;

  const baseAlias = sanitizeAliasFragment(modelId);
  const taken = new Set(savedModels.map((m) => m.id));
  if (!taken.has(baseAlias)) return baseAlias;

  const prefixed = `${sanitizeAliasFragment(providerId)}:${baseAlias}`.slice(0, 100);
  if (!taken.has(prefixed)) return prefixed;

  let index = 2;
  while (taken.has(`${prefixed}-${index}`.slice(0, 100))) index += 1;
  return `${prefixed}-${index}`.slice(0, 100);
}

export function resolveConnectedProviders(
  settings: QuotaModels,
  sessionProviders: Record<string, SessionProviderState>,
): ResolvedProvider[] {
  const defaultModelId = settings.models[0]?.id;
  const providerIds = new Set<string>();

  for (const backendProvider of settings.providers || []) {
    providerIds.add(backendProvider.id);
  }
  for (const model of settings.models) {
    providerIds.add(model.providerId || "mobilesci");
  }
  for (const id of Object.keys(sessionProviders)) {
    providerIds.add(id);
  }

  const resolved: ResolvedProvider[] = [];
  for (const id of providerIds) {
    const catalog = findCatalogProvider(id);
    const backend = settings.providers?.find((p) => p.id === id);
    const session = sessionProviders[id];
    const savedForProvider = settings.models.filter((m) => (m.providerId || "mobilesci") === id);
    const firstSaved = savedForProvider[0];

    const baseUrl = session?.baseUrl || backend?.baseUrl || firstSaved?.baseUrl || catalog?.defaultBaseUrl || "";
    const sessionApiKey = session?.apiKey || "";
    const hasApiKey = Boolean(sessionApiKey || session?.hasApiKey || backend?.hasApiKey || savedForProvider.some((m) => m.hasApiKey));
    const name = session?.name || backend?.name || firstSaved?.providerName || catalog?.name || id;
    const description = catalog?.description || "自定义 OpenAI 兼容模型服务";

    const models: ResolvedProviderModel[] = [];
    const seenModelIds = new Set<string>();

    for (const saved of savedForProvider) {
      seenModelIds.add(saved.model);
      models.push({
        key: `${id}::${saved.id}`,
        providerId: id,
        model: saved.model,
        name: saved.name || saved.model,
        baseUrl: saved.baseUrl || baseUrl,
        contextTokens: saved.contextTokens,
        maxOutputTokens: saved.maxOutputTokens,
        outputParameter: saved.outputParameter === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
        opencode: saved.opencode || {},
        enabled: true,
        isDefault: saved.id === defaultModelId,
        source: "saved",
        needsLimitConfirmation: false,
        savedModel: saved,
      });
    }

    if (catalog) {
      for (const preset of catalog.models) {
        if (seenModelIds.has(preset.model)) continue;
        seenModelIds.add(preset.model);
        models.push({
          key: `${id}::${preset.model}`,
          providerId: id,
          model: preset.model,
          name: preset.name,
          baseUrl,
          contextTokens: preset.contextTokens,
          maxOutputTokens: preset.maxOutputTokens,
          outputParameter: preset.outputParameter || "max_tokens",
          opencode: preset.opencode || {},
          enabled: false,
          isDefault: false,
          source: "catalog",
          needsLimitConfirmation: false,
        });
      }
    }

    const discovered = [...(backend?.discoveredModels || []), ...(session?.discoveredModels || [])];
    for (const modelId of discovered) {
      const trimmed = modelId.trim();
      if (!trimmed || seenModelIds.has(trimmed)) continue;
      seenModelIds.add(trimmed);
      models.push({
        key: `${id}::${trimmed}`,
        providerId: id,
        model: trimmed,
        name: trimmed,
        baseUrl,
        contextTokens: DEFAULT_CONTEXT_TOKENS,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        outputParameter: "max_tokens",
        opencode: { tool_call: true },
        enabled: false,
        isDefault: false,
        source: "discovered",
        needsLimitConfirmation: true,
      });
    }

    resolved.push({
      id,
      name,
      description,
      baseUrl,
      hasApiKey,
      sessionApiKey,
      isBuiltin: Boolean(catalog),
      enabledCount: savedForProvider.length,
      models,
    });
  }

  return resolved.sort((a, b) => {
    const aHasDefault = a.models.some((m) => m.isDefault);
    const bHasDefault = b.models.some((m) => m.isDefault);
    if (aHasDefault !== bHasDefault) return aHasDefault ? -1 : 1;
    if (b.enabledCount !== a.enabledCount) return b.enabledCount - a.enabledCount;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}
