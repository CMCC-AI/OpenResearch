// Dedicated connector for the preserved original owner's research instance.
import { mkdir, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
await mkdir("/home/node/.runner-state", { recursive: true });
await unlink("/home/node/.runner-state/connector.lock").catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
const child = spawn(process.execPath, ["src/runner.mjs"], { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
