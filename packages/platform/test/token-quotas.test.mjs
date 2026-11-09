import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quotaConfiguration,
  nativeUsage,
  publicModelConfig,
  loadQuotaModels,
} from "../src/model-gateway.mjs";
import { runtimeConfig, reconcile } from "../src/provisioner.mjs";
import { prepareQuotaExecutor } from "../src/quota-executor-config.mjs";

test("quota policy defaults to two million per month and validates opt-in", () => {
  assert.equal(quotaConfiguration({}).monthlyTokens, 2000000);
  assert.equal(quotaConfiguration({}).enabled, false);
  assert.throws(() => quotaConfiguration({ TOKEN_QUOTAS_ENABLED: "true" }));
  for (const n of ["-1", "1.2", "NaN", "9007199254740992"])
    assert.throws(() =>
      quotaConfiguration({ TOKEN_QUOTA_DEFAULT_MONTHLY_TOKENS: n }),
    );
});
test("provider usage includes cached and reasoning subsets only once; unknown is not zero", () => {
  assert.equal(
    nativeUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }),
    13,
  );
  for (const u of [
    undefined,
    {},
    { prompt_tokens: 10 },
    { prompt_tokens: 1, completion_tokens: -1 },
    { prompt_tokens: 2, completion_tokens: 1, total_tokens: 30 },
  ])
    assert.equal(nativeUsage({ usage: u }), null);
  assert.equal(
    nativeUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    0,
  );
});
test("quota executors never mount provider credentials and cannot reuse old runtimes", async () => {
  const workspace = "11111111-1111-4111-8111-111111111111";
  const env = {
    MANAGED_EXECUTOR_IMAGE: "executor:test",
    PLATFORM_ORIGIN: "http://localhost:5300",
    TOKEN_QUOTAS_ENABLED: "true",
    MANAGED_OPENCODE_LIVE_CONFIG_DIR: "/secrets/live",
    MANAGED_OPENCODE_CONFIG_DIR: "/secrets/seed",
    MANAGED_OPENCODE_CONFIG_FILE: "/secrets/provider.json",
    MANAGED_OPENCODE_AUTH_FILE: "/secrets/auth.json",
  };
  const config = runtimeConfig(workspace, env);
  assert.deepEqual(config.HostConfig.Binds, [
    `orx-managed-${workspace}:/home/node`,
  ]);
  assert.ok(config.Env.includes("TOKEN_QUOTAS_ENABLED=true"));
  assert.throws(() =>
    runtimeConfig(workspace, { ...env, MANAGED_LEGACY_WORKSPACE: workspace }),
  );
  let mutations = 0;
  await assert.rejects(
    reconcile(
      { query: async () => {} },
      { workspace_id: workspace, desired: "running" },
      env,
      async (method) => {
        if (method !== "GET") mutations++;
        return {
          Config: { Labels: config.Labels, Env: [] },
          State: { Running: true },
        };
      },
    ),
    /migrated/,
  );
  assert.equal(mutations, 0);
});
test("executor bootstrap exposes only user gateway credentials and preserves old files", async () => {
  const home = await mkdtemp(join(tmpdir(), "quota-home-"));
  const models = [
    {
      id: "research",
      model: "private-upstream",
      apiKey: "UPSTREAM_SECRET",
      baseUrl: "https://provider.invalid/v1",
      contextTokens: 100,
      maxOutputTokens: 10,
    },
  ];
  const payload = publicModelConfig(models, "", "user-gateway-secret");
  assert.ok(!JSON.stringify(payload).includes("UPSTREAM_SECRET"));
  assert.ok(!JSON.stringify(payload).includes("private-upstream"));
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { ok: true, json: async () => structuredClone(payload) };
  };
  try {
    await prepareQuotaExecutor({
      home,
      base: "http://platform:5300",
      secret: "user-key",
      fetcher,
    });
    const cfg = JSON.parse(
      await readFile(join(home, ".config/opencode/opencode.json")),
    );
    assert.equal(
      cfg.provider.mobilesci.options.baseURL,
      "http://platform:5300/api/platform/model-gateway/v1",
    );
    assert.equal(cfg.provider.mobilesci.options.apiKey, "user-key");
    await prepareQuotaExecutor({
      home,
      base: "http://platform:5300",
      secret: "new-key",
      fetcher,
    });
    assert.match(
      await readFile(join(home, ".config/opencode/opencode.json"), "utf8"),
      /new-key/,
    );
    const old = join(home, "old-home");
    await mkdir(join(old, ".config/opencode"), { recursive: true });
    await writeFile(
      join(old, ".config/opencode/opencode.json"),
      "original-secret",
    );
    await assert.rejects(
      prepareQuotaExecutor({
        home: old,
        base: "http://platform:5300",
        secret: "other",
        fetcher,
      }),
      /credentials were preserved/,
    );
    assert.equal(
      await readFile(join(old, ".config/opencode/opencode.json"), "utf8"),
      "original-secret",
    );
    assert.equal(calls, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("model registry requires trusted bounds and never accepts redirect credentials in URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-registry-"));
  const file = join(dir, "models.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        models: [
          {
            id: "a",
            model: "b",
            apiKey: "key",
            baseUrl: "https://user:pass@example.com/v1",
            contextTokens: 10,
            maxOutputTokens: 3,
          },
        ],
      }),
    );
    await assert.rejects(loadQuotaModels(file), /地址无效/);
    await writeFile(file, "{}");
    await assert.rejects(loadQuotaModels(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
