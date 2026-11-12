import * as caseArtifacts from "../src/product/caseArtifacts.ts";
import * as runtimeRequest from "../src/runtimeRequest.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { canonicalRequest, createReadOnlyProjectApi } from "../src/readOnlyApi.ts";
import { sha256Hex } from "../src/product/sha256.ts";
import * as security from "../../packages/platform/src/security.mjs";

// Run the actual server validator without loading its database or HTTP dependencies.
const validatorCode = ts.transpileModule(readFileSync(new URL("../../packages/platform/src/featured-cases.mjs", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const validator = {};
new Function("require", "exports", validatorCode)((name) => {
  if (name === "./security.mjs") return security;
  if (name === "node:crypto") return { createHash };
  if (name === "./db.mjs" || name === "./tunnel.mjs") return {};
  throw new Error(`Unexpected validator import: ${name}`);
}, validator);

const code = ts.transpileModule(readFileSync(new URL("../src/product/captureNativeProject.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function("require", "exports", code)((name) => {
  if (name === "../runtimeRequest") return runtimeRequest;
  if (name === "../readOnlyApi") return { canonicalRequest };
  if (name === "./caseArtifacts") return caseArtifacts;
  if (name === "./sha256") return { sha256Hex };
  throw new Error(`Unexpected import: ${name}`);
}, exports);

test("HTTP project capture with uploaded materials passes the server contract and preserves file bytes", async t => {
  const originalFetch = globalThis.fetch;
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const bytes = new TextEncoder().encode("科研成果\n");
  const materialId = "11111111-1111-4111-8111-111111111111";
  const responses = {
    "/api/projects": { projects: [{ id: "p", baselineBranch: "main" }] },
    "/api/chat/sessions?projectId=p": { sessions: [{ id: "s", projectId: "p", harness: "opencode" }] },
    "/api/projects/p/runs": { runs: [] },
    "/api/projects/p/ui-state": { lastTaskId: "s" },
    "/api/settings/ui-state": { workspace: null },
    "/api/projects/activity": { activity: [] },
    "/api/projects/p/files": { dir: "/results", entries: [] },
    "/api/projects/p/code-tree": { path: "/repo", entries: ["report.txt"] },
    "/api/projects/p/code-tree?ref=main": { path: "/repo", entries: ["report.txt"] },
    "/api/projects/p/file?path=report.txt": { content: "科研成果\n" },
    "/api/projects/p/file?path=report.txt&ref=main": { content: "科研成果\n" },
    "/api/chat/sessions/s/messages": { messages: [{ parts: [{ type: "material", text: materialId }] }], queued: [] },
    [`/api/materials/${materialId}`]: { id: materialId, projectId: "p", files: [{ id: "SRC-0001", path: "输入/report.txt", sha256: createHash("sha256").update(bytes).digest("hex") }] },
    "/api/chat/sessions/s/worktree": { exists: false },
    "/api/projects/p/experiments": { experiments: [] },
    "/api/harnesses": {}, "/api/skills?project=p": {},
    "/api/skills?harness=opencode&project=p": {},
    "/api/settings/compute?projectId=p": {}, "/api/research/sessions/s": {},
  };
  const coverage = source => ({ schemaVersion:1, projectId:"p", packageId:materialId, source, session:null, study:null, measuredAt:1, coverage:{groups:[],consideredEvents:0,excluded:{},meaning:"fixture"} });
  responses[`/api/materials/${materialId}/coverage`] = coverage(null);
  responses[`/api/materials/${materialId}/coverage?source=SRC-0001`] = coverage("SRC-0001");
  let missingCoverage = false, failedCoverage = false, changingCoverage = false, timestampOnly = false, rangeCalls = 0;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  globalThis.fetch = async (path) => {
    if (path.startsWith("/api/projects/p/file/raw?") || path === `/api/materials/${materialId}/SRC-0001/download`) return new Response(bytes);
    if (path.includes("/coverage") && missingCoverage) return Response.json({ error:"route not found" },{ status:404 });
    if (path.includes("/coverage") && failedCoverage) return Response.json({ error:"too many" },{ status:400 });
    const key = canonicalRequest(path);
    if ((changingCoverage || timestampOnly) && key === `/api/materials/${materialId}/coverage`) {
      rangeCalls++;
      const value = structuredClone(responses[key]);
      value.measuredAt = rangeCalls;
      if (changingCoverage && rangeCalls > 1) value.coverage.consideredEvents = 1;
      return Response.json(value);
    }

    assert.ok(key in responses, `Unexpected capture request: ${key}`);
    return Response.json(responses[key]);
  };
  try {
    const captured = await exports.captureNativeProject("p");
    const name = `native-${createHash("sha256").update(bytes).digest("hex")}.txt`;
    assert.deepEqual(captured.assets, [{ name, content: Buffer.from(bytes).toString("base64") }]);
    assert.equal(captured.workspace.assets["/api/projects/p/file/raw?path=report.txt"], name);
    assert.equal(captured.workspace.assets["/api/projects/p/file/raw?path=report.txt&ref=main"], name);
    assert.equal(captured.workspace.assets[`/api/materials/${materialId}/SRC-0001/download`], name);
    assert.deepEqual(validator.normalizeNativeWorkspace(captured.workspace), captured.workspace);
    const replay = createReadOnlyProjectApi({ id: "case", base: "", admin: false, workspace: captured.workspace });
    assert.deepEqual(await (await replay.read(`/api/materials/${materialId}`)).json(), responses[`/api/materials/${materialId}`]);
    assert.equal(replay.asset(`/api/materials/${materialId}/SRC-0001/download`), `/api/platform/cases/case/assets?name=${name}`);
    assert.equal((await replay.read("/api/materials/foreign")).status, 404);
    assert.deepEqual(await (await replay.read(`/api/materials/${materialId}/coverage?source=SRC-0001`)).json(), coverage("SRC-0001"));
    await t.test("explicit result selection leaves repository, material originals and intermediate files in the source", async () => {
      const previousFetch = globalThis.fetch;
      const previousStudy = responses["/api/research/sessions/s"];
      const selected = "research/study_s/paper";
      const listing = {scope:"conversation-results",sessionId:"s",dir:"/results",truncated:false,roots:[{path:"research/study_s",title:"Study"}],entries:[{name:"paper",path:selected,isDir:true,size:0,children:[{name:"report.md",path:`${selected}/report.md`,isDir:false,size:bytes.length}]}]};
      const reads = [];
      responses["/api/research/sessions/s"] = {study:{id:"study_s",projectId:"p",sessionId:"s",plans:[]}};
      globalThis.fetch = async (path, init) => {
        reads.push(path);
        if (path.startsWith("/api/projects/p/case-artifacts?")) return Response.json(listing);
        if (path.startsWith("/api/projects/p/files/file?")) return new Response(bytes);
        assert.ok(!/\/code-tree|\/worktree|\/materials\/[^/]+\/[^/]+\/download|\/projects\/p\/file(?:[/?]|$)/.test(path), `private file was requested: ${path}`);
        assert.notEqual(path, "/api/projects/p/files");
        return previousFetch(path, init);
      };
      try {
        const captured = await exports.captureNativeProject("p", undefined, "s", [selected]);
        assert.deepEqual(captured.workspace.fileScope, {kind:"conversation-results",artifactPaths:[selected]});
        assert.equal(captured.assets.length, 1);
        assert.equal(Object.keys(captured.workspace.assets).length, 2);
        assert.ok(captured.workspace.responses[`/api/materials/${materialId}/coverage`]);
        assert.deepEqual(validator.normalizeNativeWorkspace(captured.workspace), captured.workspace);
        for (const change of [
          value => value.fileScope.artifactPaths.push("research/study_other/paper"),
          value => value.assets[`/api/materials/${materialId}/SRC-0001/download`] = captured.assets[0].name,
          value => value.responses["/api/projects/p/code-tree"].entries.push("private.csv"),
          value => delete value.assets[canonicalRequest(`/api/projects/p/files/file?path=${encodeURIComponent(selected + "/report.md")}`)],
        ]) {
          const bad = structuredClone(captured.workspace); change(bad);
          assert.throws(() => validator.normalizeNativeWorkspace(bad));
        }
        reads.length = 0;
        const transcript = await exports.captureNativeProject("p", undefined, "s", []);
        assert.equal(transcript.assets.length, 0);
        assert.deepEqual(transcript.workspace.responses["/api/projects/p/files"].entries, []);
        assert.deepEqual(validator.normalizeNativeWorkspace(transcript.workspace), transcript.workspace);
        assert.equal(reads.some(path => path.startsWith("/api/projects/p/files/file?")), false);
      } finally { globalThis.fetch = previousFetch; responses["/api/research/sessions/s"] = previousStudy; }
    });

    await t.test("old executors preserve missing range snapshots without fabricating zero", async () => {
      missingCoverage = true;
      const legacy = await exports.captureNativeProject("p");
      assert.ok(!(`/api/materials/${materialId}/coverage` in legacy.workspace.responses));
      validator.normalizeNativeWorkspace(legacy.workspace);
      const oldCase = createReadOnlyProjectApi({ id:"old",base:"",admin:false,workspace:legacy.workspace });
      assert.equal((await oldCase.read(`/api/materials/${materialId}/coverage`)).status,404);
      missingCoverage = false;
    });
    await t.test("CLI receipt changes without chat updates invalidate the captured snapshot", async () => {
      changingCoverage = true; rangeCalls = 0;
      await assert.rejects(exports.captureNativeProject("p"), /读取记录发生变化/);
      changingCoverage = false;
    });
    await t.test("a new observation timestamp alone does not invalidate unchanged ranges", async () => {
      timestampOnly = true; rangeCalls = 0;
      validator.normalizeNativeWorkspace((await exports.captureNativeProject("p")).workspace);
      timestampOnly = false;
    });
    await t.test("available but incomplete range snapshots cannot be silently omitted", async () => {
      failedCoverage = true;
      await assert.rejects(exports.captureNativeProject("p"), /未复制完整/);
      failedCoverage = false;
    });

    await t.test("conversation capture excludes an unrelated busy chat and experiment but keeps expert history", async () => {
      const sessionPath = "/api/chat/sessions?projectId=p";
      const originalSessions = structuredClone(responses[sessionPath]);
      const originalStudy = responses["/api/research/sessions/s"];
      responses[sessionPath].sessions.push(
        { id: "expert", projectId: "p", parentSessionId: "s", harness: "opencode", archived: true },
        { id: "other", projectId: "p", harness: "opencode", busy: true },
      );
      responses["/api/research/sessions/s"] = { study: { plans: [{ tasks: [{ sessionId: "expert" }] }] } };
      responses["/api/research/sessions/expert"] = {};
      responses["/api/chat/sessions/expert/messages"] = { messages: [{ parts: [{ type: "text", text: "expert results" }] }], queued: [] };
      responses["/api/chat/sessions/expert/worktree"] = { exists: false };
      responses["/api/projects/p/experiments"] = { experiments: [{ id: "other-exp", chatSessionId: "other" }] };
      responses["/api/projects/p/runs"] = { runs: [{ id: "other-run", experimentId: "other-exp", status: "running" }] };
      const originalFetchForScope = globalThis.fetch;
      let sessionReads = 0;
      globalThis.fetch = async (path, init) => {
        if (path === sessionPath && ++sessionReads % 2 === 0) {
          const latest = structuredClone(responses[sessionPath]);
          latest.sessions.find(session => session.id === "other").updatedAt = Date.now();
          return Response.json(latest);
        }
        return originalFetchForScope(path, init);
      };
      try {
        const scoped = await exports.captureNativeProject("p", undefined, "s");
        assert.equal(scoped.workspace.sourceSessionId, "s");
        assert.equal(scoped.workspace.sessionId, "s");
        assert.deepEqual(scoped.workspace.responses[sessionPath].sessions.map(session => session.id), ["s", "expert"]);
        assert.deepEqual(scoped.workspace.responses["/api/projects/p/experiments"], { experiments: [] });
        assert.deepEqual(scoped.workspace.responses["/api/projects/p/runs"], { runs: [] });
        assert.ok(scoped.workspace.responses["/api/chat/sessions/expert/messages"]);
        assert.equal(Object.keys(scoped.workspace.responses).some(path => path.includes("/other/")), false);
        assert.deepEqual(validator.normalizeNativeWorkspace(scoped.workspace), scoped.workspace);
        const replay = createReadOnlyProjectApi({ id: "single", base: "", admin: false, workspace: scoped.workspace });
        assert.equal((await replay.read("/api/chat/sessions/other/messages")).status, 404);
        responses[sessionPath].sessions[1].busy = true;
        await assert.rejects(exports.captureNativeProject("p", undefined, "s"), /运行中/);
        responses[sessionPath].sessions[1].busy = false;
        responses["/api/chat/sessions/expert/messages"].queued = [{}];
        await assert.rejects(exports.captureNativeProject("p", undefined, "s"), /排队/);
        await assert.rejects(exports.captureNativeProject("p", undefined, "deleted"), /不存在/);
        await assert.rejects(exports.captureNativeProject("p"), /运行中/);
      } finally {
        globalThis.fetch = originalFetchForScope;
        responses[sessionPath] = originalSessions;
        responses["/api/research/sessions/s"] = originalStudy;
        responses["/api/projects/p/experiments"] = { experiments: [] };
        responses["/api/projects/p/runs"] = { runs: [] };
      }
    });

  } finally {
    globalThis.fetch = originalFetch;
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    else delete globalThis.crypto;
  }
});
