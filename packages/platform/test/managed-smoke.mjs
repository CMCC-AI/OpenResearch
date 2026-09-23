// Explicit real-Docker smoke test: creates and removes only random test resources.
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createPool, migrate, transaction } from "../src/db.mjs";
import { configuration, createPlatform } from "../src/server.mjs";
import { passwordHash } from "../src/security.mjs";
import { reconcile, docker } from "../src/provisioner.mjs";

const admin = createPool(process.env.DATABASE_URL);
const schema = `managed_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.href);
const created = [];
let app;
function hostRequest(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          ok: res.statusCode < 400,
          headers: {
            get: (key) =>
              Array.isArray(res.headers[key])
                ? res.headers[key][0]
                : res.headers[key],
          },
          json: async () => JSON.parse(Buffer.concat(chunks).toString()),
        }),
      );
    });
    req.on("error", reject);
    req.end(options.body?.toString());
  });
}
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const password = randomUUID();
  await pool.query(
    "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
    [
      randomUUID(),
      "managed@test.invalid",
      "Managed smoke",
      await passwordHash(password),
    ],
  );
  const config = configuration({
    DATABASE_URL: url.href,
    PLATFORM_ORIGIN: "http://localhost:5300",
    MANAGED_EXECUTORS: "true",
  });
  app = await createPlatform(config, pool);
  app.server.listen(0, "0.0.0.0");
  await once(app.server, "listening");
  const port = app.server.address().port;
  config.origin = new URL(`http://localhost:${port}`);
  let cookie;
  const request = async (path, method = "GET", data) => {
    const r = await fetch(`${config.origin.origin}/api/platform${path}`, {
      method,
      headers: {
        origin: config.origin.origin,
        ...(cookie ? { cookie } : {}),
        ...(data ? { "content-type": "application/json" } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (path === "/login") cookie = r.headers.get("set-cookie").split(";")[0];
    const result = await r.json();
    assert(r.ok, JSON.stringify(result));
    return result;
  };
  await request("/login", "POST", { email: "managed@test.invalid", password });
  const env = {
    ...process.env,
    PLATFORM_ORIGIN: config.origin.origin,
    MANAGED_CONNECT_URL: `http://host.docker.internal:${port}`,
    MANAGED_EXECUTOR_IMAGE: "openresearch-managed-executor:local",
  };
  for (let i = 0; i < 2; i++)
    created.push(
      (
        await request("/workspaces", "POST", {
          name: `Smoke ${i}`,
          mode: "managed",
        })
      ).id,
    );
  for (const workspace of created) {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      await transaction(pool, async (db) => {
        const { rows } = await db.query(
          "SELECT * FROM workspace_runtimes WHERE workspace_id=$1 FOR UPDATE",
          [workspace],
        );
        await reconcile(db, rows[0], env);
      });
      const state = await request(`/workspaces/${workspace}/runtime`);
      if (state.status === "ready" && state.online) {
        ready = true;
        break;
      }
      if (state.status === "failed") throw new Error(state.error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert(ready, "Managed environment did not become ready");
    const info = await docker(
      "GET",
      `/containers/orx-managed-${workspace}/json`,
    );
    assert(info.Mounts.some((m) => m.Name === `orx-managed-${workspace}`));
    assert(!info.Config.Env.some((v) => v.startsWith("RUNNER_TOKEN=")));
    console.log("Managed environment healthy and connected:", workspace);
  }
  // Both are online simultaneously; retries must not allocate a second container.
  const list = await request("/workspaces");
  assert.equal(list.filter((w) => w.online).length, 2);
  const research = [];
  for (const workspace of created) {
    const launch = await request(`/workspaces/${workspace}/launch`, "POST");
    const host = `${workspace}.localhost:${port}`;
    const entry = await hostRequest(`${config.origin.origin}/_platform/enter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        host,
        origin: "null",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ticket: launch.ticket }),
    });
    assert.equal(entry.status, 303);
    const session = entry.headers.get("set-cookie").split(";")[0];
    research.push(async (path, data) => {
      const response = await hostRequest(`${config.origin.origin}${path}`, {
        method: data ? "POST" : "GET",
        headers: {
          host,
          cookie: session,
          origin: `http://${host}`,
          ...(data ? { "content-type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      const body = await response.json();
      assert(response.ok, JSON.stringify(body));
      return body;
    });
  }
  const project = await research[0]("/api/projects", {
    name: "Isolation smoke",
    path: "/home/node/research/isolation-smoke",
    creationMode: "blank",
    createFolder: true,
    requireNewFolder: true,
    initializeGit: true,
    githubSyncEnabled: false,
  });
  assert(project.project.id);
  const firstProjects = JSON.stringify(await research[0]("/api/projects"));
  const secondProjects = JSON.stringify(await research[1]("/api/projects"));
  assert(firstProjects.includes(project.project.id));
  assert(!secondProjects.includes(project.project.id));
  for (let i = 0; i < created.length; i++) {
    const workspace = created[i];
    await request(`/workspaces/${workspace}`, "DELETE", { name: `Smoke ${i}` });
    await transaction(pool, async (db) => {
      const { rows } = await db.query(
        "SELECT * FROM workspace_runtimes WHERE workspace_id=$1 FOR UPDATE",
        [workspace],
      );
      await reconcile(db, rows[0], env);
    });
    await assert.rejects(
      docker("GET", `/containers/orx-managed-${workspace}/json`),
      (e) => e.status === 404,
    );
    await docker("GET", `/volumes/orx-managed-${workspace}`);
  }
  console.log(
    "PASS: two managed environments, private volumes, healthy connections, deletion and data retention",
  );
} finally {
  for (const workspace of created) {
    await docker(
      "DELETE",
      `/containers/orx-managed-${workspace}?force=true`,
    ).catch(() => {});
    await docker("DELETE", `/volumes/orx-managed-${workspace}`).catch(() => {});
  }
  if (app) await app.close();
  else await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
