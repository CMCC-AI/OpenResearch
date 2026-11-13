import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { quotaModelSettings } from "../src/quota-model-settings.mjs";
import { loadQuotaModels, publicModelConfig } from "../src/model-gateway.mjs";
import { configuration, createPlatform } from "../src/server.mjs";
import { hash } from "../src/security.mjs";

const model = {
  id: "kimi",
  providerId: "moonshotai-cn",
  name: "Kimi",
  model: "kimi-test",
  baseUrl: "https://example.invalid/v1",
  apiKey: "secret-upstream-key",
  contextTokens: 262144,
  maxOutputTokens: 8192,
  headers: { "x-private": "secret-header" },
  opencode: { reasoning: true, tool_call: true },
};
test("quota model edits preserve private metadata, default routing, accounting limits and reject stale writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-admin-"));
  const file = join(dir, "models.json");
  try {
    await writeFile(
      file,
      JSON.stringify({ extra: true, models: [model, { ...model, id: "glm" }] }),
    );
    const settings = quotaModelSettings(file);
    let state = await settings.read();
    assert(!JSON.stringify(state).includes("secret-"));
    assert.equal(state.models[0].hasApiKey, true);
    const before = await readFile(file, "utf8");
    for (const change of [
      { contextTokens: 0 },
      { maxOutputTokens: 300000 },
      { baseUrl: "https://user:key@example.com" },
      { opencode: { apiKey: "leak" } },
      { apiKey: "{env:KEY}" },
      { npm: "@ai-sdk/anthropic" },
    ]) {
      await assert.rejects(
        settings.save({
          ...state.models[0],
          ...change,
          revision: state.revision,
        }),
        { status: 400 },
      );
      assert.equal(await readFile(file, "utf8"), before);
    }
    await assert.rejects(
      settings.save(
        { ...state.models[0], revision: state.revision },
        async () => {
          throw Error("audit offline");
        },
      ),
    );
    assert.equal(await readFile(file, "utf8"), before);
    const stale = state.revision;
    state = await settings.save({
      ...state.models[0],
      apiKey: "",
      name: "Updated Kimi",
      revision: state.revision,
    });
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.extra, true);
    assert.equal(stored.models[0].apiKey, model.apiKey);
    assert.deepEqual(stored.models[0].headers, model.headers);
    assert.deepEqual(stored.models[0].opencode, model.opencode);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(settings.remove({ id: "glm", revision: stale }), {
      status: 409,
    });
    state = await settings.default({ id: "glm", revision: state.revision });
    assert.equal(
      publicModelConfig(
        await loadQuotaModels(file),
        "http://platform",
        "runner-only",
      ).model,
      "moonshotai-cn/glm",
    );
    state = await settings.remove({ id: "glm", revision: state.revision });
    assert.equal(state.models[0].id, "kimi");
    await assert.rejects(
      settings.remove({ id: "kimi", revision: state.revision }),
      { status: 400 },
    );
    const results = await Promise.allSettled([
      settings.save({ ...model, id: "one", revision: state.revision }),
      settings.save({ ...model, id: "two", revision: state.revision }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.status,
      409,
    );
    assert(!JSON.stringify(await settings.read()).includes("secret-"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quota-mode HTTP configuration requires administrator and trusted origin, writes actual gateway catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-admin-http-"));
  const file = join(dir, "models.json");
  let admin = false;
  const audits = [];
  const pool = {
    async end() {},
    async query(sql, args) {
      if (sql.includes("SELECT s.*,u.email"))
        return {
          rows:
            args[0] === hash("session")
              ? [{ user_id: "test", is_admin: admin }]
              : [],
        };
      if (sql.includes("auth_limits")) return { rows: [{ attempts: 1 }] };
      if (sql.includes("audit_events")) {
        audits.push(args);
        return { rows: [] };
      }
      throw Error("Unexpected database write");
    },
  };
  await writeFile(file, JSON.stringify({ models: [model] }));
  const config = configuration({
    DATABASE_URL: "postgres://unused",
    PLATFORM_ORIGIN: "http://localhost:5300",
    TOKEN_QUOTAS_ENABLED: "true",
    PRIVATE_USER_SPACES: "true",
    MANAGED_EXECUTORS: "true",
    TOKEN_QUOTA_MODELS_FILE: file,
  });
  const app = await createPlatform(config, pool);
  try {
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    config.origin = new URL(`http://localhost:${app.server.address().port}`);
    const url = `${config.origin.origin}/api/platform/admin/opencode`;
    const request = (method, data, origin = config.origin.origin) =>
      fetch(url, {
        method,
        headers: {
          cookie: "orx_session=session",
          origin,
          "content-type": "application/json",
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await request("GET")).status, 403);
    assert.equal((await request("POST", model)).status, 403);
    admin = true;
    assert.equal(
      (await request("POST", model, "https://evil.invalid")).status,
      403,
    );
    const loaded = await request("GET");
    assert.equal(loaded.status, 200);
    const state = await loaded.json();
    assert.equal(state.backend, "quota");
    const saved = await request("POST", {
      ...state.models[0],
      revision: state.revision,
      maxOutputTokens: 4096,
    });
    assert.equal(saved.status, 200);
    assert(!(await saved.text()).includes(model.apiKey));
    assert.equal((await loadQuotaModels(file))[0].maxOutputTokens, 4096);
    assert.equal(audits.length, 1);
    assert(!JSON.stringify(audits).includes(model.apiKey));
    assert.equal((await request("POST", { action: "disconnect" })).status, 400);
    assert.equal(
      (await request("POST", { ...model, revision: state.revision })).status,
      409,
    );
    const savedState = await (await request("GET")).json();
    const connected = await request("POST", {
      action: "connectProvider",
      providerId: "deepseek",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "secret-deepseek-key",
      revision: savedState.revision,
    });
    assert.equal(connected.status, 200);
    const connectedBody = await connected.json();
    assert(!JSON.stringify(connectedBody).includes("secret-deepseek-key"));
    assert.ok(
      connectedBody.providers.some(
        (p) => p.id === "deepseek" && p.hasApiKey === true,
      ),
    );
    const enabledSecond = await request("POST", {
      id: "deepseek-chat",
      name: "DeepSeek V3",
      providerId: "deepseek",
      providerName: "DeepSeek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      contextTokens: 65536,
      maxOutputTokens: 8192,
      opencode: { tool_call: true },
      revision: connectedBody.revision,
    });
    assert.equal(enabledSecond.status, 200);
    const afterEnable = await enabledSecond.json();
    assert.equal(afterEnable.models.length, 2);
    const disconnected = await request("POST", {
      action: "disconnectProvider",
      providerId: "deepseek",
      revision: afterEnable.revision,
    });
    assert.equal(disconnected.status, 200);
    const afterDisconnect = await disconnected.json();
    assert.equal(afterDisconnect.models.length, 1);
    assert.ok(!afterDisconnect.providers.some((p) => p.id === "deepseek"));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("quota provider connection, sibling key inheritance, model probing and provider disconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-provider-"));
  const file = join(dir, "models.json");
  try {
    await writeFile(file, JSON.stringify({ models: [model] }));
    const calls = [];
    const settings = quotaModelSettings(file, {
      async fetcher(url, init) {
        calls.push({ url, headers: init.headers });
        return {
          ok: true,
          async json() {
            return {
              data: [{ id: "kimi-k2.6" }, { id: "kimi-k3" }],
            };
          },
        };
      },
    });
    let state = await settings.read();
    assert.equal(state.providers.length, 1);
    assert.equal(state.providers[0].id, "moonshotai-cn");
    assert.equal(state.providers[0].hasApiKey, true);

    // Enable a second model under moonshotai-cn without re-entering apiKey
    state = await settings.save({
      id: "kimi-k3",
      name: "Kimi K3",
      providerId: "moonshotai-cn",
      providerName: "Kimi / Moonshot",
      model: "kimi-k3",
      baseUrl: "https://example.invalid/v1",
      apiKey: "",
      contextTokens: 262144,
      maxOutputTokens: 16384,
      opencode: { reasoning: true, tool_call: true },
      revision: state.revision,
    });
    const storedAfterSibling = JSON.parse(await readFile(file, "utf8"));
    assert.equal(storedAfterSibling.models.length, 2);
    assert.equal(storedAfterSibling.models[1].apiKey, model.apiKey);
    assert.deepEqual(storedAfterSibling.models[1].headers, model.headers);

    // Probe models using stored provider/model apiKey when request apiKey is empty
    const probed = await settings.probeModels({
      providerId: "moonshotai-cn",
      baseUrl: "https://example.invalid/v1/",
      apiKey: "",
    });
    assert.deepEqual(probed.models, ["kimi-k2.6", "kimi-k3"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.invalid/v1/models");
    assert.equal(
      calls[0].headers.authorization,
      `Bearer ${model.apiKey}`,
    );

    // Reject disconnecting the only remaining provider
    await assert.rejects(
      settings.disconnectProvider({
        providerId: "moonshotai-cn",
        revision: state.revision,
      }),
      { status: 400 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
