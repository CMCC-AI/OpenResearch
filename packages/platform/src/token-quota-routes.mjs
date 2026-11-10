import { check, sameOrigin } from "./security.mjs";
import { tokenInteger } from "./token-quotas.mjs";
export function tokenQuotaRoutes({ config, pool, quota, input, json }) {
  return async (req, res, path, s, trustedOrigin = config.origin.origin) => {
    if (path === "/api/platform/token-quota") {
      check(req.method === "GET", 405);
      json(
        res,
        config.tokenQuota.enabled
          ? { enabled: true, ...(await quota.balance(s.user_id)) }
          : { enabled: false },
      );
      return true;
    }
    const prefix = "/api/platform/admin/token-quotas";
    if (path !== prefix && path !== prefix + "/reconcile") return false;
    check(s.is_admin, 403, "仅系统管理员可配置用户额度");
    check(config.tokenQuota.enabled, 409, "Token 配额尚未启用");
    check(["GET", "POST"].includes(req.method), 405);
    const value =
      req.method === "GET"
        ? Object.fromEntries(new URL(req.url, config.origin).searchParams)
        : await input(req);
    if (req.method === "POST") sameOrigin(req, trustedOrigin);
    check(
      typeof value.email === "string" && value.email.length <= 254,
      400,
      "请填写用户邮箱",
    );
    const user = (
      await pool.query(
        "SELECT id,email,name FROM platform_users WHERE email=$1",
        [value.email.trim().toLowerCase()],
      )
    ).rows[0];
    check(user, 404, "用户不存在");
    if (path === prefix + "/reconcile") {
      check(
        req.method === "POST" &&
          typeof value.reason === "string" &&
          value.reason.trim().length > 0 &&
          value.reason.length <= 500,
        400,
        "请填写补账原因",
      );
      check(
        typeof value.requestId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value.requestId,
          ),
        400,
        "请求标识无效",
      );
      const request = (
        await pool.query(
          "SELECT id FROM token_quota_requests WHERE id=$1 AND user_id=$2",
          [value.requestId, user.id],
        )
      ).rows[0];
      check(request, 404, "用户请求不存在");
      await quota.settle(
        request.id,
        tokenInteger(value.actualTokens),
        s.user_id,
        value.reason.trim(),
      );
    } else if (req.method === "POST") {
      await quota.configure(
        user.id,
        s.user_id,
        value.monthlyLimit,
        value.reason,
        value.idempotencyKey,
      );
    }
    json(res, {
      user,
      ...(await quota.balance(user.id)),
      requests: await quota.requests(user.id),
    });
    return true;
  };
}
