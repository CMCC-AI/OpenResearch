import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const text = readFileSync(new URL("../src/components/SettingsPage.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("SettingsPage.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ManagedStorageTab");
const compiled = ts.transpileModule(`export ${component.getText(source)}`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function render(canInspect, result) {
  let options;
  const exports = {};
  const icon = () => null;
  new Function("require", "exports", "useQuery", "m", "SETTINGS_CARD_CLASS_NAME", "KV_CLASS_NAME", "LoadingRow", "Spinner", "RefreshCw", compiled)(
    require, exports, (value) => { options = value; return result; },
    new Proxy({}, { get: (_, key) => () => String(key) }), "card", "kv",
    ({ children }) => React.createElement("div", null, children), icon, icon,
  );
  const html = renderToStaticMarkup(React.createElement(exports.ManagedStorageTab, { canInspect, accountUrl: "https://research.example", userId: "user-1" }));
  return { html, options };
}

test("ordinary users never fetch or render a physical storage path", () => {
  const { html, options } = render(false, { data: { current: "/private/research" } });
  assert.equal(options.enabled, false);
  assert.match(html, /storage_managed_title/);
  assert.doesNotMatch(html, /private|<input|<form|<button/);
});

test("administrators have a read-only location and a refresh action", () => {
  const { html, options } = render(true, { data: { current: "/server/research" } });
  assert.equal(options.enabled, true);
  assert.deepEqual(options.queryKey, ["managedStorage", "https://research.example", "user-1"]);
  assert.match(html, /\/server\/research/);
  assert.match(html, /settings_page_refresh/);
  assert.doesNotMatch(html, /<input|<form/);
});

test("an expired administrator permission hides stale data and raw error HTML", () => {
  const { html } = render(true, { isError: true, data: { current: "/private/research" }, error: new Error("<html>nginx</html>") });
  assert.match(html, /storage_managed_unavailable/);
  assert.doesNotMatch(html, /private|nginx|&lt;html/);
});
