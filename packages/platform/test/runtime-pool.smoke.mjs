// Real-Docker acceptance. Use a dedicated, disposable DATABASE_URL only.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createPool, migrate, transaction } from "../src/db.mjs";
import { createPlatform, configuration } from "../src/server.mjs";
import { docker, reconcile } from "../src/provisioner.mjs";
import { canSuspend, scheduleRuntimes } from "../src/runtime-pool.mjs";
const pool = createPool(process.env.DATABASE_URL);
const origin = "http://localhost:15300";
const bind = process.env.POOL_SMOKE_BIND_ADDRESS || "127.0.0.1";
const connectOrigin = `http://${bind}:15300`;
const env = {
  ...process.env,
  PLATFORM_ORIGIN: origin,
  MANAGED_CONNECT_URL: "http://host.docker.internal:15300",
  MANAGED_CAPACITY: "2",
  MANAGED_IDLE_SECONDS: "30",
};
let app;
const users = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(path, method = "GET", data, user) {
  const payload = data ? JSON.stringify(data) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      connectOrigin + path,
      {
        method,
        headers: {
          origin,
          host: "localhost:15300",
          ...(user ? { cookie: user.cookie } : {}),
          ...(payload ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            assert(
              res.statusCode < 400,
              `${res.statusCode} ${JSON.stringify(value)}`,
            );
            resolve({
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
    req.end(payload);
  });
}
async function tick() {
  await transaction(pool, async (db) => {
    await scheduleRuntimes(db, env, docker);
    const jobs = await db.query(
      "SELECT * FROM workspace_runtimes WHERE status IN ('queued','starting','ready') ORDER BY checked_at NULLS FIRST LIMIT 1 FOR UPDATE",
    );
    if (jobs.rows[0]) await reconcile(db, jobs.rows[0], env);
  });
}
async function waitReady(user) {
  for (let n = 0; n < 90; n++) {
    await tick();
    const state = (
      await request("/api/platform/personal-space", "GET", undefined, user)
    ).data;
    if (state.status === "ready" && state.online) return;
    await sleep(500);
  }
  throw Error("Real executor readiness timeout");
}
try {
  assert(
    process.env.POOL_SMOKE_DISPOSABLE === "true",
    "Dedicated disposable database required",
  );
  await migrate(pool);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM platform_users")).rows[0].n,
    0,
  );
  const config = configuration({
    ...env,
    OPENRESEARCH_APP_ORIGIN: origin,
    PRIVATE_USER_SPACES: "true",
    MANAGED_EXECUTORS: "true",
    PRIVATE_SPACE_ROUTING: "shared-origin",
  });
  app = await createPlatform(config, pool);
  app.server.listen(15300, bind);
  await once(app.server, "listening");
  for (let n = 0; n < 100; n++) {
    const user = await request("/api/platform/register", "POST", {
      email: `pool-${n}@test.invalid`,
      name: `Pool ${n}`,
      password: randomUUID() + "aA!",
    });
    const space = (
      await request("/api/platform/personal-space", "POST", {}, user)
    ).data;
    assert.equal(space.status, "waiting");
    users.push({ ...user, workspace: space.id });
  }
  console.log("100 real registrations and independent private spaces: PASS");
  await waitReady(users[0]);
  await waitReady(users[1]);
  const project = (
    await request(
      "/api/projects",
      "POST",
      {
        name: "Pool retained data",
        path: "/home/node/research/pool-retained",
        creationMode: "blank",
        createFolder: true,
        requireNewFolder: true,
        initializeGit: true,
        githubSyncEnabled: false,
      },
      users[0],
    )
  ).data.project;
  assert(project.id);
  assert(
    !JSON.stringify(
      (await request("/api/projects", "GET", undefined, users[1])).data,
    ).includes(project.id),
  );
  const before = await docker(
    "GET",
    `/containers/orx-managed-${users[0].workspace}/json`,
  );
  let idle = false;
  for (let n = 0; n < 30; n++) {
    if (await canSuspend(users[0].workspace, docker)) {
      idle = true;
      break;
    }
    await sleep(500);
  }
  assert.equal(
    idle,
    true,
    "real idle probe must accept an idle environment after transient project initialization",
  );
  const busy = await docker(
    "POST",
    `/containers/orx-managed-${users[0].workspace}/exec`,
    { User: "1000:1000", Cmd: ["python3", "-c", "import time;time.sleep(6)"] },
  );
  await docker("POST", `/exec/${busy.Id}/start`, { Detach: true, Tty: false });
  assert.equal(
    await canSuspend(users[0].workspace, docker),
    false,
    "detached research script must prevent sleep",
  );
  await sleep(6500);
  await pool.query(
    "UPDATE workspace_runtimes SET last_used_at=now()-interval '5 minutes' WHERE workspace_id=$1",
    [users[0].workspace],
  );
  await waitReady(users[2]);
  assert(
    !JSON.stringify(
      (await request("/api/projects", "GET", undefined, users[2])).data,
    ).includes(project.id),
  );
  assert.equal(
    (await docker("GET", `/containers/orx-managed-${users[0].workspace}/json`))
      .State.Running,
    false,
  );
  console.log(
    "Two-slot pool admits third user; detached work protected; idle environment stops: PASS",
  );
  // Expire abandoned queue requests; an actual returning user renews their demand.
  await pool.query(
    "UPDATE workspace_runtimes SET last_requested_at=now()-interval '2 minutes' WHERE status='waiting'",
  );
  await request("/api/platform/personal-space", "POST", {}, users[0]);
  await pool.query(
    "UPDATE workspace_runtimes SET last_used_at=now()-interval '5 minutes' WHERE workspace_id=$1",
    [users[2].workspace],
  );
  await waitReady(users[0]);
  const after = await docker(
    "GET",
    `/containers/orx-managed-${users[0].workspace}/json`,
  );
  assert.equal(after.Id, before.Id);
  assert.deepEqual(after.Mounts, before.Mounts);
  assert(
    JSON.stringify(
      (await request("/api/projects", "GET", undefined, users[0])).data,
    ).includes(project.id),
  );
  console.log(
    JSON.stringify({
      registered: 100,
      capacity: 2,
      thirdUserReady: true,
      backgroundTaskProtected: true,
      wakeSameContainer: true,
      dataPreserved: true,
      crossUserIsolation: true,
    }),
  );
} finally {
  for (const user of users) {
    await docker(
      "DELETE",
      `/containers/orx-managed-${user.workspace}?force=true`,
    ).catch(() => {});
    await docker("DELETE", `/volumes/orx-managed-${user.workspace}`).catch(
      () => {},
    );
  }
  if (app) await app.close();
  else await pool.end();
}
