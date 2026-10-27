import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { canonicalRequest } from "../src/readOnlyApi.ts";
import { sha256Hex } from "../src/product/sha256.ts";

const code = ts.transpileModule(readFileSync(new URL("../src/product/captureNativeProject.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function("require", "exports", code)((name) => {
  if (name === "../readOnlyApi") return { canonicalRequest };
  if (name === "./sha256") return { sha256Hex };
  throw new Error(`Unexpected import: ${name}`);
}, exports);

test("HTTP project capture preserves file bytes and deduplicates matching SHA-256 assets", async () => {
  const originalFetch = globalThis.fetch;
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const bytes = new TextEncoder().encode("科研成果\n");
  const responses = {
    "/api/projects": { projects: [{ id: "p", baselineBranch: "main" }] },
    "/api/chat/sessions?projectId=p": { sessions: [{ id: "s", harness: "opencode" }] },
    "/api/projects/p/runs": { runs: [] },
    "/api/projects/p/ui-state": { lastTaskId: "s" },
    "/api/settings/ui-state": { workspace: null },
    "/api/projects/activity": { activity: [] },
    "/api/projects/p/files": { dir: "/results", entries: [] },
    "/api/projects/p/code-tree": { path: "/repo", entries: ["report.txt"] },
    "/api/projects/p/code-tree?ref=main": { path: "/repo", entries: ["report.txt"] },
    "/api/projects/p/file?path=report.txt": { content: "科研成果\n" },
    "/api/projects/p/file?path=report.txt&ref=main": { content: "科研成果\n" },
    "/api/chat/sessions/s/messages": { messages: [], queued: [] },
    "/api/chat/sessions/s/worktree": { exists: false },
    "/api/projects/p/experiments": { experiments: [] },
    "/api/harnesses": {}, "/api/skills?project=p": {},
    "/api/skills?harness=opencode&project=p": {},
    "/api/settings/compute?projectId=p": {}, "/api/research/sessions/s": {},
  };
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  globalThis.fetch = async (path) => {
    if (path.startsWith("/api/projects/p/file/raw?")) return new Response(bytes);
    const key = canonicalRequest(path);
    assert.ok(key in responses, `Unexpected capture request: ${key}`);
    return Response.json(responses[key]);
  };
  try {
    const captured = await exports.captureNativeProject("p");
    const name = `native-${createHash("sha256").update(bytes).digest("hex")}.txt`;
    assert.deepEqual(captured.assets, [{ name, content: Buffer.from(bytes).toString("base64") }]);
    assert.equal(captured.workspace.assets["/api/projects/p/file/raw?path=report.txt"], name);
    assert.equal(captured.workspace.assets["/api/projects/p/file/raw?path=report.txt&ref=main"], name);
  } finally {
    globalThis.fetch = originalFetch;
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    else delete globalThis.crypto;
  }
});
