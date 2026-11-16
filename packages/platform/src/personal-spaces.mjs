import { check, id } from "./security.mjs";

// Caller locks the user row (registration already owns its inserted row).
export async function ensurePersonalSpace(db, user) {
  const existing = await db.query(
    "SELECT workspace_id FROM personal_spaces WHERE user_id=$1",
    [user],
  );
  if (existing.rows.length) return existing.rows[0].workspace_id;
  const workspace = id();
  await db.query(
    "INSERT INTO workspaces(id,name,created_by) VALUES($1,'我的科研空间',$2)",
    [workspace, user],
  );
  await db.query(
    "INSERT INTO personal_spaces(user_id,workspace_id) VALUES($1,$2)",
    [user, workspace],
  );
  return workspace;
}
export async function preparePersonalSpace(db, user, _capacity, retry = false) {
  // Same order in all callers: capacity advisory lock, then user row.
  await db.query("SELECT pg_advisory_xact_lock(721947)");
  const found = await db.query(
    "SELECT id FROM platform_users WHERE id=$1 AND NOT disabled FOR UPDATE",
    [user],
  );
  check(found.rows.length, 401, "请重新登录");
  const workspace = await ensurePersonalSpace(db, user);
  const runtime = await db.query(
    "SELECT status,desired FROM workspace_runtimes WHERE workspace_id=$1",
    [workspace],
  );
  if (!runtime.rows.length || runtime.rows[0].desired === "deleted") {
    await db.query(
      "INSERT INTO workspace_runtimes(workspace_id,status,requested_at,last_requested_at) VALUES($1,'waiting',now(),now()) ON CONFLICT(workspace_id) DO UPDATE SET desired='running',status='waiting',error=NULL,checked_at=NULL,requested_at=now(),last_requested_at=now(),last_used_at=now()",
      [workspace],
    );
  } else if (retry && runtime.rows[0].status === "failed") {
    await db.query(
      "UPDATE workspace_runtimes SET status='queued',error=NULL,checked_at=NULL,last_used_at=now() WHERE workspace_id=$1",
      [workspace],
    );
  }
  await db.query(
    "UPDATE workspace_runtimes SET status=CASE WHEN status='sleeping' THEN 'waiting' ELSE status END, requested_at=CASE WHEN status='sleeping' THEN now() ELSE requested_at END, last_requested_at=now(), last_used_at=now() WHERE workspace_id=$1",
    [workspace],
  );
  return workspace;
}
