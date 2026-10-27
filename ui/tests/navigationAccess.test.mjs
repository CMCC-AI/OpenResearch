import * as appBase from "../src/appBasePath.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import ts from "typescript";

function authGate(pathname, user, loading = false, canAccessResearch = true, privateResearch = false) {
  let stateIndex = 0;
  const source = readFileSync(new URL("../src/product/AuthSession.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const mocks = {
    "../appBasePath": appBase,
    react: { ...React, useState: () => { const values = [loading, user, canAccessResearch, null, null, privateResearch]; return [values[stateIndex++], () => {}]; }, useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn() },
    "react/jsx-runtime": jsx,
    "@tanstack/react-router": { Navigate: "Navigate", useRouterState: ({ select }) => select({ location: { pathname } }) },
    "../components/ui": { Spinner: "Spinner" },
    "./PersonalResearchGate": { PersonalResearchGate: "PersonalResearchGate" },
    "./CloudWorkspace": { isCloudWorkspace: () => false },
  };
  new Function("require", "exports", "location", code)((name) => {
    if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`);
    return mocks[name];
  }, exports, { protocol: "http:", host: "localhost:4791" });
  return exports.AuthSessionProvider({ runtime: { kind: "local", accountUrl: "http://localhost:5300" }, children: "page" });
}
import * as jsx from "react/jsx-runtime";

test("authenticated users can reopen the public product introduction", () => {
  const result = authGate("/", { id: "user", name: "user", email: "user@example.test" });
  assert.notEqual(result.type, "Navigate");
  assert.equal(result.props.children, "page");
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
  assert.equal(authGate("/mobilesci/", {id:"user"}).props.children, "page");
});

test("catalog-only users browse public cases without entering the private research workspace", () => {
  const reader={id:"reader"};
  assert.equal(authGate("/",reader,false,false).props.children,"page");
  assert.equal(authGate("/projects/private-project",reader,false,false).props.to,"/cases");
  assert.equal(authGate("/mobilesci/projects",reader,false,false).props.to,"/cases");
  assert.notEqual(authGate("/cases/case-id",reader,false,false).type,"Navigate");
  assert.notEqual(authGate("/mobilesci/cases",reader,false,false).type,"Navigate");
  assert.equal(authGate("/cases",null).props.to,"/");
});

test("administration requires login and permits administrators without private research access", () => {
  assert.equal(authGate("/admin/users",null).props.to,"/");
  assert.equal(authGate("/mobilesci/admin/cases",null).props.to,"/");
  assert.notEqual(authGate("/admin/users",{id:"admin",isAdmin:true},false,false).type,"Navigate");
});

test("only research pages prepare private compute; cases and administration remain available",()=>{
 const user={id:"researcher",isAdmin:true};
 const research=authGate("/projects",user,false,true,true);
 assert.equal(research.props.children.type,"PersonalResearchGate");
 assert.equal(research.props.children.key,user.id);
 for(const path of ["/cases","/admin/users","/admin/cases","/literature"])assert.equal(authGate(path,user,false,true,true).props.children,"page");
});


test("workspace settings keep login, research access, and private runtime gates", () => {
  for (const path of ["/settings/settings", "/settings/compute", "/mobilesci/settings/instances"]) {
    assert.equal(authGate(path, null).props.to, "/");
    assert.equal(authGate(path, { id: "reader" }, false, false).props.to, "/cases");
    assert.equal(authGate(path, { id: "user" }, false, true, true).props.children.type, "PersonalResearchGate");
    assert.equal(authGate(path, { id: "user" }).props.children, "page");
  }
});
