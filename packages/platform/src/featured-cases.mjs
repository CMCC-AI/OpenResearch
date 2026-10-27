import { createHash } from "node:crypto";
import { transaction } from "./db.mjs";
import { body } from "./tunnel.mjs";
import {
  check,
  id,
  text,
  browserSessionOrigin,
  workspaceOrigin,
} from "./security.mjs";

export const CASE_FILE_LIMIT = 25 * 1024 * 1024;
export const CASE_TOTAL_LIMIT = 200 * 1024 * 1024;
const NATIVE_FILE_LIMIT = 128 * 1024 * 1024;
const NATIVE_TOTAL_LIMIT = 512 * 1024 * 1024;
const uuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields =
  "id,title,summary,category,status,revision,sort_order,created_at,updated_at,published_at";

// Only allowlisted metadata reaches the public copy. Conversation text is kept
// verbatim for administrator review, including any paths it already contains.
function validateParts(parts, depth = 0) {
  check(Array.isArray(parts) && depth <= 32, 400, "消息片段格式无效或嵌套过深");
  for (const part of parts) {
    check(part && typeof part === "object" && !Array.isArray(part));
    check(typeof part.id === "string" && part.id.length <= 200);
    check(typeof part.type === "string" && part.type.length <= 100);
    check(part.text == null || typeof part.text === "string");
    check(part.name == null || typeof part.name === "string");
    check(part.tool == null || typeof part.tool === "string");
    if (part.state != null) {
      check(typeof part.state === "object" && !Array.isArray(part.state));
      if (part.state.input != null) object(part.state.input);
      for (const key of ["status", "title", "output", "error"]) {
        check(part.state[key] == null || typeof part.state[key] === "string");
      }
    }
    if (part.prompt != null) {
      const prompt = part.prompt;
      object(prompt);
      if (prompt.toolInput != null) object(prompt.toolInput);
      check(["plan", "permission", "question"].includes(prompt.kind));
      for (const key of ["plan", "question", "header", "tool", "note"])
        if (prompt[key] != null) string(prompt[key]);
      if (prompt.options != null)
        list(prompt.options, (option) => {
          object(option);
          string(option.label);
          if (option.description != null) string(option.description);
        });
      if (prompt.answers != null) strings(prompt.answers);
      if (prompt.annotations != null)
        list(prompt.annotations, (annotation) => {
          object(annotation);
          string(annotation.text);
        });
    }
    if (part.children != null) validateParts(part.children, depth + 1);
  }
  return parts;
}

const object = (value) =>
  check(value && typeof value === "object" && !Array.isArray(value));
const string = (value, max = 2 * 1024 * 1024) => {
  check(typeof value === "string" && Buffer.byteLength(value, "utf8") <= max);
  return value;
};
const timestamp = (value) => {
  check(Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000);
  return value;
};
const list = (value, map, max = 10000) => {
  check(Array.isArray(value) && value.length <= max);
  return value.map(map);
};
const strings = (value) => list(value, (item) => string(item));
function normalizeRuns(value) {
  return list(value, (run) => {
    object(run);
    check(
      ["done", "failed", "cancelled"].includes(run.status),
      400,
      "实验仍在执行，不能生成完成项目快照",
    );
    return {
      id: string(run.id, 100),
      experimentId: string(run.experimentId, 100),
      projectId: "snapshot",
      status: run.status,
      createdAt: timestamp(run.createdAt),
      updatedAt: timestamp(run.updatedAt),
      endedAt: run.endedAt == null ? null : timestamp(run.endedAt),
      cancelRequested: false,
      resultMarkdown:
        run.resultMarkdown == null ? null : string(run.resultMarkdown),
      command: run.command == null ? null : string(run.command),
      commitSha: run.commitSha == null ? null : string(run.commitSha, 200),
      exitCode: Number.isSafeInteger(run.exitCode) ? run.exitCode : null,
    };
  });
}
function normalizeStudy(study, sessionIds) {
  if (study == null) return null;
  object(study);
  check(
    [
      "team",
      "design",
      "diagnosis",
      "review",
      "literature",
      "reproduction",
      "analysis",
      "proposal",
    ].includes(study.mode),
  );
  const sessionId = (value) => (sessionIds.has(value) ? value : null);
  const result = {
    id: string(study.id, 100),
    sessionId: sessionId(study.sessionId),
    mode: study.mode,
    objective: string(study.objective),
    status: string(study.status, 100),
    plans: list(study.plans, (plan) => {
      object(plan);
      check(Number.isSafeInteger(plan.version) && plan.version >= 0);
      check(
        plan.workflow == null ||
          ["literature", "reproduction", "analysis", "proposal"].includes(
            plan.workflow,
          ),
      );
      return {
        version: plan.version,
        workflow: plan.workflow ?? null,
        summary: string(plan.summary),
        tasks: list(plan.tasks, (task) => {
          object(task);
          return {
            id: string(task.id, 100),
            role: string(task.role, 100),
            brief: string(task.brief),
            dependsOn: strings(task.dependsOn),
            outputs: strings(task.outputs),
            state: string(task.state, 100),
            sessionId: sessionId(task.sessionId),
            summary: task.summary == null ? null : string(task.summary),
            runIds: strings(task.runIds),
            artifacts: list(task.artifacts, (artifact) => {
              object(artifact);
              check(
                Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0,
              );
              return {
                path: string(artifact.path),
                sha256: string(artifact.sha256, 100),
                bytes: artifact.bytes,
              };
            }),
            ...(task.runContract?.experimentId
              ? {
                  runContract: {
                    experimentId: string(task.runContract.experimentId, 100),
                  },
                }
              : {}),
          };
        }),
      };
    }),
    decisions: list(study.decisions, (decision) => {
      object(decision);
      check(Number.isSafeInteger(decision.version));
      check(["pending", "approved", "rejected"].includes(decision.status));
      return {
        id: string(decision.id, 100),
        gate: string(decision.gate, 100),
        version: decision.version,
        scope: string(decision.scope),
        scopeHash: string(decision.scopeHash, 200),
        status: decision.status,
        reason: decision.reason == null ? null : string(decision.reason),
      };
    }),
    claims: list(study.claims ?? [], (claim) => {
      object(claim);
      return Object.fromEntries(
        ["id", "text", "support", "source", "location", "runId", "excerpt"]
          .filter((key) => claim[key] != null)
          .map((key) => [key, string(claim[key])]),
      );
    }),
  };
  check(result.sessionId, 400, "研究记录必须关联已保存的案例会话");
  check(
    Buffer.byteLength(JSON.stringify(result), "utf8") <= 2 * 1024 * 1024,
    413,
    "研究状态超过 2 MB，不能截断发布",
  );
  return result;
}

export function normalizeNativeWorkspace(value) {
  object(value);
  check(value.version === 1);
  string(value.projectId, 100);
  string(value.sessionId, 100);
  object(value.responses);
  object(value.assets);
  const projects = value.responses["/api/projects"]?.projects;
  check(
    Array.isArray(projects) &&
      projects.length === 1 &&
      projects[0].id === value.projectId,
    400,
    "项目副本必须且只能包含当前项目",
  );
  const sessions = Object.values(value.responses).find((response) =>
    Array.isArray(response?.sessions),
  )?.sessions;
  check(
    Array.isArray(sessions) &&
      sessions.some((session) => session.id === value.sessionId),
  );
  check(
    sessions.every(
      (session) => session.projectId === value.projectId && !session.busy,
    ),
  );
  const sessionIds = new Set(sessions.map((session) => session.id));
  const materialRefs = new Set();
  for (const session of sessions) {
    const messages =
      value.responses[`/api/chat/sessions/${session.id}/messages`]?.messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (!Array.isArray(message?.parts)) continue;
      for (const part of message.parts)
        if (part?.type === "material" && typeof part.text === "string")
          materialRefs.add(part.text);
    }
  }
  const materials = new Map();
  const runs =
    value.responses[`/api/projects/${value.projectId}/runs`]?.runs ?? [];
  const experiments =
    value.responses[`/api/projects/${value.projectId}/experiments`]
      ?.experiments ?? [];
  const runIds = new Set(runs.map((run) => run.id)),
    experimentIds = new Set(experiments.map((experiment) => experiment.id));
  const allowed =
    /^\/api\/(?:projects(?:\/activity|\/[^/?]+(?:\/(?:ui-state|experiments|runs|files|code-tree|file))?)?|chat\/sessions(?:\/[^/?]+(?:\/(?:messages|worktree))?)?|research\/sessions\/[^/?]+|materials\/[^/?]+|settings\/(?:ui-state|compute)|files\/abs|harnesses|skills|runs\/[^/?]+\/(?:diff|log)|experiments\/[^/?]+\/diff)(?:\?|$)/;
  for (const [path, response] of Object.entries(value.responses)) {
    check(allowed.test(path), 400, "项目副本含不支持的资源");
    const route = new URL(path, "http://snapshot.invalid").pathname;
    const project = route.match(/^\/api\/projects\/([^/]+)/);
    if (project && project[1] !== "activity")
      check(project[1] === value.projectId, 400, "项目副本混入其他项目资源");
    const chat = route.match(/^\/api\/(?:chat|research)\/sessions\/([^/]+)/);
    if (chat) check(sessionIds.has(chat[1]), 400, "项目副本混入其他会话资源");
    const run = route.match(/^\/api\/runs\/([^/]+)/);
    if (run) check(runIds.has(run[1]));
    const experiment = route.match(/^\/api\/experiments\/([^/]+)/);
    if (experiment) check(experimentIds.has(experiment[1]));
    check(response && typeof response === "object");
    const material = route.match(/^\/api\/materials\/([^/]+)$/);
    if (material) {
      const materialId = material[1];
      check(
        path === route &&
          uuid(materialId) &&
          materialRefs.has(materialId) &&
          response.id === materialId &&
          response.projectId === value.projectId,
        400,
        "项目副本混入其他项目或未引用的材料",
      );
      check(Array.isArray(response.files), 400, "材料文件清单无效");
      const fileIds = new Set();
      for (const file of response.files) {
        check(
          file &&
            typeof file.id === "string" &&
            /^[a-z0-9_-]{1,100}$/i.test(file.id) &&
            !fileIds.has(file.id),
          400,
          "材料文件标识无效或重复",
        );
        fileIds.add(file.id);
        const assetName =
          value.assets[`/api/materials/${materialId}/${file.id}/download`];
        check(
          typeof file.sha256 === "string" &&
            /^[0-9a-f]{64}$/i.test(file.sha256) &&
            typeof assetName === "string" &&
            assetName.startsWith(`native-${file.sha256}.`),
          400,
          "材料原文件副本缺失或哈希不一致",
        );
      }
      materials.set(materialId, fileIds);
    }
  }
  for (const [path, name] of Object.entries(value.assets)) {
    check(
      /^\/api\/(?:projects\/[^/?]+\/(?:file\/raw|files\/file)|chat\/attachments\/[^/?]+|files\/abs\/raw|research\/studies\/[^/?]+\/package|materials\/[^/?]+\/[^/?]+\/download)(?:\?|$)/.test(
        path,
      ),
    );
    const materialAsset = path.match(
      /^\/api\/materials\/([^/?]+)\/([^/?]+)\/download$/,
    );
    if (path.startsWith("/api/materials/"))
      check(
        materialAsset && materials.get(materialAsset[1])?.has(materialAsset[2]),
        400,
        "材料下载资源不属于已复制的材料清单",
      );
    check(
      typeof name === "string" &&
        /^native-[0-9a-f]{64}\.[a-z0-9]{1,10}$/i.test(name),
    );
  }
  check(
    Buffer.byteLength(JSON.stringify(value), "utf8") <= 16 * 1024 * 1024,
    413,
    "完整项目元数据超过 16 MB",
  );
  return {
    version: 1,
    projectId: value.projectId,
    sessionId: value.sessionId,
    responses: value.responses,
    assets: value.assets,
  };
}

export function normalizeCase(value) {
  check(value && typeof value === "object");
  if (value.workspace != null)
    return {
      workspace: normalizeNativeWorkspace(value.workspace),
      sessions: [],
      ...(value.projectName
        ? { projectName: text(value.projectName, 300) }
        : {}),
    };
  check(
    Array.isArray(value.sessions) &&
      value.sessions.length > 0 &&
      value.sessions.length <= 500,
    400,
    "需要包含项目的研究对话，最多 500 个会话",
  );
  const sessionIds = new Set(
    value.sessions.map(
      (session, index) => session?.id ?? `session-${index + 1}`,
    ),
  );
  check(sessionIds.size === value.sessions.length, 400, "会话 ID 重复");
  const runs = value.runs == null ? undefined : normalizeRuns(value.runs);
  let count = 0;
  const sessions = value.sessions.map((session, index) => {
    check(session && typeof session === "object" && !Array.isArray(session));
    check(Array.isArray(session.messages) && session.messages.length <= 10000);
    check(
      session.messages.every(
        (message) =>
          message && typeof message === "object" && !Array.isArray(message),
      ),
    );
    const identifiers = new Set(session.messages.map((message) => message.id));
    check(
      identifiers.size === session.messages.length,
      400,
      "对话消息 ID 重复",
    );
    if (session.id != null)
      check(
        typeof session.id === "string" &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(session.id),
      );
    if (session.harness != null)
      check(
        ["claude-code", "codex", "opencode", "cursor", "antigravity"].includes(
          session.harness,
        ),
      );
    if (session.activeLeafId != null)
      check(identifiers.has(session.activeLeafId));
    return {
      ...(session.id != null ? { id: session.id } : {}),
      ...(session.harness != null ? { harness: session.harness } : {}),
      ...(session.archived != null
        ? { archived: Boolean(session.archived) }
        : {}),
      ...(session.parentSessionId != null
        ? {
            parentSessionId: sessionIds.has(session.parentSessionId)
              ? session.parentSessionId
              : null,
          }
        : {}),
      ...(session.activeLeafId != null
        ? { activeLeafId: session.activeLeafId }
        : {}),
      ...(session.research != null
        ? {
            research: {
              study: normalizeStudy(session.research.study, sessionIds),
              runs:
                session.research.runs == null
                  ? (runs ?? [])
                  : normalizeRuns(session.research.runs),
            },
          }
        : {}),
      title: text(session.title, 300),
      messages: session.messages.map((message) => {
        count++;
        check(
          typeof message.id === "string" &&
            /^[a-zA-Z0-9_-]{1,100}$/.test(message.id),
        );
        check(["user", "assistant"].includes(message.role));
        check(
          Number.isSafeInteger(message.createdAt) &&
            message.createdAt >= 0 &&
            message.createdAt <= 8640000000000000,
        );
        check(
          typeof message.content === "string" &&
            Buffer.byteLength(message.content, "utf8") <= 2 * 1024 * 1024,
          413,
          "单条消息超过 2 MB，不能截断发布",
        );
        check(
          message.parentId == null ||
            (message.parentId !== message.id &&
              identifiers.has(message.parentId)),
        );
        if (message.parts != null) {
          check(
            Buffer.byteLength(JSON.stringify(message.parts), "utf8") <=
              2 * 1024 * 1024,
            413,
            "单条消息片段超过 2 MB，不能截断发布",
          );
          validateParts(message.parts);
        }
        return {
          ...(message.parts != null ? { parts: message.parts } : {}),
          id: message.id,
          parentId: message.parentId ?? null,
          role: message.role,
          createdAt: message.createdAt,
          ...(message.completedAt != null
            ? { completedAt: timestamp(message.completedAt) }
            : {}),
          content: message.content,
        };
      }),
    };
  });
  check(
    count > 0 && count <= 50000,
    400,
    "案例需要包含研究记录，最多 50,000 条消息",
  );
  return {
    sessions,
    ...(value.workspace != null
      ? { workspace: normalizeNativeWorkspace(value.workspace) }
      : {}),
    ...(value.projectName != null
      ? { projectName: text(value.projectName, 300) }
      : {}),
    ...(runs ? { runs } : {}),
    ...(value.experiments != null
      ? {
          experiments: list(value.experiments, (experiment) => {
            object(experiment);
            return {
              id: string(experiment.id, 100),
              projectId: "snapshot",
              slug: string(experiment.slug, 300),
              branchName: string(experiment.branchName, 1000),
              title: experiment.title == null ? null : string(experiment.title),
              description:
                experiment.description == null
                  ? null
                  : string(experiment.description),
              runCommand: string(experiment.runCommand),
              agentStatus: string(experiment.agentStatus, 100),
              createdAt: timestamp(experiment.createdAt),
              updatedAt: timestamp(experiment.updatedAt),
              archived: Boolean(experiment.archived),
              chatSessionId: sessionIds.has(experiment.chatSessionId)
                ? experiment.chatSessionId
                : null,
            };
          }),
        }
      : {}),
  };
}

async function caseInput(req, maxBytes = 16 * 1024 * 1024) {
  check(req.headers["content-type"]?.split(";")[0] === "application/json", 415);
  let value;
  try {
    value = JSON.parse((await body(req, maxBytes)).toString("utf8"));
  } catch (error) {
    if (error.status) throw error;
    check(false, 400, "JSON 格式无效");
  }
  check(value && typeof value === "object" && !Array.isArray(value));
  return value;
}

export function featuredCaseRoutes({
  config,
  pool,
  session,
  json,
  audit,
  limit,
}) {
  return async (req, res, path, workspace) => {
    const admin =
      path === "/api/platform/admin/cases" ||
      path.startsWith("/api/platform/admin/cases/");
    const prefix = admin ? "/api/platform/admin/cases" : "/api/platform/cases";
    if (!admin && path !== prefix && !path.startsWith(prefix + "/"))
      return false;
    const origin =
      req.headers.origin === config.origin.origin
        ? config.origin.origin
        : workspace
          ? workspaceOrigin(config, workspace)
          : config.appOrigin;
    browserSessionOrigin(req, origin);
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "Origin");
    res.setHeader(
      "access-control-expose-headers",
      "content-length,content-range,accept-ranges,x-openresearch-presentation",
    );
    res.setHeader("cache-control", "private, no-store");
    if (req.method === "OPTIONS") {
      res.setHeader(
        "access-control-allow-methods",
        "GET, HEAD, POST, DELETE, OPTIONS",
      );
      res.setHeader("access-control-allow-headers", "content-type,range");
      res.writeHead(204);
      res.end();
      return true;
    }
    const authorize = async () => {
      const user = await session(req);
      if (admin) check(user.is_admin, 403, "仅系统管理员可发布精选案例");
      return user;
    };
    const user = await authorize();
    await limit(`cases:${user.user_id}`, admin ? 600 : 300, 60);
    if (!admin)
      check(
        req.method === "GET" ||
          (req.method === "HEAD" && path.endsWith("/assets")),
        405,
      );
    const suffix = path.slice(prefix.length).split("/").filter(Boolean);
    check(suffix.length <= 3, 404);
    if (suffix.length === 0) {
      if (req.method === "GET") {
        const result = await pool.query(
          `SELECT ${fields}${admin ? ",source_project_id" : ""} FROM featured_cases ${admin ? "" : "WHERE status='published'"} ORDER BY sort_order,published_at DESC NULLS LAST,created_at DESC LIMIT 200`,
        );
        json(res, { cases: result.rows });
        return true;
      }
      check(admin && req.method === "POST", 405);
      const value = await caseInput(req);
      const snapshot = normalizeCase(value.snapshot);
      check(
        Number.isSafeInteger(value.expectedFileCount) &&
          value.expectedFileCount >= 0 &&
          value.expectedFileCount <= (value.snapshot.workspace ? 2000 : 200),
      );
      const source = text(value.sourceProjectId, 100);
      const caseId = id();
      await authorize();
      await transaction(pool, async (db) => {
        await db.query(
          `INSERT INTO featured_cases(id,created_by,source_project_id,title,summary,category,snapshot,expected_file_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            caseId,
            user.user_id,
            source,
            text(value.title, 200),
            text(value.summary, 4000),
            text(value.category, 80),
            JSON.stringify(snapshot),
            value.expectedFileCount,
          ],
        );
        await audit(db, user.user_id, null, "case.draft", caseId);
      });
      json(res, { id: caseId }, 201);
      return true;
    }
    const [caseId, action, fileId] = suffix;
    check(uuid(caseId), 404);
    check(!fileId || action === "files", 404);
    if (action === "assets" && !fileId) {
      check(req.method === "GET" || req.method === "HEAD", 405);
      const name = new URL(req.url, config.origin).searchParams.get("name");
      check(
        typeof name === "string" &&
          /^native-[0-9a-f]{64}\.[a-z0-9]{1,10}$/i.test(name),
        404,
      );
      const result = await pool.query(
        `SELECT f.content,f.size,f.sha256 FROM featured_case_files f JOIN featured_cases c ON c.id=f.case_id WHERE c.id=$1 AND f.name=$2 ${admin ? "" : "AND c.status='published'"}`,
        [caseId, name],
      );
      const file = result.rows[0];
      check(file, 404, "案例文件不存在或案例已下架");
      const extension = name.split(".").at(-1).toLowerCase();
      const mime =
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
          pdf: "application/pdf",
          zip: "application/zip",
        }[extension] || "text/plain; charset=utf-8";
      let content = file.content;
      let status = 200;
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const headers = {};
      if (range && req.method !== "HEAD") {
        const start = Number(range[1]),
          end = range[2]
            ? Math.min(Number(range[2]), file.size - 1)
            : file.size - 1;
        if (start >= file.size || end < start) {
          res.writeHead(416, { "content-range": `bytes */${file.size}` });
          res.end();
          return true;
        }
        content = content.subarray(start, end + 1);
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${file.size}`;
      }
      res.writeHead(status, {
        ...headers,
        "accept-ranges": "bytes",
        "content-type": mime,
        "content-length": content.length,
        "content-security-policy": "sandbox; default-src 'none'",
        "x-openresearch-presentation": [
          "png",
          "jpg",
          "jpeg",
          "gif",
          "webp",
          "svg",
        ].includes(extension)
          ? "image"
          : extension === "pdf"
            ? "pdf"
            : [
                  "md",
                  "txt",
                  "json",
                  "csv",
                  "py",
                  "js",
                  "ts",
                  "html",
                  "tex",
                ].includes(extension)
              ? "text"
              : "download",
      });
      res.end(req.method === "HEAD" ? undefined : content);
      return true;
    }
    if (action === "native" && !fileId) {
      check(admin && req.method === "POST", 405);
      const value = await caseInput(req, 768 * 1024 * 1024);
      const native = normalizeNativeWorkspace(value.workspace);
      const manifestNames = new Set(Object.values(native.assets));
      check(manifestNames.size <= 2000, 413, "原项目副本最多包含 2,000 个文件");
      const copies = list(
        value.assets ?? [],
        (file) => {
          object(file);
          string(file.name, 255);
          check(/^native-[0-9a-f]{64}\.[a-z0-9]{1,10}$/i.test(file.name));
          check(
            typeof file.content === "string" &&
              file.content.length <= Math.ceil(NATIVE_FILE_LIMIT / 3) * 4 + 4,
            413,
          );
          const content = Buffer.from(file.content, "base64");
          check(content.length <= NATIVE_FILE_LIMIT, 413);
          const sha256 = createHash("sha256").update(content).digest("hex");
          check(file.name.startsWith(`native-${sha256}.`), 400, "文件校验失败");
          return {
            id: id(),
            name: file.name,
            size: content.length,
            sha256,
            content,
          };
        },
        2000,
      );
      check(
        copies.reduce((sum, file) => sum + file.size, 0) <= NATIVE_TOTAL_LIMIT,
        413,
      );
      const names = new Set(copies.map((file) => file.name));
      check(names.size === copies.length);
      check(
        [...names].every((name) => manifestNames.has(name)),
        400,
        "上传了不属于原项目的文件",
      );
      await authorize();
      await transaction(pool, async (db) => {
        const current = (
          await db.query(
            "SELECT revision,snapshot,source_project_id FROM featured_cases WHERE id=$1 FOR UPDATE",
            [caseId],
          )
        ).rows[0];
        check(current, 404);
        check(
          current.revision === value.revision,
          409,
          "案例已变化，请重新读取",
        );
        check(
          current.source_project_id === native.projectId,
          400,
          "只允许同步原关联项目",
        );
        const existing = await db.query(
          "SELECT name FROM featured_case_files WHERE case_id=$1",
          [caseId],
        );
        await db.query(
          "DELETE FROM featured_case_files WHERE case_id=$1 AND NOT (name = ANY($2::text[]))",
          [caseId, [...manifestNames]],
        );
        for (const file of copies)
          await db.query(
            "INSERT INTO featured_case_files VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(case_id,name) DO UPDATE SET size=EXCLUDED.size,sha256=EXCLUDED.sha256,content=EXCLUDED.content",
            [file.id, caseId, file.name, file.size, file.sha256, file.content],
          );
        await db.query(
          "UPDATE featured_cases SET snapshot=$2,expected_file_count=$3,revision=revision+1,updated_at=now() WHERE id=$1",
          [
            caseId,
            JSON.stringify({
              sessions: [],
              projectName: native.responses["/api/projects"].projects[0].name,
              workspace: native,
            }),
            manifestNames.size,
          ],
        );
        await audit(db, user.user_id, null, "case.native", caseId);
      });
      json(res, { ok: true });
      return true;
    }
    if (action === "files" && fileId) {
      check(uuid(fileId) && req.method === "GET", 404);
      const result = await pool.query(
        `SELECT f.name,f.size,f.sha256,f.content FROM featured_case_files f JOIN featured_cases c ON c.id=f.case_id WHERE c.id=$1 AND f.id=$2 ${admin ? "" : "AND c.status='published'"}`,
        [caseId, fileId],
      );
      const file = result.rows[0];
      check(file, 404, "成果文件不存在或案例已下架");
      const name = encodeURIComponent(file.name).replace(
        /['()*]/g,
        (char) => "%" + char.charCodeAt(0).toString(16),
      );
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="research-artifact"; filename*=UTF-8''${name}`,
        "content-length": file.size,
        "content-security-policy": "sandbox; default-src 'none'",
      });
      res.end(file.content);
      return true;
    }
    if (!action && req.method === "GET") {
      const result = await pool.query(
        `SELECT ${fields},snapshot${admin ? ",source_project_id,expected_file_count" : ""} FROM featured_cases WHERE id=$1 ${admin ? "" : "AND status='published'"}`,
        [caseId],
      );
      check(result.rows[0], 404, "案例不存在或尚未发布");
      const files = await pool.query(
        "SELECT id,name,size,sha256 FROM featured_case_files WHERE case_id=$1 ORDER BY name,id",
        [caseId],
      );
      json(res, { ...result.rows[0], files: files.rows });
      return true;
    }
    check(admin, 405);
    if (action === "files") {
      check(!fileId && req.method === "POST", 405);
      const name = text(
        new URL(req.url, config.origin).searchParams.get("name"),
        255,
      );
      check(
        !/[\\/\x00-\x1f\x7f]/.test(name) && ![".", ".."].includes(name),
        400,
        "请使用不含目录的公开文件名",
      );
      check(req.headers["content-type"] === "application/octet-stream", 415);
      const nativeFile = /^native-[0-9a-f]{64}\.[a-z0-9]{1,10}$/i.test(name);
      const content = await body(
        req,
        nativeFile ? NATIVE_FILE_LIMIT : CASE_FILE_LIMIT,
      );
      await authorize();
      const file = {
        id: id(),
        name,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
      await transaction(pool, async (db) => {
        const row = (
          await db.query(
            "SELECT status FROM featured_cases WHERE id=$1 FOR UPDATE",
            [caseId],
          )
        ).rows[0];
        check(row, 404);
        check(row.status === "draft", 409, "请先下架案例，再修改公开内容");
        const usage = (
          await db.query(
            "SELECT count(*)::int AS count,coalesce(sum(size),0)::bigint AS bytes FROM featured_case_files WHERE case_id=$1",
            [caseId],
          )
        ).rows[0];
        check(
          usage.count < (nativeFile ? 2000 : 200) &&
            Number(usage.bytes) + content.length <=
              (nativeFile ? NATIVE_TOTAL_LIMIT : CASE_TOTAL_LIMIT),
          413,
          nativeFile
            ? "原项目副本最多 2,000 个文件，总计 512 MB"
            : "补充成果最多 200 个文件，总计 200 MB",
        );
        const exists = await db.query(
          "SELECT 1 FROM featured_case_files WHERE case_id=$1 AND name=$2",
          [caseId, name],
        );
        check(!exists.rows.length, 409, "公开文件名重复");
        await db.query(
          "INSERT INTO featured_case_files VALUES($1,$2,$3,$4,$5,$6)",
          [file.id, caseId, name, file.size, file.sha256, content],
        );
        await db.query(
          "UPDATE featured_cases SET revision=revision+1,updated_at=now() WHERE id=$1",
          [caseId],
        );
        await audit(db, user.user_id, null, "case.file", caseId);
      });
      json(res, file, 201);
      return true;
    }
    if (!action && req.method === "DELETE") {
      await transaction(pool, async (db) => {
        const row = (
          await db.query(
            "SELECT status FROM featured_cases WHERE id=$1 FOR UPDATE",
            [caseId],
          )
        ).rows[0];
        check(row, 404);
        check(row.status === "draft", 409, "请先下架案例");
        await db.query("DELETE FROM featured_cases WHERE id=$1", [caseId]);
        await audit(db, user.user_id, null, "case.delete", caseId);
      });
      json(res, { ok: true });
      return true;
    }
    check(
      req.method === "POST" &&
        ["publish", "unpublish", "order"].includes(action),
      405,
    );
    const value = await caseInput(req);
    await authorize();
    await transaction(pool, async (db) => {
      const row = (
        await db.query(
          "SELECT status,revision,expected_file_count FROM featured_cases WHERE id=$1 FOR UPDATE",
          [caseId],
        )
      ).rows[0];
      check(row, 404);
      check(
        Number.isSafeInteger(value.revision) && row.revision === value.revision,
        409,
        "案例已变化，请重新预览确认",
      );
      if (action === "publish") {
        check(
          row.status === "draft" && value.reviewed === true,
          400,
          "请先审核完整对话和成果文件",
        );
        const files = await db.query(
          "SELECT count(*)::int AS count FROM featured_case_files WHERE case_id=$1",
          [caseId],
        );
        check(
          files.rows[0].count === row.expected_file_count,
          409,
          "成果文件尚未复制完整，不能发布；请删除草稿后重新导入",
        );
        await db.query(
          "UPDATE featured_cases SET status='published',published_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",
          [caseId],
        );
      } else if (action === "unpublish") {
        await db.query(
          "UPDATE featured_cases SET status='draft',revision=revision+1,updated_at=now() WHERE id=$1",
          [caseId],
        );
      } else {
        check(
          Number.isSafeInteger(value.order) && Math.abs(value.order) <= 100000,
        );
        await db.query(
          "UPDATE featured_cases SET sort_order=$2,revision=revision+1,updated_at=now() WHERE id=$1",
          [caseId, value.order],
        );
      }
      await audit(db, user.user_id, null, `case.${action}`, caseId);
    });
    json(res, { ok: true });
    return true;
  };
}
