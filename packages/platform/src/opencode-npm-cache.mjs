import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Merge only public package cache data, never config/auth or project files.
export async function seedOpenCodeNpmCache({
  home,
  source = "/opt/opencode-npm-cache/_cacache",
  cache = process.env.npm_config_cache,
}) {
  if (!home) throw new Error("Executor HOME is required");
  const baseCache = cache || join(home, ".npm");
  const destination = join(baseCache, "_cacache");
  await mkdir(destination, { recursive: true });
  try {
    const sourceStat = await stat(source);
    const stampPath = join(baseCache, ".orx-seed-stamp");
    const nextStamp = `${sourceStat.ino}:${sourceStat.mtimeMs}\n`;
    const previousStamp = await readFile(stampPath, "utf8").catch(() => null);
    if (previousStamp === nextStamp) return;
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    await writeFile(stampPath, nextStamp, { mode: 0o600 }).catch(() => {});
  } catch (error) {
    // Older images may not yet include a seed; retain online installation.
    if (error.code !== "ENOENT") throw error;
  }
}
