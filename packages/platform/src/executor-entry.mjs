import { spawn } from "node:child_process";
import { mkdir, unlink, cp, access } from "node:fs/promises";
// This entrypoint is for a dedicated container; neither API port is published.
await mkdir("/home/node/.runner-state", { recursive: true });
// The previous connector cannot survive a container restart; remove only its lock.
await unlink("/home/node/.runner-state/connector.lock").catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
// Seed settings once into this user's writable home; never overwrite personal data.
if (process.env.MANAGED_CONFIG_SEED_DIR) {
  const destination = "/home/node/.config/opencode";
  const configured = await Promise.any([
    access(`${destination}/opencode.json`),
    access(`${destination}/opencode.jsonc`),
  ]).then(
    () => true,
    () => false,
  );
  if (!configured)
    await cp(process.env.MANAGED_CONFIG_SEED_DIR, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
}
if (process.env.MANAGED_AUTH_SEED_FILE) {
  const destination = "/home/node/.local/share/opencode/auth.json";
  const exists = await access(destination).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await mkdir("/home/node/.local/share/opencode", { recursive: true });
    await cp(process.env.MANAGED_AUTH_SEED_FILE, destination, { force: false });
  }
}
const orx = spawn("orx", ["up", "--no-browser", "--no-telemetry"], {
  stdio: "inherit",
});
let connector;
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  connector?.kill("SIGTERM");
  orx.kill("SIGTERM");
  setTimeout(() => process.exit(1), 5000).unref();
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
orx.on("exit", stop);
try {
  for (let n = 0; n < 60; n++) {
    if (stopped) throw new Error("OpenResearch exited");
    try {
      const response = await fetch("http://127.0.0.1:4791/api/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {}
    if (n === 59) throw new Error("OpenResearch did not become ready");
    await new Promise((done) => setTimeout(done, 1000));
  }
  connector = spawn(process.execPath, ["src/runner.mjs"], { stdio: "inherit" });
  connector.on("exit", stop);
} catch {
  stop();
}
