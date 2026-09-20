// Pipe into the one-off executor image, never run against a personal host.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
assert.equal(
  process.getuid(),
  1000,
  "Expected the dedicated non-root container",
);
const child = spawn(
  "orx",
  ["up", "--no-agent", "--no-browser", "--no-telemetry"],
  { stdio: "ignore" },
);
try {
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch("http://127.0.0.1:4791/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.ok(ready, "Executor health check failed");
  const response = await fetch("http://127.0.0.1:4791/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4791",
    },
    body: JSON.stringify({
      name: "Container smoke",
      path: "/home/node/research/smoke",
      creationMode: "blank",
      createFolder: true,
      requireNewFolder: true,
      initializeGit: true,
      githubSyncEnabled: false,
    }),
  });
  assert.ok(response.ok, `Project creation returned ${response.status}`);
  assert.ok((await response.json()).project.id);
  console.log(
    "Executor container: non-root startup, health and isolated Git project creation passed",
  );
} finally {
  child.kill("SIGTERM");
}
