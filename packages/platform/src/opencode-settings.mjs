import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { check, HttpError } from "./security.mjs";

const packages = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const field = (value, max = 2048) => {
  check(
    typeof value === "string" &&
      value.length <= max &&
      !/[\x00-\x1f]/.test(value),
    400,
    "配置字段格式不正确",
  );
  return value.trim();
};

// Only the configured server path is writable. Never accept a filesystem path from a browser.
export function opencodeSettings(file, apiUrl = "") {
  let pending = Promise.resolve();
  async function api(path, method = "GET", body, timeout = 20000) {
    try {
      const response = await fetch(
        new URL(path, `${apiUrl.replace(/\/$/, "")}/`),
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeout),
        },
      );
      // Never forward upstream errors: they may contain configuration or credentials.
      check(
        response.ok,
        502,
        "OpenCode 配置服务拒绝请求，请检查服务状态和版本",
      );
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (["TimeoutError", "AbortError"].includes(error.name))
        throw new HttpError(504, "模型验证超时，请检查服务状态后重试");
      throw new HttpError(502, "无法连接 OpenCode 配置服务，请联系管理员");
    }
  }
  async function load() {
    if (apiUrl) return api("global/config");
    check(file, 503, "服务器尚未启用网页模型配置，请配置共享目录后重新部署");
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      check(
        object(value) &&
          (value.provider === undefined || object(value.provider)),
        409,
        "现有 OpenCode 配置格式不支持网页编辑",
      );
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        409,
        "无法读取 OpenCode 配置，请检查文件权限及 JSON 格式",
      );
    }
  }
  function summary(config, catalog = {}) {
    const model = typeof config.model === "string" ? config.model : "";
    const slash = model.indexOf("/");
    const providerId = slash > 0 ? model.slice(0, slash) : "openresearch";
    const provider = config.provider?.[providerId];
    const providers = catalogProviders(config, catalog);
    const preset = providers.find((item) => item.id === providerId);
    return {
      enabled: true,
      providerId,
      npm: provider?.npm || preset?.npm || "@ai-sdk/openai-compatible",
      baseUrl:
        typeof provider?.options?.baseURL === "string"
          ? provider.options.baseURL
          : preset?.baseUrl || "",
      modelId: slash > 0 ? model.slice(slash + 1) : "",
      hasApiKey: !!provider?.options?.apiKey,
      providers,
      ...(apiUrl ? { backend: "opencode" } : {}),
    };
  }
  function catalogProviders(config, catalog) {
    const all = new Map(
      (catalog.all || []).map((provider) => [provider.id, provider]),
    );
    for (const [id, provider] of Object.entries(config.provider || {}))
      all.set(id, {
        ...all.get(id),
        ...provider,
        id,
        models: { ...all.get(id)?.models, ...provider.models },
      });
    return [...all.values()]
      .flatMap((provider) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(provider.id)) return [];
        const configured = config.provider?.[provider.id];
        const endpoint = Object.values(provider.models || {}).find(
          (model) => model.api?.url,
        )?.api?.url;
        const npm =
          configured?.npm ||
          provider.npm ||
          Object.values(provider.models || {})
            .map((model) => model.api?.npm)
            .find((npm) => packages.has(npm)) ||
          {
            google: "@ai-sdk/google",
            openai: "@ai-sdk/openai",
            anthropic: "@ai-sdk/anthropic",
          }[provider.id] ||
          "";
        if (!packages.has(npm)) return [];
        return [
          {
            id: provider.id,
            name: provider.name || provider.id,
            npm,
            baseUrl:
              typeof configured?.options?.baseURL === "string"
                ? configured.options.baseURL
                : typeof endpoint === "string" && !/[{}]/.test(endpoint)
                  ? endpoint
                  : "",
            hasApiKey: !!configured?.options?.apiKey,
            connected:
              !(config.disabled_providers || []).includes(provider.id) &&
              (!!configured?.options?.apiKey ||
                (catalog.connected || []).includes(provider.id)),
            models: Object.keys({ ...provider.models, ...configured?.models }),
          },
        ];
      })
      .sort(
        (a, b) =>
          Number(b.connected) - Number(a.connected) || a.id.localeCompare(b.id),
      );
  }
  async function persist(next, audit) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      // The directory is mounted read-only into executors. Renaming there makes
      // updates atomic and visible without exposing partially written credentials.
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
        mode: 0o644,
        flag: "wx",
      });
      await audit();
      await rename(temporary, file);
    } catch {
      throw new HttpError(500, "保存失败，请检查服务器配置目录权限后重试");
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  function validateProviderId(value) {
    const id = field(value, 100);
    check(
      /^[a-zA-Z0-9_-]+$/.test(id) &&
        !["__proto__", "constructor", "prototype"].includes(id),
      400,
      "供应商 ID 仅支持字母、数字、下划线和连字符",
    );
    return id;
  }
  return {
    async read() {
      if (!file && !apiUrl) return { enabled: false };
      const config = await load();
      return summary(config, apiUrl ? await api("provider") : {});
    },
    verify(data, audit = async () => {}) {
      const operation = pending.then(async () => {
        check(apiUrl, 503, "模型验证需要启用 OpenCode 配置服务");
        const providerId = validateProviderId(data.providerId);
        const modelId = field(data.modelId, 256);
        check(modelId, 400, "请选择已保存的模型");
        const config = await load();
        const catalog = await api("provider");
        const provider = catalogProviders(config, catalog).find(
          (p) => p.id === providerId,
        );
        check(
          provider?.connected && provider.models.includes(modelId),
          400,
          "请先保存并启用该供应商和模型，再进行验证",
        );
        await audit();
        const started = Date.now();
        let session;
        try {
          session = await api("session", "POST", {
            title: "模型接入验证",
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          });
          check(
            typeof session?.id === "string" &&
              /^ses[a-zA-Z0-9_-]+$/.test(session.id),
            502,
            "模型验证会话创建失败",
          );
          const result = await api(
            `session/${session.id}/message`,
            "POST",
            {
              model: { providerID: providerId, modelID: modelId },
              system:
                "This is a model connectivity check. Reply only OK. Do not use tools.",
              parts: [{ type: "text", text: "Reply only OK." }],
            },
            60000,
          );
          const error = result?.info?.error;
          const status = error?.data?.statusCode;
          let message = "模型未返回有效文本，请检查模型能力和服务配置";
          let code = "invalid_response";
          if (error) {
            code = "upstream_error";
            message = "模型调用失败，请检查供应商状态、接口类型和模型配置";
            if (
              status === 401 ||
              status === 403 ||
              error.name === "ProviderAuthError"
            ) {
              code = "authentication_failed";
              message =
                "鉴权失败：请检查密钥是否有效，以及是否属于当前供应商接口";
            } else if (status === 404) {
              code = "model_not_found";
              message = "模型或接口不存在：请核对模型 ID 与 Base URL";
            } else if (status === 429) {
              code = "rate_limited";
              message = "请求受限：请检查余额、额度或频率限制";
            }
          } else if (
            result?.parts?.some(
              (part) => part.type === "text" && part.text?.trim(),
            )
          ) {
            return {
              ok: true,
              providerId,
              modelId,
              checkedAt: new Date().toISOString(),
              durationMs: Date.now() - started,
              message: "模型调用验证成功",
            };
          }
          return {
            ok: false,
            providerId,
            modelId,
            checkedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            code,
            message,
          };
        } finally {
          if (session?.id && /^ses[a-zA-Z0-9_-]+$/.test(session.id)) {
            await api(`session/${session.id}/abort`, "POST").catch(() => {});
            await api(`session/${session.id}`, "DELETE").catch(() => {});
          }
        }
      });
      pending = operation.catch(() => {});
      return operation;
    },
    disconnect(data, audit = async () => {}) {
      const operation = pending.then(async () => {
        const providerId = validateProviderId(data.providerId);
        const config = await load();
        const existing = config.provider?.[providerId] || {};
        // Global PATCH merges objects: explicitly clear the key and disable the
        // provider so environment credentials and executor auth seeds cannot reconnect it.
        const next = {
          ...config,
          provider: {
            ...config.provider,
            [providerId]: {
              ...existing,
              options: { ...existing.options, apiKey: "" },
            },
          },
          disabled_providers: [
            ...new Set([...(config.disabled_providers || []), providerId]),
          ],
          ...(Array.isArray(config.enabled_providers)
            ? {
                enabled_providers: config.enabled_providers.filter(
                  (id) => id !== providerId,
                ),
              }
            : {}),
        };
        for (const key of ["model", "small_model"])
          if (config[key]?.startsWith(`${providerId}/`)) next[key] = "";
        if (apiUrl) {
          await audit();
          await api("global/config", "PATCH", next);
          await api(`auth/${encodeURIComponent(providerId)}`, "DELETE");
          return summary(await load(), await api("provider"));
        }
        await persist(next, audit);
        return summary(next);
      });
      pending = operation.catch(() => {});
      return operation;
    },
    save(data, audit = async () => {}) {
      const operation = pending.then(async () => {
        const providerId = field(data.providerId, 100);
        check(
          /^[a-zA-Z0-9_-]+$/.test(providerId) &&
            !["__proto__", "constructor", "prototype"].includes(providerId),
          400,
          "供应商 ID 仅支持字母、数字、下划线和连字符",
        );
        const npm = field(data.npm, 100);
        check(packages.has(npm), 400, "不支持的接口类型");
        const modelId = field(data.modelId, 256);
        check(modelId && !/[{}]/.test(modelId), 400, "请填写有效的模型 ID");
        const catalog = apiUrl ? await api("provider") : {};
        const known = (catalog.all || []).some(
          (provider) => provider.id === providerId,
        );
        const baseUrl = field(data.baseUrl);
        let url;
        if (baseUrl) {
          try {
            url = new URL(baseUrl);
          } catch {
            throw new HttpError(400, "请填写有效的模型服务地址");
          }
          check(
            ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              !/[{}]/.test(baseUrl),
            400,
            "模型服务地址必须是 HTTP 或 HTTPS 地址，不能包含凭据、查询参数或占位符",
          );
        } else
          check(
            npm !== "@ai-sdk/openai-compatible" || known,
            400,
            "自定义兼容接口必须填写服务地址",
          );
        const apiKey = field(data.apiKey ?? "", 8192);
        check(!/[{}]/.test(apiKey), 400, "API Key 不能包含配置占位符");
        const config = await load();
        const providers = config.provider ?? {};
        const existing = providers[providerId] ?? {};
        const preset = apiUrl
          ? catalogProviders(config, catalog).find(
              (provider) => provider.id === providerId,
            )
          : null;
        check(
          object(existing) &&
            (existing.options === undefined || object(existing.options)) &&
            (existing.models === undefined || object(existing.models)),
          409,
          "现有供应商配置格式不支持网页编辑",
        );
        const provider = {
          ...existing,
          // Native model entries may use different SDKs/endpoints under one
          // provider. Preserve OpenCode's model-specific routing for presets.
          ...(!known || existing.npm || npm !== preset?.npm ? { npm } : {}),
          options: {
            ...existing.options,
            ...(baseUrl &&
            (!known || existing.options?.baseURL || baseUrl !== preset?.baseUrl)
              ? { baseURL: baseUrl }
              : {}),
            ...(apiKey ? { apiKey } : {}),
          },
          models: {
            ...existing.models,
            [modelId]: existing.models?.[modelId] ?? { name: modelId },
          },
        };
        // Saving a provider as the default also makes it selectable when the
        // pre-existing configuration restricts provider/model availability.
        if (
          Array.isArray(provider.whitelist) &&
          !provider.whitelist.includes(modelId)
        )
          provider.whitelist = [...provider.whitelist, modelId];
        if (Array.isArray(provider.blacklist))
          provider.blacklist = provider.blacklist.filter(
            (id) => id !== modelId,
          );
        const next = {
          ...config,
          provider: { ...providers, [providerId]: provider },
          model: `${providerId}/${modelId}`,
          ...(Array.isArray(config.enabled_providers)
            ? {
                enabled_providers: [
                  ...new Set([...config.enabled_providers, providerId]),
                ],
              }
            : {}),
          ...(Array.isArray(config.disabled_providers)
            ? {
                disabled_providers: config.disabled_providers.filter(
                  (id) => id !== providerId,
                ),
              }
            : {}),
        };
        if (apiUrl) {
          await audit();
          // The official global endpoint chooses and edits the existing JSON/JSONC
          // source. Project PATCH /config would write to the wrong scope.
          const saved = await api("global/config", "PATCH", next);
          return summary(saved, catalog);
        }
        await persist(next, audit);
        return summary(next);
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
