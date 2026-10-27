import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { expertSessionContext, isSidebarSession, mainSessionId } from "../src/researchSessions.ts";
import { readTranscriptScroll, rememberTranscriptScroll } from "../src/transcriptScrollMemory.ts";

const sessions = [{ id: "main", title: "as-methodology-designer is my project" }, { id: "expert", parentSessionId: "main", title: "renamed" }, { id: "side", sideParentSessionId: "main" }, { id: "normal", title: "用户对话" }];

test("sidebar eligibility uses the session relationship and preserves independent chats", () => {
  assert.deepEqual(sessions.filter(isSidebarSession).map((session) => session.id), ["main", "normal"]);
  assert.equal(mainSessionId("expert", sessions), "main");
  assert.equal(mainSessionId("side", sessions), "main");
  assert.equal(mainSessionId("expert", [sessions[1]]), "main");
  assert.equal(mainSessionId(null, sessions), null);
  assert.equal(mainSessionId("a", [{ id: "a", parentSessionId: "b" }, { id: "b", parentSessionId: "a" }]), "a");
});

test("expert identity comes from registered tasks including historical plans, not its title", () => {
  const study = { sessionId: "main", plans: [{ tasks: [{ sessionId: "expert", role: "as-methodology-designer", brief: "核验方法与假设" }] }, { tasks: [] }] };
  const expert = expertSessionContext(sessions[1], study);
  assert.deepEqual(expert, { mainSessionId: "main", name: "方法论设计专家", task: "核验方法与假设" });
  assert.equal(expertSessionContext(sessions[0], study), null);
  assert.equal(expertSessionContext(sessions[2], study), null);
  assert.deepEqual(expertSessionContext(sessions[1], null), { mainSessionId: "main", name: "专家子对话", task: null });
});

test("transcript reading positions remain isolated by conversation and workspace scope", () => {
  const main = JSON.stringify(["scope-1", "main"]), child = JSON.stringify(["scope-1", "expert"]);
  const position = { offset: 1350, atBottom: false };
  rememberTranscriptScroll(main, position);
  position.offset = 0;
  rememberTranscriptScroll(child, { offset: 2700, atBottom: true });
  assert.deepEqual(readTranscriptScroll(main), { offset: 1350, atBottom: false });
  assert.deepEqual(readTranscriptScroll(child), { offset: 2700, atBottom: true });
  assert.equal(readTranscriptScroll(JSON.stringify(["scope-2", "main"])), undefined);
  rememberTranscriptScroll(main, { offset: NaN, atBottom: true });
  assert.equal(readTranscriptScroll(main).offset, 1350);
});

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/ExpertConversationHeader.tsx", import.meta.url), "utf8");
const exported = {};
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(require, exported);

test("expert header exposes a return action and the Chinese task identity", () => {
  let returned = false;
  const tree = exported.ExpertConversationHeader({ name: "方法论设计专家", task: "核验方法与假设", onReturn: () => { returned = true; } });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /返回主对话/);
  assert.match(html, /方法论设计专家/);
  assert.match(html, /当前任务：核验方法与假设/);
  const buttons = [];
  const visit = (node) => { if (!React.isValidElement(node)) return; if (node.type === "button") buttons.push(node); React.Children.forEach(node.props.children, visit); };
  visit(tree);
  buttons[0].props.onClick();
  assert.equal(returned, true);
});
