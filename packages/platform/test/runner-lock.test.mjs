import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireRunnerLock } from "../src/runner-lock.mjs";

test(
  "runner ownership is exclusive, reusable and released after forced process death",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orx-runner-lock-"));
    const url = new URL("../src/runner-lock.mjs", import.meta.url).href;
    const code = `import {acquireRunnerLock} from ${JSON.stringify(url)}; await acquireRunnerLock(${JSON.stringify(directory)});console.log('ready');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw Error("Lock owner exited before readiness");
        }),
      ]);
      await assert.rejects(acquireRunnerLock(directory), /Another executor/);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const release = await acquireRunnerLock(directory);
      release();
      release();
      const next = await acquireRunnerLock(directory);
      next();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("legacy lock is never silently removed during a mixed-version upgrade", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orx-legacy-lock-"));
  try {
    await writeFile(join(directory, "connector.lock"), "");
    await assert.rejects(acquireRunnerLock(directory), /Legacy connector.lock/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
