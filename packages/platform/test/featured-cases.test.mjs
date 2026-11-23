import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import {
  featuredCaseRoutes,
  jsonbSafe,
  jsonbString,
  NATIVE_METADATA_LIMIT,
  normalizeCase,
  normalizeNativeWorkspace,
} from "../src/featured-cases.mjs";

test("case snapshots replace only characters PostgreSQL jsonb rejects", () => {
  const value = {
    responses: {
      "/api/chat/sessions/s/messages": {
        messages: [
          {
            parts: [
              {
                text: "bin\u0000ary \uD83D tail \uDE00 ok 😀 研究",
                "k\u0000": [1, null, true, "\u0000"],
              },
            ],
          },
        ],
      },
    },
  };
  const safe = jsonbSafe(value);
  const part =
    safe.responses["/api/chat/sessions/s/messages"].messages[0].parts[0];
  assert.equal(part.text, "bin\uFFFDary \uFFFD tail \uFFFD ok 😀 研究");
  assert.deepEqual(part["k\uFFFD"], [1, null, true, "\uFFFD"]);
  const encoded = jsonbString(value);
  assert.doesNotMatch(encoded, /\\u0000|\\ud[89a-f][0-9a-f]{2}/i);
  assert.equal(
    value.responses[
      "/api/chat/sessions/s/messages"
    ].messages[0].parts[0].text.includes("\u0000"),
    true,
  );
});

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

test("case detail supports lightweight meta=1 check and gzip compression with uncompressed size header", async () => {
  const caseId = "11111111-1111-4111-8111-111111111111";
  const row = {
    id: caseId,
    title: "研究案例",
    summary: "摘要",
    category: "人工智能",
    status: "published",
    revision: 3,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    published_at: "2026-01-02T00:00:00Z",
    snapshot: {
      sessions: [
        {
          title: "s",
          messages: [
            { id: "m1", role: "assistant", content: "内容".repeat(1500) },
          ],
        },
      ],
    },
  };
  let jsonOut;
  const route = featuredCaseRoutes({
    config: {
      origin: new URL("http://localhost:5300"),
      appOrigin: "http://localhost:5201",
    },
    pool: {
      query: async (sql) => {
        if (sql.includes("FROM featured_case_files")) return { rows: [] };
        return {
          rows: [
            sql.includes(",snapshot")
              ? row
              : (({ snapshot: _s, ...meta }) => meta)(row),
          ],
        };
      },
    },
    session: async () => ({ user_id: "reader", is_admin: false }),
    json: (_res, data) => {
      jsonOut = data;
    },
    audit: async () => {},
    limit: async () => {},
  });
  await route(
    {
      method: "GET",
      url: `/api/platform/cases/${caseId}?meta=1`,
      headers: { origin: "http://localhost:5201" },
    },
    { setHeader() {} },
    `/api/platform/cases/${caseId}`,
  );
  assert.equal(jsonOut.revision, 3);
  assert.equal("snapshot" in jsonOut, false);
  assert.equal("files" in jsonOut, false);

  const headers = {};
  let statusCode = 0;
  let bodyBuf;
  await route(
    {
      method: "GET",
      url: `/api/platform/cases/${caseId}`,
      headers: {
        origin: "http://localhost:5201",
        "accept-encoding": "gzip, deflate",
      },
    },
    {
      setHeader(k, v) {
        headers[k.toLowerCase()] = v;
      },
      writeHead(code, h) {
        statusCode = code;
        Object.assign(headers, h);
      },
      end(chunk) {
        bodyBuf = chunk;
      },
    },
    `/api/platform/cases/${caseId}`,
  );
  assert.equal(statusCode, 200);
  assert.equal(headers["content-encoding"], "gzip");
  assert.ok(Number(headers["x-case-json-bytes"]) > bodyBuf.length);
  const decoded = JSON.parse(gunzipSync(bodyBuf).toString("utf8"));
  assert.equal(decoded.id, caseId);
  assert.equal(decoded.snapshot.sessions[0].title, "s");
});

test("admin meta endpoint edits draft and published case metadata with optimistic locking and validation", async () => {
  const caseId = "11111111-1111-4111-8111-111111111111";
  let currentStatus = "draft";
  let currentRevision = 2;
  const queries = [];
  const audits = [];
  const db = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      if (sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              status: currentStatus,
              revision: currentRevision,
              expected_file_count: 1,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  let jsonOut;
  const route = featuredCaseRoutes({
    config: {
      origin: new URL("http://localhost:5300"),
      appOrigin: "http://localhost:5201",
    },
    pool: { connect: async () => db },
    session: async () => ({ user_id: "admin-1", is_admin: true }),
    json: (_res, data) => {
      jsonOut = data;
    },
    audit: async (_db, userId, _orgId, action, targetId) => {
      audits.push([userId, action, targetId]);
    },
    limit: async () => {},
  });
  const postMeta = (payload) =>
    route(
      Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
        method: "POST",
        headers: {
          origin: "http://localhost:5201",
          "content-type": "application/json",
        },
      }),
      { setHeader() {} },
      `/api/platform/admin/cases/${caseId}/meta`,
    );

  await postMeta({
    revision: 2,
    title: "  建筑电力负荷预测实证研究  ",
    summary: "  利用气象数据改善预测精度。 ",
    category: " 实证分析 ",
  });
  assert.deepEqual(jsonOut, { ok: true });
  const updateDraft = queries.find(([sql]) =>
    sql.startsWith("UPDATE featured_cases SET title=$2,summary=$3,category=$4"),
  );
  assert.deepEqual(updateDraft[1], [
    caseId,
    "建筑电力负荷预测实证研究",
    "利用气象数据改善预测精度。",
    "实证分析",
    false,
    null,
  ]);
  assert.deepEqual(audits.at(-1), ["admin-1", "case.meta", caseId]);

  currentStatus = "published";
  currentRevision = 3;
  await postMeta({
    revision: 3,
    title: "已发布案例新标题",
    summary: "已发布案例新简介",
    category: "文献综述",
  });
  assert.deepEqual(audits.at(-1), ["admin-1", "case.meta", caseId]);

  await assert.rejects(
    postMeta({
      revision: 2,
      title: "旧版本",
      summary: "旧摘要",
      category: "科研实践",
    }),
    { status: 409 },
  );

  for (const invalid of [
    { revision: 3, title: "   ", summary: "ok", category: "科研实践" },
    {
      revision: 3,
      title: "x".repeat(201),
      summary: "ok",
      category: "科研实践",
    },
    { revision: 3, title: "ok", summary: "", category: "科研实践" },
    {
      revision: 3,
      title: "ok",
      summary: "x".repeat(4001),
      category: "科研实践",
    },
    { revision: 3, title: "ok", summary: "ok", category: "" },
    { revision: 3, title: "ok", summary: "ok", category: "x".repeat(81) },
  ]) {
    await assert.rejects(postMeta(invalid), { status: 400 });
  }
});

test("admin native sync updates metadata when provided and preserves existing metadata when omitted", async () => {
  const caseId = "11111111-1111-4111-8111-111111111111";
  const workspace = {
    version: 1,
    projectId: "project",
    sessionId: "session",
    responses: {
      "/api/projects": { projects: [{ id: "project", name: "原项目" }] },
      "/api/chat/sessions?projectId=project": {
        sessions: [{ id: "session", projectId: "project", busy: false }],
      },
      "/api/chat/sessions/session/messages": { messages: [] },
    },
    assets: {},
  };
  const updates = [];
  const db = {
    query: async (sql, params) => {
      if (sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              revision: 4,
              snapshot: {},
              source_project_id: "project",
            },
          ],
        };
      }
      if (sql.startsWith("UPDATE featured_cases")) updates.push(params);
      return { rows: [] };
    },
    release() {},
  };
  const route = featuredCaseRoutes({
    config: {
      origin: new URL("http://localhost:5300"),
      appOrigin: "http://localhost:5201",
    },
    pool: { connect: async () => db },
    session: async () => ({ user_id: "admin-1", is_admin: true }),
    json: () => {},
    audit: async () => {},
    limit: async () => {},
  });
  const postNative = (payload) =>
    route(
      Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
        method: "POST",
        headers: {
          origin: "http://localhost:5201",
          "content-type": "application/json",
        },
      }),
      { setHeader() {} },
      `/api/platform/admin/cases/${caseId}/native`,
    );

  await postNative({ revision: 4, workspace, assets: [] });
  assert.deepEqual(updates[0].slice(3), [null, null, null, false, null]);

  await postNative({
    revision: 4,
    workspace,
    assets: [],
    title: " 新标题 ",
    summary: " 新描述 ",
    category: " 实验复现 ",
  });
  assert.deepEqual(updates[1].slice(3), [
    "新标题",
    "新描述",
    "实验复现",
    false,
    null,
  ]);
});

test("admin cover upload stores hashed cover image, updates case cover, and rejects invalid mime", async () => {
  const caseId = "11111111-1111-4111-8111-111111111111";
  const queries = [];
  const db = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      if (sql.includes("FOR UPDATE")) return { rows: [{ revision: 5 }] };
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
    session: async () => ({ user_id: "admin-1", is_admin: true }),
    json: (_res, data, status) => {
      result = { data, status };
    },
    audit: async () => {},
    limit: async () => {},
  });
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await route(
    Object.assign(Readable.from([pngBytes]), {
      method: "POST",
      url: `/api/platform/admin/cases/${caseId}/cover?revision=5`,
      headers: {
        origin: "http://localhost:5201",
        "content-type": "image/png",
      },
    }),
    { setHeader() {} },
    `/api/platform/admin/cases/${caseId}/cover`,
  );
  assert.equal(result.status, 201);
  assert.match(result.data.cover, /^asset:cover-[0-9a-f]{64}\.png$/);
  assert.ok(
    queries.some(
      ([sql, params]) =>
        sql.startsWith("UPDATE featured_cases SET cover=$2") &&
        params[1] === result.data.cover,
    ),
  );

  await assert.rejects(
    route(
      Object.assign(Readable.from([pngBytes]), {
        method: "POST",
        url: `/api/platform/admin/cases/${caseId}/cover`,
        headers: {
          origin: "http://localhost:5201",
          "content-type": "text/plain",
        },
      }),
      { setHeader() {} },
      `/api/platform/admin/cases/${caseId}/cover`,
    ),
    { status: 415 },
  );
});
