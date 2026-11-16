import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as research from "../src/research.ts";
import { reconcileFlowNodes } from "../src/flowNodes.ts";
import * as workflowGraph from "../src/workflow/graph.ts";
import { createLiteratureDraft } from "../src/workflow/model.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/ResearchTeamDag.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const mocks = {
  "../api": { fmtTokens: (value) => String(value) },
  "../appBasePath": { appHref: (value) => value },
  "../research": research,
  "../flowNodes": { reconcileFlowNodes },
  "../workflow/graph": workflowGraph,
  "../workflow/SystemNode": { SystemNodeCard: () => null },
  "@xyflow/react": { useNodesState: (nodes) => [nodes, () => {}, () => {}], ReactFlow: () => null, MarkerType: { ArrowClosed: "arrowclosed" } },
  "./ResearchWorkflow": {},
  "./ResearchEvidence": { ResearchEvidence: () => null },
  "./ui": { Button: "button", ButtonLink: "a", IconButton: "button" },
  "../readOnlyApi": { getReadOnlyApi: () => null, projectAssetUrl: url => url },
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


test("the active DAG page exposes the evidence view and renders persisted claims there", () => {
  const evidenceMocks = { ...mocks, react: { ...React, useId: () => "dag", useRef: value => ({ current: value }), useEffect() {}, useMemo: fn => fn(), useState: initial => [initial === "overview" ? "evidence" : typeof initial === "function" ? initial() : initial, () => {}] }, "./ResearchEvidence": { ResearchEvidence: ({ study }) => React.createElement("div", null, `persisted-claim:${study.claims[0].id}`) } };
  const view = {};
  new Function("require", "exports", code)(id => id in evidenceMocks ? evidenceMocks[id] : require(id), view);
  const html = renderToStaticMarkup(React.createElement(view.ResearchTeamDagDialog, { embedded: true, study: { ...study, claims: [{ id: "claim-with-source" }] }, metrics: measured, runs: [], onClose() {} }));
  assert.match(html, /研究证据与原文来源/); assert.match(html, /persisted-claim:claim-with-source/);
  assert.match(html, /aria-pressed="true"[^>]*>证据与来源/);
  assert.doesNotMatch(html, /aria-label="科研专家团流程图"/);
});


test("the active DAG links deliverables only for confirmed studies without active runs", () => {
  const current = { ...study, plans: [{ version: 1, tasks: [] }], deliverySnapshot: { scopeHash: "scope" }, decisions: [{ id: "gate", gate: "G4", version: 1, status: "approved", scopeHash: "scope" }] };
  function render(currentStudy, runs = [], readonly = false) {
    const view = {};
    const isolated = { ...mocks, "../readOnlyApi": { getReadOnlyApi: () => readonly ? {} : null, projectAssetUrl: url => url } };
    new Function("require", "exports", code)(id => id in isolated ? isolated[id] : require(id), view);
    return renderToStaticMarkup(React.createElement(view.ResearchTeamDagDialog, { embedded: true, study: currentStudy, metrics: measured, runs, onClose() {}, onOpenDeliverables() {} }));
  }
  assert.match(render(current), /查看研究成果/);
  assert.doesNotMatch(render(current), /下载已确认研究包/);
  assert.match(render({ ...current, status: "stopped" }), /查看研究成果/);
  assert.doesNotMatch(render(current, [{ id: "old", status: "running" }]), /查看研究成果/);
  assert.doesNotMatch(render(current, [], true), /查看研究成果/);
  assert.doesNotMatch(render({ ...current, decisions: [{ ...current.decisions[0], status: "pending" }] }), /查看研究成果/);
});

test("the W1 task view renders existing plan and task approvals as read-only graph nodes", () => {
  let rendered;
  const tasks = createLiteratureDraft().tasks.map(task => ({ ...task, state: "pending", summary: null, artifacts: [], runIds: [], sessionId: null }));
  tasks[0].state = "completed";
  const current = { ...study, mode: "literature", objective: "Evidence review", claims: [], plans: [{ version: 1, workflow: "literature", tasks }], decisions: [{ gate: "G1", version: 1, status: "pending" }] };
  const graphMocks = {
    ...mocks,
    react: { ...React, useId: () => "dag", useRef: value => ({ current: value }), useEffect() {}, useMemo: fn => fn(), useState: initial => [initial === "overview" ? "tasks" : typeof initial === "function" ? initial() : initial, () => {}] },
    "@xyflow/react": { ...mocks["@xyflow/react"], useReactFlow: () => ({ fitView() {} }), Background: () => null, Controls: () => null, ReactFlow: props => { rendered = props; return null; } },
  };
  const view = {};
  new Function("require", "exports", code)(id => id in graphMocks ? graphMocks[id] : require(id), view);
  const render = () => renderToStaticMarkup(React.createElement(view.ResearchTeamDagDialog, { embedded: true, study: current, metrics: measured, runs: [], onClose() {} }));
  render();
  assert.equal(rendered.nodes.length, 13);
  assert.equal(rendered.deleteKeyCode, null);
  assert.equal(rendered.nodesConnectable, false);
  assert.equal(rendered.nodes.find(node => node.id === workflowGraph.systemNodeIds.scope).data.state, "blocked");
  current.decisions[0].status = "approved";
  current.decisions.push({ gate: `G5:${tasks[0].id}`, version: 1, status: "approved", scope: JSON.stringify({ taskId: tasks[0].id, summary: null, artifacts: [] }) });
  render();
  assert.equal(rendered.nodes.find(node => node.id === workflowGraph.systemNodeIds.scope).data.state, "completed");
  assert.equal(rendered.nodes.find(node => node.id === workflowGraph.approvalNodeId(tasks[0].id)).data.state, "completed");
  assert.ok(rendered.edges.some(edge => edge.source === workflowGraph.approvalNodeId(tasks[0].id) && edge.target === tasks[1].id));
});
