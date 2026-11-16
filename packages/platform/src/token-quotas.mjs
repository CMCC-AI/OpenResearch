import { randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { check } from "./security.mjs";

export function tokenInteger(value) {
  check(
    Number.isSafeInteger(value) && value >= 0,
    400,
    "Token 数量必须是非负安全整数",
  );
  return value;
}
const snapshot = (row, limit) => ({
  period: row.period,
  timezone: "Asia/Shanghai",
  monthlyLimit: Number(limit),
  granted: Number(row.granted),
  used: Number(row.used),
  reserved: Number(row.reserved),
  available: Math.max(
    0,
    Number(row.granted) - Number(row.used) - Number(row.reserved),
  ),
});
export async function ensureTokenQuota(db, user, limit) {
  tokenInteger(limit);
  await db.query(
    "INSERT INTO token_quota_accounts(user_id,monthly_limit) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
    [user, limit],
  );
}
async function current(db, user, defaultLimit) {
  await ensureTokenQuota(db, user, defaultLimit);
  const policy = (
    await db.query(
      "SELECT monthly_limit FROM token_quota_accounts WHERE user_id=$1 FOR UPDATE",
      [user],
    )
  ).rows[0];
  const period = (
    await db.query(
      "SELECT to_char(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS period",
    )
  ).rows[0].period;
  await db.query(
    "INSERT INTO token_quota_periods(user_id,period,granted) VALUES($1,$2,$3) ON CONFLICT(user_id,period) DO NOTHING",
    [user, period, policy.monthly_limit],
  );
  return { period, limit: policy.monthly_limit };
}
export function tokenQuotas(pool, defaultLimit) {
  return {
    async balance(user) {
      return transaction(pool, async (db) => {
        const { period, limit } = await current(db, user, defaultLimit);
        return snapshot(
          (
            await db.query(
              "SELECT * FROM token_quota_periods WHERE user_id=$1 AND period=$2",
              [user, period],
            )
          ).rows[0],
          limit,
        );
      });
    },
    async configure(user, actor, monthlyLimit, reason, key) {
      tokenInteger(monthlyLimit);
      check(
        typeof reason === "string" &&
          reason.trim().length > 0 &&
          reason.length <= 500 &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            key,
          ),
        400,
        "请填写原因和有效请求标识",
      );
      return transaction(pool, async (db) => {
        const actors = await db.query(
          "SELECT id,is_admin,disabled FROM platform_users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
          [[user, actor]],
        );
        check(
          actors.rows.some(
            (row) => row.id === actor && row.is_admin && !row.disabled,
          ),
          403,
          "管理员权限已变更，请重新登录",
        );
        const { period } = await current(db, user, defaultLimit);
        const existing = (
          await db.query(
            "SELECT * FROM token_quota_adjustments WHERE user_id=$1 AND idempotency_key=$2",
            [user, key],
          )
        ).rows[0];
        if (existing) {
          check(
            Number(existing.monthly_limit) === monthlyLimit &&
              existing.reason === reason.trim() &&
              existing.actor_id === actor,
            409,
            "请求标识已用于其他配置",
          );
        } else {
          await db.query(
            "INSERT INTO token_quota_adjustments(user_id,idempotency_key,monthly_limit,actor_id,reason) VALUES($1,$2,$3,$4,$5)",
            [user, key, monthlyLimit, actor, reason.trim()],
          );
          await db.query(
            "UPDATE token_quota_accounts SET monthly_limit=$2,updated_at=now() WHERE user_id=$1",
            [user, monthlyLimit],
          );
          // Preserve consumption and in-flight requests when changing the limit.
          await db.query(
            "UPDATE token_quota_periods SET granted=$3 WHERE user_id=$1 AND period=$2",
            [user, period, monthlyLimit],
          );
          await db.query(
            "INSERT INTO audit_events(actor_id,action,resource) VALUES($1,'token_quota.configure',$2)",
            [
              actor,
              JSON.stringify({
                user,
                monthlyLimit,
                key,
                reason: reason.trim(),
              }),
            ],
          );
        }
        const policy = (
          await db.query(
            "SELECT monthly_limit FROM token_quota_accounts WHERE user_id=$1",
            [user],
          )
        ).rows[0];
        return snapshot(
          (
            await db.query(
              "SELECT * FROM token_quota_periods WHERE user_id=$1 AND period=$2",
              [user, period],
            )
          ).rows[0],
          policy.monthly_limit,
        );
      });
    },
    async reserve(user, workspace, model, tokens) {
      tokenInteger(tokens);
      check(tokens > 0, 400);
      return transaction(pool, async (db) => {
        const { period } = await current(db, user, defaultLimit);
        const result = await db.query(
          "UPDATE token_quota_periods SET reserved=reserved+$3 WHERE user_id=$1 AND period=$2 AND granted-used-reserved >= $3 RETURNING user_id",
          [user, period, tokens],
        );
        check(
          result.rowCount === 1,
          402,
          "Token 余额不足以预占本次模型请求，请联系管理员调整月额度",
        );
        const id = randomUUID();
        await db.query(
          "INSERT INTO token_quota_requests(id,user_id,period,workspace_id,model,reserved) VALUES($1,$2,$3,$4,$5,$6)",
          [id, user, period, workspace, model, tokens],
        );
        return id;
      });
    },
    async upstream(id, reference) {
      if (
        typeof reference === "string" &&
        reference.length <= 200 &&
        !/[\r\n]/.test(reference)
      )
        await pool.query(
          "UPDATE token_quota_requests SET upstream_request_id=$2 WHERE id=$1",
          [id, reference],
        );
    },
    async pending(id, reason) {
      await pool.query(
        "UPDATE token_quota_requests SET state='pending',reason=$2 WHERE id=$1 AND state='reserved'",
        [id, reason],
      );
    },
    async settle(id, actual, actor = null, reason = "provider_usage") {
      tokenInteger(actual);
      return transaction(pool, async (db) => {
        if (actor) {
          const active = await db.query(
            "SELECT id FROM platform_users WHERE id=$1 AND is_admin AND NOT disabled FOR SHARE",
            [actor],
          );
          check(active.rowCount === 1, 403, "管理员权限已变更，请重新登录");
        }
        const r = (
          await db.query(
            "SELECT *,created_at < now()-interval '10 minutes' AS orphaned FROM token_quota_requests WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        check(r, 404, "请求不存在");
        if (actor)
          check(
            r.state !== "reserved" || r.orphaned,
            409,
            "请求仍可能执行，请稍后核实用量再补账",
          );
        if (r.state === "settled") {
          check(Number(r.actual) === actual, 409, "请求已按其他用量结算");
          return;
        }
        await db.query(
          "UPDATE token_quota_periods SET reserved=reserved-$3,used=used+$4 WHERE user_id=$1 AND period=$2",
          [r.user_id, r.period, r.reserved, actual],
        );
        await db.query(
          "UPDATE token_quota_requests SET state='settled',actual=$2,reason=$3,settled_at=now() WHERE id=$1",
          [id, actual, reason],
        );
        if (actor)
          await db.query(
            "INSERT INTO audit_events(actor_id,action,resource) VALUES($1,'token_quota.reconcile',$2)",
            [actor, JSON.stringify({ id, actual, reason })],
          );
      });
    },
    async requests(user) {
      return (
        await pool.query(
          "SELECT id,period,model,upstream_request_id,reserved,actual,state,reason,created_at FROM token_quota_requests WHERE user_id=$1 ORDER BY (state <> 'settled') DESC,created_at DESC,id DESC LIMIT 50",
          [user],
        )
      ).rows;
    },
  };
}
