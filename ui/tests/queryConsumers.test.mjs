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
    if ((ts.isVariableDeclaration(node) && node.name.getText(file) === name)
      || (ts.isFunctionDeclaration(node) && node.name?.text === name)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, name);
  return found.initializer?.getText(file) ?? found.getText(file);
}

function sendPreparation() {
  const file = source("ChatPanel.tsx");
  let send;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "send") send = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  let turn;
  function findTurn(node) {
    if (ts.isTryStatement(node) && node.tryBlock.statements.some(statement => statement.getText(file).includes('type: "optimisticUser"') && !ts.isTryStatement(statement) && !ts.isIfStatement(statement))) turn = node;
    ts.forEachChild(node, findTurn);
  }
  findTurn(send);
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

function sendFunction() {
  const file = source("ChatPanel.tsx");
  let send;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "send") send = node; ts.forEachChild(node, visit); }
  visit(file);
  return { file, send };
}

test("lost send responses use request receipts rather than another turn's busy state", async () => {
  const { file, send } = sendFunction();
  let block;
  function findBlock(node) { if (ts.isTryStatement(node) && node.catchClause?.getText(file).includes('dispatch({ type: "localError"')) block = node; ts.forEachChild(node, findBlock); }
  findBlock(send);
  const code = block.catchClause.block.statements.map(node => node.getText(file)).join("\n");
  for (const resolution of ["accepted", "unknown", "rejected", "retired", "late-retired"]) {
    let restored = 0, reseeded = 0;
    const actions = [], warnings = [];
    const pending = { current: { id: "request", signature: "payload" } };
    await evaluate(`return (async () => { ${code} })()`, {
      sid: "s", err: new Error("offline"), sessionsOptions: { queryKey: [] }, isCurrentScope: () => true,
      resolveSubmissionFailure: async () => resolution === "late-retired" ? "accepted" : resolution, pendingClientTurn: pending, clientTurnId: "request",
      finishPendingSubmission: async () => { pending.current = null; }, PendingConflictError: class extends Error {}, pendingSaved: null, setPendingRefresh: () => {},
      restoreComposer: () => { restored++; }, clearFailedPlanCommand: () => {},
      reseedSession: async () => { reseeded++; }, inSourceScope: () => resolution !== "late-retired",
      setAttachError: warning => warnings.push(warning), dispatch: action => actions.push(action),
      m: { chat_message_not_sent: ({error}) => error }, ltr: value => value,
      queryClient: { fetchQuery: () => assert.fail("busy is not a request receipt") },
    });
    if (resolution === "accepted") {
      assert.equal(restored, 0); assert.equal(reseeded, 1); assert.equal(pending.current, null); assert.deepEqual(actions, []);
    } else if (resolution === "unknown") {
      assert.equal(restored, 1); assert.equal(pending.current.id, "request"); assert.equal(reseeded, 1); assert.deepEqual(actions, []); assert.match(warnings[0], /尚未确认/);
    } else if (resolution === "retired" || resolution === "late-retired") {
      assert.equal(restored, 0); assert.equal(reseeded, 0); assert.deepEqual(actions, []);
    } else {
      assert.equal(restored, 1); assert.equal(reseeded, 1); assert.equal(actions.length, 1); assert.equal(actions[0].type, "localError");
    }
  }
});

test("unchanged retries preserve their ID and admission mode across busy transitions", () => {
  const { file, send } = sendFunction();
  const statements = send.body.statements;
  const first = statements.findIndex(node => node.getText(file).startsWith("const signatureFor"));
  const last = statements.findIndex((node, index) => index > first && node.getText(file).startsWith("pendingClientTurn.current ="));
  const code = statements.slice(first, last + 1).map(node => node.getText(file)).join("\n");
  const pending = { current: null };
  let sequence = 0;
  const bindings = { sourceSessionId: "s", sessionsOptions: { queryKey: ["workspace", 1, "project"] },
    pendingClientTurn: pending, createClientTurnId: () => `request-${++sequence}`, text: "same", pending: [], wireAnnotations: [], effective: null,
    independentPlanMode: false, busy: false, steering: true, queue: false, planRequested: false };
  const run = () => evaluate(`${code}; return { id: clientTurnId, mode: submissionMode, signatureFor };`, bindings);
  const original = run();
  bindings.busy = true;
  const retry = run();
  assert.equal(retry.id, original.id);
  assert.equal(retry.mode, undefined, "an ordinary retry must not become steering");
  bindings.sourceSessionId = "other";
  assert.notEqual(run().id, original.id);
  const other = pending.current.id;
  bindings.sessionsOptions.queryKey = ["workspace", 2, "project"];
  assert.notEqual(run().id, other);
  bindings.sourceSessionId = null; bindings.busy = false;
  const fresh = run();
  // The new-session preparation updates the signature to its assigned target.
  pending.current.signature = fresh.signatureFor("created");
  bindings.sourceSessionId = "created";
  assert.equal(run().id, fresh.id);
});

test("assigning a new session preserves its pending identity before navigation effects run", async () => {
  const { file } = sendFunction();
  let create;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "openNewSession") create = node; ts.forEachChild(node, visit); }
  visit(file);
  const pending = { current: { id: "request", signature: "new-draft", sessionId: null } };
  const visitToken = { projectId: "p" }, scope = { projectId: "p", activeId: null, mainView: "chat" };
  let navigated = false;
  await evaluate(`return (${create.getText(file)})({ harness: "opencode" }, false, "question", "normal")`, {
    composerScopeRef: { current: scope }, projectVisitRef: { current: visitToken }, projectId: "p", sideParentSessionId: null,
    createChatSessionMutation: { mutateAsync: async () => ({ id: "created" }) }, preferredAutonomy: null,
    isCurrentScope: () => true, sessionsOptions: { queryKey: [] }, setSessions: () => {}, queryClient: { getQueryData: () => true },
    preparingSend: { current: true }, pendingClientTurn: pending,
    onActiveSessionChangeRef: { current: id => { assert.equal(id, "created"); assert.equal(pending.current.sessionId, id); navigated = true; } },
  });
  assert.equal(navigated, true);
  assert.equal(pending.current.id, "request");
  let effect;
  function find(node) { if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" && node.arguments[1]?.getText(file) === "[activeId]" && node.arguments[0].getText(file).includes("pendingClientTurn")) effect = node.arguments[0]; ts.forEachChild(node, find); }
  find(file);
  const run = activeId => evaluate(`return (${effect.getText(file)})();`, { activeId, pendingClientTurn: pending, setRecoveryOverrides: () => {}, EMPTY_RECOVERY_OVERRIDES: {} });
  run("created");
  assert.equal(pending.current.id, "request");
  run("another-session");
  assert.equal(pending.current, null);
});

test("receipt recovery keeps HTTP rejections distinct from ambiguous responses and steering", async () => {
  const { reconcileSubmission } = await import("../src/chatSubmission.ts");
  const file = source("ChatPanel.tsx");
  const api = ts.createSourceFile("api.ts", readFileSync(new URL("../src/api.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const type = api.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "HttpResponseError");
  const HttpResponseError = evaluate(`return (${type.getText(api).replace(/^export /, "")});`, {});
  const error = new HttpResponseError("rejected", 409);
  assert.equal(error.name, "HttpResponseError");
  assert.equal(error.status, 409);
  for (const [cause, mode, expected, reads] of [
    [error, undefined, "rejected", 0], [new HttpResponseError("timeout", 408), undefined, "unknown", 1],
    [new HttpResponseError("admission failure", 400), undefined, "unknown", 1],
    [new HttpResponseError("upstream", 500), undefined, "unknown", 1], [new Error("offline"), "steer", "unknown", 1],
  ]) {
    let queried = 0;
    const recover = evaluate(`return ${declaration(file, "resolveSubmissionFailure")}`, {
      inSourceScope: () => true, deletedSessionIds: new Set(), deliveryAttempted: true,
      reconcileSubmission, HttpResponseError, submissionMode: mode, clientTurnId: "client",
      getChatSubmission: async (session, client) => { queried++; assert.equal(session, "s"); assert.equal(client, "client"); return { sessionId: session, clientTurnId: client, submission: null }; },
    });
    assert.equal(await recover(cause, "s"), expected);
    assert.equal(queried, reads);
  }
});

test("steering lost-response recovery queries the original durable registration", async () => {
  const { reconcileSubmission } = await import("../src/chatSubmission.ts");
  const file = source("ChatPanel.tsx");
  let reads = 0;
  const recover = evaluate(`return ${declaration(file, "resolveSubmissionFailure")}`, {
    inSourceScope: () => true, deletedSessionIds: new Set(), deliveryAttempted: true,
    reconcileSubmission, HttpResponseError: class extends Error {}, submissionMode: "steer", clientTurnId: "native-key",
    getChatSubmission: async (session, client, signal) => {
      reads++; assert.equal(session, "s"); assert.equal(client, "native-key"); assert.ok(signal instanceof AbortSignal);
      return { sessionId: session, clientTurnId: client, submission: { kind: "steer", id: "registered" } };
    },
  });
  assert.equal(await recover(new Error("response lost"), "s"), "accepted");
  assert.equal(reads, 1);
});

test("retry transport retains the captured mode and request ID on both sending branches", async () => {
  const file = source("ChatPanel.tsx");
  for (const callback of ["sendTurn", "sendBusy"]) for (const mode of [undefined, "steer"]) {
    let sent;
    const send = evaluate(`return ${declaration(file, callback)}`, {
      deliveryAttempted: false, savePendingSubmission: async () => {}, isCurrentScope: () => true, sessionsOptions: { queryKey: [] }, deletedSessionIds: new Set(), sendChatMessage: async (...args) => { sent = args; },
      targetSessionId: "s", sid: "s", text: "payload", turnOpts: {}, images: [], wireAnnotations: [], clientTurnId: "original", submissionMode: mode,
    });
    await send();
    assert.equal(sent[0], "s"); assert.equal(sent[5], "original"); assert.equal(sent[6], mode);
  }
});

function pendingHydrationEffect() {
  const file = source("ChatPanel.tsx"); let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect"
      && node.arguments[1]?.getText(file).includes("pendingStorageScope")
      && node.arguments[0].getText(file).includes("pendingJournal.read")) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(file); return effect.getText(file);
}
function savedPending() {
  return { id: "original", sessionId: "s", mode: "steer", scope: "scope", owner: "actor", key: JSON.stringify(["scope", "s"]),
    signature: JSON.stringify({ sessionId: "s", workspace: ["workspace", 1], text: "original", settings: { model: null, planMode: false } }),
    composer: { draft: "original", attachments: [], annotations: [{ id: "quote", text: "source" }], workMode: "team" },
    wire: { images: [{ materialId: "original-material", dataBase64: "", mediaType: "application/pdf" }], options: { model: null }, annotations: [{ text: "source" }] } };
}
async function hydrationHarness({ record = savedPending(), initial, receipt = null, lookup } = {}) {
  const helpers = await import("../src/pendingSubmissions.ts");
  const { reconcileSubmission } = await import("../src/chatSubmission.ts");
  const composer = initial ?? { draft: "", attachments: [], annotations: [] };
  const state = { draft: composer.draft, attachments: composer.attachments, annotations: composer.annotations, loading: null, recovery: null, removed: [], reseeded: 0, selection: null };
  const live = { current: composer }, pending = { current: { id: "original", sessionId: "s" } };
  const bindings = { activeId: "s", mainView: "chat", pendingStorageScope: "scope", sessionsOptions: { queryKey: ["workspace", 4] },
    composerLiveRef: live, pendingClientTurn: pending, planModeOverrideRef: { current: null },
    isCurrentScope: () => true, deletedSessionIds: new Set(), ...helpers, hasPendingFlight: () => false,
    pendingJournal: { read: async () => record, remove: async (...args) => state.removed.push(args) },
    reconcileSubmission, getChatSubmission: lookup ?? (async () => ({ sessionId: "s", clientTurnId: "original", submission: receipt })),
    setPendingRecovery: value => { state.recovery = value; }, setPendingLoading: value => { state.loading = value; },
    setDraft: value => { state.draft = value; }, setAttachments: value => { state.attachments = value; }, setAnnotations: value => { state.annotations = value; },
    setResearchMode: value => { state.workMode = value; }, setSessionOverride: value => { state.selection = value; }, setPlanModeOverride: () => {},
    setAttachError: value => { state.error = value; }, reseedSession: async () => { state.reseeded++; },
  };
  return { state, live, pending, run: extra => evaluate(`return (${pendingHydrationEffect()})();`, { ...bindings, ...extra }) };
}

test("pending hydration restores an unknown request without sending or overwriting a newer draft", async () => {
  for (const draft of ["", "new unsent work"]) {
    const harness = await hydrationHarness({ initial: { draft, attachments: [], annotations: [] } });
    const cleanup = harness.run(); await until(() => harness.state.loading === false);
    assert.equal(harness.state.draft, draft || "original");
    assert.equal(harness.pending.current.id, "original"); assert.equal(harness.pending.current.mode, "steer");
    assert.equal(JSON.parse(harness.pending.current.signature).workspace[1], 4);
    assert.equal(harness.state.selection, null, "background lookup must not change current model settings");
    assert.equal(harness.state.removed.length, 0); cleanup();
  }
});

test("confirmed registration clears only the unchanged recovered draft and keeps edits made during lookup", async () => {
  for (const edited of [false, true]) {
    let release;
    const record = savedPending();
    const harness = await hydrationHarness({ initial: record.composer, lookup: () => new Promise(done => { release = done; }) });
    const cleanup = harness.run(); await until(() => release);
    if (edited) { harness.live.current = { draft: "new work", attachments: [], annotations: [] }; harness.state.draft = "new work"; }
    release({ sessionId: "s", clientTurnId: "original", submission: { kind: "steer", id: "registered" } });
    await until(() => harness.state.loading === false);
    assert.equal(harness.state.draft, edited ? "new work" : "");
    assert.equal(harness.live.current.draft, edited ? "new work" : "", "route cleanup must not resurrect a confirmed draft");
    assert.equal(harness.pending.current, null); assert.equal(harness.state.reseeded, 1);
    assert.deepEqual(harness.state.removed, [["scope", "s", "original"]]); cleanup();
  }
});

test("retired hydration cannot restore another chat, and live local sends are not mistaken for unknown delivery", async () => {
  let release;
  const retired = await hydrationHarness({ lookup: () => new Promise(done => { release = done; }) });
  const cleanup = retired.run(); await until(() => release); cleanup();
  release({ sessionId: "s", clientTurnId: "original", submission: null });
  await new Promise(done => setImmediate(done));
  assert.equal(retired.state.draft, ""); assert.equal(retired.state.recovery, null);
  let reads = 0;
  const live = await hydrationHarness();
  const stop = live.run({ hasPendingFlight: () => true, pendingJournal: { read: () => { reads++; } } });
  assert.equal(reads, 0); assert.equal(live.state.loading, true); stop();
});

test("explicit recovery restores original settings but refuses to replace different unsent work", async () => {
  const file = source("ChatPanel.tsx"), helpers = await import("../src/pendingSubmissions.ts");
  for (const draft of ["original", "different work"]) {
    const record = savedPending(), changes = [];
    const restore = evaluate(`return ${declaration(file, "restorePendingRecovery")}`, {
      pendingRecovery: record, pendingStorageScope: "scope", composerScopeRef: { current: { activeId: "s" } },
      composerLiveRef: { current: { ...record.composer, draft } }, ...helpers,
      setDraft: value => changes.push(["draft", value]), setAttachments: () => {}, setAnnotations: () => {}, setResearchMode: () => {},
      setSessionOverride: value => changes.push(["settings", value]), setPlanModeOverride: value => changes.push(["plan", value]), planModeOverrideRef: { current: null },
      setAttachError: value => changes.push(["warning", value]),
    });
    restore();
    if (draft === "original") { assert.deepEqual(changes[1], ["settings", { model: null }]); assert.deepEqual(changes[2], ["plan", false]); }
    else { assert.equal(changes.length, 1); assert.equal(changes[0][0], "warning"); }
  }
});

test("both send branches wait for the recovery record and recheck runtime scope before transport", async () => {
  const file = source("ChatPanel.tsx");
  for (const callback of ["sendTurn", "sendBusy"]) for (const retired of [false, true]) {
    let release, posted = 0;
    const save = new Promise(done => { release = done; });
    const send = evaluate(`return ${declaration(file, callback)}`, {
      savePendingSubmission: () => save, deliveryAttempted: false, isCurrentScope: () => !retired,
      sessionsOptions: { queryKey: [] }, deletedSessionIds: new Set(),
      targetSessionId: "s", sid: "s", images: [], turnOpts: {}, text: "original", wireAnnotations: [], clientTurnId: "original", submissionMode: "steer",
      sendChatMessage: async () => { posted++; },
    });
    const sending = send(); assert.equal(posted, 0); release();
    if (retired) await assert.rejects(sending, error => error.name === "AbortError"); else await sending;
    assert.equal(posted, retired ? 0 : 1);
  }
});

test("recovering a slash Plan request reuses its wire text and does not toggle the command again", () => {
  const { file, send } = sendFunction();
  const sendSource = ts.createSourceFile("send.ts", send.getText(file), ts.ScriptTarget.Latest, true);
  const row = savedPending(); row.composer.draft = "/plan investigate";
  row.signature = JSON.stringify({ sessionId: "s", workspace: ["workspace", 1], text: "investigate", settings: { model: null, planMode: true } });
  const result = evaluate(`
    const replayingPending = ${declaration(sendSource, "replayingPending")};
    const composerCommand = ${declaration(sendSource, "composerCommand")};
    const independentPlanMode = ${declaration(sendSource, "independentPlanMode")};
    const text = ${declaration(sendSource, "text")};
    return { composerCommand, independentPlanMode, text };`, {
      starter: undefined, pendingRecovery: row, activeId: "s", pendingStorageScope: "scope", composerLiveRef: { current: row.composer },
      samePendingComposer: (a, b) => a === b,
      recoveredSettings: signature => JSON.parse(signature).settings,
      parseComposerCommand: () => assert.fail("a retry must not execute the local command again"),
      effectiveCommandPlanMode: () => assert.fail("a retry must not toggle the current mode"),
    });
  assert.deepEqual(result, { composerCommand: null, independentPlanMode: true, text: "investigate" });
});

test("both transport preparations reuse registered material references and frozen options after reload", async () => {
  const { file, send } = sendFunction(); const options = [], attachments = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "turnOpts" && node.initializer.getText(file).includes("retryWire")) options.push(node.initializer.getText(file));
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "images" && node.initializer?.getText(file).includes("retryWire")) attachments.push(node.initializer.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(send); assert.equal(options.length, 2); assert.equal(attachments.length, 2);
  const wire = savedPending().wire;
  for (const expression of options) assert.deepEqual(evaluate(`return ${expression}`, { retryWire: wire, effective: { model: "new-default" } }), wire.options);
  for (const expression of attachments) {
    const value = await evaluate(`return (async () => ${expression})()`, {
      retryWire: wire, uploadSendMaterials: () => assert.fail("registered materials must not be uploaded again"), pending: [],
    });
    assert.equal(value[0].materialId, "original-material");
  }
});

test("discarding a local record excludes live sends and cannot clear a newly selected chat", async () => {
  const file = source("ChatPanel.tsx"), helpers = await import("../src/pendingSubmissions.ts");
  for (const outcome of ["success", "retired", "storage-error"]) {
    const row = savedPending(), pending = { current: { id: row.id } }, view = { current: { activeId: "s" } };
    let release, recovery = row, warning;
    const removal = new Promise((resolve, reject) => { release = () => outcome === "storage-error" ? reject(new Error("storage offline")) : resolve(); });
    const discard = evaluate(`return ${declaration(file, "discardPendingRecovery")}`, {
      ...helpers, pendingRecovery: row, pendingStorageScope: "scope", composerScopeRef: view, pendingClientTurn: pending,
      pendingJournal: { remove: () => removal }, setPendingRecovery: value => { recovery = value; }, setAttachError: value => { warning = value; },
    });
    const deleting = discard();
    assert.ok(helpers.hasPendingFlight(row.key));
    assert.throws(() => helpers.beginPendingFlight(row.key, "new-send"), helpers.PendingConflictError);
    if (outcome === "retired") view.current = { activeId: "other-chat" };
    release(); await deleting;
    assert.equal(helpers.hasPendingFlight(row.key), false);
    if (outcome === "success") { assert.equal(recovery, null); assert.equal(pending.current, null); }
    else { assert.equal(recovery, row); assert.equal(pending.current.id, row.id); }
    if (outcome === "storage-error") assert.equal(warning, "storage offline");
  }
});


test("non-chat views and unverified persistence scopes do not load conversation recovery records", async () => {
  for (const boundary of [{ mainView: "files" }, { pendingStorageScope: null }, { activeId: null }]) {
    const harness = await hydrationHarness();
    harness.run({ ...boundary, pendingJournal: { read: () => assert.fail("inactive scope must not load pending records") } });
    assert.equal(harness.state.loading, false);
    assert.equal(harness.state.recovery, null);
    assert.equal(harness.state.draft, "");
  }
});
