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
const uuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields =
  "id,title,summary,category,status,revision,sort_order,created_at,updated_at,published_at";

// Only allowlisted metadata reaches the public copy. Conversation text is kept
// verbatim for administrator review, including any paths it already contains.
export function normalizeCase(value) {
  check(value && typeof value === "object");
  check(
    Array.isArray(value.sessions) &&
      value.sessions.length > 0 &&
      value.sessions.length <= 500,
    400,
    "需要包含项目的研究对话，最多 500 个会话",
  );
  let count = 0;
  const sessions = value.sessions.map((session) => {
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
    return {
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
        return {
          id: message.id,
          parentId: message.parentId ?? null,
          role: message.role,
          createdAt: message.createdAt,
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
  return { sessions };
}

async function caseInput(req) {
  check(req.headers["content-type"]?.split(";")[0] === "application/json", 415);
  let value;
  try {
    value = JSON.parse((await body(req, 16 * 1024 * 1024)).toString("utf8"));
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
    res.setHeader("cache-control", "private, no-store");
    if (req.method === "OPTIONS") {
      res.setHeader(
        "access-control-allow-methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader("access-control-allow-headers", "content-type");
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
    if (!admin) check(req.method === "GET", 405);
    const suffix = path.slice(prefix.length).split("/").filter(Boolean);
    check(suffix.length <= 3, 404);
    if (suffix.length === 0) {
      if (req.method === "GET") {
        const result = await pool.query(
          `SELECT ${fields} FROM featured_cases ${admin ? "" : "WHERE status='published'"} ORDER BY sort_order,published_at DESC NULLS LAST,created_at DESC LIMIT 200`,
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
          value.expectedFileCount <= 200,
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
      const content = await body(req, CASE_FILE_LIMIT);
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
          usage.count < 200 &&
            Number(usage.bytes) + content.length <= CASE_TOTAL_LIMIT,
          413,
          "每个案例最多 200 个文件，总计 200 MB",
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
