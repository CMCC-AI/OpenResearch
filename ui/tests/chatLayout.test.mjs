import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { isNewChatLayout, isChatLayoutPending } from "../src/chatLayout.ts";

const newChat = { mainView: "chat", embedded: false, activeId: null, historyLoaded: false, hasMessages: false, busy: false, sideChat: false };

test("new-chat layout stays stable throughout startup, refresh and errors", () => {
  for (const transient of [
    { contentLoading: true, historyLoading: false },
    { contentLoading: false, historyLoading: false },
    { contentLoading: true, historyLoading: true },
    { contentError: "retry", historyError: new Error("retry") },
  ]) assert.equal(isNewChatLayout({ ...newChat, ...transient }), true);
  assert.equal(isNewChatLayout({ ...newChat, activeId: "empty", historyLoaded: true, contentLoading: true }), true);
});

test("existing histories do not flash an empty new-chat page before loading", () => {
  assert.equal(isNewChatLayout({ ...newChat, activeId: "history" }), false);
  assert.equal(isNewChatLayout({ ...newChat, activeId: "history", historyLoaded: true, hasMessages: true }), false);
  assert.equal(isNewChatLayout({ ...newChat, busy: true }), false);
});

test("side chats, embedded panels and settings keep their own layouts", () => {
  assert.equal(isNewChatLayout({ ...newChat, sideChat: true }), false);
  assert.equal(isNewChatLayout({ ...newChat, embedded: true }), false);
  assert.equal(isNewChatLayout({ ...newChat, mainView: "settings" }), false);
});


test("restoring a saved empty conversation uses a neutral shell until its history arrives", () => {
  const state = { ...newChat, activeId: "saved-empty", contentLoading: false, historyLoading: true };
  assert.equal(isChatLayoutPending(state), true);
  assert.equal(isNewChatLayout(state), false);
  const restored = { ...state, historyLoading: false, historyLoaded: true };
  assert.equal(isChatLayoutPending(restored), false);
  assert.equal(isNewChatLayout(restored), true);
  assert.equal(isChatLayoutPending({ ...state, hasMessages: true }), false);
  assert.equal(isChatLayoutPending({ ...state, embedded: true }), false);
});


test("the startup shell renders the modern frame without legacy header or composer", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/components/ChatLoadingShell.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported = {};
  new Function("require", "exports", code)(require, exported);
  const html = renderToStaticMarkup(React.createElement(exported.ChatLoadingShell, { projectName: "研究项目", label: "正在恢复对话" }));
  assert.match(html, /new-chat-shell/);
  assert.doesNotMatch(html, /new-chat-header/);
  assert.match(html, /role="status"/);
  assert.match(html, /正在恢复对话/);
  assert.doesNotMatch(html, /class="chat-header|<textarea|<form/);
});
