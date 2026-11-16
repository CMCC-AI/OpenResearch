import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFetch, cancelRuntimeRequests } from "../src/runtimeRequest.ts";

const pending = () => new Response("{}", { status: 503, headers: { "x-orx-runtime-pending": "1" } });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("a submitted operation waits for compute and executes once with its original body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0, executed = 0;
  const body = JSON.stringify({ text: "未发送的研究草稿", clientTurnId: "same-turn" });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.body, body);
    if (++attempts < 3) return pending();
    executed++;
    return Response.json({ ok: true });
  });
  const result = runtimeFetch("/api/chat/sessions/session/messages", { method: "POST", body });
  await flush();
  assert.equal(executed, 0);
  t.mock.timers.tick(1500); await flush();
  assert.equal(executed, 0);
  t.mock.timers.tick(1500);
  assert.equal((await result).status, 200);
  assert.equal(executed, 1);
});

test("ordinary 503 responses and ambiguous network errors are never replayed", async t => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; return new Response("failed", { status: 503 }); });
  assert.equal((await runtimeFetch("/api/projects", { method: "POST" })).status, 503);
  assert.equal(attempts, 1);
  globalThis.fetch = async () => { attempts++; throw new TypeError("Connection lost"); };
  await assert.rejects(runtimeFetch("/api/projects", { method: "POST" }), /Connection lost/);
  assert.equal(attempts, 2);
});

test("cancelling a queued operation prevents it from executing later", async t => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; return pending(); });
  const controller = new AbortController();
  const result = runtimeFetch("/api/projects", { method: "POST", signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("leaving the personal workspace cancels queued requests before a different account can send them", async t => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; return pending(); });
  const result = runtimeFetch("/api/projects", { method: "POST" });
  await flush();
  cancelRuntimeRequests();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("one-shot stream bodies and unload writes are never replayed", async t => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; return pending(); });
  assert.equal((await runtimeFetch("/api/projects", { method: "POST", body: new ReadableStream() })).status, 503);
  assert.equal((await runtimeFetch("/api/settings/ui-state", { method: "POST", keepalive: true })).status, 503);
  assert.equal(attempts, 2);
});
