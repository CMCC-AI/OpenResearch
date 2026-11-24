import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { createLiteratureDraft, generatedToDraftInput, layeredPositions, searchWorkflows } from "../src/workflow/model.ts";
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/workflow/WorkflowLibrary.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const searchBoxExports = {};
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../src/workflow/WorkflowSearch.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText)((name) => require(name), searchBoxExports);
const draft = (id, projectId, name = `方法 ${id}`) => ({ ...createLiteratureDraft(), id, projectId, name, createdAt: 1, updatedAt: 1 });
const library = [draft("review", "", "综述流水线"), draft("bio", "project", "机制研究")];
const searchable = [
  { ...draft("review", "", "综述流水线"), tasks: [{ id: "t1", role: "writer", brief: "引用审计", dependsOn: [], outputs: [] }] },
  { ...draft("bio", "project", "机制研究"), tasks: [{ id: "t2", role: "reader", brief: "通路机制", dependsOn: [], outputs: [] }] },
];
function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  // 直接调用组件时，内层函数组件（如 WorkflowSearchBox）以未渲染元素出现：就地执行一遍再遍历。
  if (typeof tree.type === "function") return nodes(tree.type(tree.props));
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}
function harness({ choices = library, error = null } = {}) {
  let cursor = 0;
  const slots = [], calls = [], exported = {};
  // 与 React 一致：setter 既接受值也接受函数式更新。
  const state = initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; };
  new Function("require", "exports", code)(name => {
    if (name === "react") return { ...React, useState: state };
    if (name === "lucide-react") return new Proxy({}, { get: (_, icon) => (props) => React.createElement("i", { "data-icon": String(icon), ...props }) });
    if (name === "./CapabilityTile") return { CapabilityTile: "CapabilityTile" };
    if (name === "./WorkflowSearch") return searchBoxExports;
    if (name === "./model") return { searchWorkflows };
    if (name === "@tanstack/react-query") return { useQuery: () => ({ data: choices, isPending: false, error, refetch() {} }) };
    if (name === "../queries/client") return { workspaceKey: (...parts) => parts.join(":"), queryClient: { invalidateQueries() {} } };
    if (name === "../components/ui") return { Button: "Button", IconButton: "IconButton", Spinner: "Spinner", showAlert: (...args) => calls.push(["alert", ...args]) };
    if (name === "../api") return {
      timeAgo: () => "刚刚",
      deleteWorkflow: async (id) => { calls.push(["delete", id]); return { ok: true }; },
    };
    return require(name);
  }, exported);
  const render = () => { cursor = 0; return nodes(exported.WorkflowLibrary({ onEdit: (...args) => calls.push(["edit", ...args]) })); };
  return { render, calls };
}
const cardButtons = tree => tree.filter(node => node.type === "button" && React.Children.toArray(node.props.children).some(child => child?.type === "strong"));
const settle = () => new Promise(resolve => setImmediate(resolve));

test("library cards open the editor and the create button starts a blank draft", () => {
  const h = harness();
  const cards = cardButtons(h.render());
  assert.equal(cards.length, 2);
  assert.ok(JSON.stringify(cards.map(node => node.props.children)).includes("综述流水线"));
  cards[1].props.onClick();
  assert.deepEqual(h.calls, [["edit", "bio"]]);
  h.render().find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("新建工作流")).props.onClick();
  assert.deepEqual(h.calls, [["edit", "bio"], ["edit", null]]);
});

test("search filters cards by name and task brief and can be cleared", () => {
  const h = harness({ choices: searchable });
  const input = () => h.render().find(node => node.type === "input" && node.props["aria-label"] === "搜索工作流");
  input().props.onChange({ target: { value: "综述" } });
  assert.equal(cardButtons(h.render()).length, 1);
  h.render().find(node => node.props["aria-label"] === "清空搜索").props.onClick();
  assert.equal(cardButtons(h.render()).length, 2);
  input().props.onChange({ target: { value: "引用" } });
  assert.equal(cardButtons(h.render()).length, 1);
  input().props.onChange({ target: { value: "不存在" } });
  const tree = h.render();
  assert.equal(cardButtons(tree).length, 0);
  assert.ok(tree.some(node => node.props.role === "status" && JSON.stringify(node.props.children).includes("没有匹配")));
});

test("delete acts on the library through the api after confirmation", async () => {
  globalThis.window = { confirm: () => true };
  const h = harness();
  h.render().find(node => node.type === "IconButton" && node.props["aria-label"] === `删除 ${library[0].name}`).props.onClick();
  await settle();
  assert.deepEqual(h.calls, [["delete", "review"], ["alert", "工作流已删除", "success"]]);
});

test("declining the confirmation keeps the workflow untouched", async () => {
  globalThis.window = { confirm: () => false };
  const h = harness();
  h.render().find(node => node.type === "IconButton" && node.props["aria-label"] === `删除 ${library[0].name}`).props.onClick();
  await settle();
  assert.deepEqual(h.calls, []);
});

test("empty and failed libraries show guidance without cards", () => {
  const empty = harness({ choices: [] }).render();
  assert.equal(cardButtons(empty).length, 0);
  assert.ok(empty.some(node => JSON.stringify(node.props.children).includes("工作流库还是空的")));
  const failed = harness({ error: new Error("offline") }).render();
  assert.ok(failed.some(node => node.props.role === "alert"));
  assert.equal(failed.filter(node => node.type === "IconButton").length, 0);
});

// ---- AI 排流程：纯函数 ----

const chain = (...ids) => ids.map((id, index) => ({ id, role: "as-research-synthesizer", brief: "b", dependsOn: index ? [ids[index - 1]] : [], outputs: [`${id}/result.md`] }));

// 排布方向的判据：有依赖关系的上下游之间，坐标沿哪个轴推进。x 变化多=流程横着走。
function flowAxis(tasks) {
  const positions = layeredPositions(tasks);
  let alongX = 0, alongY = 0;
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!positions[dep]) continue;
    if (positions[task.id].x !== positions[dep].x) alongX++;
    if (positions[task.id].y !== positions[dep].y) alongY++;
  }
  return alongX > alongY ? "x" : alongY > alongX ? "y" : "none";
}

test("layeredPositions runs a chain top-down: each layer one step below the last", () => {
  // 编辑器的画布是竖长的（约 460×670），流程自上而下走能用上它更长的那条边。
  const positions = layeredPositions(chain("t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"));
  assert.equal(flowAxis(chain("t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8")), "y");
  assert.deepEqual(Object.values(positions).map(p => p.x), new Array(8).fill(0));
  assert.deepEqual(Object.values(positions).map(p => p.y), [0, 300, 600, 900, 1200, 1500, 1800, 2100]);
});

test("layeredPositions fans peers of one layer out sideways and joins them below", () => {
  // 菱形：a → b、a → c（同层并排）、b+c → d。
  const tasks = [
    { id: "a", role: "r", brief: "b", dependsOn: [], outputs: ["a.md"] },
    { id: "b", role: "r", brief: "b", dependsOn: ["a"], outputs: ["b.md"] },
    { id: "c", role: "r", brief: "b", dependsOn: ["a"], outputs: ["c.md"] },
    { id: "d", role: "r", brief: "b", dependsOn: ["b", "c"], outputs: ["d.md"] },
  ];
  assert.equal(flowAxis(tasks), "y");
  assert.deepEqual(layeredPositions(tasks), {
    a: { x: 0, y: 0 },
    b: { x: 0, y: 300 },
    c: { x: 320, y: 300 },
    d: { x: 0, y: 600 },
  });
});

test("layeredPositions turns a wide fan sideways: one row per layer would only make it taller", () => {
  // 2 层、第二层 8 个并排：内容又宽又扁。竖排时 8 个并排会把宽度撑到 2560px（画布只有
  // 460 宽），横排把并排方向放到 670 高的边上，能放进视野的部分更多。
  const fan = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
  const tasks = [
    { id: "root", role: "r", brief: "b", dependsOn: [], outputs: ["root.md"] },
    ...fan.map(id => ({ id, role: "r", brief: "b", dependsOn: ["root"], outputs: [`${id}.md`] })),
  ];
  assert.equal(flowAxis(tasks), "x");
  const positions = layeredPositions(tasks);
  assert.deepEqual(positions.root, { x: 0, y: 0 });
  assert.deepEqual(fan.map(id => positions[id].x), new Array(8).fill(300));
  assert.deepEqual(fan.map(id => positions[id].y), [0, 320, 640, 960, 1280, 1600, 1920, 2240]);
});

test("layeredPositions places a task below its latest prerequisite, not just one layer down", () => {
  // b 等到最晚的 c 完成：c 在第 1 层，所以 b 落在第 2 层而不是第 1 层。
  const tasks = [
    { id: "a", role: "r", brief: "b", dependsOn: [], outputs: ["a.md"] },
    { id: "b", role: "r", brief: "b", dependsOn: ["a", "c"], outputs: ["b.md"] },
    { id: "c", role: "r", brief: "b", dependsOn: ["a"], outputs: ["c.md"] },
  ];
  assert.equal(layeredPositions(tasks).b.y, 600);
  assert.equal(layeredPositions(tasks).c.y, 300);
});

test("layeredPositions never freezes on a cycle and still gives every task a position", () => {
  const cyclic = [
    { id: "x", role: "r", brief: "b", dependsOn: ["y"], outputs: ["x.md"] },
    { id: "y", role: "r", brief: "b", dependsOn: ["x"], outputs: ["y.md"] },
  ];
  const positions = layeredPositions(cyclic);
  assert.deepEqual(Object.keys(positions).sort(), ["x", "y"]);
  // 环里的任务都兜底到第 0 层，并排错开而不重叠。
  assert.deepEqual(positions.x, { x: 0, y: 0 });
  assert.deepEqual(positions.y, { x: 0, y: 320 });  assert.deepEqual(layeredPositions([]), {});
});

test("generatedToDraftInput fills a complete draft with layered positions and no run goal", () => {
  const draft = generatedToDraftInput({ name: " 文献综述流程 ", tasks: chain("search", "read", "write") });
  assert.equal(draft.name, "文献综述流程");
  assert.equal(draft.workflow, "custom");
  // 目标与摘要是提交运行时才收集的内容，生成稿不填。
  assert.equal(draft.objective, "");
  assert.equal(draft.summary, "");
  assert.equal(draft.viewport, null);
  assert.deepEqual(draft.frames, []);
  assert.deepEqual(draft.positions, { search: { x: 0, y: 0 }, read: { x: 0, y: 300 }, write: { x: 0, y: 600 } });
  // 名称缺失时落回默认名，不留下空名草稿。
  assert.equal(generatedToDraftInput({ name: "  ", tasks: [] }).name, "未命名工作流");
});

// ---- AI 排流程：库页不再放入口 ----

test("the library stays a list: the AI entry belongs to the canvas page", () => {
  const tree = harness().render();
  assert.equal(tree.find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("AI 排流程")), undefined);
  assert.equal(tree.find(node => node.props?.role === "dialog" && node.props["aria-label"] === "AI 排流程"), undefined);
});
