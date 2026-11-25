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

function harness({ projectId, sessionId = null, nameSlot = null } = {}) {
  let cursor = 0;
  const slots = [], calls = [], exported = {};
  let hookOptions = null;
  const state = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  };
  const ref = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  };
  const query = (data = []) => ({ data, isPending: false, error: null, refetch() {} });
  new Function("require", "exports", code)(name => {
    if (name === "react") return { ...React, useState: state, useRef: ref, useEffect: () => {}, useContext: () => nameSlot, useMemo: (factory) => factory() };
    if (name === "react-dom") return { createPortal: (children, target) => React.createElement("portal", { "data-target": target }, children) };
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
    if (name === "./AiWorkflowPrompt") return { AiWorkflowPrompt: "AiWorkflowPrompt" };
    if (name === "./SkillsLibrary") return { SkillsLibrary: "SkillsLibrary" };
    if (name === "./McpLibrary") return { McpLibrary: "McpLibrary" };
    if (name === "./WorkflowCanvas") return { WorkflowCanvas: "WorkflowCanvas" };
    if (name === "./WorkflowLibrary") return { WorkflowLibrary: "WorkflowLibrary" };
    if (name === "./nameSlot") return { WorkflowNameSlot: {} };
    if (name === "./autosave") return { createAutosave: () => ({
      schedule: () => calls.push(["schedule"]),
      cancel: () => calls.push(["cancel"]),
      flush: async () => { calls.push(["flush"]); },
      dispose: async () => {},
    }) };
    if (name === "./pendingUse") return { stagePendingWorkflowUse: (workflow) => calls.push(["pending", workflow.id, workflow.name]) };
    if (name === "./conversation") return { stageWorkflowConversation: (projectId, sessionId, workflow) => calls.push(["stage", projectId, sessionId, workflow.id]) };
    // 生成编排是异步 + SSE 的，这里换成可控桩：测试按需触发 onGenerated/onError。
    if (name === "./useWorkflowDraftGeneration") return {
      WORKFLOW_DRAFT_STAGES: [{ key: "writing", label: "AI 正在编排流程" }],
      useWorkflowDraftGeneration: (options) => {
        hookOptions = options;
        return {
          running: false,
          stage: "inventory",
          elapsed: 0,
          thinking: "",
          previewTasks: [],
          start: (intent) => calls.push(["start", intent]),
          stop: () => calls.push(["stop"]),
        };
      },
    };
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
  return { openEditor, render, calls, hook: () => hookOptions };
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

test("the name moves into the page-header slot when the shell provides one", () => {
  const slot = { id: "page-header" };
  const h = harness({ nameSlot: slot });
  const { render } = h.openEditor(null);
  const nameInputs = (tree) => (Array.isArray(tree) ? tree.flatMap(nodes) : nodes(tree)).filter(node => node.type === "input" && node.props["aria-label"] === "工作流名称");
  const tree = render();
  // 名称投进页头槽位，工具栏不再重复一份。
  const portal = tree.find(node => node.type === "portal");
  assert.ok(portal, "名称没有投到页头槽位");
  assert.deepEqual(portal.props["data-target"], slot);
  const portalInputs = nameInputs(portal);
  assert.equal(portalInputs.length, 1);
  assert.equal(portalInputs[0].props.value, "未命名工作流");
  const toolbar = tree.find(node => node.type === "header");
  assert.equal(nameInputs(toolbar).length, 0);
  // 仍走同一套受控改名：输入触发自动保存，新名字回写到投出去的输入框。
  portalInputs[0].props.onChange({ target: { value: "通路梳理" } });
  assert.deepEqual(h.calls, [["schedule"]]);
  assert.equal(nameInputs(render().find(node => node.type === "portal"))[0].props.value, "通路梳理");
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

// ---- AI 排流程：入口在编排页，确认在开始前，生成稿由编排 hook 交回落盘 ----

const generated = model.generatedToDraftInput({
  name: "综述流水线",
  tasks: ["search", "read", "write"].map((id, index) => ({ id, role: "as-experiment-designer", brief: "b", dependsOn: index ? [["search", "read", "write"][index - 1]] : [], outputs: [`${id}.md`] })),
});
const promptOf = (render) => render().find(node => node.type === "AiWorkflowPrompt");
const canvasDraft = (render) => render().find(node => node.type === "WorkflowCanvas").props.draft;

test("the canvas page hosts the AI prompt and lands a generated flow on the blank canvas", () => {
  const h = harness();
  const { render } = h.openEditor(null);
  assert.ok(promptOf(render), "编排页缺少 AI 排流程入口");
  assert.equal(promptOf(render).props.disabled, false);
  // 空画布不问替换，直接把句子交给生成编排。
  assert.equal(promptOf(render).props.onGenerate("先检索再精读最后成稿"), true);
  assert.deepEqual(h.calls, [["start", "先检索再精读最后成稿"]]);
  // 生成完成：算一次编辑，草稿整份换成生成稿。
  render();
  h.hook().onGenerated(generated);
  assert.deepEqual(h.calls, [["start", "先检索再精读最后成稿"], ["schedule"]]);
  assert.equal(canvasDraft(render).name, "综述流水线");
  assert.deepEqual(canvasDraft(render).tasks.map(task => task.id), ["search", "read", "write"]);
});

test("generating over an existing flow asks before starting and keeps the workflow's own name", () => {
  globalThis.window = { confirm: () => false };
  const h = harness();
  const { render } = h.openEditor(null);
  render().find(node => node.type === "WorkflowCanvas").props.onChange({ ...validDraft, name: "我的流程" });
  assert.equal(promptOf(render).props.onGenerate("换一版"), false);
  // 拒绝替换：不启动生成，画布保持原样。
  assert.deepEqual(h.calls, [["schedule"]]);
  assert.equal(canvasDraft(render).name, "我的流程");
  assert.deepEqual(canvasDraft(render).tasks.map(task => task.id), ["t1"]);
  globalThis.window.confirm = () => true;
  assert.equal(promptOf(render).props.onGenerate("换一版"), true);
  assert.deepEqual(h.calls, [["schedule"], ["start", "换一版"]]);
  // 已确认过替换：落稿时不再问第二遍，且工作流已有的名字不被顺手改掉。
  render();
  h.hook().onGenerated(generated);
  assert.deepEqual(h.calls, [["schedule"], ["start", "换一版"], ["schedule"]]);
  assert.equal(canvasDraft(render).name, "我的流程");
  assert.deepEqual(canvasDraft(render).tasks.map(task => task.id), ["search", "read", "write"]);
  delete globalThis.window;
});

test("a failed generation reports the reason without touching the canvas", () => {
  const h = harness();
  const { render } = h.openEditor(null);
  promptOf(render).props.onGenerate("来一条流程");
  render();
  h.hook().onError("没有可用的对话引擎");
  assert.deepEqual(h.calls, [["start", "来一条流程"], ["alert", "没有可用的对话引擎", "error"]]);
  assert.deepEqual(canvasDraft(render).tasks, []);
});
