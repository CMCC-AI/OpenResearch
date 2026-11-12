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
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
