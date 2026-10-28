import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSubmission } from "../src/chatSubmission.ts";
const receipt = (kind = "turn", sessionId = "s", clientTurnId = "client") => ({ sessionId, clientTurnId, submission: { kind, id: "stored" } });
const resolve = (lookup, extra = {}) => reconcileSubmission({ sessionId: "s", clientTurnId: "client", isCurrent: () => true, rejected: false, lookup, ...extra });

test("only the matching durable request receipt confirms a lost response", async () => {
  for (const kind of ["turn", "queued"]) assert.equal(await resolve(async () => receipt(kind)), "accepted");
  for (const value of [receipt("turn", "other"), receipt("turn", "s", "other"), receipt("steering"), { ...receipt(), submission: null }, { ...receipt(), submission: { kind: "turn", id: "" } }, null, { busy: true }]) {
    assert.equal(await resolve(async () => value), "unknown");
  }
});
test("lookup failures and absent receipts retain uncertainty without resending", async () => {
  let reads = 0;
  assert.equal(await resolve(async () => { reads++; throw new Error("offline"); }), "unknown");
  assert.equal(reads, 1);
});
test("explicit rejection and retired scopes do not query or confirm another send", async () => {
  const never = () => assert.fail("must not query");
  assert.equal(await resolve(never, { rejected: true }), "rejected");
  assert.equal(await resolve(never, { isCurrent: () => false }), "retired");
  let current = true, release;
  const pending = resolve(() => new Promise(done => { release = done; }), { isCurrent: () => current });
  current = false;
  release(receipt());
  assert.equal(await pending, "retired");
});
test("a stalled lookup has one bounded deadline and aborts its request", async () => {
  let signal;
  assert.equal(await resolve(value => { signal = value; return new Promise(() => {}); }, { timeoutMs: 5 }), "unknown");
  assert.equal(signal.aborted, true);
});
