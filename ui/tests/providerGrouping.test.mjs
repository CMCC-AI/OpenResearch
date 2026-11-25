import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadProviderLogoModule() {
  const code = ts.transpileModule(
    readFileSync(new URL("../src/components/ProviderLogo.tsx", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } },
  ).outputText;
  const exports = {};
  const customRequire = (specifier) => {
    if (specifier === "./ui/cn") return { cn: (...parts) => parts.filter(Boolean).join(" ") };
    return require(specifier);
  };
  new Function("require", "exports", code)(customRequire, exports);
  return exports;
}

function loadApiModelHelpers() {
  const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  const sf = ts.createSourceFile("api.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = new Set([
    "MODEL_DISPLAY_ALIASES",
    "resolveModelDisplayAlias",
    "harnessModelLabel",
    "modelLabel",
  ]);
  const snippets = sf.statements
    .filter((node) => {
      if (ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text)) return true;
      if (ts.isVariableStatement(node)) {
        return node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && wanted.has(d.name.text));
      }
      return false;
    })
    .map((node) => node.getText(sf))
    .join("\n\n");

  const code = ts.transpileModule(snippets, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const mMock = { local_models_custom_endpoint: () => "Custom Endpoint" };
  new Function("exports", "m", code)(exports, mMock);
  return exports;
}

test("jt236b model displays as jiutian-236b in harnessModelLabel and modelLabel", () => {
  const { harnessModelLabel, modelLabel } = loadApiModelHelpers();

  assert.equal(harnessModelLabel({ id: "jt236b/jt236b", displayName: "jt236b" }), "jiutian-236b");
  assert.equal(harnessModelLabel({ id: "jt236b/jt236b" }), "jiutian-236b");
  assert.equal(harnessModelLabel({ id: "jiutian/jt236b", displayName: "jt236b" }), "jiutian-236b");
  assert.equal(modelLabel("jt236b/jt236b"), "jiutian-236b");
  assert.equal(modelLabel("jt236b"), "jiutian-236b");
  assert.equal(harnessModelLabel({ id: "moonshotai-cn/kimi-k3", displayName: "Kimi K3" }), "Kimi K3");
});

test("groupModelsByProvider groups models by supplier and renders SVG logos", () => {
  const { groupModelsByProvider, ProviderLogo } = loadProviderLogoModule();

  const models = [
    { id: "moonshotai-cn/kimi-k3.1-pro", displayName: "Kimi K3.1 Pro" },
    { id: "moonshotai-cn/kimi-k3", displayName: "Kimi K3" },
    { id: "jt236b/jt236b", displayName: "jt236b" },
    { id: "deepseek/deepseek-chat", displayName: "DeepSeek Chat" },
    { id: "orx-local-1/qwen", displayName: "Qwen · Ollama" },
    { id: "acme-ai/custom-1", displayName: "Custom 1" },
  ];

  const groups = groupModelsByProvider(models);
  assert.deepEqual(
    groups.map((g) => ({ key: g.key, label: g.label, count: g.models.length })),
    [
      { key: "moonshot", label: "Kimi / Moonshot", count: 2 },
      { key: "jiutian", label: "九天 Jiutian", count: 1 },
      { key: "deepseek", label: "DeepSeek", count: 1 },
      { key: "local", label: "本地模型", count: 1 },
      { key: "other", label: "Acme Ai", count: 1 },
    ],
  );

  for (const group of groups) {
    const svg = renderToStaticMarkup(React.createElement(ProviderLogo, { providerKey: group.key }));
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /aria-hidden="true"/);
  }
});
