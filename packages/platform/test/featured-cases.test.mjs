import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  featuredCaseRoutes,
  NATIVE_METADATA_LIMIT,
  normalizeCase,
  normalizeNativeWorkspace,
} from "../src/featured-cases.mjs";

test("large team case requests preserve transcripts above the former 16 MiB limit", async () => {
  const workspace = materialWorkspace();
  const transcript = "研究结果".repeat(2 * 1024 * 1024);
  workspace.responses["/api/chat/sessions/session/messages"].messages.push({
    parts: [{ type: "text", text: transcript }],
  });
  const queries = [];
  const db = {
    query: async (...args) => {
      queries.push(args);
      return { rows: [] };
    },
    release() {},
  };
  let result;
  const route = featuredCaseRoutes({
    config: {
      origin: new URL("http://localhost:5300"),
      appOrigin: "http://localhost:5201",
    },
    pool: { connect: async () => db },
    session: async () => ({ user_id: "admin", is_admin: true }),
    json: (_res, data, status) => {
      result = { data, status };
    },
    audit: async () => {},
    limit: async () => {},
  });
  const payload = JSON.stringify({
    sourceProjectId: "project",
    title: "研究",
    summary: "摘要",
    category: "科研实践",
    snapshot: { workspace },
    expectedFileCount: 1,
  });
  assert.ok(Buffer.byteLength(payload) > 16 * 1024 * 1024);
  const request = (chunks) =>
    Object.assign(Readable.from(chunks), {
      method: "POST",
      headers: {
        origin: "http://localhost:5201",
        "content-type": "application/json",
      },
    });
  await route(
    request([Buffer.from(payload)]),
    { setHeader() {} },
    "/api/platform/admin/cases",
  );
  assert.equal(result.status, 201);
  const insert = queries.find(([sql]) =>
    sql.startsWith("INSERT INTO featured_cases"),
  );
  const saved = JSON.parse(insert[1][6]);
  assert.equal(
    saved.workspace.responses["/api/chat/sessions/session/messages"].messages[1]
      .parts[0].text,
    transcript,
  );
  const queryCount = queries.length;
  const chunk = Buffer.alloc(1024 * 1024, " ");
  await assert.rejects(
    route(
      request([...Array(65).fill(chunk), Buffer.from(" ")]),
      { setHeader() {} },
      "/api/platform/admin/cases",
    ),
    { status: 413, message: /65 MiB/ },
  );
  assert.equal(queries.length, queryCount);
});

test("native metadata remains bounded by UTF-8 bytes with a useful size error", () => {
  const workspace = materialWorkspace();
  workspace.responses["/api/chat/sessions/session/messages"].messages.push({
    parts: [{ type: "text", text: "x".repeat(NATIVE_METADATA_LIMIT) }],
  });
  assert.throws(() => normalizeNativeWorkspace(workspace), {
    status: 413,
    message: /64 MiB/,
  });
});

function materialWorkspace() {
  const id = "11111111-1111-4111-8111-111111111111";
  const sha256 = "a".repeat(64);
  return {
    version: 1,
    projectId: "project",
    sessionId: "session",
    responses: {
      "/api/projects": { projects: [{ id: "project" }] },
      "/api/chat/sessions?projectId=project": {
        sessions: [{ id: "session", projectId: "project", busy: false }],
      },
      "/api/chat/sessions/session/messages": {
        messages: [{ parts: [{ type: "material", text: id }] }],
      },
      [`/api/materials/${id}`]: {
        id,
        projectId: "project",
        files: [
          {
            id: "SRC-0001",
            path: "输入/原件.pdf",
            sha256,
            status: "on-demand",
          },
        ],
      },
    },
    assets: {
      [`/api/materials/${id}/SRC-0001/download`]: `native-${sha256}.pdf`,
    },
  };
}

test("native material manifests and original downloads preserve project scope and provenance", () => {
  const workspace = materialWorkspace();
  assert.deepEqual(normalizeNativeWorkspace(workspace), workspace);
  assert.deepEqual(normalizeCase({ workspace }).workspace, workspace);
});

test("material copies reject foreign, unreferenced, missing and mismatched files", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const change of [
    (v) => {
      v.responses[`/api/materials/${id}`].projectId = "foreign";
    },
    (v) => {
      v.responses[`/api/materials/${id}`].id = "foreign";
    },
    (v) => {
      v.responses["/api/chat/sessions/session/messages"].messages = [];
    },
    (v) => {
      delete v.assets[`/api/materials/${id}/SRC-0001/download`];
    },
    (v) => {
      v.assets[`/api/materials/${id}/SRC-0001/download`] =
        `native-${"b".repeat(64)}.pdf`;
    },
    (v) => {
      v.assets[`/api/materials/${id}/SRC-9999/download`] =
        `native-${"a".repeat(64)}.pdf`;
    },
    (v) => {
      v.responses[`/api/materials/${id}`].files.push(
        v.responses[`/api/materials/${id}`].files[0],
      );
    },
    (v) => {
      v.responses["/api/settings/secrets"] = {};
    },
  ]) {
    const workspace = materialWorkspace();
    change(workspace);
    assert.throws(() => normalizeNativeWorkspace(workspace));
  }
});

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

test("range snapshot identities cannot mix projects, packages or sources", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `/api/materials/${id}/coverage`;
  const base = materialWorkspace();
  base.responses[`/api/materials/${id}`].files[0].format = "pdf";
  base.responses[path] = {
    schemaVersion: 1,
    projectId: "project",
    packageId: id,
    source: null,
    session: null,
    study: null,
    coverage: {
      consideredEvents: 1,
      groups: [
        {
          scope: {
            packageId: id,
            source: "SRC-0001",
            path: "输入/原件.pdf",
            format: "pdf",
            sha256: "a".repeat(64),
          },
        },
      ],
    },
  };
  assert.deepEqual(normalizeNativeWorkspace(base), base);
  for (const change of [
    (v) => {
      v.responses[path].projectId = "foreign";
    },
    (v) => {
      v.responses[path].packageId = "foreign";
    },
    (v) => {
      v.responses[path].source = "SRC-0001";
    },
    (v) => {
      v.responses[path].coverage.groups[0].scope.source = "SRC-9999";
    },
    (v) => {
      v.responses[path].coverage.groups[0].scope.sha256 = "b".repeat(64);
    },
    (v) => {
      v.responses[path].coverage.consideredEvents = 10001;
    },
    (v) => {
      v.responses[path + "?session=foreign"] = v.responses[path];
      delete v.responses[path];
    },
  ]) {
    const v = structuredClone(base);
    change(v);
    assert.throws(() => normalizeNativeWorkspace(v));
  }
});

test("conversation cases preserve their source while old project snapshots remain compatible", () => {
  const workspace = materialWorkspace();
  workspace.sourceSessionId = workspace.sessionId;
  assert.deepEqual(normalizeNativeWorkspace(workspace), workspace);
  workspace.sourceSessionId = "other-session";
  assert.throws(() => normalizeNativeWorkspace(workspace));
  delete workspace.sourceSessionId;
  assert.deepEqual(normalizeNativeWorkspace(workspace), workspace);
});
