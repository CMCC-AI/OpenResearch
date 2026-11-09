// Run via stdin in the deployed platform container. Creates only one random
// acceptance account and removes that account/space after the gateway checks.
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
const { createPool, transaction } = await import("./src/db.mjs");
assert.equal(
  process.env.POOL_VERIFY_PRODUCTION,
  "true",
  "Explicit production verification required",
);
const pool = createPool(process.env.DATABASE_URL);
const origin = process.env.OPENRESEARCH_APP_ORIGIN;
const host = new URL(origin).host;
let email = `pool-verify-${randomUUID()}@test.invalid`;
const password = randomUUID() + "aA!";
let cookie, user, workspace;
let passed = false,
  initial;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(path, method = "GET", data, anonymous = false, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      "http://127.0.0.1:20281" + path,
      {
        method,
        headers: {
          host,
          origin,
          ...(!anonymous && cookie ? { cookie } : {}),
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(JSON.stringify(data)),
              }
            : {}),
          ...extra,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              status: res.statusCode,
              data: value,
              cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(Error("Gateway timeout")));
    req.end(data ? JSON.stringify(data) : undefined);
  });
}
try {
  if (process.env.POOL_VERIFY_RESUME_WORKSPACE) {
    const fixture = await pool.query(
      "SELECT u.id,u.email FROM platform_users u JOIN personal_spaces p ON p.user_id=u.id WHERE p.workspace_id=$1 AND u.name='Runtime pool acceptance' AND u.email LIKE 'pool-verify-%@test.invalid'",
      [process.env.POOL_VERIFY_RESUME_WORKSPACE],
    );
    assert.equal(
      fixture.rows.length,
      1,
      "Only this verification fixture may be resumed",
    );
    email = fixture.rows[0].email;
    const { token, hash, sessionCookie } = await import("./src/security.mjs");
    const secret = token();
    await pool.query(
      "INSERT INTO platform_sessions(token_hash,user_id,host,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes')",
      [hash(secret), fixture.rows[0].id, host],
    );
    cookie = sessionCookie(secret, false).split(";")[0];
  } else {
    const register = await request("/api/platform/register", "POST", {
      email,
      name: "Runtime pool acceptance",
      password,
    });
    assert.equal(register.status, 201, JSON.stringify(register.data));
    cookie = register.cookie;
  }
  const me = await request("/api/platform/me");
  assert.equal(me.status, 200);
  user = me.data.id;
  const prepare = await request("/api/platform/personal-space", "POST", {});
  assert.equal(prepare.status, 200);
  workspace = prepare.data.id;
  initial = prepare.data.status;
  assert(["waiting", "queued", "starting", "ready"].includes(initial));
  console.log("Public gateway registration and private-space admission: PASS");
  let ready = false;
  for (let n = 0; n < 240; n++) {
    const state = await request("/api/platform/personal-space");
    assert.equal(state.status, 200);
    if (state.data.status === "ready" && state.data.online) {
      ready = true;
      break;
    }
    assert.notEqual(state.data.status, "failed");
    await sleep(1500);
  }
  assert(ready, "New user must obtain a healthy private environment");
  const suffix = randomUUID().slice(0, 8);
  const project = await request("/mobilesci/api/projects", "POST", {
    name: "Runtime pool acceptance " + suffix,
    path: "/home/node/research/pool-acceptance-" + suffix,
    creationMode: "blank",
    createFolder: true,
    requireNewFolder: true,
    initializeGit: true,
    githubSyncEnabled: false,
  });
  assert.equal(project.status, 200, JSON.stringify(project.data));
  assert(project.data.project.id);
  const foreign = (
    await pool.query(
      "SELECT workspace_id FROM personal_spaces WHERE user_id<>$1 LIMIT 1",
      [user],
    )
  ).rows[0]?.workspace_id;
  const projects = await request(
    "/mobilesci/api/projects?workspace=" + foreign,
    "GET",
    undefined,
    false,
    { "x-workspace-id": foreign },
  );
  assert.equal(projects.status, 200);
  assert(projects.data.projects.some((x) => x.id === project.data.project.id));
  assert(
    projects.data.projects.every((x) =>
      x.name.startsWith("Runtime pool acceptance"),
    ),
  );
  assert.equal(
    (await request("/mobilesci/api/projects", "GET", undefined, true)).status,
    401,
  );
  console.log(
    "New user research API, project persistence and account routing: PASS",
  );
  passed = true;
} catch (error) {
  console.error("Acceptance assertion failed:", error.message);
  throw error;
} finally {
  if (cookie && workspace) {
    const removed = await request(
      "/api/platform/workspaces/" + workspace,
      "DELETE",
      { name: "我的科研空间" },
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    for (let n = 0; n < 40; n++) {
      const state = (
        await pool.query(
          "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
          [workspace],
        )
      ).rows[0];
      if (state?.status === "deleted") break;
      await sleep(500);
    }
    await transaction(pool, async (db) => {
      const owned = await db.query(
        "SELECT id FROM platform_users WHERE id=$1 AND email=$2",
        [user, email],
      );
      assert.equal(owned.rows.length, 1);
      const runtime = await db.query(
        "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
        [workspace],
      );
      assert.equal(runtime.rows[0]?.status, "deleted");
      await db.query(
        "DELETE FROM workspace_runtime_leases WHERE workspace_id=$1",
        [workspace],
      );
      await db.query(
        "DELETE FROM workspace_runtimes WHERE workspace_id=$1 AND status='deleted'",
        [workspace],
      );
      await db.query(
        "UPDATE audit_events SET actor_id=NULL WHERE actor_id=$1",
        [user],
      );
      await db.query("DELETE FROM platform_users WHERE id=$1 AND email=$2", [
        user,
        email,
      ]);
    });
  }
  await pool.end();
  console.log(
    JSON.stringify({
      passed,
      initialStatus: initial,
      workspace,
      temporaryAccountRemoved: !!workspace,
      modelCalls: 0,
    }),
  );
}
