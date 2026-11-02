import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { getComposerStashStore, getResearchSubmissionStore } from "../src/composerStash.ts";

const require = createRequire(import.meta.url);
const messages = { m: new Proxy({}, { get: (_, name) => () => String(name) }) };

function load(file, mocks, globals = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", ...Object.keys(globals), code)(
    (name) => mocks[name] ?? require(name), exports, ...Object.values(globals),
  );
  return exports;
}

function hooks() {
  const values = [];
  let cursor = 0;
  return {
    reset: () => { cursor = 0; },
    react: {
      ...React,
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useState: (initial) => {
        const index = cursor++;
        if (!(index in values)) values[index] = initial;
        return [values[index], (value) => { values[index] = value; }];
      },
    },
  };
}

function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}

for (const corner of [true, false]) {
  test(`local ${corner ? "home" : "sidebar"} control opens hosts and returns from SSH config`, () => {
    const state = hooks();
    const { WorkspaceConnection } = load("components/WorkspaceConnection.tsx", {
      react: state.react,
      "../i18n": { ltr: (text) => text },
      "../paraglide/messages.js": messages,
      "./RemoteHostDialog": { RemoteHostDialog: "HostDialog" },
      "./RemoteStatus": { RemoteStatus: "RemoteStatus" },
      "./RemoteIcon": { RemoteIcon: "RemoteIcon" },
      "./SshConfigDialog": { SshConfigDialog: "ConfigDialog" },
      "./ui": { Button: "button", IconButton: "button" },
    });
    const runtime = { kind: "local", version: "test" };
    const render = () => { state.reset(); return nodes(WorkspaceConnection({ runtime, corner })); };
    assert.equal(render().some((node) => node.type === "HostDialog"), false);
    render().find((node) => node.type === "button" && node.props["aria-haspopup"] === "dialog").props.onClick();
    render().find((node) => node.type === "HostDialog").props.onConfigureSsh();
    assert.equal(render().some((node) => node.type === "HostDialog"), false);
    render().find((node) => node.type === "ConfigDialog").props.onClose();
    render().find((node) => node.type === "HostDialog").props.onClose();
    assert.equal(render().some((node) => node.type === "HostDialog" || node.type === "ConfigDialog"), false);

    state.reset();
    const remote = { kind: "ssh", session: { host: "research" } };
    const status = WorkspaceConnection({ runtime: remote, corner });
    assert.equal(status.type, "RemoteStatus");
    assert.equal(status.props.runtime, remote);
    assert.equal(status.props.corner, corner);
  });
}

for (const kind of ["local", "ssh"]) {
  for (const scenario of ["loading", "error", "onboarding", "projects"]) {
    test(`${kind} project home connection control during ${scenario}`, async () => {
      const runtime = { kind, version: "test" };
      const { ProjectsPage } = load("routePages.tsx", {
        react: hooks().react,
        "./queries/client": { getWorkspaceGeneration: () => 10 },
        "./api": {},
        "./queries/settings": {},
        "./queries/chat": {},
        "./research": {},
        "./components/ModelPicker": {},
        "./composerStash": { getComposerStashStore, getResearchSubmissionStore },
        "@tanstack/react-query": { useQuery: ({ kind }) => ({
          data: scenario === "loading" || scenario === "error" ? undefined
            : kind === "projects" ? (scenario === "projects" ? [{ id: "p" }] : []) : { onboardingCompleted: scenario !== "onboarding" },
          error: scenario === "error" ? new Error("offline") : null,
        }) },
        "./queries/projects": { listProjectsQuery: () => ({ kind: "projects" }), getUiStateQuery: () => ({ kind: "state" }) },
        "@tanstack/react-router": { useRouteContext: () => ({ queryClient: {} }), useNavigate: () => () => {}, useSearch: () => ({}) },
        "./RemoteRuntime": { useRuntime: () => runtime },
        "./product/CloudWorkspace": { isCloudWorkspace: () => false },
        "./product/ProductNav": { PlatformFrame: "PlatformFrame" },
        "./demoSessionState": {}, "./routeResume": {}, "./workspacePersistence": {}, "./panelLayout": {},
        "./paraglide/messages.js": messages,
        "./components/Onboarding": { Onboarding: "Onboarding" },
        "./components/ProjectsHome": { ProjectsHome: "ProjectsHome" },
        "./components/OfflineBanner": { OfflineBanner: "OfflineBanner" },
        "./components/WorkspaceConnection": { WorkspaceConnection: "WorkspaceConnection" },
        "./components/UpdateBanner": { UpdateBanner: "UpdateBanner", useUpdateStatus: () => ({}) },
        "./components/DesktopAppBanner": { DesktopAppBanner: "DesktopAppBanner" },
        "./components/ui": {},
      });
      const page = nodes(ProjectsPage());
      const connection = page.find((node) => node.type === "WorkspaceConnection");
      if (kind === "local") {
        assert.equal(connection, undefined);
        return;
      }
      assert.ok(connection);
      assert.equal(connection.props.runtime, runtime);
      assert.equal(connection.props.corner, true);
    });
  }
}

for (const outcome of ["success", "failure", "popup-blocked"]) {
  test(`SSH host selection from home preserves new-tab behavior: ${outcome}`, async () => {
    const state = hooks();
    const calls = [];
    const { RemoteHostDialog } = load("components/RemoteHostDialog.tsx", {
      react: state.react,
      "react-dom": { createPortal: (tree) => tree },
      "@tanstack/react-query": {
        useQuery: ({ kind }) => ({ data: kind === "hosts" ? { hosts: [{ host: "research" }], defaultHost: null } : [] }),
        useMutation: () => ({ mutateAsync: async (args) => {
          calls.push(["connect", ...args]);
          if (outcome === "failure") throw new Error("connection failed");
          return { gatewayUrl: "http://localhost:4910/" };
        } }),
      },
      "lucide-react": { SlidersHorizontal: "Icon", X: "Icon" },
      "../api": {}, "../paraglide/messages.js": messages,
      "../paraglide/runtime.js": { getLocale: () => "en" },
      "../queries/settings": { getSshSettingsQuery: () => ({ kind: "hosts" }), listRemoteSessionsQuery: () => ({ kind: "sessions" }) },
      "../theme": { getThemePreference: () => "dark" },
      "./useDialogFocus": { useDialogFocus: () => {} },
      "./ui": {
        Button: "button", IconButton: "button", Input: "input", Spinner: "Spinner",
        showAlert: (...args) => calls.push(["alert", ...args]),
      },
    }, {
      document: { body: {} },
      window: { open: (...args) => {
        calls.push(["open", ...args]);
        return outcome === "popup-blocked" ? null : {
          location: { replace: (url) => calls.push(["navigate", url]) },
          close: () => calls.push(["close-tab"]),
        };
      } },
    });
    const tree = RemoteHostDialog({ onClose: () => calls.push(["close-dialog"]), onConfigureSsh: () => {} });
    nodes(tree).find((node) => node.type === "button" && nodes(node).some((child) => child.props.children === "research")).props.onClick();
    await new Promise(setImmediate);
    assert.deepEqual(calls[0], ["open", "/remote-launch", "_blank"]);
    if (outcome === "popup-blocked") {
      assert.deepEqual(calls.slice(1), [["alert", "remote_popup_blocked", "error"]]);
    } else {
      assert.deepEqual(calls[1], ["connect", "research", { theme: "dark", locale: "en" }]);
      assert.deepEqual(calls.slice(2), outcome === "success"
        ? [["navigate", "http://localhost:4910/"], ["close-dialog"]]
        : [["close-tab"], ["alert", "connection failed", "error"]]);
    }
  });
}

for (const content of ["objective", "attachments", "empty", "missing"]) for (const workMode of ["normal", "team"]) test(`home submits directly to a real session: ${content}/${workMode}`, async () => {
  const stashes = new Map();
  const submissions = new Map();
  const navigations = [];
  const calls = [];
  const alerts = [];
  let createFailure = false;
  let harnessReady = true;
  const session = { id: "session", projectId: "p", harness: "opencode", model: "configured-model" };
  const { ProjectsPage } = load("routePages.tsx", {
    react: hooks().react,
    "./queries/client": { getWorkspaceGeneration: () => 7, setScopedQueryData: () => {} },
    "./api": { createChatSession: async (...args) => { calls.push(args); if (createFailure) throw new Error("create failed"); return session; } },
    "./research": { researchModes: { team: "团队研究" } },
    "./queries/settings": { getHarnessesQuery: () => ({ kind: "harnesses" }) },
    "./queries/chat": { listChatSessionsQuery: () => ({ queryKey: ["sessions"] }) },
    "./components/ModelPicker": { defaultSelection: (_, preferred) => preferred },
    "./composerStash": { getComposerStashStore: () => stashes, getResearchSubmissionStore: () => submissions },
    "@tanstack/react-query": { useQuery: ({ kind }) => ({ data: kind === "projects" ? [{ id: "p", name: "研究项目" }] : { preferredAgent: { harness: "opencode", model: "configured-model" }, preferredAutonomy: "copilot" } }) },
    "./queries/projects": { listProjectsQuery: () => ({ kind: "projects" }), getUiStateQuery: () => ({ kind: "state" }) },
    "@tanstack/react-router": {
      useRouteContext: () => ({ queryClient: { fetchQuery: async () => [{ id: "opencode", agentReady: harnessReady }] } }),
      useNavigate: () => async (options) => navigations.push(options), useSearch: () => ({ project: "p" }),
    },
    "./RemoteRuntime": { useRuntime: () => ({ kind: "local" }) },
    "./product/CloudWorkspace": { isCloudWorkspace: () => false },
    "./product/ProductNav": { PlatformFrame: "PlatformFrame" },
    "./routeResume": {}, "./paraglide/messages.js": messages,
    "./components/ProjectsHome": { ProjectsHome: "ProjectsHome" },
    "./components/OfflineBanner": { OfflineBanner: "OfflineBanner" },
    "./components/WorkspaceConnection": {},
    "./components/UpdateBanner": { UpdateBanner: "UpdateBanner", useUpdateStatus: () => ({}) },
    "./components/ui": { showAlert: (message) => alerts.push(message) },
  });
  const home = nodes(ProjectsPage()).find((node) => node.type === "ProjectsHome");
  const draft = content === "missing" ? undefined : {
    workMode,
    draft: content === "objective" ? "验证研究假设" : "  ",
    attachments: content === "attachments" ? [{ name: "paper.pdf", mediaType: "application/pdf", dataUrl: "data:application/pdf;base64,AA==", size: 1 }] : [],
    annotations: [],
  };
  await home.props.onCreated({ id: "p" }, null, draft);
  const hasContent = content === "objective" || content === "attachments";
  assert.equal(calls.length, hasContent ? 1 : 0);
  if (hasContent) {
    assert.equal(calls[0][0], "p");
    assert.equal(calls[0][1], "opencode");
    assert.equal(calls[0][2].model, "configured-model");
    assert.equal(calls[0][2].autonomy, "copilot");
    assert.deepEqual(calls[0][2].research, workMode === "team" ? { mode: "team", objective: draft.draft.trim() || "团队研究" } : undefined);
  }
  assert.equal(stashes.get("session"), hasContent ? draft : undefined);
  assert.equal(submissions.get("session"), hasContent ? draft : undefined);
  assert.deepEqual(navigations[0], hasContent ? {
    to: "/projects/$projectId/tasks/$sessionId", params: { projectId: "p", sessionId: "session" },
  } : { to: "/projects/$projectId", params: { projectId: "p" } });
  if (hasContent) {
    submissions.clear();
    const count = calls.length;
    await Promise.all([home.props.onResume({ id: "p" }, draft), home.props.onResume({ id: "p" }, draft)]);
    assert.equal(calls.length, count + 1, "double clicks must not create two sessions");
    assert.equal(submissions.get("session"), draft, "existing project submissions use the same direct session flow");
    submissions.clear();
    const navigationCount = navigations.length;
    createFailure = true;
    await home.props.onResume({ id: "p" }, draft);
    assert.equal(stashes.get("p:new"), draft, "creation failures preserve the home draft");
    assert.equal(submissions.size, 0);
    assert.equal(navigations.length, navigationCount, "failures must not navigate to the retired page");
    assert.deepEqual(alerts, ["create failed"]);
    harnessReady = false;
    const attempts = calls.length;
    await home.props.onResume({ id: "p" }, draft);
    assert.equal(calls.length, attempts, "unavailable harnesses stay on the home without creating a session");
  }
});
