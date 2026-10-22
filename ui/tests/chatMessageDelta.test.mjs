import test from "node:test";
import assert from "node:assert/strict";
import { ChatMessageStream } from "../src/chatMessageDelta.ts";
const full = () => ({ sessionId: "s", streamRevision: 1, message: { id: "m", role: "assistant", createdAt: 0, parts: [{ id: "p", type: "text", text: "hello" }] } });
const delta = changes => ({ sessionId: "s", messageId: "m", baseRevision: 1, revision: 2, changes });
test("append, replace and removal reconstruct messages without mutating a previous frame", () => {
  const stream = new ChatMessageStream();
  const first = full(); stream.full(first);
  const result = stream.delta(delta([{ op: "append", path: ["parts", 0, "text"], text: " 世界" }, { op: "set", path: ["completedAt"], value: 10 }]));
  assert.equal(result.message.parts[0].text, "hello 世界");
  assert.equal(first.message.parts[0].text, "hello");
  assert.equal(result.message.completedAt, 10);
  const removed = stream.delta({ ...delta([{ op: "remove", path: ["completedAt"] }]), baseRevision: 2, revision: 3 });
  assert.equal(Object.hasOwn(removed.message, "completedAt"), false);
});
test("gaps, reconnects, cross-session frames and prototype paths require a new baseline", () => {
  const stream = new ChatMessageStream();
  assert.equal(stream.delta(delta([])), null);
  stream.full(full());
  assert.equal(stream.delta({ ...delta([]), baseRevision: 2, revision: 3 }), null);
  assert.equal(stream.delta({ ...delta([]), sessionId: "other" }), null);
  assert.equal(stream.delta(delta([{ op: "set", path: ["__proto__", "polluted"], value: true }])), null);
  assert.equal({}.polluted, undefined);
  stream.clear();
  assert.equal(stream.delta(delta([])), null);
  assert.ok(stream.full({ sessionId: "s", message: full().message }));
});
test("invalid paths and malformed message envelopes fail closed", () => {
  const stream = new ChatMessageStream();stream.full(full());
  for (const path of [["parts", -1], ["parts", 2], ["parts", "0"], ["missing", "nested"]])
    assert.equal(stream.delta(delta([{ op: "set", path, value: "bad" }])), null);
  assert.equal(stream.full({ sessionId: "s", message: { id: "m" } }), null);
});

test("client reconstructs the shared Rust wire contract fixture", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("../../tests/fixtures/chat-message-stream.json", import.meta.url), "utf8"));
  const stream = new ChatMessageStream();
  stream.full(fixture.baseline);
  assert.deepEqual(stream.delta(fixture.delta), fixture.next);
});

test("refreshing an existing full baseline at capacity preserves other active messages", () => {
  const stream = new ChatMessageStream();
  for (let index = 0; index < 128; index++) {
    const data = full();
    data.message.id = `m${index}`;
    stream.full(data);
  }
  const refreshed = full();
  refreshed.message.id = "m0";
  refreshed.streamRevision = 2;
  stream.full(refreshed);
  const result = stream.delta({ ...delta([{ op: "append", path: ["parts", 0, "text"], text: " next" }]), messageId: "m127" });
  assert.equal(result.message.parts[0].text, "hello next");
});
