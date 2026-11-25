import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as research from "../src/research.ts";
import { activePath } from "../src/transcriptTree.ts";
import { sha256Hex } from "../src/product/sha256.ts";
import { createLiteratureDraft } from "../src/workflow/model.ts";
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/components/ResearchConversation.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const message = (id, role, text, parentId = null) => ({ id, role, parts: [{ id: `${id}-part`, type: "text", text }], parentId, createdAt: 1 });
function fixture() {
  const tasks = createLiteratureDraft().tasks.map(task => ({ ...task, state: "pending", sessionId: null, summary: null, artifacts: [], runIds: [] }));
  tasks[0] = { ...tasks[0], state: "running", sessionId: "expert-a" };
  tasks[1] = { ...tasks[1], state: "running", sessionId: "expert-b" };
  return { id: "study", projectId: "project", sessionId: "lead", mode: "team", objective: "Compare evidence", status: "active", plans: [{ version: 1, workflow: "literature", workflowSource: { id: "saved", name: "Saved method", updatedAt: 1 }, summary: "Scope", tasks }], decisions: [{ id: "scope", gate: "G1", version: 1, status: "approved", scopeHash: "scope" }], claims: [] };
}
function load({ histories = {}, file = { content: "Report", binary: false, truncated: false } } = {}) {
  const exported = {}, readers = [];
  const mocks = {
    "../api": { artifactUrl: (project, path) => `/${project}/${path}`, deliveryArtifactUrl: (study, path, archive) => `/delivery/${study}/${path}?archive=${archive}`, getArtifactFileText: async () => file, getDeliveryArtifactFileText: async () => file, interruptChat: async () => ({ ok: true }), reopenHumanTask: async () => ({ ok: true }) },
    "@tanstack/react-query": { useQuery: options => { readers.push(options); return { data: file, isPending: false, refetch() {} }; } },
    "../queries/client": { workspaceKey: (...parts) => parts, queryClient: { invalidateQueries() {} } },
    "../queries/chatStore": { useChatState: (_, id) => [{ messagesBySession: { [id]: histories[id] ?? [] }, activeLeafBySession: { [id]: histories[id]?.at(-1)?.id }, busySessions: new Set([id]) }, () => {}, { isPending: false }] },
    "../transcriptTree": { activePath }, "../research": research, "../product/sha256": { sha256Hex },
    "./ReadOnlyWorkspace": { useReadOnlyWorkspace: () => null }, "./ResearchPanel": { ResearchPanel: ({ placement, sessionId }) => React.createElement("div", { "data-confirmation-placement": placement }, sessionId) },
    "./ResearchWorkflow": { HumanSubmitForm: ({ task }) => React.createElement("textarea", { "data-human-submit": task.id }) },
    "./Md": { Md: ({ text }) => React.createElement("span", null, text) },
    "./ui": { Button: ({ active, variant, size, children, ...props }) => React.createElement("button", props, children), ButtonLink: ({ children, href }) => React.createElement("a", { href }, children), Spinner: () => null },
  };
  new Function("require", "exports", code)(id => id in mocks ? mocks[id] : require(id), exported);
  const render = study => renderToStaticMarkup(React.createElement(exported.ResearchConversation, { projectId: "project", study, renderMessage: (message, sessionId) => React.createElement("span", { "data-session": sessionId }, message.parts.filter(part => part.type === "text").map(part => part.text).join("")) }));
  return { render, readers, file };
}

test("parallel experts keep their persisted identity and branch; dispatch instructions never enter the visible process", () => {
  const app = load({ histories: {
    "expert-a": [message("a-user", "user", "PRIVATE_DISPATCH"), message("a-work", "assistant", "First expert work", "a-user")],
    "expert-b": [message("b-user", "user", "PRIVATE_DISPATCH"), message("b-work", "assistant", "Second expert work", "b-user")],
  } });
  const html = app.render(fixture());
  assert.match(html, /Saved method/); assert.match(html, /First expert work/); assert.match(html, /Second expert work/);
  assert.match(html, /data-expert-message-id="a-work"/); assert.match(html, /data-session="expert-b"/);
  assert.doesNotMatch(html, /PRIVATE_DISPATCH/);
  assert.match(html, /data-confirmation-placement="conversation"/);
  assert.doesNotMatch(html, /下载已确认研究包/);
});


test("the conversation never offers a confirmed package download", () => {
  const app = load(), study = fixture();
  study.deliverySnapshot = { scopeHash: "delivery" };
  study.decisions.push({ gate: "G4", version: 1, status: "pending", scopeHash: "delivery" });
  assert.doesNotMatch(app.render(study), /下载已确认研究包/);
  study.decisions.at(-1).status = "approved";
  assert.doesNotMatch(app.render(study), /下载已确认研究包/);
  study.evidenceReviewRequired = true;
  assert.doesNotMatch(app.render(study), /下载已确认研究包/);
  study.evidenceReviewRequired = false;
  study.decisions.at(-1).version = 0;
  assert.doesNotMatch(app.render(study), /下载已确认研究包/);
});

test("inline artifact readers verify accepted bytes and reject a later mutable file", async () => {
  const file = { content: "Accepted report\n", binary: false, truncated: false };
  const app = load({ file }), study = fixture();
  const artifact = { path: "writing/review.md", sha256: await sha256Hex(new TextEncoder().encode(file.content)), bytes: file.content.length };
  study.plans[0].tasks[0].artifacts = [artifact];
  const html = app.render(study);
  assert.doesNotMatch(html, /文件指纹/);
  assert.doesNotMatch(html, new RegExp(artifact.sha256));
  assert.doesNotMatch(html, /验收 SHA-256/);
  const reader = app.readers.find(item => item.queryKey.includes(artifact.sha256));
  assert.ok(reader);
  await reader.queryFn({ signal: new AbortController().signal });
  file.content = "A different report";
  await assert.rejects(reader.queryFn({ signal: new AbortController().signal }), /验收版本不一致/);
});

test("running experts expand by default while finished ones stay collapsed until opened", () => {
  const app = load(), study = fixture();
  study.plans[0].tasks[2] = { ...study.plans[0].tasks[2], state: "completed", summary: "Finished deliverable summary", artifacts: [], runIds: [] };
  const html = app.render(study);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Finished deliverable summary/);
});

test("awaiting human tasks open their submission form inline; pending ones stay closed", () => {
  const app = load(), study = fixture();
  study.plans[0].tasks.push({ id: "pick-final-figure", kind: "human", state: "awaiting", role: "", brief: "从三张候选图里挑最终用的那张，附一句挑选理由。", dependsOn: ["draft-figures"], outputs: ["choices/final-figure.md"], sessionId: null, summary: null, artifacts: [], runIds: [] });
  const html = app.render(study);
  assert.match(html, /data-human-submit="pick-final-figure"/);
  assert.match(html, /人工任务/);
  const idleApp = load(), idle = fixture();
  idle.plans[0].tasks.push({ id: "later-step", kind: "human", state: "pending", role: "", brief: "还没轮到这一步。", dependsOn: ["pick-final-figure"], outputs: [], sessionId: null, summary: null, artifacts: [], runIds: [] });
  assert.doesNotMatch(idleApp.render(idle), /data-human-submit/);
});

test("a plan that has not started folds its checklist into one line instead of repeating the gate status", () => {
  const app = load(), study = fixture();
  study.plans[0].tasks = study.plans[0].tasks.map(task => ({ ...task, state: "pending", sessionId: null, summary: null, reworkCount: 0 }));
  study.decisions = [{ id: "scope", gate: "G1", version: 1, status: "pending", scopeHash: "scope" }];
  const html = app.render(study);
  const count = study.plans[0].tasks.length;
  // 摘要一行说清「有几个步骤、卡在哪」，名单默认收起。
  assert.match(html, /<details[^>]*class="group min-w-0/);
  assert.match(html, new RegExp(`<summary[^>]*>[\\s\\S]*?${count} 个步骤 · 等待你确认研究范围[\\s\\S]*?</summary>`));
  assert.ok(html.indexOf(`${count} 个步骤`) < html.indexOf("data-research-task-list"));
  // 研究目标就是上方用户消息，不再在卡片里重复一遍。
  assert.doesNotMatch(html, /Compare evidence/);
  assert.doesNotMatch(html, /个步骤已结束/);
});

test("pending confirmations render above the expert checklist", () => {
  const app = load();
  const html = app.render(fixture());
  const confirmation = html.indexOf("data-confirmation-placement");
  const list = html.indexOf("data-research-task-list");
  assert.ok(confirmation >= 0);
  assert.ok(list >= 0);
  assert.ok(confirmation < list);
});

test("a delivered study surfaces its final results open while mid-chain artifacts stay collapsed", async () => {
  const file = { content: "Accepted report\n", binary: false, truncated: false };
  const app = load({ file }), study = fixture();
  const hash = await sha256Hex(new TextEncoder().encode(file.content));
  // 叶子任务（research-package，无下游依赖）是最终产出：结论正文默认展开。
  const leaf = study.plans[0].tasks.at(-1);
  study.plans[0].tasks[study.plans[0].tasks.length - 1] = { ...leaf, state: "completed", summary: "Final packaged conclusion", artifacts: [{ path: "package/manifest.md", sha256: hash, bytes: file.content.length }], runIds: [] };
  // 中段任务完成后保持折叠，产物不重复铺开。
  study.plans[0].tasks[2] = { ...study.plans[0].tasks[2], state: "completed", artifacts: [{ path: "evidence/papers.md", sha256: hash, bytes: file.content.length }], runIds: [] };
  study.deliverySnapshot = { scopeHash: "delivery", archive: { formatVersion: 1, sha256: "archive", bytes: 0, manifestSha256: "manifest" } };
  study.decisions.push({ id: "g4", gate: "G4", version: 1, status: "approved", scopeHash: "delivery" });
  const html = app.render(study);
  assert.match(html, /aria-label="研究成果"/);
  assert.match(html, /Accepted report/);
  assert.match(html, /data-outcome-conclusion/);
  assert.match(html, /成果清单/);
  assert.match(html, /研究结论/);
  assert.match(html, /研究过程/);
  // 各专家的摘要留在执行过程的步骤行里，结果卡片不再重复铺开。
  assert.doesNotMatch(html, /Final packaged conclusion/);
  assert.doesNotMatch(html, /专家工作摘要/);
  // 已确认交付的正文与下载都从封存归档取，不读工作区。
  assert.match(html, /\/delivery\/study\/package\/manifest\.md\?archive=archive/);
  // 指纹不进入界面，正文读取时仍按验收版本校验。
  assert.doesNotMatch(html, /验收 SHA-256/);
  assert.doesNotMatch(html, new RegExp(hash));
  assert.doesNotMatch(html, /evidence\/papers\.md/);
  assert.doesNotMatch(html, /复制报告全文/);
});

test("an undelivered study keeps every task row collapsed with no result block", () => {
  const app = load(), study = fixture();
  study.plans[0].tasks[2] = { ...study.plans[0].tasks[2], state: "completed", summary: "Mid-chain summary", artifacts: [], runIds: [] };
  const html = app.render(study);
  assert.doesNotMatch(html, /aria-label="研究成果"/);
  assert.doesNotMatch(html, /Mid-chain summary/);
});
