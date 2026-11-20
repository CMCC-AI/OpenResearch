import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as model from "../src/workflow/model.ts";
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/workflow/WorkflowStudio.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const agents = [{ id: "as-experiment-designer", name: "实验设计" }];
const validDraft = {
  ...model.createBlankDraft(),
  tasks: [{ id: "t1", role: "as-experiment-designer", brief: "设计实验", dependsOn: [], outputs: ["design.md"] }],
};
function nodes(tree) { return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)] : []; }
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ projectId, sessionId = null } = {}) {
  let cursor = 0;
  const slots = [], calls = [], exported = {};
  const state = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = next; }];
  };
  const ref = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  };
  const query = (data = []) => ({ data, isPending: false, error: null, refetch() {} });
  new Function("require", "exports", code)(name => {
    if (name === "react") return { ...React, useState: state, useRef: ref, useEffect: () => {} };
    if (name === "@tanstack/react-query") return { useQuery: (options) => {
      const key = options.queryKey.join(":");
      if (key.startsWith("workflowAgents")) return query(agents);
      return query();
    } };
    if (name === "../queries/client") return { workspaceKey: (...parts) => parts, queryClient: { invalidateQueries() {} } };
    if (name === "../queries/projects") return { listProjectsQuery: () => ({ queryKey: ["projects"] }) };
    if (name === "../components/ui") return { Button: "Button", Spinner: "Spinner", showAlert: (...args) => calls.push(["alert", ...args]) };
    if (name === "./model") return model;
    if (name === "./AgentLibrary") return { AgentLibrary: "AgentLibrary" };
    if (name === "./SkillsLibrary") return { SkillsLibrary: "SkillsLibrary" };
    if (name === "./McpLibrary") return { McpLibrary: "McpLibrary" };
    if (name === "./WorkflowCanvas") return { WorkflowCanvas: "WorkflowCanvas" };
    if (name === "./WorkflowLibrary") return { WorkflowLibrary: "WorkflowLibrary" };
    if (name === "./autosave") return { createAutosave: () => ({
      schedule: () => calls.push(["schedule"]),
      cancel: () => calls.push(["cancel"]),
      flush: async () => { calls.push(["flush"]); },
      dispose: async () => {},
    }) };
    if (name === "./pendingUse") return { stagePendingWorkflowUse: (workflow) => calls.push(["pending", workflow.id, workflow.name]) };
    if (name === "./conversation") return { stageWorkflowConversation: (projectId, sessionId, workflow) => calls.push(["stage", projectId, sessionId, workflow.id]) };
    if (name === "../api") return {
      createWorkflow: async (input, projectId) => { calls.push(["create", input.name, projectId]); return { ...input, id: "wf1", projectId, createdAt: 1, updatedAt: 1 }; },
      saveWorkflow: async (id, input) => { calls.push(["save", id, input.name]); return { ...input, id, projectId: "", createdAt: 1, updatedAt: 1 }; },
      getWorkflow: async () => null,
      listWorkflows: async () => [],
      listWorkflowAgents: async () => agents,
      listWorkflowSkills: async () => [],
      listMcpServers: async () => [],
    };
    return require(name);
  }, exported);
  // 工作流库是字符串桩：手动触发 onEdit 进入编辑器。渲染始终从
  // WorkflowStudio 进入再调起内层组件，保证 hook 槽位顺序与 React 一致。
  const studioProps = { projectId, sessionId, onOpenSession: (...args) => calls.push(["open", ...args]), onOpenChats: () => calls.push(["chats"]) };
  const render = () => {
    cursor = 0;
    const tree = nodes(exported.WorkflowStudio(studioProps));
    const editorElement = tree.find(node => typeof node.type === "function" && node.type.name === "WorkflowEditor");
    if (!editorElement) return tree;
    return [...tree, ...nodes(editorElement.type(editorElement.props))];
  };
  const openEditor = (draftId) => {
    render().find(node => node.type === "WorkflowLibrary").props.onEdit(draftId);
    return { render, calls };
  };
  return { openEditor, render, calls };
}

test("editor opens with the default name and drops the removed chrome", () => {
  const { render, calls } = harness().openEditor(null);
  const tree = render();
  const nameInput = tree.find(node => node.type === "input" && node.props["aria-label"] === "工作流名称");
  assert.equal(nameInput.props.value, "未命名工作流");
  const text = JSON.stringify(tree);
  assert.ok(!text.includes("保存草稿"));
  assert.ok(!text.includes("选择使用项目"));
  assert.ok(!text.includes("新建项目"));
  assert.ok(!text.includes("自由组合专家与依赖"));
  assert.ok(!text.includes("专家与依赖自由组合"));
  assert.ok(!text.includes("在聊天中提出需求"));
  assert.ok(!text.includes("保存并返回"));
  assert.deepEqual(calls, []);
});

test("renaming schedules the autosave and going back flushes it", async () => {
  const h = harness();
  const { render } = h.openEditor(null);
  const nameInput = () => render().find(node => node.type === "input" && node.props["aria-label"] === "工作流名称");
  nameInput().props.onChange({ target: { value: "通路梳理" } });
  assert.deepEqual(h.calls, [["schedule"]]);
  render().find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("返回工作流库")).props.onClick();
  await settle();
  assert.deepEqual(h.calls, [["schedule"], ["flush"]]);
  // 返回后回到工作流库总览（onBack 只是路由状态回退）。
  assert.ok(render().some(node => node.type === "WorkflowLibrary"));
});

test("submitting a global workflow stages pending use and heads to the chats page", async () => {
  const h = harness();
  const { render } = h.openEditor(null);
  render().find(node => node.type === "WorkflowCanvas").props.onChange({ ...validDraft, name: "" });
  assert.deepEqual(h.calls, [["schedule"]]);
  render().find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("在对话中使用")).props.onClick();
  await settle();
  assert.deepEqual(h.calls, [["schedule"], ["cancel"], ["create", "未命名工作流", ""], ["pending", "wf1", "未命名工作流"], ["chats"]]);
});

test("submitting inside a project without a session stages pending use for the new chat", async () => {
  const h = harness({ projectId: "p1" });
  const { render } = h.openEditor(null);
  render().find(node => node.type === "WorkflowCanvas").props.onChange(validDraft);
  render().find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("在对话中使用")).props.onClick();
  await settle();
  assert.ok(h.calls.some(call => call[0] === "create" && call[2] === "p1"));
  assert.deepEqual(h.calls.filter(call => ["pending", "open", "stage", "chats"].includes(call[0])), [["pending", "wf1", "未命名工作流"], ["open", "new", "p1"]]);
});

test("invalid drafts block submission with the error list instead of saving", async () => {
  const h = harness();
  const { render } = h.openEditor(null);
  render().find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("在对话中使用")).props.onClick();
  await settle();
  assert.deepEqual(h.calls, []);
  assert.ok(render().some(node => node.props.role === "alert" && JSON.stringify(node.props.children).includes("至少需要一个 Agent 任务")));
});
