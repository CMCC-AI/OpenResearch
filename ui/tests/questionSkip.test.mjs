import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as bashCommand from "../src/bashCommand.ts";
import * as chatRecovery from "../src/chatRecovery.ts";
import * as chatRendering from "../src/chatRendering.ts";
import * as orxCommand from "../src/orxCommand.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/ChatPanel.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const stub = new Proxy({}, { get: (_, name) => (name === "__esModule" ? false : () => null) });
const mocks = {
  "../paraglide/messages.js": { m: new Proxy({}, { get: (_, name) => () => String(name) }) },
  "../paraglide/runtime.js": { getLocale: () => "en" },
  "../i18n": { ltr: String, autoDir: String },
  "../bashCommand": bashCommand,
  "../chatRecovery": chatRecovery,
  "../chatRendering": chatRendering,
  "../orxCommand": orxCommand,
  "@tanstack/react-router": { useNavigate: () => () => {} },
  "./ui": new Proxy({}, {
    get: (_, name) => (name === "Button" ? ({ children }) => React.createElement("button", null, children) : stub[name]),
  }),
};
const exports = {};
new Function("require", "exports", compiled)(
  (name) => mocks[name] ?? (name.startsWith(".") ? stub : require(name)),
  exports,
);
const renderMessage = (parts) => renderToStaticMarkup(React.createElement(exports.Message, {
  message: { id: "msg-1", role: "assistant", parts, createdAt: 0, completedAt: 1000 },
  activePermissionId: null,
  forkDisabled: false,
  branchDisabled: false,
  onFork: () => {},
  onSelectFork: () => {},
  onRecover: () => {},
  onRespond: () => {},
}));


const question = (overrides = {}) => ({ id: "question", type: "prompt", prompt: {
  kind: "question", resolved: false, question: "Synthetic question?", nativeId: "request",
  options: [{ label: "Option A" }], ...overrides,
} });

test("native questions expose the correct skip scope without changing other harnesses", () => {
  assert.match(renderMessage([question({ skipScope: "question" })]), /chat_skip_question</);
  assert.match(renderMessage([question({ skipScope: "form" })]), /chat_skip_questions</);
  assert.doesNotMatch(renderMessage([question()]), /chat_skip_question/);
});

test("skipped questions never display stale choices or notes as an answer", () => {
  const html = renderMessage([question({ skipScope: "question", resolved: true, approved: false,
    answers: ["Stale selection"], note: "Stale custom answer" })]);
  assert.match(html, /chat_question_skipped/);
  assert.doesNotMatch(html, /Stale selection|Stale custom answer|class="sel"/);
});

test("answered and stale-closed questions retain distinct outcomes", () => {
  assert.match(renderMessage([question({ skipScope: "question", resolved: true, approved: true, answers: ["Option A"] })]), /Option A/);
  const stale = renderMessage([question({ skipScope: "question", resolved: true })]);
  assert.match(stale, /chat_resolved/);
  assert.doesNotMatch(stale, /chat_question_skipped/);
});
