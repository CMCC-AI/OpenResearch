import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/workflow/AiWorkflowPrompt.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}
function harness({ accept = true, props = {} } = {}) {
  let cursor = 0;
  const slots = [], calls = [], exported = {};
  // 与 React 一致：setter 既接受值也接受函数式更新。
  const state = initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; };
  new Function("require", "exports", code)(name => {
    if (name === "react") return { ...React, useState: state };
    if (name === "lucide-react") return new Proxy({}, { get: (_, icon) => (props) => React.createElement("i", { "data-icon": String(icon), ...props }) });
    if (name === "../components/ui") return { Button: "Button" };
    return require(name);
  }, exported);
  const render = () => {
    cursor = 0;
    return nodes(exported.AiWorkflowPrompt({ onGenerate: (...args) => { calls.push(["generate", ...args]); return accept; }, ...props }));
  };
  return { render, calls };
}
const entry = tree => tree.find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("AI 排流程"));
const dialog = tree => tree.find(node => node.props?.role === "dialog" && node.props["aria-label"] === "AI 排流程");
const submit = tree => nodes(dialog(tree)).find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("生成流程"));
const textbox = tree => nodes(dialog(tree)).find(node => node.type === "textarea");

test("the AI prompt stays closed until asked and cannot open while disabled", () => {
  const tree = harness().render();
  assert.ok(entry(tree), "缺少 AI 排流程入口");
  assert.equal(entry(tree).props["aria-expanded"], false);
  assert.equal(dialog(tree), undefined);
  assert.equal(entry(harness({ props: { disabled: true } }).render()).props.disabled, true);
});

test("the AI prompt hands the sentence to the canvas and closes when accepted", () => {
  const h = harness();
  h.render();
  entry(h.render()).props.onClick();
  assert.ok(dialog(h.render()), "弹层没有打开");
  // 每一步都从最新一次渲染的树上取节点：输入会触发重渲染，旧快照上的按钮状态已过期。
  assert.equal(submit(h.render()).props.disabled, true);
  textbox(h.render()).props.onChange({ target: { value: "先检索再精读最后成稿" } });
  assert.equal(textbox(h.render()).props.value, "先检索再精读最后成稿");
  assert.equal(submit(h.render()).props.disabled, false);
  submit(h.render()).props.onClick();
  assert.deepEqual(h.calls, [["generate", "先检索再精读最后成稿"]]);
  // 开始生成后弹层收起，进度与节点预览交给画布。
  assert.equal(dialog(h.render()), undefined);
});

test("a canvas that declines the replacement keeps the prompt open so the sentence is not lost", () => {
  const h = harness({ accept: false });
  h.render();
  entry(h.render()).props.onClick();
  textbox(h.render()).props.onChange({ target: { value: "先检索再精读" } });
  submit(h.render()).props.onClick();
  assert.deepEqual(h.calls, [["generate", "先检索再精读"]]);
  assert.ok(dialog(h.render()), "弹层不该关闭");
  assert.equal(textbox(h.render()).props.value, "先检索再精读");
});

test("Escape closes the open prompt without generating", () => {
  const h = harness();
  h.render();
  entry(h.render()).props.onClick();
  // 键盘事件从弹层内冒泡到外层包装元素处理；直接调包装元素的 onKeyDown。
  const wrapper = h.render().find(node => typeof node.props?.onKeyDown === "function");
  assert.ok(wrapper, "缺少 Escape 处理");
  wrapper.props.onKeyDown({ key: "Escape", stopPropagation() {} });
  assert.equal(dialog(h.render()), undefined);
  assert.deepEqual(h.calls, []);
});
