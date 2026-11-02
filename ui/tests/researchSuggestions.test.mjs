import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { resolveStarterPrompts } from "../src/starterPrompts.ts";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/product/ResearchSuggestions.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

test("home suggestions keep working defaults for loading, failures, blank and empty responses", () => {
  for (const data of [undefined, { blank: true, prompts: null }, { blank: false, prompts: [] },
    { blank: false, prompts: [{ title: "本项目", prompt: "继续研究" }] }]) {
    const exports = {}, selected = [];
    const mocks = {
      "@tanstack/react-query": { useQuery: () => ({ data }) },
      "../queries/projects": { getProjectStarterPromptsQuery: () => ({}) },
      "../starterPrompts": { resolveStarterPrompts },
      "../paraglide/runtime.js": { getLocale: () => "zh-CN" },
      "../paraglide/messages.js": { m: new Proxy({}, { get: (_, key) => () => String(key) }) },
    };
    new Function("require", "exports", code)(name => mocks[name] ?? require(name), exports);
    const tree = exports.ResearchSuggestions({ projectId: "p", harness: "codex", model: null, onPick: prompt => selected.push(prompt) });
    const buttons = React.Children.toArray(tree.props.children);
    assert.equal(buttons.length, data?.prompts?.length ? 1 : 4);
    buttons[0].props.onClick();
    assert.equal(selected.length, 1);
    const html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /<img|new-chat-starter|猜你想问|我们应该研究什么/);
    assert.match(html, /type="button"/);
  }
});
