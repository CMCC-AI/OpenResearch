import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedOpenCodeNpmCache } from "../src/opencode-npm-cache.mjs";

test("cache seed supports existing HOME volumes without replacing cache data", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-cache-"));
  try {
    const source = join(root, "seed");
    const home = join(root, "home");
    const cache = join(home, ".npm");
    await mkdir(source, { recursive: true });
    await mkdir(join(cache, "_cacache"), { recursive: true });
    await writeFile(join(source, "existing"), "seed");
    await writeFile(join(source, "plugin"), "public package");
    await writeFile(join(cache, "_cacache", "existing"), "personal cache");
    await seedOpenCodeNpmCache({ home, source, cache });
    await seedOpenCodeNpmCache({ home, source, cache });
    assert.equal(
      await readFile(join(cache, "_cacache", "existing"), "utf8"),
      "personal cache",
    );
    assert.equal(
      await readFile(join(cache, "_cacache", "plugin"), "utf8"),
      "public package",
    );
    await seedOpenCodeNpmCache({ home, source: join(root, "missing"), cache });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
