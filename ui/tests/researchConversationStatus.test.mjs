import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { researchConversationStatus } from "../src/researchConversationStatus.ts";

const task = (state = "running") => ({ id: "task", role: "as-literature-researcher", state, sessionId: "expert", artifacts: [], runIds: [], dependsOn: [], outputs: [], brief: "read" });
const decision = (status, version = 1, gate = "G4") => ({ id: `${gate}-${version}`, gate, status, version });
const study = (tasks = [task()], decisions = []) => ({ id: "study", sessionId: "lead", mode: "team", status: "active", plans: [{ version: 1, tasks }], decisions, claims: [] });
const status = (value, options = {}) => researchConversationStatus(value, { busy: false, stopping: false, waitingForInput: false, busySessions: new Set(), runs: [], ...options });

test("an idle lead with dispatched experts keeps the research visibly in progress", () => {
  const value = study();
  const waiting = status(value);
  assert.equal(waiting.kind, "experts");
  assert.match(waiting.label, /主理人正在等待专家结果/);
  assert.match(waiting.placeholder, /可以补充要求或提出问题/);
  assert.equal(status(value, { busy: true }).kind, "working");
  // A live child overrides a delayed persisted task state; unrelated sessions do not.
  value.plans[0].tasks[0].state = "pending";
  assert.equal(status(value, { busySessions: new Set(["expert"]) }).kind, "experts");
  assert.equal(status(value, { busySessions: new Set(["unrelated"]) }).kind, "idle");
});

test("pending confirmation stays visible even while another expert is working", () => {
  const current = status(study([task()], [decision("pending")]));
  assert.equal(current.kind, "confirmation");
  assert.match(current.label, /待你确认 · 1 项/);
  assert.match(current.label, /1 项专家任务处理中/);
  assert.equal(status(study(), { busy: true, waitingForInput: true }).kind, "confirmation");
});

test("completion requires accepted tasks and the current plan's result confirmation", () => {
  const value = study([task("completed")]);
  assert.equal(status(value).kind, "attention");
  assert.match(status(value).label, /交付确认尚未生成/);
  value.deliveryError = "证据日志已变化，需要重新审查";
  assert.match(status(value).label, /交付确认受阻.*证据日志已变化/);
  value.deliveryError = null;
  value.decisions = [decision("approved", 0)];
  assert.notEqual(status(value).kind, "complete");
  value.decisions.push(decision("approved"));
  assert.equal(status(value).kind, "complete");
  assert.equal(status(value, { busy: true }).kind, "working");
  assert.equal(status(value, { busySessions: new Set(["expert"]) }).kind, "experts");
  for (const runState of ["starting", "running", "unknown"]) {
    assert.equal(status(value, { runs: [{ id: "run", status: runState }] }).kind, "experts");
  }
  assert.equal(status(value, { runs: [{ id: "run", status: "done" }] }).kind, "complete");
  value.plans[0].tasks.push(task("pending"));
  assert.notEqual(status(value).kind, "complete");
});

test("routed proposal studies use G3 confirmation without implying experiment execution", () => {
  const value = study([task("completed")], [decision("approved", 1, "G4")]);
  value.plans[0].workflow = "proposal";
  assert.notEqual(status(value).kind, "complete");
  value.decisions.push(decision("approved", 1, "G3"));
  assert.equal(status(value).kind, "complete");
});

test("failed, stopped, unavailable, and unplanned studies never appear completed", () => {
  assert.equal(status(study([task("failed")])).kind, "attention");
  assert.equal(status(study([task("completed")], [decision("rejected")])).kind, "attention");
  assert.equal(status(study([])).kind, "idle");
  assert.match(status({ ...study(), status: "stopped" }).label, /已停止/);
  assert.match(status(study(), { stopping: true }).label, /停止主理人的当前回复/);
  assert.equal(status(study([task("completed")], [decision("approved")]), { unavailable: true }).kind, "attention");
});

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/ResearchConversationStatus.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exported = {};
new Function("require", "exports", code)(require, exported);

test("the status is announced and offers progress navigation without a stop control", () => {
  const props = { status: status(study()), onOpen() {} };
  const html = renderToStaticMarkup(React.createElement(exported.ResearchConversationStatus, props));
  assert.match(html, /role="status"/);
  assert.match(html, /主理人正在等待专家结果/);
  assert.match(html, /<button/);
  assert.doesNotMatch(html, /停止/);
  const nonInteractive = renderToStaticMarkup(React.createElement(exported.ResearchConversationStatus, { status: props.status }));
  assert.doesNotMatch(nonInteractive, /<button/);
});
