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
export function quotaModelSettings(file) {
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
    return {
      enabled: true,
      backend: "quota",
      revision: state.revision,
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
        check(
          data.apiKey === undefined ||
            (typeof data.apiKey === "string" &&
              data.apiKey.length <= 8192 &&
              !/[\x00-\x1f{}]/.test(data.apiKey)),
          400,
          "API Key 格式不正确",
        );
        if (data.apiKey) model.apiKey = data.apiKey;
        if (index < 0) models.push(model);
        else models[index] = model;
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
  };
}
