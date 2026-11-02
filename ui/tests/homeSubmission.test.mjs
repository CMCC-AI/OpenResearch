import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute the real handoff effect without mounting transcript and terminal UI.
const source = ts.createSourceFile("ChatPanel.tsx", readFileSync(new URL("../src/components/ChatPanel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const panel = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ChatPanel");
const effect = panel.body.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "useEffect"
  && node.expression.arguments[0].getText(source).includes("researchSubmissions.get(stashKey)"));
const code = ts.transpileModule(`return ${effect.expression.arguments[0].getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(overrides = {}) {
  let sends = 0, finish;
  const starting = [], errors = [];
  const draft = { draft: "研究问题", attachments: [{ name: "paper.pdf" }], annotations: [], workMode: "team" };
  const requests = new Map([["session", draft]]);
  const bindings = {
    homeSubmission: draft, activeId: "session", mainView: "chat", embedded: false, readOnly: false,
    contentLoading: false, contentError: null, historyLoading: false, historyError: null,
    openSession: { id: "session" }, pendingLoading: false, harnessesQuery: { isPending: false },
    draft: draft.draft, attachments: draft.attachments, annotations: [], researchMode: "team",
    researchSubmissions: requests, stashKey: "session", activeHarness: { agentReady: true },
    composerSelection: { harness: "codex" }, imageInputBlocked: false, projectId: "p", bashActive: false,
    setAttachError: value => errors.push(value), setStartingHomeSubmission: value => starting.push(value),
    send: () => { sends++; return new Promise(resolve => { finish = resolve; }); },
    runShell: () => assert.fail("message must use the regular send path"),
    m: { chat_selected_harness_unavailable: () => "unavailable" }, ...overrides,
  };
  return { run: () => new Function(...Object.keys(bindings), code)(...Object.values(bindings))(),
    requests, starting, errors, finish: async () => { finish(); await Promise.resolve(); }, get sends() { return sends; } };
}

test("a home submission sends once even when effects replay, and holds the loading shell until settled", async () => {
  const state = setup();
  state.run();
  state.run();
  assert.equal(state.sends, 1);
  assert.equal(state.requests.size, 0);
  assert.deepEqual(state.starting, ["p"]);
  await state.finish();
  assert.deepEqual(state.starting, ["p", null]);
});

for (const waiting of [{ contentLoading: true }, { historyLoading: true }, { pendingLoading: true },
  { harnessesQuery: { isPending: true } }, { openSession: undefined }, { researchMode: "normal" }]) {
  test(`the real session waits for its restored content and settings: ${Object.keys(waiting)[0]}`, () => {
    const state = setup(waiting);
    state.run();
    assert.equal(state.sends, 0);
    assert.equal(state.requests.size, 1);
  });
}

test("an unavailable agent exposes a recoverable error without replaying or returning to the old page", () => {
  const state = setup({ activeHarness: { agentReady: false } });
  state.run();
  state.run();
  assert.equal(state.sends, 0);
  assert.equal(state.requests.size, 0);
  assert.deepEqual(state.errors, ["unavailable"]);
});
