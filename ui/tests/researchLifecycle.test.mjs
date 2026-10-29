import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as research from "../src/research.ts";

const require = createRequire(import.meta.url);
const file = ts.createSourceFile("ResearchPanel.tsx", readFileSync(new URL("../src/components/ResearchPanel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = file.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(file).replace(/^export /, "")).join("\n");
const code = ts.transpileModule(`${declarations}\nexports.Panel = ResearchPanel;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function setup({ status = "active", readOnly = false, failure = null, disabled = false } = {}) {
  const buttons = [], calls = [], errors = [];
  let refetches = 0;
  const study = { id: "study", sessionId: "lead", mode: "team", status, plans: [{ version: 7, tasks: [], summary: "scope" }], decisions: [], claims: [] };
  const bindings = {
    ...research, require,
    useState: initial => [initial, value => { if (typeof value === "string") errors.push(value); }],
    useReadOnlyWorkspace: () => readOnly,
    workspaceKey: (...values) => values,
    useQuery: () => ({ data: { study, runs: [] }, isPending: false, error: null, refetch: async () => { refetches++; } }),
    Button: ({ children, size: _size, ...props }) => { buttons.push({ ...props, children }); return React.createElement("button", props, children); },
    ResearchTeamDagDialog: ({ confirmationContent }) => React.createElement("div", null, confirmationContent),
    ResearchModulePreview: () => null,
    endResearchStudy: async (...args) => { calls.push(args); if (failure) throw new Error(failure); },
  };
  const exports = {};
  new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
  const html = renderToStaticMarkup(React.createElement(exports.Panel, { sessionId: "lead", placement: "pane", disabled }));
  return { html, buttons, calls, errors, get refetches() { return refetches; } };
}

test("research panel explicitly ends the displayed version and refetches persisted status", async () => {
  const app = setup();
  assert.match(app.html, /不会批准交付或取消实验/);
  assert.match(app.html, /结束后不能继续修订本轮计划/);
  const button = app.buttons.find(button => button.children === "确认结束研究");
  assert.equal(button.disabled, false);
  button.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(app.calls, [["study", 7]]);
  assert.equal(app.refetches, 1);
});

test("ending failures remain visible without claiming the study was stopped", async () => {
  const app = setup({ failure: "仍有未结束的实验" });
  app.buttons.find(button => button.children === "确认结束研究").onClick();
  await new Promise(setImmediate);
  assert.deepEqual(app.errors, ["仍有未结束的实验"]);
  assert.equal(app.refetches, 0);
});

test("ended and read-only studies offer no end action and busy controls stay disabled", () => {
  for (const options of [{ status: "stopped" }, { readOnly: true }]) {
    const app = setup(options);
    assert.ok(!app.buttons.some(button => button.children === "确认结束研究"));
    if (options.status) assert.match(app.html, /本轮研究已结束，历史记录继续保留/);
  }
  const app = setup({ disabled: true });
  assert.equal(app.buttons.find(button => button.children === "确认结束研究").disabled, true);
});
