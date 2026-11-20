import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { createLiteratureDraft, searchWorkflows } from "../src/workflow/model.ts";
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
function harness({ choices = library, error = null, confirmAnswer = true } = {}) {
  let cursor = 0;
  const slots = [], calls = [], exported = {};
  const state = initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = next; }]; };
  new Function("require", "exports", code)(name => {
    if (name === "react") return { ...React, useState: state };
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
