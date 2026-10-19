import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, mocks) {
  const code = ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((id) => id in mocks ? mocks[id] : require(id), exports);
  return exports;
}

test("account settings open without reading a project or remembered location", () => {
  const clicks = [];
  const navigations = [];
  const { AccountMenu } = load("components/AccountMenu.tsx", {
    "@tanstack/react-router": { useNavigate: () => (target) => navigations.push(target) },
    "../product/AuthSession": { useAuthSession: () => ({ user: { name: "User" }, canAccessResearch: true }) },
    "../RemoteRuntime": { useRuntime: () => ({ kind: "local" }) },
    "../paraglide/messages.js": { m: { settings_page_compute: () => "Compute", settings_page_settings: () => "Settings" } },
    "./ModelPicker": { usePopover: () => ({ open: true, ref: { current: null }, setOpen() {} }) },
    "./ui": { MenuItem: ({ onClick, children }) => { clicks.push(onClick); return React.createElement("button", null, children); } },
    "./WorkspaceConnection": { WorkspaceConnection: () => null },
  });
  renderToStaticMarkup(React.createElement(AccountMenu));
  clicks[0]();
  clicks[1]();
  assert.deepEqual(navigations, [
    { to: "/settings/$tab", params: { tab: "compute" } },
    { to: "/settings/$tab", params: { tab: "settings" } },
  ]);
});

test("workspace settings render with no project and retain compute history navigation", () => {
  for (const tab of ["settings", "compute", "instances"]) {
    let settings;
    let navigation;
    const { WorkspaceSettingsPage } = load("product/WorkspaceSettingsPage.tsx", {
      "@tanstack/react-router": { useParams: () => ({ tab }), useNavigate: () => (target) => { navigation = target; } },
      "../components/SettingsPage": { SettingsView: (props) => { settings = props; return React.createElement("p", null, props.tab); } },
      "../RemoteRuntime": { useRuntime: () => ({ kind: "local" }) },
      "../workspaceState": { isSettingsSection: () => true },
      "../paraglide/messages.js": { m: { settings_page_compute: () => "Compute", settings_page_settings: () => "Settings" } },
      "./ProductNav": { PlatformFrame: ({ children }) => children },
    });
    assert.match(renderToStaticMarkup(React.createElement(WorkspaceSettingsPage)), new RegExp(tab));
    assert.equal(settings.project, null);
    settings.onSelectTab("instances");
    assert.deepEqual(navigation, { to: "/settings/$tab", params: { tab: "instances" } });
  }
});
