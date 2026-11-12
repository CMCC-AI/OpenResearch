import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

const source = readFileSync(new URL("../src/routePages.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function home(projects, state) {
  let query = 0;
  const empty = new Proxy({}, { get: () => () => null });
  const mocks = {
    react: { ...React, useEffect() {}, useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    "react/jsx-runtime": jsx,
    "@tanstack/react-query": { useQuery: () => [projects, state][query++], isCancelledError: () => false },
    "@tanstack/react-router": { useRouteContext: () => ({ queryClient: {} }), useNavigate: () => () => {}, useSearch: () => ({}) },
    "./RemoteRuntime": { useRuntime: () => ({ kind: "local" }) },
    "./queries/projects": { listProjectsQuery: () => ({}), getUiStateQuery: () => ({}) },
    "./product/CloudWorkspace": { isCloudWorkspace: () => false },
    "./components/UpdateBanner": { useUpdateStatus: () => ({ status: null }) },
    "./components/ProjectsHome": { ProjectsHome: "ProjectsHome" },
    "./product/ProductNav": { PlatformFrame: "PlatformFrame" },
  };
  const exports = {};
  new Function("require", "exports", code)(name => mocks[name] ?? empty, exports);
  return exports.ProjectsPage();
}
function find(node, type) {
  if (!node || typeof node !== "object") return null;
  if (node.type === type) return node;
  const children = React.Children.toArray(node.props?.children);
  for (const child of children) { const result = find(child, type); if (result) return result; }
  return null;
}

test("the real research home mounts its composer before project data or preferences arrive", () => {
  const tree = home({ data: undefined }, { data: undefined });
  const page = find(tree, "ProjectsHome");
  assert.ok(page, "the home must not be replaced by a preparation or loading page");
  assert.deepEqual(page.props.projects, []);
  assert.equal(page.props.projectsLoading, true);
  assert.equal(page.props.preferredAgent, null);
});

test("loaded project data uses the same home component", () => {
  const projects = [{ id: "mine" }];
  const page = find(home({ data: projects }, { data: { preferredAgent: null } }), "ProjectsHome");
  assert.equal(page.props.projects, projects);
  assert.equal(page.props.projectsLoading, false);
});
