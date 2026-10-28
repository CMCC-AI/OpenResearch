import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { materialTree, materialLink, materialKind, materialLines, materialUrl } from "../src/materialReader.ts";

const file = (id, path, format = "text", content = "内容") => {
  const bytes = Buffer.from(content);
  return { id, path, format, status: "ready", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};

test("material folders preserve hierarchy and distinguish equal basenames", () => {
  const first = file("one", "项目/文献/论文.md");
  const second = file("two", "项目/草稿/论文.md");
  const root = materialTree([file("root", "README.md"), second, first]);
  assert.equal(root[0].kind, "folder");
  assert.equal(root[0].name, "项目");
  assert.equal(root[1].file.id, "root");
  const leaves = root[0].children.flatMap(folder => folder.children);
  assert.deepEqual(new Set(leaves.map(node => node.file.id)), new Set(["one", "two"]));
  assert.throws(() => materialTree([file("bad", "../outside.md")]), /无效路径/);
  assert.throws(() => materialTree([file("bad", "/outside.md")]), /无效路径/);
});

test("material references decode Chinese paths once and never escape their package", () => {
  const current = file("one", "资料/方案.md");
  const target = file("two", "资料/数据/结果.csv");
  const files = [current, target];
  assert.equal(materialLink(files, current, "%E6%95%B0%E6%8D%AE/%E7%BB%93%E6%9E%9C.csv#table"), target);
  for (const path of ["../../host.txt", "file:///etc/passwd", "/资料/方案.md", "https://example.com/paper", "bad%ZZ", "#section"]) assert.equal(materialLink(files, current, path), null);
  assert.equal(materialUrl("pack/id", "SRC/1", "preview"), "/api/materials/pack%2Fid/SRC%2F1/preview");
});

test("reader respects detected formats and keeps exact source line numbers", () => {
  assert.equal(materialKind(file("one", "paper.txt", "pdf")), "pdf");
  assert.equal(materialKind(file("two", "说明.MD")), "markdown");
  assert.equal(materialKind(file("three", "index.html")), "text");
  assert.equal(materialKind(file("four", "sheet.xlsx", "binary")), "unsupported");
  assert.deepEqual(materialLines("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(materialLines("\n"), [""]);
  assert.deepEqual(materialLines(""), []);
});

let source = await readFile(new URL("../src/materialPreview.ts", import.meta.url), "utf8");
source = source.replace('import { getReadOnlyApi, projectAssetUrl, projectRequest } from "./readOnlyApi";', 'const getReadOnlyApi = () => globalThis.materialPreviewTransport.readOnly; const projectAssetUrl = url => globalThis.materialPreviewTransport.asset(url); const projectRequest = (...args) => globalThis.materialPreviewTransport.read(...args);');
source = source.replace(/from "([^"]+)"/g, (_match, path) => `from "${path.startsWith(".") ? new URL(`../src/${path.endsWith(".ts") ? path : `${path}.ts`}`, import.meta.url).href : import.meta.resolve(path)}"`);
const { loadMaterialPreview } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

test("preview validates the recorded version and propagates cancellation", async () => {
  const input = file("source", "资料/说明.md");
  const calls = [];
  globalThis.materialPreviewTransport = { readOnly: null, read: async (url, init) => { calls.push([url, init]); return new Response("内容"); } };
  const controller = new AbortController();
  const result = await loadMaterialPreview("pack", input, controller.signal);
  assert.equal(result.content, "内容");
  assert.equal(calls[0][0], "/api/materials/pack/source/preview");
  assert.equal(calls[0][1].signal, controller.signal);
  globalThis.materialPreviewTransport.read = async () => new Response("损坏");
  await assert.rejects(loadMaterialPreview("pack", input, controller.signal), /版本不一致/);
  globalThis.materialPreviewTransport.read = async () => { controller.abort(); return new Response("内容"); };
  await assert.rejects(loadMaterialPreview("pack", input, controller.signal), { name: "AbortError" });
});

test("oversized and unsupported files make no preview request", async () => {
  globalThis.materialPreviewTransport = { readOnly: null, read: () => { throw new Error("must not fetch"); } };
  await assert.rejects(loadMaterialPreview("pack", { ...file("big", "large.txt"), size: 1024 * 1024 + 1 }, new AbortController().signal), /1 MiB/);
  await assert.rejects(loadMaterialPreview("pack", file("book", "book.xlsx", "binary"), new AbortController().signal), /暂不支持/);
});

test("published cases load original snapshot assets without private API fallback", async () => {
  const input = file("source", "说明.md");
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.materialPreviewTransport = { readOnly: {}, asset: url => { seen.push(url); return "https://case.invalid/original.txt"; }, read: () => { throw new Error("must not query private executor"); } };
  globalThis.fetch = async url => { assert.equal(url, "https://case.invalid/original.txt"); return new Response("内容"); };
  try {
    assert.equal((await loadMaterialPreview("case-pack", input, new AbortController().signal)).content, "内容");
    assert.deepEqual(seen, ["/api/materials/case-pack/source/download"]);
  } finally { globalThis.fetch = originalFetch; }
});
