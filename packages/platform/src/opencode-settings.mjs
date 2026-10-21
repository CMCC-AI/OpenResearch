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
  async function api(path, method = "GET", body) {
    try {
      const response = await fetch(
        new URL(path, `${apiUrl.replace(/\/$/, "")}/`),
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(20000),
        },
      );
      // Never forward upstream errors: they may contain configuration or credentials.
      check(
        response.ok,
        502,
        "OpenCode 配置服务拒绝请求，请检查服务状态和版本",
      );
      return await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
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
    const providers = apiUrl ? catalogProviders(config, catalog) : [];
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
      ...(apiUrl ? { backend: "opencode", providers } : {}),
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
              !!configured?.options?.apiKey ||
              (catalog.connected || []).includes(provider.id),
            models: Object.keys({ ...provider.models, ...configured?.models }),
          },
        ];
      })
      .sort(
        (a, b) =>
          Number(b.connected) - Number(a.connected) || a.id.localeCompare(b.id),
      );
  }
  return {
    async read() {
      if (!file && !apiUrl) return { enabled: false };
      const config = await load();
      return summary(config, apiUrl ? await api("provider") : {});
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
        return summary(next);
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
