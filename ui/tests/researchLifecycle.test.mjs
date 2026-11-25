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
// 结束本轮研究已抽到独立组件；测试同样按源码函数拼接，保持对结束流程的端到端断言。
const endFile = ts.createSourceFile("EndResearchControl.tsx", readFileSync(new URL("../src/components/EndResearchControl.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const endDeclarations = endFile.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(endFile).replace(/^export /, "")).join("\n");
const endCode = ts.transpileModule(`${endDeclarations}\nexports.EndResearchControl = EndResearchControl;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function setup({ status = "active", readOnly = false, failure = null, disabled = false, decisions = [], tasks = [], placement = "pane" } = {}) {
  const buttons = [], calls = [], errors = [];
  let refetches = 0;
  const study = { id: "study", sessionId: "lead", mode: "team", status, plans: [{ version: 7, tasks, summary: "scope" }], decisions, claims: [] };
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
  const endExports = {};
  new Function(...Object.keys(bindings), "exports", endCode)(...Object.values(bindings), endExports);
  bindings.EndResearchControl = endExports.EndResearchControl;
  const exports = {};
  new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
  const html = renderToStaticMarkup(React.createElement(exports.Panel, { sessionId: "lead", placement, disabled }));
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

test("approval scope reads as a task plan instead of raw JSON", () => {
  const scope = {
    materialIds: [],
    objective: "验证绑定工作流后的会话标题是否使用工作流名。",
    summary: "围绕目标「验证绑定工作流后的会话标题是否使用工作流名。」，按「研究工作流」流程执行 2 个专家任务（2 项等你完成），各任务按依赖顺序登记产物，最终整理为可追溯的研究成果。",
    tasks: [
      { id: "collect", kind: "human", role: "", brief: "列出三条最值得写进综述的观察，每条一句话。", outputs: ["notes/points.md"], dependsOn: [] },
      { id: "finalize", kind: "human", role: "", brief: "定稿综述标题与三段式提纲。", outputs: ["summary/outline.md"], dependsOn: ["collect"] },
    ],
    version: 1,
  };
  const tasks = scope.tasks.map((task) => ({ ...task, artifacts: [], runIds: [], sessionId: null, summary: null }));
  const app = setup({ tasks, decisions: [{ id: "g1", gate: "G1", version: 7, status: "pending", scope: JSON.stringify(scope), scopeHash: "bf9df78f3bed3b32c6134787fcfe693dc704eab48b8f43a187daa3107b9398a9", reason: null }] });
  assert.match(app.html, /研究目标：验证绑定工作流后的会话标题/);
  assert.match(app.html, /将执行 2 个步骤，都由你亲自完成，预计产出 2 份文件。/);
  assert.doesNotMatch(app.html, /2 个专家任务|各任务按依赖顺序登记产物/);
  assert.match(app.html, /未附加研究材料 · 计划 v1/);
  assert.match(app.html, /查看任务安排（2）/);
  assert.match(app.html, /第 1 步/);
  assert.match(app.html, /人工任务/);
  assert.match(app.html, /列出三条最值得写进综述的观察/);
  assert.match(app.html, /产物：notes\/points\.md/);
  assert.match(app.html, /接在第 1 步之后/);
  assert.doesNotMatch(app.html, /查看完整审批范围/);
  // 原始 scope JSON 和范围校验编码只留在持久化审批记录里，不再出现在界面。
  assert.doesNotMatch(app.html, /原始审批数据|范围校验|scopeHash|"materialIds"/);
  assert.doesNotMatch(app.html, /bf9df78f/);
});

test("the conversation card stays out of the way when nothing needs a decision", () => {
  // 没有待确认、没有记录、没有交付提示时，对话里不留空壳也不写「暂无待确认事项」。
  assert.equal(setup({ placement: "conversation" }).html, "");
  const pending = setup({
    placement: "conversation",
    decisions: [{ id: "g1", gate: "G1", version: 7, status: "pending", scope: JSON.stringify({ objective: "看结论" }), scopeHash: "g1", reason: null }],
  });
  assert.match(pending.html, /研究范围与目标/);
});

test("delivery confirmation lists the actual files and sizes before approval", () => {
  const scope = {
    plan: {
      summary: "",
      version: 7,
      tasks: [{
        id: "collect",
        kind: "human",
        brief: "列出三条观察。",
        outputs: ["notes/points.md"],
        dependsOn: [],
        artifacts: [{ path: "notes/points.md", sha256: "a".repeat(64), bytes: 3 }],
      }],
    },
    claims: [],
    runs: [],
  };
  const app = setup({ decisions: [{ id: "g4", gate: "G4", version: 7, status: "pending", scope: JSON.stringify(scope), scopeHash: "g4hash", reason: null }] });
  // 批准前就能看到实际交付物；3 字节的占位文件不再藏在任务摘要后面。
  assert.match(app.html, /交付文件（1 份 · 3 B）/);
  assert.match(app.html, /notes\/points\.md/);
  assert.match(app.html, /aaaaaaaaaaaaaaaa…/);
});
