import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { hash, check, HttpError } from "./security.mjs";
import { body } from "./tunnel.mjs";
import { tokenInteger } from "./token-quotas.mjs";

export function quotaConfiguration(env) {
  check(
    env.TOKEN_QUOTAS_ENABLED === undefined ||
      ["true", "false"].includes(env.TOKEN_QUOTAS_ENABLED),
    500,
    "TOKEN_QUOTAS_ENABLED 必须为 true 或 false",
  );
  const enabled = env.TOKEN_QUOTAS_ENABLED === "true";
  const monthlyTokens = Number(
    env.TOKEN_QUOTA_DEFAULT_MONTHLY_TOKENS ?? 2000000,
  );
  tokenInteger(monthlyTokens);
  if (enabled)
    check(
      env.TOKEN_QUOTA_MODELS_FILE &&
        env.PRIVATE_USER_SPACES === "true" &&
        env.MANAGED_EXECUTORS === "true",
      500,
      "Token 配额需要私人托管空间和 TOKEN_QUOTA_MODELS_FILE",
    );
  return {
    enabled,
    monthlyTokens,
    modelsFile: env.TOKEN_QUOTA_MODELS_FILE || "",
  };
}
export async function loadQuotaModels(file) {
  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new HttpError(503, "平台模型配置不可用");
  }
  check(
    Array.isArray(document.models) &&
      document.models.length > 0 &&
      document.models.length <= 100,
    503,
    "平台模型列表无效",
  );
  const seen = new Set();
  for (const model of document.models) {
    check(
      model &&
        /^[a-zA-Z0-9_.:-]{1,100}$/.test(model.id) &&
        !["__proto__", "prototype", "constructor"].includes(model.id) &&
        !seen.has(model.id),
      503,
      "模型别名无效或重复",
    );
    seen.add(model.id);
    check(
      typeof model.model === "string" &&
        model.model.length > 0 &&
        model.model.length <= 200 &&
        typeof model.apiKey === "string" &&
        model.apiKey.length > 0 &&
        !/[\r\n]/.test(model.apiKey),
      503,
      "模型认证配置无效",
    );
    let url;
    try {
      url = new URL(model.baseUrl);
    } catch {
      throw new HttpError(503, "模型地址无效");
    }
    check(
      ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      503,
      "模型地址无效",
    );
    check(
      Number.isSafeInteger(model.contextTokens) &&
        model.contextTokens > 0 &&
        model.contextTokens <= 10000000 &&
        Number.isSafeInteger(model.maxOutputTokens) &&
        model.maxOutputTokens > 0 &&
        model.maxOutputTokens <= model.contextTokens,
      503,
      "请配置可信的模型上下文和输出上限",
    );
    check(
      !model.outputParameter ||
        ["max_tokens", "max_completion_tokens"].includes(model.outputParameter),
      503,
      "输出上限字段无效",
    );
  }
  return document.models;
}
export function nativeUsage(value) {
  const usage = value?.usage;
  const input = usage?.prompt_tokens,
    output = usage?.completion_tokens;
  if (
    !Number.isSafeInteger(input) ||
    input < 0 ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    !Number.isSafeInteger(input + output)
  )
    return null;
  if (usage.total_tokens !== undefined && usage.total_tokens !== input + output)
    return null;
  // Cached input and reasoning output are already included by this protocol.
  return input + output;
}
export function publicModelConfig(models, base, secret) {
  return {
    enabled_providers: ["mobilesci"],
    model: `mobilesci/${models[0].id}`,
    small_model: `mobilesci/${models[0].id}`,
    provider: {
      mobilesci: {
        name: "平台额度模型",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `${base.replace(/\/$/, "")}/api/platform/model-gateway/v1`,
          apiKey: secret,
        },
        models: Object.fromEntries(
          models.map((m) => [
            m.id,
            {
              name: m.name || m.id,
              limit: { context: m.contextTokens, output: m.maxOutputTokens },
            },
          ]),
        ),
      },
    },
  };
}
export function modelGateway({ pool, quota, settings, limit }) {
  async function identity(req) {
    check(!req.headers.origin, 403, "模型网关不接受浏览器来源");
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization || "",
    );
    check(match, 401, "模型网关凭据无效");
    const { rows } = await pool.query(
      `SELECT r.workspace_id,p.user_id FROM runners r JOIN personal_spaces p ON p.workspace_id=r.workspace_id JOIN platform_users u ON u.id=p.user_id WHERE r.token_hash=$1 AND r.expires_at>now() AND NOT u.disabled`,
      [hash(match[1])],
    );
    check(rows[0], 401, "模型网关凭据已失效");
    return { ...rows[0], secret: match[1] };
  }
  return async function handle(req, res, path) {
    const configPath = "/api/platform/runner/model-config";
    const prefix = "/api/platform/model-gateway/v1";
    if (path !== configPath && !path.startsWith(prefix + "/")) return false;
    check(settings.enabled, 404, "Token 配额模型网关未启用");
    const user = await identity(req);
    await limit(`model-gateway:${user.user_id}`, 120, 60);
    const models = await loadQuotaModels(settings.modelsFile);
    const send = (value) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    if (path === configPath && req.method === "GET") {
      send(publicModelConfig(models, "", user.secret));
      return true;
    }
    if (path === prefix + "/models" && req.method === "GET") {
      send({
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          owned_by: "mobilesci",
        })),
      });
      return true;
    }
    check(
      path === prefix + "/chat/completions" && req.method === "POST",
      404,
      "不支持的模型接口",
    );
    check(
      req.headers["content-type"]?.split(";")[0] === "application/json",
      415,
    );
    let input;
    try {
      input = JSON.parse((await body(req, 2 * 1024 * 1024)).toString());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "模型请求 JSON 无效");
    }
    check(input && typeof input === "object" && !Array.isArray(input), 400);
    const model = models.find((m) => m.id === input.model);
    check(model, 400, "该模型未开放");
    check(
      Array.isArray(input.messages) &&
        input.messages.length > 0 &&
        input.messages.length <= 1000,
      400,
      "消息列表无效",
    );
    check(
      input.messages.every(
        (m) =>
          m &&
          typeof m.role === "string" &&
          (typeof m.content === "string" ||
            m.content === null ||
            (Array.isArray(m.content) &&
              m.content.every(
                (c) => c?.type === "text" && typeof c.text === "string",
              ))) &&
          !("audio" in m),
      ),
      400,
      "当前额度网关仅支持文本与工具消息",
    );
    check(
      input.stream === undefined || typeof input.stream === "boolean",
      400,
      "stream 格式无效",
    );
    check(input.n === undefined || input.n === 1, 400, "仅支持单个响应");
    const requested =
      input.max_completion_tokens ?? input.max_tokens ?? model.maxOutputTokens;
    tokenInteger(requested);
    check(
      requested > 0 && requested <= model.maxOutputTokens,
      400,
      "请求输出上限超过模型配置",
    );
    // Reserve a conservative bound, not an untrusted client token estimate.
    // The configured provider must enforce its advertised context/output limits.
    const reserved = model.contextTokens + requested;
    const request = await quota.reserve(
      user.user_id,
      user.workspace_id,
      model.id,
      reserved,
    );
    res.setHeader("x-token-quota-request-id", request);
    const abort = new AbortController();
    const close = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", close);
    let settled = false;
    try {
      const payload = {};
      for (const key of [
        "messages",
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
        "response_format",
        "parallel_tool_calls",
        "stop",
        "seed",
      ])
        if (input[key] !== undefined) payload[key] = input[key];
      payload.model = model.model;
      payload[model.outputParameter || "max_tokens"] = requested;
      payload.stream = !!input.stream;
      if (payload.stream) payload.stream_options = { include_usage: true };
      const upstream = await fetch(
        `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${model.apiKey}`,
            "content-type": "application/json",
            "x-client-request-id": request,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
        },
      );
      await quota.upstream(
        request,
        upstream.headers.get("x-request-id") ||
          upstream.headers.get("request-id"),
      );
      if (!upstream.ok) {
        await upstream.body?.cancel();
        if ([400, 401, 403, 404, 413, 422, 429].includes(upstream.status)) {
          await quota.settle(request, 0, null, "provider_rejected");
          settled = true;
        }
        throw new HttpError(
          502,
          "上游模型拒绝请求，请联系管理员并提供配额请求标识",
        );
      }
      if (!payload.stream) {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          check(bytes <= 16 * 1024 * 1024, 502, "模型响应过大");
          chunks.push(chunk);
        }
        let result;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new HttpError(502, "模型响应格式无效");
        }
        const used = nativeUsage(result);
        if (used !== null) {
          await quota.settle(request, used);
          settled = true;
        }
        send(result);
      } else {
        check(
          upstream.headers.get("content-type")?.startsWith("text/event-stream"),
          502,
          "模型流格式无效",
        );
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        const decoder = new TextDecoder();
        let buffer = "",
          used = null,
          done = false,
          invalid = false;
        upstreamChunks: for await (const chunk of upstream.body) {
          buffer += decoder.decode(chunk, { stream: true });
          check(buffer.length <= 1024 * 1024, 502, "模型流事件过大");
          let split;
          while ((split = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, split.index);
            buffer = buffer.slice(split.index + split[0].length);
            const data = frame
              .split(/\r?\n/)
              .filter((x) => x.startsWith("data:"))
              .map((x) => x.slice(5).trimStart())
              .join("\n");
            if (data === "[DONE]") {
              done = true;
              break upstreamChunks;
            }
            if (data) {
              try {
                const v = JSON.parse(data);
                if (v.usage) {
                  const n = nativeUsage(v);
                  if (n === null || (used !== null && n < used)) invalid = true;
                  else used = n;
                }
              } catch {
                invalid = true;
              }
            }
            if (!res.write(frame + "\n\n"))
              await once(res, "drain", { signal: abort.signal });
          }
        }
        if (done && !invalid && used !== null) {
          await quota.settle(request, used);
          settled = true;
        }
        if (done) res.write("data: [DONE]\n\n");
        res.end();
      }
      return true;
    } finally {
      res.removeListener("close", close);
      if (!settled) await quota.pending(request, "usage_unconfirmed");
    }
  };
}
