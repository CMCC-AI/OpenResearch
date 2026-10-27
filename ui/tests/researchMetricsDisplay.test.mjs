import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as research from "../src/research.ts";
import { reconcileFlowNodes } from "../src/flowNodes.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/ResearchTeamDag.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const mocks = {
  "../api": { fmtTokens: (value) => String(value) },
  "../appBasePath": { appHref: (value) => value },
  "../research": research,
  "../flowNodes": { reconcileFlowNodes },
  "@xyflow/react": { useNodesState: (nodes) => [nodes, () => {}, () => {}], ReactFlow: () => null, MarkerType: { ArrowClosed: "arrowclosed" } },
  "./ResearchWorkflow": {},
  "./ui": { Button: "button", IconButton: "button" },
  "./useDialogFocus": { useDialogFocus() {} },
  "./ResearchTeamDag.css": {},
};
const exported = {};
new Function("require", "exports", code)((id) => id in mocks ? mocks[id] : require(id), exported);
const study = { id: "study", mode: "team", status: "active", plans: [], decisions: [] };
const measured = { activeDurationMs: 62000, activeDurationComplete: true, tokenCount: 12345, tokenCountComplete: true, measuredAt: Date.now(), running: false };
function stats(metrics, currentStudy = study) {
  const html = renderToStaticMarkup(React.createElement(exported.ResearchTeamDagDialog, { embedded: true, study: currentStudy, metrics, runs: [], onClose() {} }));
  return html.slice(html.indexOf("<dl"), html.indexOf("</dl>"));
}

test("a service without metrics differs from a study with unrecorded history", () => {
  assert.match(stats(undefined), /暂不可用/);
  assert.match(stats(undefined), /更新服务后重试/);
  const historical = stats({ ...measured, activeDurationMs: null, tokenCount: null });
  assert.match(historical, /未记录/);
  assert.match(historical, /未上报/);
  assert.doesNotMatch(historical, /暂不可用/);
});

test("measured and partial values remain visible while an unstarted study shows zero", () => {
  assert.match(stats(measured), /1分02秒/);
  assert.match(stats(measured), /12345/);
  const partial = stats({ ...measured, activeDurationComplete: false, tokenCountComplete: false });
  assert.match(partial, /≥1分02秒/);
  assert.match(partial, /≥12345/);
  assert.match(stats(undefined, null), /0分00秒/);
  assert.doesNotMatch(stats(undefined, null), /暂不可用|未记录|未上报/);
});
