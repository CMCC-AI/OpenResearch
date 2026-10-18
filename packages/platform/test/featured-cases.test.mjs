import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCase } from "../src/featured-cases.mjs";

const snapshot = () => ({
  sessions: [
    {
      title: "真实研究",
      privatePath: "/private/research",
      messages: [
        {
          id: "first",
          role: "user",
          createdAt: 1,
          content: "目标\n完整内容",
          secretMetadata: "not-public",
        },
        {
          id: "second",
          parentId: "first",
          role: "assistant",
          createdAt: 2,
          content: "工具输出\n<script>inert()</script>",
        },
      ],
    },
  ],
});

test("the published schema preserves full text and branching without private metadata", () => {
  const result = normalizeCase(snapshot());
  assert.equal(result.sessions[0].messages[1].parentId, "first");
  assert.equal(
    result.sessions[0].messages[1].content,
    "工具输出\n<script>inert()</script>",
  );
  assert.equal(result.sessions[0].messages[0].content, "目标\n完整内容");
  assert.equal("privatePath" in result.sessions[0], false);
  assert.equal("secretMetadata" in result.sessions[0].messages[0], false);
});

test("empty, duplicated, cross-session, malformed and oversized transcripts are rejected", () => {
  for (const change of [
    (v) => (v.sessions = []),
    (v) => (v.sessions[0].messages = []),
    (v) => (v.sessions[0].messages[1].id = "first"),
    (v) => (v.sessions[0].messages[1].parentId = "other-session-message"),
    (v) => (v.sessions[0].messages[1].parentId = "second"),
    (v) => (v.sessions[0].messages[0].createdAt = 8640000000000001),
    (v) => (v.sessions[0].messages[0].role = "admin"),
    (v) =>
      (v.sessions[0].messages[0].content = "x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const value = snapshot();
    change(value);
    assert.throws(() => normalizeCase(value));
  }
});
