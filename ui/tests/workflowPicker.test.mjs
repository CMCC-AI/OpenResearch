import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { createLiteratureDraft } from "../src/workflow/model.ts";
import { stageWorkflowConversation, takeWorkflowConversation, workflowConversationRequest } from "../src/workflow/conversation.ts";
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/workflow/WorkflowPicker.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const draft = (id, projectId) => ({ ...createLiteratureDraft(), id, projectId, name: `方法 ${id}`, createdAt: 1, updatedAt: 1 });
const library = [draft("global", ""), draft("project", "project"), draft("other", "other-project")];
function nodes(tree) { return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)] : []; }
function harness({ choices = library, error = null, sessionId = "current-chat" } = {}) {
  let cursor = 0;
  const slots = [], calls = [], exported = {};
  const state = initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = next; }]; };
  new Function("require", "exports", code)(name => {
    if (name === "react") return { ...React, useState: state };
    if (name === "@tanstack/react-query") return { useQuery: ({ queryKey }) => ({ data: queryKey[0] === "workflowAgents" ? [] : choices, isPending: false, error, refetch() {} }) };
    if (name === "../queries/client") return { workspaceKey: (...parts) => parts };
    if (name === "../components/ui") return { Button: "Button", Spinner: "Spinner" };
    if (name === "./conversation") return { stageWorkflowConversation: (...args) => { calls.push(["stage", ...args]); stageWorkflowConversation(...args); } };
    if (name === "../api") return {};
    return require(name);
  }, exported);
  const render = () => { cursor = 0; return nodes(exported.WorkflowPicker({ projectId: "project", sessionId, onEdit: (...args) => calls.push(["edit", ...args]), onOpenSession: (...args) => calls.push(["open", ...args]) })); };
  return { render, calls, select: id => render().find(node => node.type === "input" && node.props.value === id).props.onChange(), submit: () => render().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }) };
}

test("shared workflow selection only stages a request in the existing chat", () => {
  for (const source of library) {
    const h = harness();
    assert.equal(h.render().find(node => node.props.type === "submit").props.disabled, true);
    h.select(source.id);
    assert.equal(h.render().filter(node => node.type === "li").length, source.tasks.length);
    assert.equal(h.render().some(node => node.type === "textarea"), false);
    h.submit();
    assert.deepEqual(h.calls, [["stage", "project", "current-chat", source], ["open", "current-chat", "project"]]);
    assert.equal(takeWorkflowConversation("project", "current-chat"), workflowConversationRequest(source));
  }
});

test("new-chat selection stages text without creating a session or research", () => {
  const h = harness({ sessionId: null }); h.select(library[0].id); h.submit();
  assert.deepEqual(h.calls.at(-1), ["open", "new", "project"]);
  assert.ok(takeWorkflowConversation("project", null));
  assert.equal(takeWorkflowConversation("project", null), null);
});

test("handoffs stay scoped to their project and chat and are consumed only once", () => {
  stageWorkflowConversation("first", "one", library[0]);
  assert.equal(takeWorkflowConversation("first", "two"), null);
  assert.equal(takeWorkflowConversation("second", "one"), null);
  assert.equal(takeWorkflowConversation("first", "one"), workflowConversationRequest(library[0]));
  assert.equal(takeWorkflowConversation("first", "one"), null);
});

test("empty or failed libraries do not create a research or stage a default method", () => {
  for (const options of [{ choices: [] }, { error: new Error("offline") }]) {
    const h = harness(options);
    assert.equal(h.render().some(node => node.type === "form"), false);
    assert.deepEqual(h.calls, []);
  }
});

test("management actions still open the template or the requested saved method", () => {
  const h = harness();
  h.render().find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("新建工作流")).props.onClick();
  h.render().find(node => node.type === "button" && node.props["aria-label"] === `编辑 ${library[1].name}`).props.onClick();
  assert.deepEqual(h.calls, [["edit", null], ["edit", library[1].id]]);
});

test("an incomplete saved method cannot be used through the library shortcut", () => {
  const h = harness({ choices: [{ ...library[0], tasks: [] }] }); h.select(library[0].id);
  assert.equal(h.render().find(node => node.props.type === "submit").props.disabled, true);
});
