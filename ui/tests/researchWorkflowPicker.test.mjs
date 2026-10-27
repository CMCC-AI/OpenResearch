import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as research from "../src/research.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/WorkModeSwitch.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exported = {};
new Function("require", "exports", code)((name) => {
  if (name === "../research") return research;
  if (name === "./ModelPicker") return { usePopover: () => ({ open: true, setOpen() {}, ref: { current: null } }) };
  if (name === "./ResearchModulePreview") return { ResearchModulePreview: "ProfilePreview" };
  return require(name);
}, exported);
function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}
test("work modes retain their names and show exactly two top-level categories", () => {
  const changes = [];
  const tree = nodes(exported.WorkModeSwitch({ value: "normal", onChange: (value) => changes.push(value) }));
  const select = tree.find((node) => node.props["aria-label"] === "工作模式大类");
  const options = nodes(select).filter((node) => node.type === "option");
  assert.deepEqual(options.map((node) => [node.props.value, node.props.children]), [["normal", "工作模式"], ["team", "专家团模式"]]);
  assert.ok(!tree.some((node) => node.props["aria-label"] === "科研专家团预设子模式"));
  select.props.onChange({ target: { value: "team" } });
  assert.deepEqual(changes, ["team"]);
});
test("team workflows have a separate selector and changes preserve team category", () => {
  for (const value of research.presetWorkflowModes) {
    const changes = [];
    const tree = nodes(exported.WorkModeSwitch({ value, onChange: (mode) => changes.push(mode) }));
    const category = tree.find((node) => node.props["aria-label"] === "工作模式大类");
    const workflow = tree.find((node) => node.props["aria-label"] === "科研专家团预设子模式");
    assert.equal(category.props.value, "team");
    assert.equal(workflow.props.value, value);
    assert.deepEqual(nodes(workflow).filter((node) => node.type === "option").map((node) => node.props.value), ["team", ...research.presetWorkflowModes]);
    for (const mode of research.presetWorkflowModes) workflow.props.onChange({ target: { value: mode } });
    assert.deepEqual(changes, research.presetWorkflowModes);
    category.props.onChange({ target: { value: "team" } });
    assert.equal(changes.at(-1), value);
    category.props.onChange({ target: { value: "normal" } });
    assert.equal(changes.at(-1), "normal");
    assert.equal(tree.find((node) => node.type === "ProfilePreview").props.mode, value);
  }
});
test("persisted studies display category and submode separately without allowing changes", () => {
  for (const value of ["normal", ...research.presetWorkflowModes, "team", "diagnosis"]) {
    const tree = nodes(exported.WorkModeSwitch({ value, onChange() { throw new Error("unexpected mutation"); }, readOnly: true }));
    assert.ok(!tree.some((node) => node.type === "select"));
    const text = tree.filter((node) => node.type === "span").flatMap((node) => React.Children.toArray(node.props.children)).filter((child) => typeof child === "string");
    assert.ok(text.includes(value === "normal" ? "工作模式" : "专家团模式"));
    if (research.presetWorkflowModes.includes(value)) assert.ok(text.includes(`指定流程：${research.researchModes[value]}`));
  }
});

test("team mode defaults to automatic routing and allows opting in and out of a preset", () => {
  const changes = [];
  const tree = nodes(exported.WorkModeSwitch({ value: "team", onChange: (mode) => changes.push(mode) }));
  const workflow = tree.find((node) => node.props["aria-label"] === "科研专家团预设子模式");
  assert.equal(workflow.props.value, "team");
  assert.deepEqual(nodes(workflow).filter((node) => node.type === "option").map((node) => node.props.value), ["team", ...research.presetWorkflowModes]);
  workflow.props.onChange({ target: { value: "analysis" } });
  workflow.props.onChange({ target: { value: "team" } });
  assert.deepEqual(changes, ["analysis", "team"]);
  const readonly = nodes(exported.WorkModeSwitch({ value: "team", activeWorkflow: "proposal", readOnly: true, onChange() {} }));
  assert.ok(readonly.some((node) => node.props.children === "自动判断 · 当前流程：Idea 到实验方案"));
});

test("compact mode menu switches modes and preset workflows directly without a nested selector", () => {
  const changes = [];
  for (const value of ["normal", "team", ...research.presetWorkflowModes]) {
    const compact = exported.WorkModeSwitch({ value, onChange: (mode) => changes.push(mode), compact: true });
    const tree = nodes(compact.type(compact.props));
    assert.equal(tree.some((node) => node.type === "select"), false);
    const items = tree.filter((node) => node.props.role === "menuitemradio");
    assert.equal(items.length, 2 + research.presetWorkflowModes.length);
    assert.equal(items.filter((node) => node.props["aria-checked"]).length, 1);
    for (const item of items) item.props.onClick();
    assert.deepEqual(changes.splice(0), ["normal", "team", ...research.presetWorkflowModes]);
  }
});
