import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { check, HttpError } from "./security.mjs";
import { validateQuotaModels } from "./model-gateway.mjs";

const revision = (text) => createHash("sha256").update(text).digest("hex");
const fields = [
  "id",
  "name",
  "providerId",
  "providerName",
  "model",
  "baseUrl",
  "contextTokens",
  "maxOutputTokens",
  "outputParameter",
  "opencode",
];
function providerMap(document) {
  const raw = document.providers;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
function validateProviderId(providerId) {
  check(
    typeof providerId === "string" &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(providerId) &&
      !["__proto__", "prototype", "constructor"].includes(providerId),
    400,
    "模型供应商标识无效",
  );
  return providerId;
}
function validateApiKey(apiKey) {
  check(
    apiKey === undefined ||
      (typeof apiKey === "string" &&
        apiKey.length <= 8192 &&
        !/[\x00-\x1f{}]/.test(apiKey)),
    400,
    "API Key 格式不正确",
  );
}
function validateBaseUrl(baseUrl) {
  check(
    typeof baseUrl === "string" &&
      baseUrl.length > 0 &&
      baseUrl.length <= 2048 &&
      !/[\x00-\x1f{}]/.test(baseUrl),
    400,
    "模型字段格式不正确",
  );
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HttpError(
      400,
      "模型配置无效：请检查别名、接口地址、密钥、能力及上下文和输出上限",
    );
  }
  check(
    ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !["169.254.169.254", "metadata.google.internal"].includes(
        url.hostname.toLowerCase(),
      ),
    400,
    "模型配置无效：请检查别名、接口地址、密钥、能力及上下文和输出上限",
  );
  return baseUrl;
}
export function quotaModelSettings(file, { fetcher = fetch } = {}) {
  let pending = Promise.resolve();
  async function load() {
    try {
      const text = await readFile(file, "utf8");
      const document = JSON.parse(text);
      validateQuotaModels(document);
      return { document, revision: revision(text) };
    } catch {
      throw new HttpError(503, "平台模型配置不可用，请检查清单文件及权限");
    }
  }
  function summary(state) {
    const providersById = new Map();
    for (const [id, entry] of Object.entries(providerMap(state.document))) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      providersById.set(id, {
        id,
        name: typeof entry.name === "string" && entry.name ? entry.name : id,
        baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
        hasApiKey: !!entry.apiKey,
        ...(Array.isArray(entry.discoveredModels)
          ? {
              discoveredModels: entry.discoveredModels.filter(
                (m) => typeof m === "string" && m.length > 0,
              ),
            }
          : {}),
      });
    }
    for (const model of state.document.models) {
      const id = model.providerId || "mobilesci";
      const current = providersById.get(id);
      if (!current) {
        providersById.set(id, {
          id,
          name: model.providerName || id,
          baseUrl: model.baseUrl || "",
          hasApiKey: !!model.apiKey,
        });
      } else {
        if (!current.name || current.name === id)
          current.name = model.providerName || current.name;
        if (!current.baseUrl && model.baseUrl) current.baseUrl = model.baseUrl;
        if (model.apiKey) current.hasApiKey = true;
      }
    }
    return {
      enabled: true,
      backend: "quota",
      revision: state.revision,
      providers: [...providersById.values()],
      models: state.document.models.map((model) => ({
        ...Object.fromEntries(
          fields
            .filter((key) => model[key] !== undefined)
            .map((key) => [key, model[key]]),
        ),
        hasApiKey: !!model.apiKey,
      })),
    };
  }
  function update(action, data, audit) {
    const operation = pending.then(async () => {
      const state = await load();
      check(
        data.revision === state.revision,
        409,
        "模型清单已更新，请刷新页面后重试",
      );
      const models = state.document.models;
      if (action === "connectProvider") {
        const providerId = validateProviderId(data.providerId);
        if (data.providerName !== undefined)
          check(
            typeof data.providerName === "string" &&
              data.providerName.length <= 2048 &&
              !/[\x00-\x1f{}]/.test(data.providerName),
            400,
            "模型字段格式不正确",
          );
        const baseUrl = validateBaseUrl(data.baseUrl);
        validateApiKey(data.apiKey);
        const providers = providerMap(state.document);
        const existingProvider = providers[providerId] || {};
        const matchingModels = models.filter(
          (m) => (m.providerId || "mobilesci") === providerId,
        );
        const resolvedApiKey =
          data.apiKey ||
          existingProvider.apiKey ||
          matchingModels.find((m) => m.apiKey)?.apiKey ||
          "";
        check(
          typeof resolvedApiKey === "string" && resolvedApiKey.length > 0,
          400,
          "首次连接供应商必须填写 API Key",
        );
        const providerName =
          (typeof data.providerName === "string" && data.providerName.trim()) ||
          existingProvider.name ||
          matchingModels.find((m) => m.providerName)?.providerName ||
          providerId;
        state.document.providers = {
          ...providers,
          [providerId]: {
            ...existingProvider,
            name: providerName,
            baseUrl,
            apiKey: resolvedApiKey,
          },
        };
        for (const m of matchingModels) {
          m.baseUrl = baseUrl;
          m.providerName = providerName;
          if (data.apiKey) m.apiKey = data.apiKey;
        }
      } else if (action === "disconnectProvider") {
        const providerId = validateProviderId(data.providerId);
        const providers = providerMap(state.document);
        const matchingCount = models.filter(
          (m) => (m.providerId || "mobilesci") === providerId,
        ).length;
        check(
          Object.hasOwn(providers, providerId) || matchingCount > 0,
          404,
          "供应商不存在",
        );
        const remaining = models.filter(
          (m) => (m.providerId || "mobilesci") !== providerId,
        );
        check(remaining.length >= 1, 400, "至少保留一个可用模型");
        state.document.models = remaining;
        if (state.document.providers && typeof state.document.providers === "object") {
          delete state.document.providers[providerId];
        }
      } else {
        const index = models.findIndex((m) => m.id === data.id);
        if (action === "remove" || action === "default") {
          check(index >= 0, 404, "模型不存在");
          if (action === "remove") {
            check(models.length > 1, 400, "至少保留一个可用模型");
            models.splice(index, 1);
          } else models.unshift(...models.splice(index, 1));
        } else {
          check(
            data.npm === undefined || data.npm === "@ai-sdk/openai-compatible",
            400,
            "额度网关仅支持 OpenAI 兼容接口",
          );
          const existing = models[index] || {};
          const model = { ...existing };
          for (const key of fields)
            if (Object.hasOwn(data, key)) model[key] = data[key];
          for (const key of [
            "id",
            "name",
            "providerId",
            "providerName",
            "model",
            "baseUrl",
          ])
            if (model[key] !== undefined)
              check(
                typeof model[key] === "string" &&
                  model[key].length <= 2048 &&
                  !/[\x00-\x1f{}]/.test(model[key]),
                400,
                "模型字段格式不正确",
              );
          validateApiKey(data.apiKey);
          const providerId = model.providerId || "mobilesci";
          const storedProvider = providerMap(state.document)[providerId];
          const siblings = models.filter(
            (m, i) => i !== index && (m.providerId || "mobilesci") === providerId,
          );
          if (data.apiKey) model.apiKey = data.apiKey;
          else if (!model.apiKey)
            model.apiKey =
              storedProvider?.apiKey ||
              siblings.find((m) => m.apiKey)?.apiKey;
          if (!model.baseUrl)
            model.baseUrl =
              storedProvider?.baseUrl ||
              siblings.find((m) => m.baseUrl)?.baseUrl;
          if (!model.providerName && storedProvider?.name)
            model.providerName = storedProvider.name;
          if (model.headers === undefined) {
            const sharedHeaders =
              storedProvider?.headers ||
              siblings.find((m) => m.headers)?.headers;
            if (sharedHeaders !== undefined) model.headers = sharedHeaders;
          }
          if (storedProvider && typeof storedProvider === "object") {
            if (data.apiKey) storedProvider.apiKey = data.apiKey;
            if (model.baseUrl) storedProvider.baseUrl = model.baseUrl;
            if (model.providerName) storedProvider.name = model.providerName;
          }
          if (index < 0) models.push(model);
          else models[index] = model;
        }
      }
      try {
        validateQuotaModels(state.document);
      } catch {
        throw new HttpError(
          400,
          "模型配置无效：请检查别名、接口地址、密钥、能力及上下文和输出上限",
        );
      }
      const text = JSON.stringify(state.document, null, 2) + "\n";
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        // Fail rather than overwrite a concurrent administrator or operator edit.
        check(
          revision(await readFile(file, "utf8")) === state.revision,
          409,
          "模型清单已更新，请刷新页面后重试",
        );
        await audit();
        await rename(temporary, file);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          500,
          "保存失败，请检查模型清单目录为平台专用可写挂载",
        );
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return summary({ document: state.document, revision: revision(text) });
    });
    pending = operation.catch(() => {});
    return operation;
  }
  async function probeModels(data, audit = async () => {}) {
    if (data.providerId !== undefined) validateProviderId(data.providerId);
    validateApiKey(data.apiKey);
    const state = await load();
    const providerId = data.providerId || "mobilesci";
    const storedProvider = providerMap(state.document)[providerId];
    const matchingModels = state.document.models.filter(
      (m) => (m.providerId || "mobilesci") === providerId,
    );
    const rawBaseUrl =
      (typeof data.baseUrl === "string" && data.baseUrl.trim()) ||
      storedProvider?.baseUrl ||
      matchingModels.find((m) => m.baseUrl)?.baseUrl ||
      "";
    const baseUrl = validateBaseUrl(rawBaseUrl);
    const apiKey =
      (typeof data.apiKey === "string" && data.apiKey) ||
      storedProvider?.apiKey ||
      matchingModels.find((m) => m.apiKey)?.apiKey ||
      "";
    check(
      typeof apiKey === "string" && apiKey.length > 0 && !/[\r\n]/.test(apiKey),
      400,
      "探测模型列表需要有效的 API Key",
    );
    await audit();
    let payload;
    try {
      const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      check(
        response.ok,
        502,
        "供应商模型列表探测失败，请检查接口地址与 API Key",
      );
      payload = await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (["TimeoutError", "AbortError"].includes(error?.name))
        throw new HttpError(504, "供应商模型探测超时，请稍后重试");
      throw new HttpError(
        502,
        "供应商模型列表探测失败，请检查接口地址与 API Key",
      );
    }
    const items = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
    const models = [
      ...new Set(
        items
          .map((item) =>
            typeof item === "string"
              ? item.trim()
              : typeof item?.id === "string"
                ? item.id.trim()
                : "",
          )
          .filter(
            (id) =>
              id.length > 0 && id.length <= 200 && !/[\x00-\x1f{}]/.test(id),
          ),
      ),
    ].slice(0, 200);
    return { models };
  }
  return {
    async read() {
      return summary(await load());
    },
    save(data, audit = async () => {}) {
      return update("save", data, audit);
    },
    remove(data, audit = async () => {}) {
      return update("remove", data, audit);
    },
    default(data, audit = async () => {}) {
      return update("default", data, audit);
    },
    connectProvider(data, audit = async () => {}) {
      return update("connectProvider", data, audit);
    },
    disconnectProvider(data, audit = async () => {}) {
      return update("disconnectProvider", data, audit);
    },
    probeModels,
  };
}
