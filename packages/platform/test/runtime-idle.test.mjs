import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { idleProcessProbe } from "../src/runtime-pool.mjs";

function unknownProcesses(extra = []) {
  const processes = [
    [1, "tini", ["/sbin/tini", "--", "node", "src/executor-entry.mjs"]],
    [2, "node", ["node", "src/executor-entry.mjs"]],
    [3, "node", ["node", "src/runner.mjs"]],
    [4, "orx", ["orx", "up", "--no-browser"]],
    [5, "opencode", ["opencode", "serve", "--port", "4970"]],
    [100, "python3", ["python3", "-c", "probe"]],
    [101, "node", ["node", "-e", "probe parent"]],
    ...extra,
  ];
  const files = Object.fromEntries(
    processes.flatMap(([pid, name, args]) => [
      [`/proc/${pid}/comm`, name],
      [`/proc/${pid}/cmdline`, args.join("\0") + "\0"],
    ]),
  );
  const script = `import os,io,json,builtins
files=json.loads(${JSON.stringify(JSON.stringify(files))})
os.listdir=lambda path: ${JSON.stringify(processes.map(([pid]) => String(pid)))}
os.getpid=lambda: 100
os.getppid=lambda: 101
builtins.open=lambda path,mode='r': io.BytesIO(files[path].encode()) if 'b' in mode else io.StringIO(files[path])
${idleProcessProbe}
print(unknown)`;
  return Number(execFileSync("python3", ["-c", script], { encoding: "utf8" }));
}

test("known idle services and the probe itself allow suspension", () => {
  assert.equal(unknownProcesses(), 0);
});
for (const [name, args] of [
  ["node", ["node", "long-experiment.mjs"]],
  ["python3", ["python3", "experiment.py"]],
  ["orx", ["orx", "materials", "read"]],
  ["codex", ["codex", "exec", "research"]],
  ["claude", ["claude", "-p", "research"]],
]) {
  test(`detached ${name} work prevents suspension even outside the task ledger`, () => {
    assert.equal(unknownProcesses([[200, name, args]]), 1);
  });
}
