import {
  readFile,
  writeFile,
  mkdir,
  rename,
  lstat,
  readdir,
  link,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const migrationRequired = () =>
  new Error(
    "Quota mode requires a fresh or explicitly migrated executor HOME; existing credentials were preserved",
  );
async function entry(path) {
  return lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
async function freshHome(home) {
  const parent = await entry(join(home, ".config"));
  if (parent && !parent.isDirectory()) throw migrationRequired();
  const directory = join(home, ".config/opencode");
  const existing = await entry(directory);
  // Fresh Docker volumes inherit this empty directory from the image.
  // Symlinks and any existing contents still require explicit migration.
  if (
    existing &&
    (!existing.isDirectory() || (await readdir(directory)).length)
  )
    throw migrationRequired();
  for (const path of [
    ".local/share/opencode/auth.json",
    ".local/share/opencode/.auth",
  ])
    if (await entry(join(home, path))) throw migrationRequired();
}

// Never delete old credentials as a side effect of enabling quotas.
// An existing executor must be explicitly migrated before opting in.
export async function prepareQuotaExecutor({
  home,
  base,
  secret,
  fetcher = fetch,
}) {
  const marker = join(home, ".quota-model-config");
  const markerEntry = await entry(marker);
  if (markerEntry && !markerEntry.isFile()) throw migrationRequired();
  const managed = await readFile(marker, "utf8").then(
    (v) => v === "v1\n",
    () => false,
  );
  if (markerEntry && !managed) throw migrationRequired();
  if (!managed) await freshHome(home);
  const origin = new URL(base);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("Invalid quota gateway origin");
  const response = await fetcher(
    new URL("/api/platform/runner/model-config", origin),
    {
      headers: { authorization: `Bearer ${secret}` },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw new Error("Quota model configuration unavailable");
  const config = await response.json();
  const providers = config?.enabled_providers;
  if (
    !Array.isArray(providers) ||
    providers.length === 0 ||
    providers.length > 100 ||
    !config.provider ||
    Object.keys(config.provider).length !== providers.length ||
    new Set(providers).size !== providers.length
  )
    throw new Error("Invalid quota model configuration");
  for (const id of providers) {
    const provider = config.provider[id];
    if (
      !provider ||
      provider.npm !== "@ai-sdk/openai-compatible" ||
      !Array.isArray(provider.whitelist) ||
      !provider.models
    )
      throw new Error("Invalid quota model configuration");
    for (const model of Object.values(provider.models)) {
      model.provider = {
        npm: "@ai-sdk/openai-compatible",
        api: new URL("/api/platform/model-gateway/v1", origin).href,
      };
    }
    provider.options = {
      baseURL: new URL("/api/platform/model-gateway/v1", origin).href,
      apiKey: secret,
    };
  }
  const directory = join(home, ".config/opencode");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!managed) await freshHome(home);
  const target = join(directory, "opencode.json"),
    temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(config) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    if (managed) await rename(temporary, target);
    else {
      // Exclusive installation cannot replace credentials created concurrently.
      await link(temporary, target);
      await unlink(temporary);
      await writeFile(marker, "v1\n", { mode: 0o600, flag: "wx" });
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
