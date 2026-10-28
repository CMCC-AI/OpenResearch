import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as readOnlyApi from "../src/readOnlyApi.ts";
import { stripAppBase } from "../src/appBasePath.ts";

const require = createRequire(import.meta.url);
function load(path, stubs) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => name in stubs ? stubs[name] : require(name), exports);
  return exports;
}

function mountCase(id = "example") {
  let effect;
  let listener;
  let resets = 0;
  const clientModule = load("../src/queries/client.ts", { "../readOnlyApi": readOnlyApi });
  const client = clientModule.queryClient;
  const queries = load("../src/queries/projects.ts", {
    "./client": clientModule,
    "./live": { readLiveSnapshot: (_client, _key, read) => read() },
    "../api": { listProjects: async (signal) => (await (await readOnlyApi.projectRequest("/api/projects", { signal })).json()).projects },
  });
  const { ReadOnlyProject } = load("../src/product/ReadOnlyProject.tsx", {
    react: { useLayoutEffect: (fn) => { effect = fn; }, useMemo: (fn) => fn(), useState: () => [false, () => {}] },
    "@tanstack/react-router": {
      useRouter: () => ({ subscribe: (event, fn) => { assert.equal(event, "onBeforeLoad"); listener = fn; return () => { listener = null; }; } }),
      useRouterState: () => ({ searchStr: "" }),
    },
    "../App": { default: () => null },
    "../appBasePath": { stripAppBase },
    "./ProductNav": { PlatformFrame: () => null },
    "../useProjectWorkspace": { clearProjectWorkspaceCache: () => { resets++; } },
    "../workspacePersistence": { resetGlobalWorkspace: () => { resets++; } },
    "../RemoteRuntime": { useRuntime: () => ({ kind: "local" }) },
    "../queries/client": { queryClient: client },
    "../readOnlyApi": readOnlyApi,
    "../workspaceState": { parsePane: () => undefined },
    "../components/ReadOnlyWorkspace": {},
  });
  ReadOnlyProject({ id, base: "", admin: false, workspace: { projectId: "case-project", sessionId: "case-chat", assets: {}, responses: { "/api/projects": { projects: [{ id: "case-project" }] } } } });
  const cleanup = effect();
  return { client, queries, navigate: (pathname) => listener({ toLocation: { pathname } }), cleanup, resets: () => resets };
}

for (const path of ["/projects", "/projects/personal/tasks/new", "/mobilesci/projects"]) {
  test(`leaving a case for ${path} restores personal queries before unmount`, async () => {
    const page = mountCase();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ projects: [{ id: "personal" }] });
    try {
      assert.deepEqual(await page.client.fetchQuery(page.queries.listProjectsQuery()), [{ id: "case-project" }]);
      page.navigate(path);
      assert.equal(readOnlyApi.getReadOnlyApi(), null);
      const options = page.queries.listProjectsQuery();
      assert.equal(typeof options.queryKey[1], "number");
      assert.deepEqual(await page.client.fetchQuery(options), [{ id: "personal" }]);
      const resets = page.resets();
      page.cleanup();
      assert.equal(page.resets(), resets, "late unmount must not reset the incoming workspace again");
      assert.deepEqual(page.client.getQueryData(options.queryKey), [{ id: "personal" }]);
    } finally { page.cleanup(); globalThis.fetch = originalFetch; page.client.clear(); }
  });
}

test("switching case conversations retains the case source; opening another case releases it", () => {
  const page = mountCase();
  try {
    page.navigate("/mobilesci/cases/example");
    assert.equal(readOnlyApi.getReadOnlyApi()?.id, "example");
    page.navigate("/cases/another");
    assert.equal(readOnlyApi.getReadOnlyApi(), null);
  } finally { page.cleanup(); page.client.clear(); }
});
