import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as model from "../src/workflow/model.ts";
import * as graph from "../src/workflow/graph.ts";
import * as research from "../src/research.ts";
import * as canvasText from "../src/workflow/canvasText.ts";
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/workflow/WorkflowCanvas.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function elements(tree) { return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : []; }
function harness(startDraft = model.createLiteratureDraft(), agents = []) {
  let draft = startDraft, cursor = 0;
  const slots = [], exported = {}, writes = [];
  const state = initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; };
  const mocks = {
    react: { ...React, useState: state, useEffect() {}, useMemo: fn => fn(), useRef: value => state(() => ({ current: value }))[0] },
    "@xyflow/react": { ReactFlow: "Flow", Handle: "Handle", Controls: "Controls", Background: "Background", MarkerType: { ArrowClosed: "arrow" }, Position: { Top: "top", Bottom: "bottom" } },
    "./model": model, "./graph": graph, "./SystemNode": { SystemNodeCard: "SystemNode" }, "../research": research,
    "../components/ui": { Button: "Button", Tooltip: "Tooltip" }, "../components/ui/Switch": { Switch: "Switch" },
    "./canvasText": canvasText, "./canvasNodeTypes": { workflowNodeTypes: {} },
  };
  new Function("require", "exports", code)(id => id in mocks ? mocks[id] : require(id), exported);
  function render() { cursor = 0; return elements(exported.WorkflowCanvas({ draft, agents, onChange: next => { writes.push(next); draft = next; } })); }
  return { render, writes, flow: () => render().find(node => node.type === "Flow").props, draft: () => draft };
}

test("system nodes and edges cannot be deleted; checkpoint edges still edit their original task dependency", () => {
  const h = harness(), original = structuredClone(h.draft().tasks), flow = h.flow();
  assert.ok(flow.nodes.filter(node => node.type === "system").every(node => node.deletable === false && node.connectable === false));
  flow.onNodesChange([{ type: "remove", id: graph.systemNodeIds.scope }]);
  flow.onEdgesChange([{ type: "remove", id: flow.edges.find(edge => !edge.dependency).id }]);
  assert.equal(h.writes.length, 0);
  flow.onEdgesChange([{ type: "remove", id: "search-strategy->literature-discovery" }]);
  assert.deepEqual(h.draft().tasks[1].dependsOn, []);
  assert.deepEqual(h.draft().tasks[0], original[0]);
});

test("clicking a dependency edge selects it for keyboard deletion; system edges only highlight", () => {
  const h = harness(), flow = h.flow();
  const dependencyId = "search-strategy->literature-discovery";
  const systemId = flow.edges.find(edge => !edge.dependency).id;
  // 受控组件必须如实保存选中态：Delete 键靠它才知道要删哪条线。
  flow.onEdgesChange([{ type: "select", id: dependencyId, selected: true }]);
  assert.equal(h.flow().edges.find(edge => edge.id === dependencyId).selected, true);
  flow.onEdgesChange([{ type: "select", id: systemId, selected: true }]);
  assert.equal(h.flow().edges.find(edge => edge.id === systemId).selected, true);
  // 点击别处取消选中：两条线都要回到未选中。
  flow.onEdgesChange([{ type: "select", id: dependencyId, selected: false }, { type: "select", id: systemId, selected: false }]);
  assert.ok(h.flow().edges.every(edge => !edge.selected));
  // 选中依赖线后按 Delete：remove 事件删掉依赖，同时不残留幽灵选中。
  flow.onEdgesChange([{ type: "select", id: dependencyId, selected: true }]);
  flow.onEdgesChange([{ type: "remove", id: dependencyId }]);
  assert.deepEqual(h.draft().tasks[1].dependsOn, []);
  flow.onEdgesChange([{ type: "select", id: systemId, selected: true }]);
  assert.ok(h.flow().edges.filter(edge => edge.selected).every(edge => edge.id === systemId));
});

test("clicking an edge thickens and colors it instead of adding a text label", () => {
  const h = harness();
  const id = "search-strategy->literature-discovery";
  const before = h.flow().edges.find(edge => edge.id === id);
  assert.equal(before.label, undefined);
  assert.equal(before.style?.stroke, undefined);
  h.flow().onEdgesChange([{ type: "select", id, selected: true }]);
  const selected = h.flow().edges.find(edge => edge.id === id);
  // 只加粗变色，不铺文字说明。
  assert.equal(selected.label, undefined);
  assert.equal(selected.style?.stroke, "var(--primary)");
  assert.ok(selected.style?.strokeWidth >= 2);
  // 取消选中后恢复普通线条。
  h.flow().onEdgesChange([{ type: "select", id, selected: false }]);
  const restored = h.flow().edges.find(edge => edge.id === id);
  assert.equal(restored.style?.stroke, undefined);
  assert.equal(restored.label, undefined);
});

test("right-click opens an in-canvas menu: dependency edge offers deletion, system edge explains", () => {
  const h = harness();
  const dependencyEdge = h.flow().edges.find(edge => edge.dependency);
  const systemEdge = h.flow().edges.find(edge => !edge.dependency);
  const prevented = [];
  const fire = (edge) => h.flow().onEdgeContextMenu({ preventDefault: () => prevented.push(edge.id), clientX: 120, clientY: 90 }, edge);
  // 右键实线：拦截浏览器默认菜单，画布内出现「删除连线」。
  fire(dependencyEdge);
  assert.deepEqual(prevented, [dependencyEdge.id]);
  let menu = h.render().find(node => node.props["data-edge-menu"]);
  assert.ok(menu, "菜单应挂在画布容器里");
  assert.equal(menu.props.style.left, 120);
  const item = elements(menu).find(node => node.type === "button");
  assert.equal(item.props.children.at(-1), "删除连线");
  item.props.onClick();
  assert.deepEqual(h.draft().tasks[1].dependsOn, []);
  // 删除后菜单随手收起。
  assert.ok(!h.render().some(node => node.props["data-edge-menu"]));
  // 右键虚线：只解释不可删，不给删除按钮。
  fire(systemEdge);
  menu = h.render().find(node => node.props["data-edge-menu"]);
  assert.ok(menu && !elements(menu).some(node => node.type === "button"), "系统线不给删除按钮");
  const hint = elements(menu).find(node => node.type === "p");
  assert.equal(hint.props.children, "系统约束线，不可删除");
});

test("adding and cancelling a checkpoint only changes requiresApproval, while dragging persists presentation coordinates", () => {
  const h = harness(), before = structuredClone(h.draft().tasks);
  h.flow().onNodesChange([{ type: "select", id: "literature-discovery", selected: true }]);
  h.render().find(node => node.type === "button" && JSON.stringify(node.props.children).includes("任务后人工确认")).props.onClick();
  assert.deepEqual(h.draft().tasks[1], { ...before[1], requiresApproval: true });
  h.flow().onNodesChange([{ type: "position", id: graph.approvalNodeId("literature-discovery"), position: { x: 123, y: -456 } }]);
  assert.deepEqual(h.draft().positions[graph.approvalNodeId("literature-discovery")], { x: 123, y: -456 });
  h.render().find(node => node.type === "Button" && node.props.children === "取消该任务的人工确认").props.onClick();
  assert.deepEqual(h.draft().tasks[1], { ...before[1], requiresApproval: false });
  assert.equal(h.draft().objective, "");
  assert.equal(h.draft().tasks.length, before.length);
});

test("a drag writes the draft once on release, not on every pointer move", () => {
  const h = harness();
  const id = "literature-discovery";
  const before = structuredClone(h.draft().positions);
  const position = () => h.flow().nodes.find(node => node.id === id).position;
  // 拖动过程中 React Flow 连续发 dragging=true 的坐标：节点跟手，但草稿不动。
  h.flow().onNodesChange([{ type: "position", id, position: { x: 10, y: 20 }, dragging: true }]);
  assert.deepEqual(position(), { x: 10, y: 20 });
  h.flow().onNodesChange([{ type: "position", id, position: { x: 30, y: 40 }, dragging: true }]);
  assert.deepEqual(position(), { x: 30, y: 40 });
  assert.deepEqual(h.draft().positions, before);
  assert.equal(h.writes.length, 0);
  // 松手后的最终坐标照常落盘。
  h.flow().onNodesChange([{ type: "position", id, position: { x: 30, y: 40 }, dragging: false }]);
  assert.deepEqual(h.draft().positions[id], { x: 30, y: 40 });
  assert.equal(h.writes.length, 1);
});

test("the editor canvas renders only explicitly added tasks; the fixed chain stays in the run view", () => {
  const editor = { fixedChain: "never" };
  const blank = graph.buildWorkflowGraph([], {}, editor);
  assert.deepEqual(blank.systemNodes, []);
  assert.deepEqual(blank.edges, []);
  const agent = { id: "agent-solo", name: "Solo analyst", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
  const withTask = model.addAgentTask(model.createBlankDraft(), agent);
  const started = graph.buildWorkflowGraph(withTask.tasks, withTask.positions, editor);
  // 点一个专家只加一个节点：固定链路不随任务自动出现，画布零系统节点、零系统连线。
  assert.deepEqual(started.systemNodes, []);
  assert.deepEqual(started.edges, []);
  // 显式开启「完成后需研究负责人确认」才生成检查点节点。
  const gated = { ...withTask, tasks: withTask.tasks.map(task => ({ ...task, requiresApproval: true })) };
  const gatedGraph = graph.buildWorkflowGraph(gated.tasks, gated.positions, editor);
  assert.deepEqual(gatedGraph.systemNodes.map(node => node.id), [graph.approvalNodeId("task-1")]);
  // 运行视图不传开关：始终渲染固定链路。
  assert.equal(graph.buildWorkflowGraph([], {}).systemNodes.length, 3);
});

test("a blank draft keeps the pipeline library visible while the canvas stays empty", () => {
  const h = harness(model.createBlankDraft());
  const flow = h.flow();
  assert.deepEqual(flow.nodes, []);
  assert.deepEqual(flow.edges, []);
  const labels = () => h.render().map(node => JSON.stringify(node.props.children ?? "")).join("\n");
  let text = labels();
  assert.ok(text.includes("阶段分组") && text.includes("G1 · 研究范围确认") && text.includes("G4 · 交付确认"));
  // 研究交付是运行时结果出口，不再是可拖入的节点库条目。
  assert.ok(!text.includes("研究交付"));
  assert.ok(text.includes("从左侧把专家拖到画布上，加入第一个专家"));
  assert.ok(text.includes("专家任务"));
  // 已下线的画布连线提示不再出现。
  assert.ok(!text.includes("点选实线按 Delete 删除"));
  assert.ok(!text.includes("约束线自动生成"));
  // 空画布上从节点库选中固定系统节点：画布无节点可高亮，属性面板仍给出静态说明。
  h.render().find(node => node.type === "button" && JSON.stringify(node.props.children).includes("G1 · 研究范围确认")).props.onClick();
  text = labels();
  assert.ok(text.includes("系统环节 · 运行时执行"));
  assert.ok(text.includes("研究负责人批准当前计划后启动专家任务"));
});

test("agent entries are drag sources; dropping on the canvas adds the dragged agent", () => {
  const agent = { id: "agent-solo", name: "Solo analyst", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
  const h = harness(model.createBlankDraft(), [agent]);
  const entry = h.render().find(node => node.props.draggable && JSON.stringify(node.props.children).includes("Solo analyst"));
  assert.ok(entry, "专家条目应作为拖拽源渲染");
  let transferred = null;
  entry.props.onDragStart({ dataTransfer: { setData: (type, value) => { transferred = { type, value }; }, effectAllowed: "" } });
  assert.deepEqual(transferred, { type: "application/x-orx-agent", value: "agent-solo" });
  const canvas = h.render().find(node => node.props.onDrop);
  assert.ok(canvas, "画布容器应接受拖放");
  const data = { types: ["application/x-orx-agent"], getData: type => (type === "application/x-orx-agent" ? "agent-solo" : ""), dropEffect: "none" };
  canvas.props.onDragOver({ dataTransfer: data, preventDefault() {} });
  assert.ok(h.render().some(node => typeof node.props.className === "string" && node.props.className.includes("border-dashed")), "拖拽悬停时画布应显示落点提示");
  // harness 无真实画布实例（screenToFlowPosition 不可用）：回退自动排位，不因缺落点丢任务。
  canvas.props.onDrop({ dataTransfer: data, preventDefault() {}, clientX: 0, clientY: 0 });
  assert.equal(h.draft().tasks.length, 1);
  assert.equal(h.draft().tasks[0].role, "agent-solo");
  assert.deepEqual(h.draft().positions["task-1"], { x: 0, y: 0 });
  assert.ok(!h.render().some(node => typeof node.props.className === "string" && node.props.className.includes("border-dashed")), "落放后提示应消失");
});

test("placed system nodes render with their constraint edges; unplaced ones stay off", () => {
  const editor = { fixedChain: "never" };
  const agent = { id: "agent-solo", name: "Solo analyst", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
  const withTask = model.addAgentTask(model.createBlankDraft(), agent);
  const placed = { ...withTask.positions, [graph.systemNodeIds.scope]: { x: -200, y: -100 }, [graph.systemNodeIds.delivery]: { x: -200, y: 300 } };
  const placedGraph = graph.buildWorkflowGraph(withTask.tasks, placed, editor);
  assert.deepEqual(placedGraph.systemNodes.map(node => node.id), [graph.systemNodeIds.scope, graph.systemNodeIds.delivery]);
  assert.deepEqual(placedGraph.systemNodes.find(node => node.id === graph.systemNodeIds.scope).position, { x: -200, y: -100 });
  assert.ok(placedGraph.edges.some(edge => edge.source === graph.systemNodeIds.scope && edge.target === "task-1"));
  assert.ok(placedGraph.edges.some(edge => edge.source === "task-1" && edge.target === graph.systemNodeIds.delivery));
  assert.ok(!placedGraph.systemNodes.some(node => node.id === graph.systemNodeIds.output));
  assert.ok(!placedGraph.edges.some(edge => edge.target === graph.systemNodeIds.output));
});

test("dropping a system entry from the library places it; deleting the node removes it", () => {
  const h = harness(model.createBlankDraft());
  const canvas = h.render().find(node => node.type === "div" && node.props.onDrop);
  canvas.props.onDrop({
    preventDefault() {}, clientX: 300, clientY: 200,
    dataTransfer: { types: ["application/x-orx-system-node"], getData: (type) => type === "application/x-orx-system-node" ? graph.systemNodeIds.scope : "" },
  });
  assert.deepEqual(h.draft().positions[graph.systemNodeIds.scope], { x: 0, y: 0 });
  const flow = h.flow();
  assert.ok(flow.nodes.some(node => node.type === "system" && node.id === graph.systemNodeIds.scope));
  const systemNode = flow.nodes.find(node => node.id === graph.systemNodeIds.scope);
  assert.equal(systemNode.deletable, true);
  // 卡片与属性面板都提供删除入口：卡片回调与「从画布移除」按钮都走坐标键移除。
  assert.equal(typeof systemNode.data.onDelete, "function");
  assert.ok(h.render().map(node => JSON.stringify(node.props.children ?? "")).join("\n").includes("从画布移除"));
  systemNode.data.onDelete();
  assert.equal(h.draft().positions[graph.systemNodeIds.scope], undefined);
  // 已撤下后再次删除不产生写入；重新渲染取最新闭包，模拟真实应用的事件间隔。
  const writesBefore = h.writes.length;
  h.flow().onNodesChange([{ type: "remove", id: graph.systemNodeIds.scope }]);
  assert.equal(h.writes.length, writesBefore);
  assert.equal(h.draft().tasks.length, 0);
});

test("route inspector offers a fallback branch for verdicts that can never arrive", () => {
  const agent = { id: "agent-check", name: "Checker", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
  let draft = model.addAgentTask(model.createBlankDraft(), agent);
  draft = { ...draft, tasks: draft.tasks.map((task) => task.id === "task-1" ? { ...task, gateDownstream: true, outputs: ["design.md"] } : task) };
  draft = model.addRouteTask(draft);
  const routeId = draft.tasks.at(-1).id;
  draft = model.connectWorkflowTasks(draft, "task-1", routeId);
  draft = { ...draft, tasks: draft.tasks.map((task) => task.id === routeId ? { ...task, route: { on: "verdict", source: "design.md", verdictIs: "pass" } } : task) };
  const h = harness(draft, [agent]);
  h.flow().onNodesChange([{ type: "select", id: routeId, selected: true }]);
  const fallbackSelect = () => {
    const label = h.render().find((node) => node.type === "label" && Array.isArray(node.props.children) && node.props.children[0] === "上游拿不到结论时走哪条");
    assert.ok(label, "应渲染兜底分支选择");
    return label.props.children[1];
  };
  // 未配置兜底：默认「停在分流节点」，序列化不落盘。
  let select = fallbackSelect();
  assert.equal(select.props.value, "");
  assert.deepEqual(select.props.children.map((option) => option.props.value), ["", "then", "else"]);
  select.props.onChange({ target: { value: "else" } });
  assert.equal(h.draft().tasks.find((task) => task.id === routeId).route.defaultBranch, "else");
  select = fallbackSelect();
  assert.equal(select.props.value, "else");
  // 改回「停在分流节点」：字段清空，不写入配置。
  select.props.onChange({ target: { value: "" } });
  assert.equal(h.draft().tasks.find((task) => task.id === routeId).route.defaultBranch, undefined);
});

test("a fresh canvas fits the whole flow into view but never shrinks nodes below a readable size", () => {
  // 实机暴露的问题：8 节点流程打开时 fitView 把节点缩到 0.2 倍（约 52px 宽），字看不清。
  const fresh = harness({ ...model.createBlankDraft(), viewport: null });
  const fit = fresh.flow();
  assert.equal(fit.fitView, true);
  assert.equal(fit.fitViewOptions.minZoom, 0.55);
  // 自动适配有下限，但用户手动缩放的范围不变：仍能自己缩小看全貌。
  assert.equal(fit.minZoom, 0.2);
  assert.equal(fit.maxZoom, 1.5);
  // 已保存过视口的草稿不再自动适配，沿用用户上次的位置和缩放。
  const saved = harness({ ...model.createBlankDraft(), viewport: { x: 40, y: -60, zoom: 0.9 } });
  const resumed = saved.flow();
  assert.equal(resumed.fitView, false);
  assert.deepEqual(resumed.defaultViewport, { x: 40, y: -60, zoom: 0.9 });
});
