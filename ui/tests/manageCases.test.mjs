import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

function page({ projects = [], projectState = "success", status = "draft", research = true, failure = null, sessions = [], extraCases = [], sourceSessionId } = {}) {
  const item = { id: "saved", source_project_id: "gone", title: "历史项目", status, revision: 7, created_at: "2026-01-01" };
  if (sourceSessionId) item.source_session_id = sourceSessionId;
  const states = [], calls = [], invalidations = [];
  let cursor = 0;
  const output = ts.transpileModule(readFileSync(new URL("../src/product/ManageCasesPage.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const dependencies = {
    react: { useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], (value) => { states[index] = value; }]; } },
    "react/jsx-runtime": jsx,
    "@tanstack/react-query": {
      useQuery: ({ queryKey }) => queryKey[0] === "case-source-projects"
        ? { data: projectState === "success" ? projects : undefined, isSuccess: projectState === "success", error: projectState === "error" ? new Error("offline") : null }
        : queryKey[0] === "case-source-sessions" ? { data: sessions, isSuccess: true }
        : { data: { cases: [item, ...extraCases] } },
      useQueryClient: () => ({ invalidateQueries: async (key) => invalidations.push(key) }),
    },
    "@tanstack/react-router": { Link: "a" },
    "../api": { listProjects: async () => projects, listChatSessions: async () => sessions },
    "../components/ui": { Button: "button" },
    "./AuthSession": { useAuthSession: () => ({ user: { id: "admin", isAdmin: true }, canAccessResearch: research }) },
    "./FeaturedCases": { useCasesBase: () => "" },
    "./addProjectToCases": { addProjectToCases: async (...args) => calls.push(["capture", ...args]) },
    "./featuredCasesApi": {
      caseRequest: async (...args) => { calls.push(["request", ...args]); if (failure) throw new Error(failure); },
      caseWrite: async (...args) => { calls.push(["write", ...args]); if (failure) throw new Error(failure); },
    },
  };
  new Function("require", "exports", output)((id) => { assert.ok(id in dependencies, id); return dependencies[id]; }, exports);
  function render() { cursor = 0; return exports.ManageCasesPage({ initialProject: "gone" }); }
  function nodes(value) { return Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : []; }
  function text(value) { return Array.isArray(value) ? value.map(text).join("") : value?.props ? text(value.props.children) : typeof value === "string" ? value : ""; }
  const button = (label) => nodes(render()).find((node) => node.type === "button" && text(node) === label);
  return { render, nodes, text, button, calls, invalidations };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("orphaned drafts explain source availability, disable stale selection, and expose snapshot actions", () => {
  const p = page();
  assert.match(p.text(p.render()), /当前工作空间未找到原项目/);
  assert.equal(p.nodes(p.render()).find((node) => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.ok(p.button("发布已保存副本"));
  assert.ok(p.button("删除草稿"));
  assert.equal(p.button("从原项目更新并加入"), undefined);
});

test("saved copies publish with reviewed revision without accessing a missing project or research runtime", async () => {
  const p = page({ research: false });
  p.button("发布已保存副本").props.onClick();
  assert.equal(p.calls.length, 0);
  p.button("已审核，确认发布").props.onClick();
  await settle();
  assert.deepEqual(p.calls, [["write", "", "admin/cases/saved/publish", { revision: 7, reviewed: true }]]);
  assert.equal(p.invalidations.length, 3);
});

test("deleting a historical draft requires confirmation and never deletes the source project", async () => {
  const p = page();
  p.button("删除草稿").props.onClick();
  p.button("取消").props.onClick();
  assert.equal(p.calls.length, 0);
  assert.equal(p.button("确认删除草稿"), undefined);
  p.button("删除草稿").props.onClick();
  p.button("确认删除草稿").props.onClick();
  await settle();
  assert.deepEqual(p.calls, [["request", "", "admin/cases/saved", { method: "DELETE" }]]);
});

test("published snapshots remain readable and removable but cannot be directly deleted", () => {
  const p = page({ status: "published" });
  assert.ok(p.button("移出案例集"));
  assert.equal(p.button("删除草稿"), undefined);
  assert.equal(p.button("发布已保存副本"), undefined);
  assert.match(p.text(p.render()), /查看案例副本/);
});

test("loading and failed project queries do not claim sources are missing", () => {
  for (const projectState of ["pending", "error"]) {
    const p = page({ projectState });
    assert.doesNotMatch(p.text(p.render()), /当前工作空间未找到原项目/);
    assert.ok(p.button("发布已保存副本"));
  }
  assert.ok(page({ projects: [{ id: "gone", name: "available" }] }).button("从原项目更新并加入"));
});

test("incomplete copies and revision conflicts surface server errors and stay unpublished", async () => {
  const p = page({ failure: "成果文件尚未复制完整，不能发布" });
  p.button("发布已保存副本").props.onClick();
  p.button("已审核，确认发布").props.onClick();
  await settle();
  assert.match(p.text(p.render()), /成果文件尚未复制完整，不能发布/);
  assert.ok(p.button("已审核，确认发布"));
  assert.equal(p.calls.length, 1);
});

test("one project's conversations remain separate from its published whole-project case", async () => {
  const p = page({ projects: [{ id: "gone", name: "project" }], status: "published", sessions: [{ id: "one", title: "first" }, { id: "two", title: "second" }], extraCases: [{ id: "second-case", source_project_id: "gone", source_session_id: "two", title: "second", status: "published" }] });
  const selects = () => p.nodes(p.render()).filter(node => node.type === "select");
  assert.equal(selects().length, 2);
  selects()[1].props.onChange({ target: { value: "one" } });
  const form = p.nodes(p.render()).find(node => node.type === "form");
  const submit = p.nodes(p.render()).find(node => node.props.type === "submit");
  assert.equal(submit.props.disabled, false);
  form.props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(p.calls[0][4], undefined);
  assert.equal(p.calls[0][5], "one");
  assert.equal(p.nodes(p.render()).filter(node => node.type === "article").length, 2);
  selects()[1].props.onChange({ target: { value: "two" } });
  assert.equal(p.button("已在案例集中").props.disabled, true);
  selects()[0].props.onChange({ target: { value: "other-project" } });
  assert.equal(selects()[0].props.value, "other-project");
});

test("updating a conversation draft retains its original conversation scope", async () => {
  const p = page({ projects: [{ id: "gone", name: "project" }], sourceSessionId: "one" });
  p.button("从原项目更新并加入").props.onClick();
  await settle();
  assert.equal(p.calls[0][4], "saved");
  assert.equal(p.calls[0][5], "one");
});

test("case scope lists only the two main conversations, hiding expert and side conversations", () => {
  const p = page({ projects: [{ id: "gone", name: "论文撰写" }], sessions: [
    { id: "greeting", title: "Greeting" },
    { id: "paper", title: "非洲绿氢输欧竞争力研究" },
    { id: "expert", title: "内部专家", parentSessionId: "paper" },
    { id: "side", title: "侧边讨论", sideParentSessionId: "paper" },
  ] });
  const select = p.nodes(p.render()).filter(node => node.type === "select")[1];
  assert.deepEqual(p.nodes(select).filter(node => node.type === "option").map(node => node.props.value), ["", "greeting", "paper"]);
  assert.doesNotMatch(p.text(select), /内部专家|侧边讨论/);
});
