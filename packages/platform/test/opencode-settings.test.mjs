import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { hash } from "../src/security.mjs";
import { opencodeSettings } from "../src/opencode-settings.mjs";
import { configuration, createPlatform } from "../src/server.mjs";
const draft = {
  providerId: "company",
  npm: "@ai-sdk/openai-compatible",
  baseUrl: "https://model.example/v1",
  modelId: "org/model",
  apiKey: "test-secret-never-return",
};
test("settings preserve unrelated config and credentials without returning secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orx-model-"));
  const file = join(dir, "opencode.json");
  try {
    const settings = opencodeSettings(file);
    assert.equal((await settings.read()).hasApiKey, false);
    await writeFile(
      file,
      JSON.stringify({
        permission: { bash: "ask" },
        provider: {
          other: { npm: "existing" },
          company: { whitelist: ["old"], blacklist: ["org/model"] },
        },
        enabled_providers: ["other"],
        disabled_providers: ["company"],
      }),
    );
    const saved = await settings.save(draft);
    assert.equal(saved.hasApiKey, true);
    assert(!JSON.stringify(saved).includes(draft.apiKey));
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.provider.company.options.apiKey, draft.apiKey);
    assert.equal(stored.model, "company/org/model");
    assert.deepEqual(stored.enabled_providers, ["other", "company"]);
    assert.deepEqual(stored.disabled_providers, []);
    assert.deepEqual(stored.provider.company.whitelist, ["old", "org/model"]);
    assert.deepEqual(stored.provider.company.blacklist, []);
    assert.deepEqual(stored.permission, { bash: "ask" });
    assert.equal(stored.provider.other.npm, "existing");
    await settings.save({ ...draft, apiKey: "", modelId: "next" });
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).provider.company.options.apiKey,
      draft.apiKey,
    );
    assert.equal((await settings.read()).modelId, "next");
    const before = await readFile(file, "utf8");
    await assert.rejects(
      settings.save(draft, async () => {
        throw Error("audit offline");
      }),
      { status: 500 },
    );
    assert.equal(await readFile(file, "utf8"), before);
    await writeFile(file, "invalid JSON");
    await assert.rejects(settings.save(draft), { status: 409 });
    assert.equal(await readFile(file, "utf8"), "invalid JSON");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("settings reject unsafe fields and arbitrary SDK packages", async () => {
  const settings = opencodeSettings("/unused/config.json");
  for (const changes of [
    { providerId: "__proto__" },
    { providerId: "../other" },
    { npm: "untrusted-package" },
    { baseUrl: "file:///etc/passwd" },
    { baseUrl: "https://key:secret@example.com" },
    { baseUrl: "https://example.com?key=secret" },
    { modelId: "" },
    { apiKey: "{file:/etc/passwd}" },
  ])
    await assert.rejects(settings.save({ ...draft, ...changes }), {
      status: 400,
    });
  assert.deepEqual(await opencodeSettings("").read(), { enabled: false });
  await assert.rejects(opencodeSettings("").save(draft), { status: 503 });
});
test("HTTP model settings require administrator permission and trusted origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orx-model-api-"));
  const auditCalls = [];
  let admin = false;
  const pool = {
    async end() {},
    async query(sql, args) {
      if (sql.includes("SELECT s.*,u.email"))
        return {
          rows:
            args[0] === hash("test")
              ? [{ user_id: "test", is_admin: admin }]
              : [],
        };
      if (sql.includes("SELECT workspace_id FROM personal_spaces"))
        return {
          rows: [{ workspace_id: "11111111-1111-4111-8111-111111111111" }],
        };
      if (sql.includes("SELECT id FROM workspaces"))
        return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
      if (sql.includes("auth_limits")) return { rows: [{ attempts: 1 }] };
      if (sql.includes("audit_events")) {
        auditCalls.push(args);
        return { rows: [] };
      }
      throw Error("Unexpected query");
    },
  };
  const config = configuration({
    DATABASE_URL: "postgres://unused",
    PLATFORM_ORIGIN: "http://localhost:5300",
    OPENCODE_ADMIN_CONFIG_FILE: join(dir, "opencode.json"),
  });
  const app = await createPlatform(config, pool);
  try {
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    config.origin = new URL(`http://localhost:${app.server.address().port}`);
    const request = (method, origin = config.origin.origin, data = draft) =>
      fetch(`${config.origin.origin}/api/platform/admin/opencode`, {
        method,
        headers: {
          origin,
          cookie: "orx_session=test",
          "content-type": "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify(data) } : {}),
      });
    const anonymous = await fetch(
      `${config.origin.origin}/api/platform/admin/opencode`,
    );
    assert.equal(anonymous.status, 401);
    assert.equal((await request("GET")).status, 403);
    assert.equal((await request("POST")).status, 403);
    for (const action of ["disconnect", "verify"])
      assert.equal(
        (await request("POST", config.origin.origin, { ...draft, action }))
          .status,
        403,
      );
    admin = true;
    assert.equal(
      (await request("POST", "https://untrusted.example")).status,
      403,
    );
    assert.equal((await request("DELETE")).status, 405);
    const saved = await request("POST");
    assert.equal(saved.status, 200);
    assert(!(await saved.text()).includes(draft.apiKey));
    const loaded = await request("GET");
    assert.equal(loaded.status, 200);
    assert.equal((await loaded.json()).hasApiKey, true);
    config.sharedOriginSpaces = true;
    admin = false;
    const blocked = await fetch(`${config.origin.origin}/api/local-models`, {
      method: "POST",
      headers: {
        origin: config.origin.origin,
        cookie: "orx_session=test",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).error, /仅系统管理员/);
    admin = true;
    const disconnected = await request("POST", config.origin.origin, {
      providerId: "company",
      action: "disconnect",
    });
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).hasApiKey, false);
    assert.equal(auditCalls.length, 2);
    assert(!JSON.stringify(auditCalls).includes(draft.apiKey));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("official global API manages native providers and never returns catalog credentials", async () => {
  const { createServer } = await import("node:http");
  let config = {
    permission: { bash: "ask" },
    provider: {
      company: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: draft.apiKey },
      },
    },
  };
  const calls = [];
  let reject = false;
  const upstream = createServer(async (req, res) => {
    calls.push([req.method, req.url]);
    res.setHeader("content-type", "application/json");
    if (reject) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: draft.apiKey }));
    }
    if (req.url === "/global/config") {
      if (req.method === "PATCH") {
        let body = "";
        for await (const chunk of req) body += chunk;
        config = JSON.parse(body);
      }
      return res.end(JSON.stringify(config));
    }
    if (req.url === "/provider")
      return res.end(
        JSON.stringify({
          all: [
            {
              id: "google",
              name: "Google",
              options: { apiKey: draft.apiKey },
              models: { "fixture-gemini": {} },
            },
            {
              id: "vendor",
              models: {
                main: {
                  api: {
                    npm: "@ai-sdk/openai-compatible",
                    url: "https://vendor.invalid/v1",
                  },
                },
                alternative: {
                  api: {
                    npm: "@ai-sdk/anthropic",
                    url: "https://vendor.invalid/anthropic",
                  },
                },
              },
            },
            { id: "unsupported.id", npm: "@ai-sdk/openai", models: {} },
          ],
          connected: ["google"],
        }),
      );
    res.writeHead(404);
    res.end("{}");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    const settings = opencodeSettings(
      "",
      `http://127.0.0.1:${upstream.address().port}`,
    );
    const initial = await settings.read();
    assert.equal(initial.backend, "opencode");
    assert.equal(
      initial.providers.find((p) => p.id === "google").connected,
      true,
    );
    assert(!JSON.stringify(initial).includes(draft.apiKey));
    assert.equal(
      initial.providers.find((p) => p.id === "vendor").baseUrl,
      "https://vendor.invalid/v1",
    );
    assert(!initial.providers.some((p) => p.id === "unsupported.id"));
    const saved = await settings.save({
      providerId: "google",
      npm: "@ai-sdk/google",
      baseUrl: "",
      modelId: "fixture-gemini",
      apiKey: "native-fixture-key",
    });
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.npm, "@ai-sdk/google");
    assert.equal(config.provider.google.npm, undefined);
    assert.equal(config.model, "google/fixture-gemini");
    assert.deepEqual(config.permission, { bash: "ask" });
    assert.equal(config.provider.company.options.apiKey, draft.apiKey);
    assert.equal(config.provider.google.options.apiKey, "native-fixture-key");
    await settings.save({
      providerId: "vendor",
      npm: "@ai-sdk/openai-compatible",
      baseUrl: "https://vendor.invalid/v1",
      modelId: "alternative",
      apiKey: "vendor-key",
    });
    assert.equal(config.provider.vendor.npm, undefined);
    assert.equal(config.provider.vendor.options.baseURL, undefined);
    assert.equal(config.model, "vendor/alternative");
    assert(!JSON.stringify(saved).includes("native-fixture-key"));
    await settings.save({
      providerId: "google",
      npm: "@ai-sdk/google",
      baseUrl: "",
      modelId: "fixture-gemini",
      apiKey: "",
    });
    assert.equal(config.provider.google.options.apiKey, "native-fixture-key");
    assert(
      calls.some(
        ([method, path]) => method === "PATCH" && path === "/global/config",
      ),
    );
    assert(!calls.some(([, path]) => path === "/config"));
    reject = true;
    await assert.rejects(
      settings.read(),
      (error) => error.status === 502 && !error.message.includes(draft.apiKey),
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("disconnect clears credentials and defaults, preserves other providers, and reconnects explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orx-disconnect-"));
  const file = join(dir, "opencode.json");
  try {
    const settings = opencodeSettings(file);
    await settings.save(draft);
    const config = JSON.parse(await readFile(file, "utf8"));
    config.small_model = "company/small";
    config.provider.other = {
      npm: "@ai-sdk/openai",
      options: { apiKey: "keep-other" },
    };
    config.enabled_providers = ["company", "other"];
    await writeFile(file, JSON.stringify(config));
    await assert.rejects(settings.disconnect({ providerId: "../invalid" }), {
      status: 400,
    });
    await assert.rejects(
      settings.disconnect({ providerId: "company" }, async () => {
        throw Error("audit unavailable");
      }),
    );
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).model,
      "company/org/model",
    );
    const result = await settings.disconnect({ providerId: "company" });
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.provider.company.options.apiKey, "");
    assert.equal(stored.provider.other.options.apiKey, "keep-other");
    assert.equal(stored.model, "");
    assert.equal(stored.small_model, "");
    assert.deepEqual(stored.disabled_providers, ["company"]);
    assert.deepEqual(stored.enabled_providers, ["other"]);
    assert.equal(
      result.providers.find((p) => p.id === "company").connected,
      false,
    );
    assert(!JSON.stringify(result).includes("keep-other"));
    await settings.disconnect({ providerId: "company" });
    await settings.save(draft);
    assert.deepEqual(
      JSON.parse(await readFile(file, "utf8")).disabled_providers,
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native verification uses saved routing, denies tools, redacts failures and cleans up", async () => {
  const { createServer } = await import("node:http");
  let config = {
    model: "company/org/model",
    provider: {
      company: {
        npm: draft.npm,
        options: { apiKey: draft.apiKey },
        models: { "org/model": {} },
      },
    },
  };
  let modelError;
  let calls = [];
  const upstream = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push([req.method, req.url, body]);
    res.setHeader("content-type", "application/json");
    if (req.url === "/global/config") {
      if (req.method === "PATCH") config = body;
      return res.end(JSON.stringify(config));
    }
    if (req.url === "/provider")
      return res.end(JSON.stringify({ all: [], connected: ["company"] }));
    if (req.url === "/session")
      return res.end(JSON.stringify({ id: "ses_verify" }));
    if (req.url.endsWith("/message"))
      return res.end(
        JSON.stringify({
          info: modelError ? { error: modelError } : {},
          parts: modelError ? [] : [{ type: "text", text: "OK" }],
        }),
      );
    res.end("true");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    const settings = opencodeSettings(
      "",
      `http://127.0.0.1:${upstream.address().port}`,
    );
    const result = await settings.verify({
      providerId: "company",
      modelId: "org/model",
    });
    assert.equal(result.ok, true);
    assert(result.checkedAt && result.durationMs >= 0);
    assert.deepEqual(calls.find((c) => c[1] === "/session")[2].permission, [
      { permission: "*", pattern: "*", action: "deny" },
    ]);
    assert.deepEqual(calls.find((c) => c[1].endsWith("/message"))[2].model, {
      providerID: "company",
      modelID: "org/model",
    });
    assert(
      calls.some((c) => c[0] === "DELETE" && c[1] === "/session/ses_verify"),
    );
    for (const [statusCode, code] of [
      [401, "authentication_failed"],
      [404, "model_not_found"],
      [429, "rate_limited"],
      [500, "upstream_error"],
    ]) {
      modelError = {
        name: "APIError",
        data: { statusCode, message: draft.apiKey },
      };
      const failed = await settings.verify({
        providerId: "company",
        modelId: "org/model",
      });
      assert.equal(failed.ok, false);
      assert.equal(failed.code, code);
      assert(!JSON.stringify(failed).includes(draft.apiKey));
    }
    calls = [];
    await assert.rejects(
      settings.verify({ providerId: "company", modelId: "missing" }),
      { status: 400 },
    );
    assert(!calls.some((c) => c[1] === "/session"));
    await settings.disconnect({ providerId: "company" });
    assert(calls.some((c) => c[0] === "DELETE" && c[1] === "/auth/company"));
    assert.equal(
      (await settings.read()).providers.find((p) => p.id === "company")
        .connected,
      false,
    );
    await assert.rejects(
      settings.verify({ providerId: "company", modelId: "org/model" }),
      { status: 400 },
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});
