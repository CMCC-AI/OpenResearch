import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { isChatLayoutPending } from "../src/chatLayout.ts";

const newChat = { mainView: "chat", embedded: false, hasMessages: false, busy: false, contentLoading: false, historyLoading: false };

test("conversation loading uses a neutral shell and resolves to a normal conversation", () => {
  assert.equal(isChatLayoutPending({ ...newChat, historyLoading: true }), true);
  assert.equal(isChatLayoutPending({ ...newChat, contentLoading: true }), true);
  assert.equal(isChatLayoutPending(newChat), false);
  assert.equal(isChatLayoutPending({ ...newChat, historyLoading: true, hasMessages: true }), false);
  assert.equal(isChatLayoutPending({ ...newChat, historyLoading: true, embedded: true }), false);
});

test("the startup shell renders the modern frame without legacy header or composer", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/components/ChatLoadingShell.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported = {};
  new Function("require", "exports", code)(require, exported);
  const html = renderToStaticMarkup(React.createElement(exported.ChatLoadingShell, { projectName: "研究项目", label: "正在恢复对话" }));
  assert.match(html, /conversation-loading-shell/);
  assert.doesNotMatch(html, /new-chat-header/);
  assert.match(html, /role="status"/);
  assert.match(html, /正在恢复对话/);
  assert.doesNotMatch(html, /class="chat-header|<textarea|<form/);
});
