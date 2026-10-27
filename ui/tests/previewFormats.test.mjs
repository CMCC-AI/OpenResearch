import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { zipSync, gzipSync, strToU8 } from "fflate";
import { inferFilePresentation, structuredPreviewKind } from "../src/filePreview.ts";
import { decodePreviewText, readPreviewResponse } from "../src/previewText.ts";
import { floatingMenuPlacement } from "../src/floatingMenu.ts";
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/structuredPreview.ts", import.meta.url), "utf8");
const exports = {};
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)((id) => id === "./previewText" ? { decodePreviewText } : require(id), exports);
const { parseDelimited, zipDirectory, parseStructuredFile } = exports;

test("common formats have consistent extension fallbacks when server metadata is unavailable", () => {
  for (const [path, expected] of [["material_audit.MD", "text"], ["study.ipynb", "text"], ["data.tsv", "text"], ["plot.SVG", "image"], ["movie.mp4", "video"], ["speech.flac", "audio"], ["paper.pdf", "pdf"], ["unknown.dat", "unknown"]]) assert.equal(inferFilePresentation(path), expected);
  assert.equal(inferFilePresentation("no-extension", "text/plain; charset=utf-8"), "text");
  for (const extension of ["docx", "odt", "xlsx", "xlsm", "ods", "pptx", "odp", "zip", "tar", "tgz", "gz", "csv", "tsv", "ipynb"]) assert.ok(structuredPreviewKind(`file.${extension}`));
  for (const extension of ["doc", "xls", "ppt", "7z", "rar"]) assert.equal(structuredPreviewKind(`file.${extension}`), null);
});

test("preview decoding distinguishes Unicode text, a truncated character and real binary", () => {
  assert.equal(decodePreviewText(strToU8("# 中文报告")).content, "# 中文报告");
  const utf16 = Uint8Array.from([0xff, 0xfe, 0x23, 0, 0x20, 0, 0x2d, 0x4e]);
  assert.equal(decodePreviewText(utf16).content, "# 中");
  assert.equal(decodePreviewText(Uint8Array.from([0xfe, 0xff, 0, 0x23])).content, "#");
  assert.equal(decodePreviewText(Uint8Array.from([0, 1, 2])).binary, true);
  assert.equal(decodePreviewText(Uint8Array.from([0xff, 2])).binary, true);
  assert.equal(decodePreviewText(Uint8Array.from([65, 0xe4, 0xb8]), true).content, "A");
});

test("raw file responses that ignore Range remain bounded", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(strToU8("123456789")); }, cancel() { cancelled = true; } }));
  const result = await readPreviewResponse(response, 4);
  assert.equal(new TextDecoder().decode(result.bytes), "1234");
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test("table preview handles quoted separators, multiline cells and escaped quotes", () => {
  assert.deepEqual(parseDelimited('a,b\r\n"x,y","line1\nline2"\r\n"a""b",=1+1'), [["a", "b"], ["x,y", "line1\nline2"], ['a"b', "=1+1"]]);
  assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t"), [["a", "b"], ["1", "2"]]);
  assert.equal(parseDelimited("a\n".repeat(2000)).length, 1000);
  assert.equal(parseDelimited("a,".repeat(200)).at(0).length, 100);
});

test("ZIP preview lists entries without extracting or executing them", () => {
  const bytes = zipSync({ "report.md": strToU8("# report"), "../do-not-extract.sh": strToU8("exit 1") });
  assert.deepEqual(zipDirectory(bytes).map((entry) => entry.name), ["report.md", "../do-not-extract.sh"]);
  assert.equal(parseStructuredFile(bytes, "archive.zip").entries[0].size, 8);
  assert.throws(() => zipDirectory(bytes.subarray(0, bytes.length - 2)), /目录/);
  const tooLarge = zipSync({ "word/document.xml": new Uint8Array(4 * 1024 * 1024 + 1) });
  assert.throws(() => parseStructuredFile(tooLarge, "large.docx"), /超过/);
});

test("gzip and notebook previews do not execute embedded content", () => {
  assert.equal(parseStructuredFile(gzipSync(strToU8("abc")), "notes.txt.gz").entries[0].size, 3);
  const notebook = strToU8(JSON.stringify({ cells: [{ cell_type: "code", source: ["print(1)"], outputs: [{ data: { "text/html": "<script>throw 1</script>", "text/plain": ["1"] } }] }] }));
  const result = parseStructuredFile(notebook, "analysis.ipynb");
  assert.deepEqual(result.sections.map((section) => section.text), ["print(1)", "1"]);
  assert.throws(() => parseStructuredFile(strToU8("{}"), "bad.ipynb"), /单元格/);
});

test("model menus avoid the workspace header and fit narrow viewports", () => {
  const above = floatingMenuPlacement({ top: 400, bottom: 432, right: 700 }, { width: 900, height: 600 }, 72);
  assert.equal(above.bottom, 208);
  assert.equal(above.maxHeight, 320);
  const below = floatingMenuPlacement({ top: 100, bottom: 132, right: 310 }, { width: 320, height: 600 }, 72);
  assert.equal(below.top, 140);
  assert.ok(below.left >= 8 && below.left + below.width <= 312);
  assert.equal(below.maxHeight, 400);
});

test("spoofed ZIP sizes do not bypass Office expansion limits", () => {
  const bytes = zipSync({ "word/document.xml": strToU8("x".repeat(100_000)) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let central = -1;
  for (let index = 0; index < bytes.length - 46; index++) if (view.getUint32(index, true) === 0x02014b50) { central = index; break; }
  assert.ok(central >= 0);
  view.setUint32(central + 24, 1, true);
  assert.throws(() => parseStructuredFile(bytes, "spoof.docx"), /超过|不一致/);
});
