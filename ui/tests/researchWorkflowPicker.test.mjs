import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as research from "../src/research.ts";
import { searchWorkflows } from "../src/workflow/model.ts";

const require = createRequire(import.meta.url);
function transpile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
const code = transpile("../src/components/WorkModeSwitch.tsx");
const searchCode = transpile("../src/workflow/WorkflowSearch.tsx");
const searchBoxExports = {};
new Function("require", "exports", searchCode)((name) => require(name), searchBoxExports);

// 列表数据可按用例改写，紧凑菜单的搜索框阈值行为依赖条目数量。
let savedWorkflows = [{ id: "wf-1", name: "文献流水线", tasks: [] }, { id: "wf-2", name: "复现流水线", tasks: [] }];

const exported = {};
new Function("require", "exports", code)((name) => {
  if (name === "../research") return research;
  if (name === "./ModelPicker") return { usePopover: () => ({ open: true, setOpen() {}, ref: { current: null } }) };
  if (name === "./ResearchModulePreview") return { ResearchModulePreview: "ProfilePreview" };
  if (name === "@tanstack/react-query") return { useQuery: () => ({ data: savedWorkflows, isPending: false, error: null, refetch() {} }) };
  if (name === "../api") return { listWorkflows: async () => savedWorkflows };
  if (name === "../queries/client") return { workspaceKey: (...parts) => parts };
  if (name === "react") return { ...React, useState: state };
  if (name === "../workflow/model") return { searchWorkflows };
  if (name === "../workflow/WorkflowSearch") return searchBoxExports;
  return require(name);
}, exported);
function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  // 直接调用组件时，内层函数组件以未渲染元素出现：就地执行一遍再遍历。
  if (typeof tree.type === "function") return nodes(tree.type(tree.props));
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}
// 假 useState：同一用例内跨渲染保留状态，交互后重新 render 即可看到更新。
let cursor = 0;
const slots = [];
function state(initial) {
  const index = cursor++;
  if (!(index in slots)) slots[index] = initial;
  return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
}
function render(props) {
  cursor = 0;
  return nodes(exported.WorkModeSwitch(props));
}
function itemText(node) {
  const walk = (tree) => {
    if (Array.isArray(tree)) return tree.flatMap(walk);
    if (React.isValidElement(tree)) return React.Children.toArray(tree.props.children).flatMap(walk);
    return [tree];
  };
  return walk(node).filter((child) => typeof child === "string").join("");
}
const changes = [];
const drafts = [];

test("work modes retain their names and show exactly three top-level categories", () => {
  const tree = render({ value: "normal", onChange: (value) => changes.push(value) });
  const select = tree.find((node) => node.props["aria-label"] === "工作模式大类");
  const options = nodes(select).filter((node) => node.type === "option");
  assert.deepEqual(options.map((node) => [node.props.value, node.props.children]), [["normal", "工作模式"], ["team", "专家团模式"], ["workflow", "工作流模式"]]);
  assert.ok(!tree.some((node) => node.props["aria-label"] === "科研专家团预设子模式"));
  select.props.onChange({ target: { value: "team" } });
  assert.deepEqual(changes, ["team"]);
});
test("team workflows have a separate selector and changes preserve team category", () => {
  for (const value of research.presetWorkflowModes) {
    const localChanges = [];
    const tree = render({ value, onChange: (mode) => localChanges.push(mode) });
    const category = tree.find((node) => node.props["aria-label"] === "工作模式大类");
    const workflow = tree.find((node) => node.props["aria-label"] === "科研专家团预设子模式");
    assert.equal(category.props.value, "team");
    assert.equal(workflow.props.value, value);
    // 专家团档不再提供保存工作流的选择（工作流是独立模式）。
    assert.ok(!tree.some((node) => node.props["aria-label"] === "选择研究工作流"));
    assert.deepEqual(nodes(workflow).filter((node) => node.type === "option").map((node) => node.props.value), ["team", ...research.presetWorkflowModes]);
    for (const mode of research.presetWorkflowModes) workflow.props.onChange({ target: { value: mode } });
    assert.deepEqual(localChanges, research.presetWorkflowModes);
    category.props.onChange({ target: { value: "team" } });
    assert.equal(localChanges.at(-1), value);
    category.props.onChange({ target: { value: "normal" } });
    assert.equal(localChanges.at(-1), "normal");
    assert.equal(tree.find((node) => node.type === "ProfilePreview").props.mode, value);
  }
});
test("workflow mode picks a saved workflow through its own searchable picker", () => {
  const localChanges = [];
  const localDrafts = [];
  let tree = render({ value: "workflow", onChange: (mode) => localChanges.push(mode), workflowDraftId: null, onWorkflowDraftChange: (id) => localDrafts.push(id) });
  const category = tree.find((node) => node.props["aria-label"] === "工作模式大类");
  assert.equal(category.props.value, "workflow");
  assert.ok(!tree.some((node) => node.props["aria-label"] === "科研专家团预设子模式"));
  // 弹出选择器替代原生 select：触发按钮 + 带搜索的列表。
  assert.ok(!tree.some((node) => node.type === "select" && node.props["aria-label"] !== "工作模式大类"));
  const trigger = tree.find((node) => node.props["aria-label"] === "选择研究工作流" && node.props["aria-haspopup"] === "dialog");
  assert.ok(trigger, "workflow mode must offer its own picker");
  assert.equal(itemText(trigger), "请选择工作流");
  const dialog = tree.find((node) => node.props.role === "dialog" && node.props["aria-label"] === "选择研究工作流");
  assert.ok(dialog);
  const workflowItems = () => tree.filter((node) => node.props.role === "menuitemradio");
  assert.deepEqual(workflowItems().map((node) => itemText(node)), savedWorkflows.map((entry) => entry.name));
  // 搜索按名称过滤，可用清空按钮还原。
  tree.find((node) => node.type === "input" && node.props["aria-label"] === "搜索工作流").props.onChange({ target: { value: "复现" } });
  tree = render({ value: "workflow", onChange: (mode) => localChanges.push(mode), workflowDraftId: null, onWorkflowDraftChange: (id) => localDrafts.push(id) });
  assert.deepEqual(tree.filter((node) => node.props.role === "menuitemradio").map((node) => itemText(node)), ["复现流水线"]);
  tree.find((node) => node.props["aria-label"] === "清空搜索").props.onClick();
  tree = render({ value: "workflow", onChange: (mode) => localChanges.push(mode), workflowDraftId: null, onWorkflowDraftChange: (id) => localDrafts.push(id) });
  assert.equal(tree.filter((node) => node.props.role === "menuitemradio").length, 2);
  // 选中工作流只改绑定，不改模式档位。
  tree.filter((node) => node.props.role === "menuitemradio")[1].props.onClick();
  assert.deepEqual(localDrafts, ["wf-2"]);
  assert.deepEqual(localChanges, []);
  category.props.onChange({ target: { value: "normal" } });
  assert.deepEqual(localChanges, ["normal"]);
});
test("persisted studies display category and submode separately without allowing changes", () => {
  for (const value of ["normal", ...research.presetWorkflowModes, "team", "diagnosis"]) {
    const tree = render({ value, onChange() { throw new Error("unexpected mutation"); }, readOnly: true });
    assert.ok(!tree.some((node) => node.type === "select"));
    const text = tree.filter((node) => node.type === "span").flatMap((node) => React.Children.toArray(node.props.children)).filter((child) => typeof child === "string");
    assert.ok(text.includes(value === "normal" ? "工作模式" : "专家团模式"));
    if (research.presetWorkflowModes.includes(value)) assert.ok(text.includes(`指定流程：${research.researchModes[value]}`));
  }
});
test("workflow-bound studies display as workflow mode with the bound name", () => {
  const tree = render({ value: "workflow", boundWorkflowName: "文献流水线", readOnly: true, onChange() { throw new Error("unexpected mutation"); } });
  assert.ok(!tree.some((node) => node.type === "select"));
  const text = tree.filter((node) => node.type === "span").flatMap((node) => React.Children.toArray(node.props.children)).filter((child) => typeof child === "string").join("");
  assert.ok(text.includes("工作流模式"));
  assert.ok(text.includes("已绑定工作流「文献流水线」，这个对话不再更换"));
  assert.ok(!text.includes("专家团模式"));
});

test("team mode defaults to automatic routing and allows opting in and out of a preset", () => {
  const localChanges = [];
  const tree = render({ value: "team", onChange: (mode) => localChanges.push(mode) });
  const workflow = tree.find((node) => node.props["aria-label"] === "科研专家团预设子模式");
  assert.equal(workflow.props.value, "team");
  assert.deepEqual(nodes(workflow).filter((node) => node.type === "option").map((node) => node.props.value), ["team", ...research.presetWorkflowModes]);
  workflow.props.onChange({ target: { value: "analysis" } });
  workflow.props.onChange({ target: { value: "team" } });
  assert.deepEqual(localChanges, ["analysis", "team"]);
  const readonly = render({ value: "team", activeWorkflow: "proposal", readOnly: true, onChange() {} });
  assert.ok(readonly.some((node) => node.props.children === "自动判断 · 当前流程：Idea 到实验方案"));
});

test("compact menu shows the three categories and keeps presets one click away", () => {
  const localChanges = [];
  for (const value of ["normal", "team", ...research.presetWorkflowModes]) {
    const tree = render({ value, onChange: (mode) => localChanges.push(mode), compact: true });
    assert.equal(tree.some((node) => node.type === "select"), false);
    const items = tree.filter((node) => node.props.role === "menuitemradio");
    assert.equal(items.length, 3 + research.presetWorkflowModes.length);
    assert.equal(items.filter((node) => node.props["aria-checked"]).length, 1);
    assert.ok(!itemText(tree).includes("保存的工作流"));
    assert.ok(!tree.some((node) => node.type === "input"), "短列表不显示搜索框");
  }
  // 前三个 radio 是三档大类；预设流程照旧一键直达，点击直接切换。
  const items = render({ value: "normal", onChange: (mode) => localChanges.push(mode), compact: true }).filter((node) => node.props.role === "menuitemradio");
  for (const item of items) item.props.onClick();
  assert.deepEqual(localChanges, ["normal", "team", "workflow", ...research.presetWorkflowModes]);
});
test("compact workflow mode lists saved workflows inline and binds on click", () => {
  const localChanges = [];
  const localDrafts = [];
  const tree = render({ value: "workflow", onChange: (mode) => localChanges.push(mode), compact: true, workflowDraftId: null, onWorkflowDraftChange: (id) => localDrafts.push(id) });
  assert.ok(itemText(tree).includes("保存的工作流"));
  assert.ok(!itemText(tree).includes("专家团预设流程"));
  const items = tree.filter((node) => node.props.role === "menuitemradio");
  // 三档大类 + 两条保存的工作流；预设流程不出现在工作流档菜单里，短列表不出搜索框。
  assert.equal(items.length, 3 + savedWorkflows.length);
  assert.ok(!tree.some((node) => node.type === "input"));
  const workflowItems = items.slice(3);
  assert.deepEqual(workflowItems.map((node) => itemText(node)), savedWorkflows.map((entry) => entry.name));
  workflowItems[1].props.onClick();
  assert.deepEqual(localDrafts, ["wf-2"]);
  assert.deepEqual(localChanges, ["workflow"]);
});
test("compact workflow menu gains a search box once the list grows", () => {
  savedWorkflows = ["甲", "乙", "丙", "丁", "戊", "己", "庚"].map((name, index) => ({ id: `wf-${index}`, name, tasks: [] }));
  const localDrafts = [];
  let tree = render({ value: "workflow", onChange() {}, compact: true, workflowDraftId: null, onWorkflowDraftChange: (id) => localDrafts.push(id) });
  const searchInput = tree.find((node) => node.type === "input" && node.props["aria-label"] === "搜索工作流");
  assert.ok(searchInput, "长列表必须带搜索框");
  assert.equal(tree.filter((node) => node.props.role === "menuitemradio").length, 3 + savedWorkflows.length);
  searchInput.props.onChange({ target: { value: "庚" } });
  tree = render({ value: "workflow", onChange() {}, compact: true, workflowDraftId: null, onWorkflowDraftChange: (id) => localDrafts.push(id) });
  // 三档大类常驻，工作流列表被过滤到一条。
  assert.deepEqual(tree.filter((node) => node.props.role === "menuitemradio").map((node) => itemText(node)), ["工作模式", "专家团模式", "工作流模式", "庚"]);
  savedWorkflows = [{ id: "wf-1", name: "文献流水线", tasks: [] }, { id: "wf-2", name: "复现流水线", tasks: [] }];
});
