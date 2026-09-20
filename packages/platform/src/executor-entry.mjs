import { spawn } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
// This entrypoint is for a dedicated container; neither API port is published.
await mkdir("/home/node/.runner-state", { recursive: true });
// The previous connector cannot survive a container restart; remove only its lock.
await unlink("/home/node/.runner-state/connector.lock").catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
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
