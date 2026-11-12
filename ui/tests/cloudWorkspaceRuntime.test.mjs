import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import * as jsx from "react/jsx-runtime";
import ts from "typescript";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/product/CloudWorkspace.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function render(context, error = null) {
  const states = [context, error];
  const exports = {};
  const modules = {
    react: { ...React, useState: () => [states.shift(), () => {}], useEffect() {} },
    "react/jsx-runtime": jsx,
    "./PersonalResearchGate": { PersonalResearchGate: "background-runtime" },
    "../components/ui": { Spinner: "Spinner" },
  };
  new Function("require", "exports", "location", code)(name => modules[name], exports, { hostname: "00000000-0000-0000-0000-000000000001.example.invalid", origin: "https://workspace.example.invalid", protocol: "https:", host: "00000000-0000-0000-0000-000000000001.example.invalid" });
  return exports.CloudWorkspace({ children: "workspace" });
}

test("the legacy private subdomain shows its workspace while compute is offline", () => {
  const tree = render({ online: false, privateSpaces: true });
  assert.equal(tree.type, "background-runtime");
  assert.equal(tree.props.children, "workspace");
  assert.equal(tree.props.endpoint, "/_platform/activity");
});

test("a self-managed workspace has no executor status interstitial or additional header", () => {
  assert.equal(render({ online: false, privateSpaces: false }), "workspace");
});

test("identity loading stays neutral and genuine permission errors remain visible", () => {
  const loading = render(null);
  assert.equal(loading.props.children.type, "Spinner");
  assert.equal(render(null, "Permission changed").props.children[0].props.role, "alert");
});
