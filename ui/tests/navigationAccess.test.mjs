import * as appBase from "../src/appBasePath.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import ts from "typescript";

function authGate(pathname, user, loading = false) {
  let stateIndex = 0;
  const source = readFileSync(new URL("../src/product/AuthSession.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const mocks = {
    "../appBasePath": appBase,
    react: { ...React, useState: () => { const values = [loading, user, null]; return [values[stateIndex++], () => {}]; }, useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn() },
    "react/jsx-runtime": jsx,
    "@tanstack/react-router": { Navigate: "Navigate", useRouterState: ({ select }) => select({ location: { pathname } }) },
    "../components/ui": { Spinner: "Spinner" },
    "./CloudWorkspace": { isCloudWorkspace: () => false },
  };
  new Function("require", "exports", "location", code)((name) => {
    if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`);
    return mocks[name];
  }, exports, { protocol: "http:", host: "localhost:4791" });
  return exports.AuthSessionProvider({ runtime: { kind: "local", accountUrl: "http://localhost:5300" }, children: "page" });
}
import * as jsx from "react/jsx-runtime";

test("authenticated users cannot reopen the public product introduction", () => {
  const result = authGate("/", { id: "user", name: "user", email: "user@example.test" });
  assert.equal(result.type, "Navigate");
  assert.equal(result.props.to, "/projects");
  assert.equal(result.props.replace, true);
});

test("anonymous users retain the introduction and protected-page sign-in gate", () => {
  assert.notEqual(authGate("/", null).type, "Navigate");
  const protectedPage = authGate("/projects/p/settings/compute", null);
  assert.equal(protectedPage.type, "Navigate");
  assert.equal(protectedPage.props.to, "/");
  assert.notEqual(authGate("/projects", { id: "user" }).type, "Navigate");
});

test("authentication loading does not flash the introduction for a signed-in session", () => {
  const result = authGate("/", null, true);
  assert.equal(result.type, "main");
});

test("subpath authentication uses the same protected-page gate", () => {
  assert.equal(authGate("/mobilesci/discover", null).type, "Navigate");
  assert.equal(authGate("/mobilesci/", {id:"user"}).props.to, "/projects");
});
