import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(
  readFileSync(new URL("../src/deleteSession.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function load(study, calls) {
  const exports = {};
  const api = {
    deleteChatSession: async (id, personal) => { calls.push(["delete", id, personal]); return { ok: true }; },
    endResearchStudy: async (id, version) => { calls.push(["end", id, version]); return { ok: true }; },
    getResearchStudy: async (id, _signal, personal) => { calls.push(["study", id, personal]); return { study }; },
  };
  new Function("require", "exports", code)((name) => name === "./api" ? api : require(name), exports);
  return exports;
}

test("a blocked delete ends the active study before deleting the session", async () => {
  const calls = [];
  const mod = load({ id: "study", status: "active", plans: [{ version: 3 }] }, calls);
  assert.equal(mod.researchBlocksSessionDelete("这个对话关联的研究还没结束；请先结束本轮研究，再删除对话。"), true);
  assert.equal(mod.researchBlocksSessionDelete("会话工作区正在迁移，请完成后再删除"), false);
  await mod.deleteSessionEndingResearch("session");
  assert.deepEqual(calls, [["study", "session", false], ["end", "study", 3], ["delete", "session", false]]);
});

test("a personal-space delete keeps its scope after ending research", async () => {
  const calls = [];
  const mod = load({ id: "study", status: "active", plans: [] }, calls);
  await mod.deleteSessionEndingResearch("session", true);
  assert.deepEqual(calls, [["study", "session", true], ["end", "study", 0], ["delete", "session", true]]);
});

test("a session without a study retries the original delete instead of inventing an end", async () => {
  const calls = [];
  const mod = load(null, calls);
  await mod.deleteSessionEndingResearch("session");
  assert.deepEqual(calls, [["study", "session", false], ["delete", "session", false]]);
});
