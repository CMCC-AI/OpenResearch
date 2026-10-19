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

test("structured native parts preserve nested outputs and accept legacy snapshots", () => {
  const value = snapshot();
  const parts = [
    {
      id: "tool",
      type: "tool",
      tool: "exec",
      state: {
        status: "completed",
        input: { command: "python run.py" },
        output: "full output",
      },
      children: [{ id: "nested", type: "text", text: "nested transcript" }],
    },
  ];
  value.sessions[0].messages[1].parts = parts;
  assert.deepEqual(normalizeCase(value).sessions[0].messages[1].parts, parts);
  assert.equal(
    "parts" in normalizeCase(snapshot()).sessions[0].messages[0],
    false,
  );
  for (const malformed of [
    {},
    [null],
    [{ type: "text", text: { invalid: true } }],
    [{ type: "tool", state: { output: { invalid: true } } }],
    [{ type: "tool", children: "invalid" }],
    [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
  ]) {
    value.sessions[0].messages[1].parts = malformed;
    assert.throws(() => normalizeCase(value));
  }
  let nested = { type: "tool", children: [] };
  for (let i = 0; i < 34; i++) nested = { type: "tool", children: [nested] };
  value.sessions[0].messages[1].parts = [nested];
  assert.throws(() => normalizeCase(value));
});

test("project snapshots retain research DAG, completed runs and session relationships", () => {
  const value = snapshot();
  const session = value.sessions[0];
  Object.assign(session, {
    id: "session-1",
    harness: "opencode",
    archived: true,
    activeLeafId: "second",
  });
  session.messages[1].completedAt = 5;
  value.projectName = "原始项目";
  value.experiments = [
    {
      id: "exp-1",
      projectId: "private-project",
      slug: "experiment",
      branchName: "experiment",
      runCommand: "python run.py",
      agentStatus: "done",
      createdAt: 1,
      updatedAt: 2,
      chatSessionId: "session-1",
    },
  ];
  value.runs = [
    {
      id: "run-1",
      experimentId: "exp-1",
      projectId: "private-project",
      backend: { secret: "never copy" },
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      resultMarkdown: "saved results",
    },
  ];
  session.research = {
    study: {
      id: "study-1",
      sessionId: "session-1",
      mode: "team",
      objective: "研究目标",
      status: "completed",
      plans: [
        {
          version: 1,
          summary: "计划",
          tasks: [
            {
              id: "task-1",
              role: "as-result-analyst",
              brief: "分析结果",
              dependsOn: [],
              outputs: ["report.md"],
              state: "completed",
              sessionId: "session-1",
              artifacts: [{ path: "report.md", sha256: "abc", bytes: 3 }],
              runIds: ["run-1"],
            },
          ],
        },
      ],
      decisions: [],
      claims: [],
    },
    runs: value.runs,
  };
  const result = normalizeCase(value);
  assert.equal(result.projectName, "原始项目");
  assert.equal(result.sessions[0].activeLeafId, "second");
  assert.equal(result.sessions[0].messages[1].completedAt, 5);
  assert.equal(
    result.sessions[0].research.study.plans[0].tasks[0].sessionId,
    "session-1",
  );
  assert.equal(result.runs[0].resultMarkdown, "saved results");
  assert.equal("backend" in result.runs[0], false);
  assert.equal(result.experiments[0].projectId, "snapshot");
  value.runs[0].status = "running";
  assert.throws(() => normalizeCase(value));
  value.runs[0].status = "done";
  session.activeLeafId = "missing";
  assert.throws(() => normalizeCase(value));
  session.activeLeafId = "second";
  session.research.study.plans[0].tasks[0].outputs = "invalid";
  assert.throws(() => normalizeCase(value));
});

test("native project snapshots support every existing coding harness", () => {
  for (const harness of [
    "claude-code",
    "codex",
    "opencode",
    "cursor",
    "antigravity",
  ]) {
    const value = snapshot();
    value.sessions[0].harness = harness;
    assert.equal(normalizeCase(value).sessions[0].harness, harness);
  }
});
