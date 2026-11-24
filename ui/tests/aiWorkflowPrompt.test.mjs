import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { generatedToDraftInput } from "../src/workflow/model.ts";
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/workflow/AiWorkflowPrompt.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
const chain = (...ids) => ids.map((id, index) => ({ id, role: "as-research-synthesizer", brief: "b", dependsOn: index ? [ids[index - 1]] : [], outputs: [`${id}/result.md`] }));

function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}
function harness({ generated = null, accept = true } = {}) {
  let cursor = 0;
  const slots = [], calls = [], exported = {};
  // 与 React 一致：setter 既接受值也接受函数式更新。
  const state = initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; };
  new Function("require", "exports", code)(name => {
    if (name === "react") return { ...React, useState: state };
    if (name === "lucide-react") return new Proxy({}, { get: (_, icon) => (props) => React.createElement("i", { "data-icon": String(icon), ...props }) });
    if (name === "../locale") return { useLocale: () => "zh-CN" };
    if (name === "../components/ui") return { Button: "Button", Spinner: "Spinner", showAlert: (...args) => calls.push(["alert", ...args]) };
    if (name === "../api") return { generateWorkflowDraft: async (body) => { calls.push(["generate", body]); if (generated instanceof Error) throw generated; return generated; } };
    if (name === "./model") return { generatedToDraftInput };
    return require(name);
  }, exported);
  const render = (props = {}) => { cursor = 0; return nodes(exported.AiWorkflowPrompt({ onGenerated: (...args) => { calls.push(["generated", ...args]); return accept; }, ...props })); };
  return { render, calls };
}
const entry = tree => tree.find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("AI 排流程"));
const findLabelled = (tree, label) => tree.find(node => node.props?.role === "dialog" && node.props["aria-label"] === label);

test("the AI prompt stays closed until asked and cannot open while disabled", () => {
  const tree = harness().render();
  assert.ok(entry(tree), "缺少 AI 排流程入口");
  assert.equal(entry(tree).props["aria-expanded"], false);
  assert.equal(findLabelled(tree, "AI 排流程"), undefined);
  assert.equal(harness().render({ disabled: true }).find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("AI 排流程")).props.disabled, true);
});

test("the AI prompt sends the sentence with the UI locale and hands back a laid-out draft", async () => {
  const generated = { name: "综述流水线", tasks: chain("search", "read", "write") };
  const h = harness({ generated });
  entry(h.render()).props.onClick();
  assert.ok(findLabelled(h.render(), "AI 排流程"), "弹层没有打开");
  // 每一步都从最新一次渲染的树上取节点：输入会触发重渲染，旧快照上的按钮状态已过期。
  const submit = () => nodes(findLabelled(h.render(), "AI 排流程")).find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("生成流程"));
  const textbox = () => nodes(findLabelled(h.render(), "AI 排流程")).find(node => node.type === "textarea");
  // 一句话为空时不能提交。
  assert.equal(submit().props.disabled, true);
  textbox().props.onChange({ target: { value: "先检索再精读最后成稿" } });
  assert.equal(textbox().props.value, "先检索再精读最后成稿");
  assert.equal(submit().props.disabled, false);
  submit().props.onClick();
  await settle();
  assert.deepEqual(h.calls.filter(call => call[0] === "generate"), [["generate", { intent: "先检索再精读最后成稿", locale: "zh-CN" }]]);
  const handed = h.calls.find(call => call[0] === "generated");
  assert.ok(handed, "生成稿没有交给画布");
  assert.equal(handed[1].name, "综述流水线");
  // 坐标已按依赖分层排好：三步链自上而下走。
  assert.deepEqual(handed[1].positions, { search: { x: 0, y: 0 }, read: { x: 0, y: 300 }, write: { x: 0, y: 600 } });
  // 生成成功后弹层收起。
  assert.equal(findLabelled(h.render(), "AI 排流程"), undefined);
});

test("a failed generation reports the reason and hands nothing to the canvas", async () => {
  const h = harness({ generated: new Error("没有可用的对话引擎") });
  entry(h.render()).props.onClick();
  const submit = () => nodes(findLabelled(h.render(), "AI 排流程")).find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("生成流程"));
  nodes(findLabelled(h.render(), "AI 排流程")).find(node => node.type === "textarea").props.onChange({ target: { value: "来一条流程" } });
  submit().props.onClick();
  await settle();
  assert.deepEqual(h.calls.filter(call => call[0] === "alert"), [["alert", "没有可用的对话引擎", "error"]]);
  assert.ok(!h.calls.some(call => call[0] === "generated"));
});

test("a canvas that declines the draft keeps the prompt open so the sentence is not lost", async () => {
  const h = harness({ generated: { name: "综述流水线", tasks: chain("search", "read") }, accept: false });
  entry(h.render()).props.onClick();
  nodes(findLabelled(h.render(), "AI 排流程")).find(node => node.type === "textarea").props.onChange({ target: { value: "先检索再精读" } });
  nodes(findLabelled(h.render(), "AI 排流程")).find(node => node.type === "Button" && JSON.stringify(node.props.children).includes("生成流程")).props.onClick();
  await settle();
  assert.deepEqual(h.calls.filter(call => call[0] === "generated").length, 1);
  // 画布没采用：弹层不关，输入还在，可以直接再来一次。
  assert.ok(findLabelled(h.render(), "AI 排流程"), "弹层不该关闭");
  assert.equal(nodes(findLabelled(h.render(), "AI 排流程")).find(node => node.type === "textarea").props.value, "先检索再精读");
});
