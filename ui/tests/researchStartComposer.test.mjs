import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function("require", "exports", "requestAnimationFrame", code)((id) => id in mocks ? mocks[id] : require(id), exports, () => {});
  return exports;
}
const commands = load("composerCommands.ts", { "./paraglide/messages.js": { m: new Proxy({}, { get: (_, key) => () => key }) } });
function elements(node, predicate) {
  if (!node || typeof node !== "object") return [];
  const children = React.Children.toArray(node.props?.children);
  return [...(predicate(node) ? [node] : []), ...children.flatMap((child) => elements(child, predicate))];
}
function setup(initialDraft = "") {
  let stateIndex = 0;
  const states = [];
  let draft = initialDraft;
  let starts = 0;
  const saved = [], cached = [];
  const selection = { harness: "codex", model: "custom/model" };
  const model = () => null, menu = () => null, projectPicker = () => null, workModeSwitch = () => null;
  const component = load("product/ResearchStartPanel.tsx", {
    react: { ...React, useEffect() {}, useRef: (value) => ({ current: value }), useState: (initial) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    } },
    "@tanstack/react-router": { useNavigate: () => () => {} },
    "@tanstack/react-query": { useQuery: (options) => ({ data: options.data }), useMutation: (options) => ({ isPending: false, mutate: async (value) => { const response = await options.mutationFn(value); options.onSuccess(response); } }) },
    "../api": { reasoningFor: () => ({ choices: [], defaultId: null }), updateUiState: async (value) => { saved.push(value); return value; } },
    "../queries/settings": { getHarnessesQuery: () => ({ data: [{ id: "codex", options: { planActivation: "command" } }] }), getSkillsQuery: () => ({ data: [{ name: "literature-review@u", source: "user", description: "Review papers" }] }) },
    "../queries/projects": { getUiStateQuery: () => ({ queryKey: ["ui"], data: {} }) },
    "../queries/client": { setScopedQueryData: (key, value) => cached.push(value) },
    "../components/ModelPicker": { ModelPicker: model, defaultSelection: () => selection },
    "../components/ComposerProjectPicker": { ComposerProjectPicker: projectPicker },
    "../components/SkillMenu": { SkillMenu: menu },
    "../composerCommands": commands,
    "../materialUploads": {},
    "../components/WorkModeSwitch": { WorkModeSwitch: workModeSwitch },
    "./ProductNav": { ProductWordmark: () => null },
    "../components/ui/IconButton": { IconButton: () => null },
    "./researchCapabilities": { quickCapabilities: [] },
    "./FeaturedCases": {},
  }).ResearchStartPanel;
  const render = () => {
    stateIndex = 0;
    return component({ draft, onDraftChange: (value) => { draft = value; }, attachments: [], onAttachmentsChange() {}, onStart: () => { starts++; }, onError: (error) => { throw new Error(error); }, workMode: "normal", onWorkModeChange() {}, preferredAgent: selection, projects: [], activity: [], onSelectProject() {} });
  };
  const textarea = (tree) => elements(tree, (node) => node.type === "textarea")[0];
  const type = (value) => { textarea(render()).props.onChange({ target: { value, selectionStart: value.length } }); return render(); };
  return { render, type, textarea, model, menu, projectPicker, workModeSwitch, saved, cached, get starts() { return starts; } };
}

test("home composer uses the requested hint and protects IME input from submission", () => {
  const app = setup("研究内容");
  const input = app.textarea(app.render());
  assert.equal(input.props.placeholder, "请输入您的研究内容，输入/使用命令和技能");
  input.props.onKeyDown({ nativeEvent: { isComposing: true }, key: "Enter", preventDefault() { assert.fail("IME must not submit"); } });
  assert.equal(app.starts, 0);
  input.props.onKeyDown({ nativeEvent: {}, key: "Enter", shiftKey: true });
  assert.equal(app.starts, 0);
  input.props.onKeyDown({ nativeEvent: {}, key: "Enter", preventDefault() {} });
  assert.equal(app.starts, 1);
});

test("slash menu inserts a selected skill into the research draft without starting a project", () => {
  const app = setup();
  let tree = app.type("/lit");
  const menu = elements(tree, (node) => node.type === app.menu)[0];
  assert.equal(menu.props.skills[0].name, "literature-review@u");
  app.textarea(tree).props.onKeyDown({ nativeEvent: {}, key: "Enter", preventDefault() {} });
  assert.match(app.textarea(app.render()).props.value, /^\/literature-review\^ /);
  assert.equal(app.starts, 0);
});

test("model command opens the existing picker and model settings update the shared preference", async () => {
  const app = setup();
  const tree = app.type("/model");
  app.textarea(tree).props.onKeyDown({ nativeEvent: {}, key: "Tab", preventDefault() {} });
  const picker = elements(app.render(), (node) => node.type === app.model)[0];
  assert.equal(picker.props.openRequest, 1);
  assert.equal(app.textarea(app.render()).props.value, "");
  const preference = { harness: "codex", model: "another/custom-model" };
  await picker.props.onSelect(preference);
  assert.deepEqual(app.saved, [{ preferredAgent: preference }]);
  assert.deepEqual(app.cached, app.saved);
  assert.equal(app.starts, 0);
});


test("mode control stays inside the composer and project selection sits outside it", () => {
  const app = setup();
  const tree = app.render();
  const form = elements(tree, (node) => node.type === "form")[0];
  assert.equal(elements(form, (node) => node.type === app.projectPicker).length, 0);
  assert.equal(elements(tree, (node) => node.type === app.projectPicker).length, 1);
  const mode = elements(form, (node) => node.type === app.workModeSwitch)[0];
  assert.equal(mode.props.compact, true);
});
