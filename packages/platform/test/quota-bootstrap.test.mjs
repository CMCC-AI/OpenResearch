import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareQuotaExecutor } from "../src/quota-executor-config.mjs";
const payload = () => ({
  enabled_providers: ["test"],
  provider: {
    test: {
      npm: "@ai-sdk/openai-compatible",
      whitelist: ["model"],
      models: { model: {} },
    },
  },
});
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "quota-bootstrap-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
const options = (
  home,
  fetcher = async () => ({ ok: true, json: async () => payload() }),
) => ({
  home,
  base: "http://platform:5300",
  secret: "synthetic-runner-secret",
  fetcher,
});
test("fresh Docker HOME with an empty image-provided config directory boots in quota mode", async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  await prepareQuotaExecutor(options(home));
  const target = join(home, ".config/opencode/opencode.json");
  const config = JSON.parse(await readFile(target, "utf8"));
  assert.equal(config.provider.test.options.apiKey, "synthetic-runner-secret");
  assert.equal(
    config.provider.test.options.baseURL,
    "http://platform:5300/api/platform/model-gateway/v1",
  );
  assert.equal(
    await readFile(join(home, ".quota-model-config"), "utf8"),
    "v1\n",
  );
  if (process.platform !== "win32")
    assert.equal((await stat(target)).mode & 0o777, 0o600);
});
for (const path of [
  ".config/opencode/opencode.jsonc",
  ".config/opencode/unknown.txt",
  ".local/share/opencode/auth.json",
  ".local/share/opencode/.auth",
  ".quota-model-config",
]) {
  test(`unmarked existing ${path} is preserved and never fetched over`, async (t) => {
    const home = await fixture(t);
    const file = join(home, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "legacy-content");
    let called = false;
    await assert.rejects(
      prepareQuotaExecutor(
        options(home, async () => {
          called = true;
          throw Error("must not fetch");
        }),
      ),
      /credentials were preserved/,
    );
    assert.equal(called, false);
    assert.equal(await readFile(file, "utf8"), "legacy-content");
  });
}
for (const path of [
  ".config",
  ".config/opencode",
  ".local/share/opencode/auth.json",
  ".quota-model-config",
]) {
  test(`symlink at ${path} cannot make HOME look fresh`, async (t) => {
    const home = await fixture(t);
    const outside = await fixture(t);
    const file = join(home, path);
    await mkdir(join(file, ".."), { recursive: true });
    await symlink(
      path.endsWith("auth.json") ? join(outside, "missing") : outside,
      file,
      "dir",
    );
    await assert.rejects(
      prepareQuotaExecutor(options(home)),
      /credentials were preserved/,
    );
    assert.deepEqual(await readdir(outside), []);
  });
}
test("credentials appearing while configuration is fetched are never replaced", async (t) => {
  const home = await fixture(t);
  const directory = join(home, ".config/opencode");
  await mkdir(directory, { recursive: true });
  const target = join(directory, "opencode.json");
  await assert.rejects(
    prepareQuotaExecutor(
      options(home, async () => {
        await writeFile(target, "concurrent-credentials");
        return { ok: true, json: async () => payload() };
      }),
    ),
    /credentials were preserved/,
  );
  assert.equal(await readFile(target, "utf8"), "concurrent-credentials");
  assert.deepEqual(await readdir(directory), ["opencode.json"]);
  await assert.rejects(readFile(join(home, ".quota-model-config")), {
    code: "ENOENT",
  });
});
test("a failed gateway response leaves fresh HOME unmarked and empty", async (t) => {
  const home = await fixture(t);
  const directory = join(home, ".config/opencode");
  await mkdir(directory, { recursive: true });
  await assert.rejects(
    prepareQuotaExecutor(options(home, async () => ({ ok: false }))),
    /unavailable/,
  );
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(readFile(join(home, ".quota-model-config")), {
    code: "ENOENT",
  });
});
