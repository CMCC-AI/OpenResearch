import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { readPreviewResponse } from "../src/previewText.ts";
import { projectRequest, installReadOnlyApi, createReadOnlyProjectApi } from "../src/readOnlyApi.ts";

const hash = value => createHash("sha256").update(value).digest("hex");
const content = "2: <script>不会执行</script>🙂\n";
export const citation = { readEventId: "event", packageId: "package", source: "SRC-0001", path: "资料/结果.txt", sha256: hash("original"), format: "text", page: null, offset: 2, lineCount: 1, contentBytes: Buffer.byteLength(content), contentSha256: hash(content), readerSessionId: "reader", readerStudyId: "study", readerPlanVersion: 1 };
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/materialCitation.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exported = {};
const mocks = { "./readOnlyApi": { projectRequest }, "./previewText": { readPreviewResponse }, "@noble/hashes/sha2.js": { sha256: value => createHash("sha256").update(value).digest() }, "@noble/hashes/utils.js": { bytesToHex: value => Buffer.from(value).toString("hex") } };
new Function("require", "exports", code)(id => mocks[id] ?? require(id), exported);
const { loadMaterialCitation, citationUrl, citationRange } = exported;
const signal = () => new AbortController().signal;
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function withFetch(fake, run) { const original = globalThis.fetch; globalThis.fetch = fake; try { await run(); } finally { globalThis.fetch = original; } }

test("citation viewer verifies exact source, UTF-8 length and content hash with bounded no-store GET", async () => {
  const calls = [];
  await withFetch(async (...args) => { calls.push(args); return response({ citation, content }); }, async () => {
    assert.equal(await loadMaterialCitation(citation, signal()), content);
  });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], citationUrl(citation)); assert.equal(calls[0][1].cache, "no-store");
  assert.equal(citationUrl({ ...citation, packageId: "p/a", source: "SRC/1", readEventId: "e?x" }), "/api/materials/p%2Fa/SRC%2F1/citations/e%3Fx");
  assert.equal(citationRange(citation), "第 2–2 行");
  assert.equal(citationRange({ ...citation, format: "pdf", page: 3 }), "第 3 页 · 第 2–2 行");
  assert.match(citationRange({ ...citation, format: "notebook" }), /Notebook 只读视图/);
});

test("citation viewer refuses identity, page and body changes without substituting a download", async () => {
  for (const field of ["readEventId", "packageId", "source", "path", "sha256", "offset", "lineCount", "page", "readerSessionId", "readerStudyId", "readerPlanVersion"]) {
    let calls = 0;
    await withFetch(async () => { calls++; return response({ citation: { ...citation, [field]: "other" }, content }); }, async () => {
      await assert.rejects(loadMaterialCitation(citation, signal()), /来源与声明引用不一致/);
    }); assert.equal(calls, 1);
  }
  for (const changed of [content + "extra", content.replace("不会", "伪造")]) {
    await withFetch(async () => response({ citation, content: changed }), async () => { await assert.rejects(loadMaterialCitation(citation, signal()), /哈希不一致/); });
  }
});

test("citation viewer caps responses and preserves auth, missing-resource and overload failures", async () => {
  let cancelled = false;
  await withFetch(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel() { cancelled = true; } })), async () => {
    await assert.rejects(loadMaterialCitation(citation, signal()), /超过允许范围/);
  }); assert.equal(cancelled, true);
  for (const status of [403, 404, 429]) {
    let calls = 0;
    await withFetch(async () => { calls++; return response({ error: `blocked-${status}` }, status); }, async () => { await assert.rejects(loadMaterialCitation(citation, signal()), new RegExp(`blocked-${status}`)); });
    assert.equal(calls, 1);
  }
  await withFetch(async () => new Response("<html>old backend shell</html>"), async () => { await assert.rejects(loadMaterialCitation(citation, signal()), /后端版本/); });
});

test("read-only cases never fall through to the viewer's private executor", async () => {
  const api = createReadOnlyProjectApi({ id: "case", base: "https://example.invalid", admin: false, workspace: { projectId: "case-project", sessionId: "case-session", assets: {}, responses: {} } });
  const remove = installReadOnlyApi(api);
  try {
    await withFetch(async () => { throw new Error("private fetch must not run"); }, async () => { await assert.rejects(loadMaterialCitation(citation, signal()), /副本中没有该资源/); });
  } finally { remove(); }
});

test("invalid references and aborted requests never publish a selection", async () => {
  for (const invalid of [{ lineCount: 0 }, { contentBytes: 65537 }, { page: 2 }, { format: "pdf", page: 0 }]) {
    await withFetch(async () => { throw new Error("unexpected request"); }, async () => { await assert.rejects(loadMaterialCitation({ ...citation, ...invalid }, signal()), /来源信息不完整/); });
  }
  const controller = new AbortController();
  await withFetch(async () => { controller.abort(); return response({ citation, content }); }, async () => { await assert.rejects(loadMaterialCitation(citation, controller.signal), error => error.name === "AbortError"); });
});
