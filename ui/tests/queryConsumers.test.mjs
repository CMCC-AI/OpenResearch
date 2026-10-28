import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CancelledError } from "@tanstack/react-query";

const source = (file) => ts.createSourceFile(file, readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function evaluate(code, bindings) {
  bindings = { CancelledError, deletedSessionIds: new Set(), ...bindings };
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
function declaration(file, name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, name);
  return found.initializer.getText(file);
}

function sendPreparation() {
  const file = source("ChatPanel.tsx");
  let send;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "send") send = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  const turn = send.body.statements.find((node) => ts.isTryStatement(node) && node.tryBlock.getText(file).includes('type: "optimisticUser"'));
  const statements = turn.tryBlock.statements;
  const optimisticIndex = statements.findIndex((node) => node.getText(file).includes('type: "optimisticUser"'));
  const prefix = statements.slice(0, optimisticIndex + 1).map((node) => node.getText(file)).join("\n");
  return prefix;
}

function settingsRenderer(name, returns, bindings) {
  const file = source("SettingsPage.tsx");
  const component = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === name);
  const statements = component.body.statements;
  const prefix = statements.slice(0, statements.findIndex(ts.isReturnStatement)).map((node) => node.getText(file)).join("\n");
  const state = [];
  let cursor, effects, changed;
  const hook = (init) => { const index = cursor++; if (!(index in state)) state[index] = init(); return index; };
  const hooks = {
    useState: (initial) => { const i = hook(() => initial); return [state[i], (next) => { const value = typeof next === "function" ? next(state[i]) : next; changed ||= !Object.is(value, state[i]); state[i] = value; }]; },
    useRef: (initial) => state[hook(() => ({ current: initial }))],
    useEffect: (effect, deps) => { const i = hook(() => undefined); if (!state[i] || deps.some((value, index) => !Object.is(value, state[i][index]))) { state[i] = deps; effects.push(effect); } },
  };
  return () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      cursor = 0; effects = []; changed = false;
      const result = evaluate(`${prefix}\nreturn ${returns};`, { ...hooks, ...bindings });
      effects.forEach((effect) => effect());
      if (!changed) return result;
    }
    assert.fail(`${name} effects did not settle`);
  };
}

test("harness settings keep the settled selection when readiness changes", () => {
  let snapshot = [];
  const render = settingsRenderer("HarnessesTab", "{ h, setActive }", {
    useOptionalAuthSession: () => null, appBasePath: "", isCloudWorkspace: () => false,
    useQuery: (options) => ({ data: options.harnesses ? snapshot : [] }),
    getHarnessesQuery: () => ({ harnesses: true }),
    getHarnessSetupCommandsQuery: () => ({}),
    useCommandRun: () => ({}), workspaceKey: () => [], listAcpHarnesses: () => {},
  });
  assert.equal(render().h, undefined);
  snapshot = [{ id: "claude-code", catalogPending: true }, { id: "opencode", catalogPending: true }];
  assert.equal(render().h.id, "claude-code");
  snapshot = [{ id: "claude-code", agentReady: false }, { id: "opencode", agentReady: true }];
  assert.equal(render().h.id, "opencode");
  snapshot = [{ id: "claude-code", agentReady: true }, { id: "opencode", agentReady: false }];
  assert.equal(render().h.id, "opencode");
  render().setActive("claude-code");
  snapshot = [{ id: "opencode", agentReady: true }, { id: "claude-code", catalogPending: true }];
  assert.equal(render().h.id, "claude-code");
});

for (const [name, fields] of [["K8s", ["context", "namespace"]], ["Slurm", ["host", "partition", "account", "timeLimit"]], ["Ray", ["address"]]]) {
  test(`${name} settings refresh clean fields while preserving edits`, () => {
    const file = source("SettingsPage.tsx");
    const component = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === `${name}Section`);
    const statements = component.body.statements;
    const prefix = statements.slice(0, statements.findIndex(ts.isReturnStatement)).map((node) => node.getText(file)).join("\n");
    const state = [];
    let cursor, effects, changed;
    let snapshot = Object.fromEntries(fields.map((field) => [field, "original"]));
    const hook = (init) => { const index = cursor++; if (!(index in state)) state[index] = init(); return index; };
    const bindings = {
      useState: (initial) => { const i = hook(() => initial); return [state[i], (next) => { const value = typeof next === "function" ? next(state[i]) : next; changed ||= !Object.is(value, state[i]); state[i] = value; }]; },
      useRef: (initial) => state[hook(() => ({ current: initial }))],
      useEffect: (effect, deps) => { const i = hook(() => undefined); if (!state[i] || deps.some((value, index) => !Object.is(value, state[i][index]))) { state[i] = deps; effects.push(effect); } },
      useMutation: () => ({}), useQuery: () => ({ data: snapshot }),
      useSshMasterStatuses: () => [{}, () => {}],
      [`get${name}SettingsQuery`]: () => ({ queryKey: [] }), [`save${name}Settings`]: () => {},
      remote: false, onEditState: undefined,
    };
    const code = `${prefix}\nreturn { values: {${fields}}, setters: {${fields.map((field) => `${field}: set${field[0].toUpperCase()}${field.slice(1)}`).join(",")}} };`;
    function render() {
      for (let attempt = 0; attempt < 5; attempt++) {
        cursor = 0; effects = []; changed = false;
        const result = evaluate(code, bindings);
        effects.forEach((effect) => effect());
        if (!changed) return result;
      }
      assert.fail("settings effects did not settle");
    }
    assert.deepEqual(render().values, snapshot);
    snapshot = Object.fromEntries(fields.map((field) => [field, "refreshed"]));
    assert.deepEqual(render().values, snapshot);
    render().setters[fields[0]]("my edit");
    const edited = render().values;
    snapshot = Object.fromEntries(fields.map((field) => [field, "external"]));
    assert.deepEqual(render().values, edited);
  });
}

test("queued chat writes stop when their captured workspace retires", async () => {
  const file = source("ChatPanel.tsx");
  let generation = 1, release, calls = 0;
  const queue = evaluate(`return ${declaration(file, "queueSessionMutation")}`, {
    useCallback: (fn) => fn, sessionsOptions: { queryKey: ["workspace", 1] },
    settingsMutationTail: { current: Promise.resolve() }, isCurrentScope: (key) => key[1] === generation,
  });
  const first = queue(() => new Promise((resolve) => { release = resolve; calls++; }));
  const second = queue(async () => { calls++; });
  const rejected = assert.rejects(second, { name: "AbortError" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  generation++;
  release();
  await first;
  await rejected;
  assert.equal(calls, 1);
});

test("old prompt responses do not reconcile against the replacement workspace", async () => {
  const file = source("ChatPanel.tsx");
  let generation = 1, release, reads = 0;
  const respond = evaluate(`return ${declaration(file, "respond")}`, {
    useCallback: (fn) => fn, activeId: "old-session", projectId: "old-project", dispatch: () => {},
    sessionsOptions: { queryKey: ["workspace", 1] }, isCurrentScope: (key) => key[1] === generation,
    queueSessionMutation: () => new Promise((resolve) => { release = resolve; }),
    queryClient: { fetchQuery: async () => { reads++; } },
    getChatMessagesQuery: () => ({}), listChatSessionsQuery: () => ({}),
  });
  const answer = respond({});
  generation++;
  release();
  await answer;
  assert.equal(reads, 0);
  generation = 1;
  const current = respond({});
  release();
  await current;
  assert.equal(reads, 2);
});

for (const [card, family, field, upload] of [
  ["SkillsCard", "listUserSkills", "skills", "uploadUserSkill"],
  ["LatexTemplatesCard", "listLatexTemplates", "templates", "uploadLatexTemplate"],
]) {
  test(`${card} retains cached rows when refresh fails`, async (t) => {
    const { QueryObserver } = await import("@tanstack/react-query");
    const { queryModules } = await import("./queryModules.mjs");
    let fail = false, calls = 0;
    const { client, load } = queryModules({ [family]: async () => { calls++; if (fail) throw new Error("offline"); return family === "listUserSkills" ? { skills: [{ name: "cached" }], importing: false } : [{ name: "cached" }]; } }, { nativeClient: true });
    const options = load("settings")[`${family}Query`]();
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    const off = observer.subscribe(() => {});
    t.after(() => { off(); client.clear(); });
    const file = source("SkillsTab.tsx");
    const component = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === card);
    const statements = component.body.statements;
    const prefix = statements.slice(0, statements.findIndex(ts.isReturnStatement)).map((node) => node.getText(file)).join("\n");
    const render = () => evaluate(`${prefix}\nreturn { rows: ${field}, loadError, refresh: ${card === "SkillsCard" ? "refresh" : "() => templatesQuery.refetch()"} };`, {
      useQuery: () => observer.getCurrentResult(), useMutation: () => ({}),
      useLayoutEffect: () => {}, useState: (value) => [value, () => {}], useCallback: (fn) => fn, useRef: (current) => ({ current }),
      [`${family}Query`]: () => options, [upload]: () => {},
    });
    assert.equal(render().rows[0].name, "cached");
    fail = true;
    render().refresh();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal(render().rows[0].name, "cached");
    assert.equal(render().loadError, "offline");
  });
}

test("first send waits for cold history so an accepted reply replaces its optimistic branch", async (t) => {
  const { queryModules } = await import("./queryModules.mjs");
  let resolveHistory;
  let snapshot;
  const cold = new Promise((resolve) => { resolveHistory = resolve; });
  const { client, load } = queryModules({ getChatMessages: () => snapshot ? Promise.resolve(snapshot) : cold }, { nativeClient: true });
  t.after(() => client.clear());
  const options = load("chat").getChatMessagesQuery("s");
  const read = client.fetchQuery(options);
  const prefix = sendPreparation();
  const sending = evaluate(`return (async () => { let sid = "s"; ${prefix} })()`, {
    sessionsOptions: { queryKey: [] }, isCurrentScope: () => true,
    preparingSend: { current: false }, inSourceScope: () => false,
    queryClient: client, getChatMessagesQuery: load("chat").getChatMessagesQuery,
    dispatch: (action) => load("chatStore").dispatchChat("p", action),
    text: "new turn", draft: "new turn", pending: [], pendingAnnotations: [],
    setDraft: () => {}, setAttachments: () => {}, setAnnotations: () => {}, setAttachError: () => {}, setImageRefusedFor: () => {},
  });
  assert.equal(client.getQueryData(options.queryKey), undefined);
  snapshot = { messages: [{ id: "history", role: "user", parts: [], createdAt: 1 }], queued: [], activeLeafId: "history" };
  resolveHistory(snapshot);
  await read;
  await sending;
  assert.match(client.getQueryData(options.queryKey).activeLeafId, /^local-/);
  snapshot = { messages: [...snapshot.messages,
    { id: "accepted", role: "user", parts: [], createdAt: 2, parentId: "history" },
    { id: "reply", role: "assistant", parts: [], createdAt: 3, parentId: "accepted" },
  ], queued: [], activeLeafId: "reply" };
  const reconciled = await client.fetchQuery({ ...options, staleTime: 0 });
  assert.deepEqual(reconciled.messages.map((message) => message.id), ["history", "accepted", "reply"]);
  assert.equal(reconciled.activeLeafId, "reply");
});

test("history preparation clears the composer up front but never sends early", async (t) => {
  const { QueryObserver } = await import("@tanstack/react-query");
  const { queryModules } = await import("./queryModules.mjs");
  const { client, load } = queryModules({ getChatMessages: () => new Promise(() => {}) }, { nativeClient: true });
  t.after(() => client.clear());
  const observer = new QueryObserver(client, load("chat").getChatMessagesQuery("s"));
  const off = observer.subscribe(() => {});
  const preparingSend = { current: false };
  let currentScope = true;
  const cleared = new Set();
  const sending = evaluate(`return (async () => { let sid = "s"; ${sendPreparation()} })()`, {
    sessionsOptions: { queryKey: [] }, isCurrentScope: () => currentScope, preparingSend,
    queryClient: client, getChatMessagesQuery: load("chat").getChatMessagesQuery,
    inSourceScope: () => true, draft: "unsent", pending: [], pendingAnnotations: [],
    setDraft: () => cleared.add("draft"), setAttachments: () => cleared.add("attachments"),
    setAnnotations: () => cleared.add("annotations"), setAttachError: () => cleared.add("attachError"), setImageRefusedFor: () => cleared.add("imageRefused"),
    dispatch: () => assert.fail("must not send before history"),
  });
  currentScope = false;
  off();
  await sending;
  // The composer clears before the first await so a scope change mid-send can
  // never stash sent text; the caller's catch restores it via restoreComposer().
  assert.deepEqual([...cleared].sort(), ["annotations", "attachError", "attachments", "draft", "imageRefused"]);
  assert.equal(preparingSend.current, false);
});

test("send joins a cold repair despite its intermediate cached history", async (t) => {
  const { queryModules } = await import("./queryModules.mjs");
  let first, repair;
  const initial = new Promise((resolve) => { first = resolve; });
  const repairing = new Promise((resolve) => { repair = resolve; });
  let calls = 0;
  const { client, load } = queryModules({ getChatMessages: () => ++calls === 1 ? initial : repairing }, { nativeClient: true });
  t.after(() => client.clear());
  const options = load("chat").getChatMessagesQuery("s");
  const read = client.fetchQuery(options);
  load("live").markLiveUpdate(client, options.queryKey);
  const snapshot = { messages: [{ id: "history", role: "user", parts: [], createdAt: 1 }], queued: [], activeLeafId: "history" };
  first(snapshot);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(client.getQueryData(options.queryKey), snapshot);
  assert.equal(client.getQueryState(options.queryKey).fetchStatus, "fetching");
  let dispatched = false;
  const sending = evaluate(`return (async () => { let sid = "s"; ${sendPreparation()} })()`, {
    sessionsOptions: { queryKey: [] }, isCurrentScope: () => true,
    preparingSend: { current: false }, inSourceScope: () => false,
    queryClient: client, getChatMessagesQuery: load("chat").getChatMessagesQuery,
    dispatch: () => { dispatched = true; }, text: "new", draft: "new", pending: [], pendingAnnotations: [],
    setDraft: () => {}, setAttachments: () => {}, setAnnotations: () => {}, setAttachError: () => {}, setImageRefusedFor: () => {},
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(dispatched, false);
  repair(snapshot);
  await read;
  await sending;
  assert.equal(dispatched, true);
  assert.equal(calls, 2);
});

test("the pre-await draft clear keeps an edit queued since render", async () => {
  let updater;
  const sending = evaluate(`return (async () => { let sid = "s"; ${sendPreparation()} })()`, {
    sessionsOptions: { queryKey: [] }, isCurrentScope: () => true,
    preparingSend: { current: false }, inSourceScope: () => true,
    queryClient: { fetchQuery: async () => ({}), getQueryState: () => undefined },
    getChatMessagesQuery: () => ({ queryKey: [] }),
    draft: "rendered", text: "rendered", pending: [], pendingAnnotations: [],
    setDraft: (update) => { updater = update; },
    setAttachments: () => {}, setAnnotations: () => {}, setAttachError: () => {}, setImageRefusedFor: () => {}, dispatch: () => {},
  });
  await sending;
  assert.equal(updater("rendered"), "");
  assert.equal(updater("typed since render"), "typed since render");
});

function historyPreparationBindings(client, overrides = {}) {
  return {
    sessionsOptions: { queryKey: [] }, isCurrentScope: () => true,
    preparingSend: { current: false }, inSourceScope: () => false,
    queryClient: client, getChatMessagesQuery: () => ({ queryKey: ["history"] }),
    dispatch: () => {}, text: "new", draft: "new", pending: [], pendingAnnotations: [],
    setDraft: () => {}, setAttachments: () => {}, setAnnotations: () => {}, setAttachError: () => {}, setImageRefusedFor: () => {},
    ...overrides,
  };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "preparation did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

for (const cached of [false, true]) test(`cancelled history rejoins a fresh read before sending (cached baseline: ${cached})`, async t => {
  const { queryModules } = await import("./queryModules.mjs");
  let calls = 0, complete;
  const repaired = new Promise(resolve => { complete = resolve; });
  const { client, load } = queryModules({ getChatMessages: () => ++calls === 1 ? new Promise(() => {}) : repaired }, { nativeClient: true });
  t.after(() => client.clear());
  const history = load("chat").getChatMessagesQuery("s");
  const snapshot = { messages: [], queued: [], activeLeafId: null };
  if (cached) client.setQueryData(history.queryKey, snapshot);
  const first = client.fetchQuery({ ...history, staleTime: 0 }).catch(() => {});
  const actions = [];
  const bindings = historyPreparationBindings(client, { getChatMessagesQuery: load("chat").getChatMessagesQuery, dispatch: action => actions.push(action) });
  const sending = evaluate(`return (async () => { let sid = "s"; ${sendPreparation()} })()`, bindings);
  await client.cancelQueries({ queryKey: history.queryKey }, { revert: false });
  await first;
  await until(() => calls === 2);
  assert.equal(bindings.preparingSend.current, true);
  assert.deepEqual(actions, []);
  complete(snapshot);
  await sending;
  assert.equal(bindings.preparingSend.current, false);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].sessionId, "s");
});

test("history cancellation stops on scope retirement or deletion and never retries real errors", async () => {
  for (const kind of ["workspace", "deleted", "success-then-deleted", "network", "permission", "data"]) {
    const deletedSessionIds = new Set();
    let current = true, reads = 0, sent = 0;
    const failure = new Error(kind);
    const client = { getQueryState: () => undefined, fetchQuery: async () => {
      reads++;
      if (kind === "workspace") current = false;
      if (kind.includes("deleted")) deletedSessionIds.add("s");
      if (kind === "success-then-deleted") return {};
      throw ["workspace", "deleted"].includes(kind) ? new CancelledError() : failure;
    } };
    const bindings = historyPreparationBindings(client, { deletedSessionIds, isCurrentScope: () => current, dispatch: () => { sent++; } });
    const sending = evaluate(`return (async () => { let sid = "s"; ${sendPreparation()} })()`, bindings);
    if (["network", "permission", "data"].includes(kind)) await assert.rejects(sending, error => error === failure);
    else await sending;
    assert.equal(reads, 1);
    assert.equal(sent, 0);
    assert.equal(bindings.preparingSend.current, false);
  }
});

test("repeated history cancellations yield until the captured workspace retires", async () => {
  let current = true, reads = 0;
  const client = { getQueryState: () => undefined, fetchQuery: async () => { reads++; throw new CancelledError(); } };
  const bindings = historyPreparationBindings(client, { isCurrentScope: () => current, dispatch: () => assert.fail("must not send") });
  const sending = evaluate(`return (async () => { let sid = "s"; ${sendPreparation()} })()`, bindings);
  await until(() => reads >= 2);
  current = false;
  await sending;
  assert.equal(bindings.preparingSend.current, false);
});

test("local send failures retain the preceding model response and render as their own alert", async () => {
  const { queryModules } = await import("./queryModules.mjs");
  const { isUsageLimitPart, isTurnStatusPart } = await import("../src/chatRendering.ts");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { load } = queryModules({});
  const answer = { id: "answer", role: "assistant", createdAt: 1, parts: [{ id: "answer-text", type: "text", text: "previous answer" }] };
  const state = { messagesBySession: { s: [answer] }, activeLeafBySession: { s: "answer" }, queuedBySession: {}, busySessions: new Set() };
  const next = load("chatState").reducer(state, { type: "localError", sessionId: "s", text: "消息未发送：<offline>" });
  const [previous, local] = next.messagesBySession.s;
  assert.equal(previous, answer);
  assert.equal(local.parentId, answer.id);
  assert.match(local.id, /^local-senderr-/);
  const part = local.parts[0];
  assert.equal(part.tool, "local_error");
  assert.equal(isUsageLimitPart(part), false);
  assert.equal(isTurnStatusPart(part), false);
  const file = source("ChatPanel.tsx");
  const component = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ToolRow");
  const statements = component.body.statements;
  const end = statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(file) === 'part.tool === "local_error"');
  assert.ok(end >= 0);
  const prefix = statements.slice(0, end + 1).map(node => node.getText(file)).join("\n");
  const js = ts.transpileModule(`${prefix}\nreturn null;`, { fileName: "local-error.tsx", compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const alert = new Function("part", "cleanToolError", "useState", "React", "TriangleAlert", js)(part, value => value, () => [false, () => {}], { createElement }, () => createElement("svg"));
  const html = renderToStaticMarkup(alert);
  assert.match(html, /role="alert"/);
  assert.match(html, /消息未发送：&lt;offline&gt;/);
});
