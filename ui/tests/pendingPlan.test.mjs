import assert from "node:assert/strict";
import test from "node:test";
import { pendingPlanForTurn, shellExchangePart } from "../src/chatRendering.ts";
import { reducer } from "../src/queries/chatState.ts";
import { SHELL_TOOL } from "../src/queries/chatState.ts";
const user = (id) => ({ id, role: "user", parts: [{ type: "text", text: id }], createdAt: 0 });
const plan = (id, resolved = false, synthesized = false) => ({ id, role: "assistant", parts: [{ id, type: "prompt", prompt: { kind: "plan", plan: id, resolved, synthesized } }], createdAt: 1 });
const shell = (status) => ({ id: "shell", role: "user", parts: [{ type: "tool", tool: SHELL_TOOL, state: { status } }], createdAt: 2 });
for (const synthesized of [false, true]) {
  test(`historical ${synthesized ? "synthesized" : "native"} plans cannot block the next turn or reappear after acceptance`, () => {
    const old = plan("old", false, synthesized);
    const messages = [user("u1"), old, user("u2"), plan("current", false, synthesized)];
    assert.equal(pendingPlanForTurn(messages).promptId, "current");
    messages[3].parts[0].prompt.resolved = true;
    assert.equal(pendingPlanForTurn(messages), null);
    assert.equal(pendingPlanForTurn(JSON.parse(JSON.stringify(messages))), null);
    messages.push({ id: "working", role: "assistant", parts: [{ type: "text", text: "working" }], createdAt: 3 });
    assert.equal(pendingPlanForTurn(messages), null);
  });
  for (const status of ["running", "completed", "error"]) {
    test(`shell ${status} preserves the current ${synthesized ? "synthesized" : "native"} approval`, () => {
      const messages = [user("u1"), plan("current", false, synthesized), shell(status)];
      assert.equal(pendingPlanForTurn(messages).promptId, "current");
      assert.equal(pendingPlanForTurn(JSON.parse(JSON.stringify(messages))).promptId, "current");
      messages.push(user("u2"));
      assert.equal(pendingPlanForTurn(messages), null);
    });
  }
}
test("queue updates preserve approval until the queued message becomes a real transcript turn", () => {
  const messages = [user("u1"), plan("current")];
  const initial = { messagesBySession: { s: messages }, busySessions: new Set(["s"]), queuedBySession: {}, activeLeafBySession: { s: "current" } };
  const queued = reducer(initial, { type: "setQueued", sessionId: "s", items: [{ id: "queued", text: "follow-up" }] });
  assert.equal(pendingPlanForTurn(queued.messagesBySession.s).promptId, "current");
  const started = reducer(queued, { type: "upsertMessage", sessionId: "s", message: { ...user("queued"), parentId: "current" } });
  assert.equal(pendingPlanForTurn(started.messagesBySession.s), null);
});
test("only a single user shell tool is a shell exchange", () => {
  assert.ok(shellExchangePart(shell("completed")));
  const mixed = shell("completed");
  mixed.parts.push({ type: "text", text: "a real follow-up" });
  assert.equal(shellExchangePart(mixed), null);
  assert.equal(shellExchangePart({ ...shell("completed"), role: "assistant" }), null);
});
