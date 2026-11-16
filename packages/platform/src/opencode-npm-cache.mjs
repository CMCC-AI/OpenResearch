import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Merge only public package cache data, never config/auth or project files.
export async function seedOpenCodeNpmCache({
  home,
  source = "/opt/opencode-npm-cache/_cacache",
  cache = process.env.npm_config_cache,
}) {
  if (!home) throw new Error("Executor HOME is required");
  const destination = join(cache || join(home, ".npm"), "_cacache");
  await mkdir(destination, { recursive: true });
  try {
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  } catch (error) {
    // Older images may not yet include a seed; retain online installation.
    if (error.code !== "ENOENT") throw error;
  }
}
