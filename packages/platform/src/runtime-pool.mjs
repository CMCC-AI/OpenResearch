// All admission, request leases and suspension use the same transaction lock.
// A slot is a running process, never an account or a persistent data directory.
import { id, check, HttpError } from "./security.mjs";
import { transaction } from "./db.mjs";

function pendingRuntime() {
  const error = new HttpError(503, "请求暂未完成，请稍后重试");
  error.runtimePending = true;
  return error;
}

// Called only after authorization, before reading/forwarding any request body.
// Background reads and SSE must not wake an idle environment on their own.
export async function personalRuntimeTunnel(
  pool,
  workspace,
  tunnels,
  target,
  wake = false,
  stream = false,
) {
  const runtime = await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(721947)");
    const { rows } = await db.query(
      "SELECT status,desired FROM workspace_runtimes WHERE workspace_id=$1",
      [workspace],
    );
    let row = rows[0];
    if (!row && wake && !tunnels.has(workspace)) {
      await db.query(
        "INSERT INTO workspace_runtimes(workspace_id,status,requested_at,last_requested_at) VALUES($1,'waiting',now(),now())",
        [workspace],
      );
      row = { status: "waiting", desired: "running" };
    }
    if (row) {
      check(row.desired === "running", 409, "此操作暂不可用");
      check(row.status !== "failed", 503, "请求暂未完成，请稍后重试");
      if (wake && ["waiting", "sleeping"].includes(row.status))
        await db.query(
          "UPDATE workspace_runtimes SET status='waiting',requested_at=coalesce(requested_at,now()),last_requested_at=now(),last_used_at=now() WHERE workspace_id=$1",
          [workspace],
        );
    }
    return row;
  });
  const tunnel = tunnels.get(workspace);
  if ((runtime && runtime.status !== "ready") || !tunnel)
    throw pendingRuntime();
  if (!stream) {
    try {
      await leaseRuntime(pool, workspace, target, wake);
    } catch (error) {
      // Suspension may have won the lock between inspection and lease creation.
      if (error.status === 503) throw pendingRuntime();
      throw error;
    }
  }
  return tunnel;
}

export async function leaseRuntime(pool, workspace, target, touch = false) {
  const db = await pool.connect();
  const lease = id();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(721947)");
    const { rows } = await db.query(
      "SELECT status,desired FROM workspace_runtimes WHERE workspace_id=$1",
      [workspace],
    );
    // Existing self-hosted runners have no managed runtime row.
    if (rows.length) {
      check(
        rows[0].desired === "running" && rows[0].status === "ready",
        503,
        "研究环境正在恢复，请稍候",
      );
      await db.query(
        "INSERT INTO workspace_runtime_leases VALUES($1,$2,now()+interval '90 seconds')",
        [lease, workspace],
      );
      if (touch)
        await db.query(
          "UPDATE workspace_runtimes SET last_used_at=now() WHERE workspace_id=$1",
          [workspace],
        );
    }
    await db.query("COMMIT");
    if (!rows.length) return;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  let ended = false;
  const heartbeat = setInterval(() => {
    pool
      .query(
        "UPDATE workspace_runtime_leases SET expires_at=now()+interval '90 seconds' WHERE id=$1",
        [lease],
      )
      .catch(() => target.destroy?.());
  }, 20000);
  heartbeat.unref();
  const release = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    pool
      .query("DELETE FROM workspace_runtime_leases WHERE id=$1", [lease])
      .catch(() => {});
  };
  target.once("close", release);
  target.once("finish", release);
  if (target.destroyed || target.writableEnded) release();
}

export const idleProcessProbe = `unknown=0
for p in os.listdir('/proc'):
 if p.isdigit() and int(p) not in (os.getpid(),os.getppid()):
  try:
   name=open('/proc/'+p+'/comm').read().strip()
   args=open('/proc/'+p+'/cmdline','rb').read().decode().strip('\\0').split('\\0')
   # Only known idle services are exempt. An arbitrary node/orx/agent process
   # may itself be a detached research task, so its name is not sufficient.
   service=(name in ('tini','docker-init') and int(p)==1)
   service=service or (name=='node' and len(args)==2 and args[1] in ('src/executor-entry.mjs','/app/platform/src/executor-entry.mjs','src/runner.mjs','/app/platform/src/runner.mjs'))
   service=service or (name=='orx' and args[1:2]==['up'])
   service=service or (name=='opencode' and args[1:2]==['serve'])
   if not service: unknown+=1
  except FileNotFoundError: pass
`;

// Executed inside the user's container. Unknown activity or unavailable tools
// must keep the container running, rather than risk interrupting research.
export const idleProbe = `
const {execFileSync}=require('node:child_process');
(async()=>{
const r=await fetch('http://127.0.0.1:4791/api/projects/activity',{signal:AbortSignal.timeout(3000)});
if(!r.ok)throw Error('activity');
const d=await r.json();
if(!Array.isArray(d.activity)||d.activity.some(x=>!Number.isInteger(x.activeAgents)||!Number.isInteger(x.runningExperiments)||x.activeAgents<0||x.runningExperiments<0))throw Error('shape');
const counts=JSON.parse(execFileSync('python3',['-c',${JSON.stringify(`import sqlite3,time,json,os
c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True)
c.execute('PRAGMA query_only=ON')
q=['SELECT count(*) FROM chat_queued_messages','SELECT count(*) FROM chat_turn_leases WHERE heartbeat_at>?',"SELECT count(*) FROM chat_spawns WHERE state!='done'","SELECT count(*) FROM runs WHERE status NOT IN ('done','failed','cancelled')"]
counts=[c.execute(s,(int(time.time()*1000)-60000,) if '?' in s else ()).fetchone()[0] for s in q]
# Preserve detached scripts and shells, even when not registered as orx runs.
${idleProcessProbe}
counts.append(unknown)
print(json.dumps(counts))`)}],{encoding:'utf8',timeout:4000}));
console.log(JSON.stringify({idle:d.activity.every(x=>x.activeAgents===0&&x.runningExperiments===0)&&counts.length===5&&counts.every(x=>x===0)}));
})().catch(()=>console.log(JSON.stringify({idle:false})));`;

export async function canSuspend(workspace, call) {
  try {
    const name = `orx-managed-${workspace}`;
    const container = await call("GET", `/containers/${name}/json`);
    if (
      container.Config?.Labels?.["openresearch.workspace"] !== workspace ||
      container.Config?.Labels?.["openresearch.managed"] !== "true"
    )
      return false;
    if (!container.State.Running) return true;
    const exec = await call("POST", `/containers/${name}/exec`, {
      User: "1000:1000",
      AttachStdout: true,
      AttachStderr: false,
      Tty: true,
      Cmd: ["node", "-e", idleProbe],
    });
    const result = await call("POST", `/exec/${exec.Id}/start`, {
      Detach: false,
      Tty: true,
    });
    const state = await call("GET", `/exec/${exec.Id}/json`);
    return !state.Running && state.ExitCode === 0 && result?.idle === true;
  } catch {
    return false;
  }
}

export async function scheduleRuntimes(db, env, call) {
  const capacity = Number(env.MANAGED_CAPACITY || 4);
  const idleSeconds = Number(env.MANAGED_IDLE_SECONDS || 120);
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    !Number.isSafeInteger(idleSeconds) ||
    idleSeconds < 30
  )
    throw Error("Invalid managed runtime pool configuration");
  await db.query("SELECT pg_advisory_xact_lock(721947)");
  await db.query("DELETE FROM workspace_runtime_leases WHERE expires_at<now()");
  // Expired browser demand must not cause abandoned accounts to cycle forever.
  await db.query(
    "UPDATE workspace_runtimes SET status='sleeping',requested_at=NULL WHERE status='waiting' AND last_requested_at<now()-interval '90 seconds'",
  );
  const candidates = await db.query(
    `SELECT workspace_id FROM workspace_runtimes r
     WHERE desired='running' AND status IN ('ready','failed')
       AND workspace_id<>$1::uuid AND last_used_at<now()-$2::int*interval '1 second'
       AND NOT EXISTS(SELECT 1 FROM workspace_runtime_leases l WHERE l.workspace_id=r.workspace_id AND expires_at>now())
     ORDER BY last_used_at LIMIT 1 FOR UPDATE`,
    [
      env.MANAGED_LEGACY_WORKSPACE || "00000000-0000-0000-0000-000000000000",
      idleSeconds,
    ],
  );
  for (const row of candidates.rows) {
    if (await canSuspend(row.workspace_id, call)) {
      await call(
        "POST",
        `/containers/orx-managed-${row.workspace_id}/stop?t=10`,
      );
      await db.query(
        "UPDATE workspace_runtimes SET status='sleeping',requested_at=NULL,error=NULL,checked_at=now() WHERE workspace_id=$1",
        [row.workspace_id],
      );
    } else {
      // Back off busy/unknown environments and fairly inspect the next account.
      await db.query(
        "UPDATE workspace_runtimes SET last_used_at=now() WHERE workspace_id=$1",
        [row.workspace_id],
      );
    }
  }
  const active = await db.query(
    "SELECT count(*)::int n FROM workspace_runtimes WHERE desired='running' AND status IN ('queued','starting','ready','failed')",
  );
  const available = Math.max(0, capacity - active.rows[0].n);
  if (available)
    await db.query(
      `UPDATE workspace_runtimes SET status='queued',error=NULL,checked_at=NULL,last_used_at=now()
     WHERE workspace_id IN (SELECT workspace_id FROM workspace_runtimes
       WHERE desired='running' AND status='waiting' ORDER BY requested_at,workspace_id LIMIT $1 FOR UPDATE)`,
      [available],
    );
}
