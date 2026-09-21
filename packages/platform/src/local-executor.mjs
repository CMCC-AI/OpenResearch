import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platformDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDir = resolve(platformDir, "../..");
const orxBin = resolve(
  process.env.ORX_BIN || resolve(repositoryDir, "target/release/orx"),
);

if (!process.env.ORX_DATA_DIR || !process.env.RUNNER_STATE_DIR) {
  throw new Error("Set ORX_DATA_DIR and RUNNER_STATE_DIR for this workspace");
}
await access(orxBin, constants.X_OK).catch(() => {
  throw new Error(
    `OpenResearch binary not found at ${orxBin}; run cargo build --release --locked`,
  );
});

const children = new Set();
let stopping = false;
const start = (command, args, cwd) => {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
};
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 5000).unref();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));

const orx = start(orxBin, ["up", "--no-browser"], repositoryDir);
orx.once("exit", (code) => stop(code || 1));
const healthUrl = new URL(
  "/api/health",
  process.env.ORX_UPSTREAM || "http://127.0.0.1:4791",
);

for (let attempt = 0; attempt < 60; attempt++) {
  if (stopping) throw new Error("OpenResearch exited before becoming ready");
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) break;
  } catch {}
  if (attempt === 59) {
    stop(1);
    throw new Error("OpenResearch did not become ready within 60 seconds");
  }
  await new Promise((done) => setTimeout(done, 1000));
}

const runner = start(process.execPath, ["src/runner.mjs"], platformDir);
runner.once("exit", (code) => stop(code || 1));
