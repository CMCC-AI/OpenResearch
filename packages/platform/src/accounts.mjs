import { transaction } from "./db.mjs";
import {
  check,
  email,
  hash,
  token,
  passwordHash,
  sessionCookie,
} from "./security.mjs";

export function accountRoutes({
  config,
  pool,
  limit,
  input,
  json,
  audit,
  tunnels,
}) {
  const deliveries = new Set();
  function deliver(user, secret) {
    const url = new URL("/_account/login", config.origin.origin);
    url.hash = `reset=${secret}`;
    const task = Promise.resolve()
      .then(() => config.sendPasswordReset({ to: user.email, url: url.href }))
      .catch(async () => {
        await pool.query(
          "DELETE FROM password_reset_tokens WHERE token_hash=$1",
          [hash(secret)],
        );
        await audit(pool, user.id, null, "password.reset.delivery_failed");
      });
    deliveries.add(task);
    task.catch(() => {}).finally(() => deliveries.delete(task));
  }
  return {
    close: () => Promise.allSettled([...deliveries]),
    async public(req, res, path) {
      if (path === "/api/platform/auth-options" && req.method === "GET") {
        json(res, { passwordRecovery: !!config.sendPasswordReset });
        return true;
      }
      if (path === "/api/platform/password/forgot" && req.method === "POST") {
        check(
          config.sendPasswordReset,
          503,
          "邮件找回尚未启用，请联系管理员协助恢复账号",
        );
        await limit(
          `reset-ip:${hash(req.socket.remoteAddress || "")}`,
          10,
          900,
        );
        const address = email((await input(req)).email);
        await limit(`reset-email:${hash(address)}`, 3, 900);
        const secret = token();
        const user = await transaction(pool, async (db) => {
          const { rows } = await db.query(
            "SELECT id,email,password_version FROM platform_users WHERE email=$1 AND NOT disabled FOR UPDATE",
            [address],
          );
          if (!rows[0]) return null;
          await db.query("DELETE FROM password_reset_tokens WHERE user_id=$1", [
            rows[0].id,
          ]);
          await db.query(
            "INSERT INTO password_reset_tokens(token_hash,user_id,password_version,expires_at) VALUES($1,$2,$3,now()+interval '20 minutes')",
            [hash(secret), rows[0].id, rows[0].password_version],
          );
          await audit(db, rows[0].id, null, "password.reset.request");
          return rows[0];
        });
        if (user) deliver(user, secret);
        json(res, {
          ok: true,
          message:
            "如果该邮箱已注册且可用，你将收到密码重置邮件，请检查收件箱及垃圾邮件。",
        });
        return true;
      }
      if (path === "/api/platform/password/reset" && req.method === "POST") {
        await limit(
          `reset-use:${hash(req.socket.remoteAddress || "")}`,
          20,
          900,
        );
        const b = await input(req);
        check(
          typeof b.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(b.token),
          400,
          "重置链接无效或已过期，请重新申请",
        );
        const encoded = await passwordHash(b.password);
        const revoked = await transaction(pool, async (db) => {
          const { rows } = await db.query(
            `SELECT u.id FROM password_reset_tokens r JOIN platform_users u ON u.id=r.user_id
            WHERE r.token_hash=$1 AND r.expires_at>now() AND NOT u.disabled AND r.password_version=u.password_version FOR UPDATE OF u,r`,
            [hash(b.token)],
          );
          check(rows[0], 400, "重置链接无效或已过期，请重新申请");
          const user = rows[0].id;
          const sessions = await db.query(
            "SELECT token_hash FROM platform_sessions WHERE user_id=$1",
            [user],
          );
          await db.query(
            "UPDATE platform_users SET password_hash=$2,password_version=password_version+1 WHERE id=$1",
            [user, encoded],
          );
          await db.query("DELETE FROM password_reset_tokens WHERE user_id=$1", [
            user,
          ]);
          await db.query("DELETE FROM platform_sessions WHERE user_id=$1", [
            user,
          ]);
          await audit(db, user, null, "password.reset.complete");
          return sessions.rows;
        });
        for (const tunnel of tunnels.values())
          for (const row of revoked) tunnel.revokeSession(row.token_hash);
        res.setHeader("set-cookie", sessionCookie("", config.secure, 0));
        json(res, { ok: true });
        return true;
      }
      return false;
    },
    async admin(req, res, path, session) {
      if (!path.startsWith("/api/platform/admin/")) return false;
      check(session.is_admin, 403, "仅系统管理员可访问");
      check(path === "/api/platform/admin/users", 404);
      check(req.method === "GET", 405);
      const params = new URL(req.url, config.origin).searchParams;
      const page = Number(params.get("page") || 1);
      const q = (params.get("q") || "").trim();
      check(
        Number.isSafeInteger(page) &&
          page >= 1 &&
          page <= 100000 &&
          q.length <= 120,
      );
      const result = await transaction(pool, async (db) => {
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const summary = await db.query(`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE NOT disabled)::int AS enabled,
          count(*) FILTER(WHERE disabled)::int AS disabled,
          count(*) FILTER(WHERE is_admin)::int AS admins FROM platform_users`);
        const filtered = await db.query(
          "SELECT count(*)::int AS total FROM platform_users WHERE email ILIKE $1 OR name ILIKE $1",
          [`%${q}%`],
        );
        const users = await db.query(
          `SELECT u.id,u.email,u.name,u.is_admin,u.disabled,u.created_at,u.last_login_at,
          (SELECT count(*)::int FROM workspaces w WHERE w.created_by=u.id) AS workspace_count
          FROM platform_users u WHERE u.email ILIKE $1 OR u.name ILIKE $1
          ORDER BY u.created_at DESC,u.id LIMIT 25 OFFSET $2`,
          [`%${q}%`, (page - 1) * 25],
        );
        return {
          summary: summary.rows[0],
          total: filtered.rows[0].total,
          page,
          pageSize: 25,
          users: users.rows,
        };
      });
      json(res, result);
      return true;
    },
  };
}
