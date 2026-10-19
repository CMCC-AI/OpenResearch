import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { check, HttpError } from "./security.mjs";

const packages = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
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
export function opencodeSettings(file) {
  let pending = Promise.resolve();
  async function load() {
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
  function summary(config) {
    const model = typeof config.model === "string" ? config.model : "";
    const slash = model.indexOf("/");
    const providerId = slash > 0 ? model.slice(0, slash) : "openresearch";
    const provider = config.provider?.[providerId];
    return {
      enabled: true,
      providerId,
      npm: provider?.npm || "@ai-sdk/openai-compatible",
      baseUrl:
        typeof provider?.options?.baseURL === "string"
          ? provider.options.baseURL
          : "",
      modelId: slash > 0 ? model.slice(slash + 1) : "",
      hasApiKey: !!provider?.options?.apiKey,
    };
  }
  return {
    async read() {
      if (!file) return { enabled: false };
      return summary(await load());
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
        const baseUrl = field(data.baseUrl);
        let url;
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
        const apiKey = field(data.apiKey ?? "", 8192);
        check(!/[{}]/.test(apiKey), 400, "API Key 不能包含配置占位符");
        const config = await load();
        const providers = config.provider ?? {};
        const existing = providers[providerId] ?? {};
        check(
          object(existing) &&
            (existing.options === undefined || object(existing.options)) &&
            (existing.models === undefined || object(existing.models)),
          409,
          "现有供应商配置格式不支持网页编辑",
        );
        const provider = {
          ...existing,
          npm,
          options: {
            ...existing.options,
            baseURL: baseUrl,
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
