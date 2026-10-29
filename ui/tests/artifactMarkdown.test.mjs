import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import ts from "typescript";
import { resolveMarkdownTarget } from "../src/markdownTarget.ts";
import { normalizeMarkdownForRendering } from "../src/markdownNormalization.ts";

const source = ts.createSourceFile("ArtifactsTab.tsx", readFileSync(new URL("../src/components/ArtifactsTab.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const api = ts.createSourceFile("api.ts", readFileSync(new URL("../src/api.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let artifactUrl;
function findUrl(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(api) === "artifactUrl") artifactUrl = node.initializer.getText(api);
  ts.forEachChild(node, findUrl);
}
findUrl(api);
const names = new Set(["isExternalSrc", "artifactTarget", "stripFrontmatter", "findArtifactEntry", "ArtifactMarkdown"]);
const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(source).replace(/^export /, "")).join("\n");
const code = ts.transpileModule(`const artifactUrl = ${artifactUrl};\n${declarations}\nexports.render = ArtifactMarkdown; exports.target = artifactTarget;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports = {};
const bindings = { useMemo: React.useMemo, useRef: React.useRef, ReactMarkdown, remarkGfm, remarkMath, rehypeKatex, remarkMathOptions: {}, mdCodeComponents: {},
  normalizeMarkdownForRendering, resolveMarkdownTarget,
  projectAssetUrl: value => value,
};
new Function("require", "exports", ...Object.keys(bindings), code)(name => { assert.equal(name, "react/jsx-runtime"); return jsx; }, exports, ...Object.values(bindings));
const render = (markdown, folder = "reports", entries = []) => renderToStaticMarkup(React.createElement(exports.render, { projectId: "project", folder, markdown, entries }));
const urls = html => [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => new URL(match[1].replaceAll("&amp;", "&"), "http://localhost"));

test("artifact Markdown resolves Chinese and reserved filenames through the real renderer and file URL builder", () => {
  for (const [link, filename] of [["结果.md", "结果.md"], ["结果%20汇总.md", "结果 汇总.md"], ["chart%231.png", "chart#1.png"], ["a%3Fb.png", "a?b.png"], ["chart%25231.png", "chart%231.png"]]) {
    const targets = urls(render(`[报告](${link})\n\n![图](${link})`));
    assert.ok(targets.length >= 3);
    for (const target of targets) assert.equal(target.searchParams.get("path"), `reports/${filename}`, link);
  }
});

test("artifact links retain version lookup, query and fragment without allowing path override", () => {
  const targets = urls(render("[报告](结果.md?path=outside&download=1#summary)", "reports", [{ path: "reports/结果.md", modifiedAt: 17, size: 12, isDir: false }]));
  assert.equal(targets.length, 1);
  const target = targets[0];
  assert.deepEqual(target.searchParams.getAll("path"), ["reports/结果.md"]);
  assert.equal(target.searchParams.get("download"), "1"); assert.equal(target.searchParams.get("v"), "17:12"); assert.equal(target.hash, "#summary");
  assert.equal(exports.target("project", "reports/100%done", "a%2525.md").path, "reports/100%done/a%25.md");
});

test("artifact paths reject invalid encoding and encoded root escape while external links and anchors stay usable", () => {
  for (const link of ["../../private.txt", "..%2F..%2Fprivate.txt", "%00.png", "%E0%A4%A"]) assert.equal(exports.target("project", "reports", link), null, link);
  assert.equal(exports.target("project", "reports/sub", "../图.png").path, "reports/图.png");
  assert.equal(exports.target("project", "reports", "/图.png").path, "图.png");
  const targets = urls(render("[网页](https://example.com/结果) [小节](#summary)"));
  assert.equal(targets[0].origin, "https://example.com"); assert.equal(targets[1].hash, "#summary");
  assert.ok(!render("[无效](..%2F..%2Fprivate.txt)").includes("<a "));
});
