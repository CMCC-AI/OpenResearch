import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createPool, migrate, transaction } from "../src/db.mjs";
import { createPlatform, configuration } from "../src/server.mjs";
import { preparePersonalSpace } from "../src/personal-spaces.mjs";
import { leaseRuntime, scheduleRuntimes } from "../src/runtime-pool.mjs";

test(
  "100 registrations queue independently of two compute slots; idle release, leases, fairness and invisible recovery preserve ownership",
  { timeout: 120000 },
  async () => {
    const schema = `pool_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(process.env.DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = createPool(url.href);
    let app;
    try {
      await migrate(pool);
      const config = configuration({
        DATABASE_URL: url.href,
        PLATFORM_ORIGIN: "http://localhost:5300",
        OPENRESEARCH_APP_ORIGIN: "http://localhost:5300",
        PRIVATE_USER_SPACES: "true",
        MANAGED_EXECUTORS: "true",
        PRIVATE_SPACE_ROUTING: "shared-origin",
        MANAGED_CAPACITY: "2",
      });
      app = await createPlatform(config, pool);
      app.server.listen(0, "127.0.0.1");
      await once(app.server, "listening");
      const origin = `http://localhost:${app.server.address().port}`;
      config.origin = new URL(origin);
      config.appOrigin = origin;
      const users = [];
      const post = async (path, data, cookie) => {
        const res = await fetch(origin + path, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(data),
        });
        return {
          status: res.status,
          headers: res.headers,
          data: await res.json(),
          cookie: res.headers.get("set-cookie")?.split(";")[0],
        };
      };
      for (let n = 0; n < 100; n++) {
        const user = await post("/api/platform/register", {
          email: `pool-${n}@test.invalid`,
          name: `User ${n}`,
          password: "Pool-test-only password 2026!",
        });
        assert.equal(user.status, 201, JSON.stringify(user.data));
        const space = await post(
          "/api/platform/personal-space",
          {},
          user.cookie,
        );
        assert.equal(space.status, 200, JSON.stringify(space.data));
        assert.equal(space.data.status, "waiting");
        users.push({ ...user, workspace: space.data.id });
      }
      assert.equal(new Set(users.map((x) => x.workspace)).size, 100);
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM personal_spaces"))
          .rows[0].n,
        100,
      );
      const env = { MANAGED_CAPACITY: "2", MANAGED_IDLE_SECONDS: "30" };
      let idle = true,
        unavailable = false;
      const calls = [];
      const call = async (method, path, body) => {
        calls.push({ method, path, body });
        if (unavailable) throw Error("Docker unavailable");
        if (path.endsWith("/json") && path.startsWith("/containers/")) {
          const workspace = path.split("/")[2].slice("orx-managed-".length);
          return {
            Config: {
              Labels: {
                "openresearch.managed": "true",
                "openresearch.workspace": workspace,
              },
            },
            State: { Running: true },
          };
        }
        if (path.endsWith("/exec")) return { Id: "probe" };
        if (path === "/exec/probe/start") return { idle };
        if (path === "/exec/probe/json") return { Running: false, ExitCode: 0 };
      };
      const schedule = () =>
        transaction(pool, (db) => scheduleRuntimes(db, env, call));
      await schedule();
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM workspace_runtimes WHERE status='queued'",
          )
        ).rows[0].n,
        2,
      );
      await pool.query(
        "UPDATE workspace_runtimes SET status='ready' WHERE status='queued'",
      );
      const first = (
        await pool.query(
          "SELECT workspace_id FROM workspace_runtimes WHERE status='ready' ORDER BY requested_at LIMIT 1",
        )
      ).rows[0].workspace_id;
      const firstUser = users.find((x) => x.workspace === first);
      const target = new EventEmitter();
      await leaseRuntime(pool, first, target, true);
      await pool.query(
        "UPDATE workspace_runtimes SET last_used_at=now()-interval '5 minutes' WHERE workspace_id=$1",
        [first],
      );
      await schedule();
      assert(
        !calls.some((x) => x.path.includes("/stop")),
        "in-flight upload/terminal must prevent sleep",
      );
      target.emit("close");
      // Await the asynchronous release without relying on a timing sleep.
      while (
        (
          await pool.query(
            "SELECT count(*)::int n FROM workspace_runtime_leases",
          )
        ).rows[0].n
      )
        await new Promise((r) => setImmediate(r));
      idle = false;
      await schedule();
      assert(
        !calls.some((x) => x.path.includes("/stop")),
        "busy research must prevent sleep",
      );
      idle = true;
      unavailable = true;
      await pool.query(
        "UPDATE workspace_runtimes SET last_used_at=now()-interval '5 minutes' WHERE workspace_id=$1",
        [first],
      );
      await schedule();
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
            [first],
          )
        ).rows[0].status,
        "ready",
        "unknown activity must fail closed",
      );
      unavailable = false;
      await pool.query(
        "UPDATE workspace_runtimes SET last_used_at=now()-interval '5 minutes' WHERE workspace_id=$1",
        [first],
      );
      await schedule();
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
            [first],
          )
        ).rows[0].status,
        "sleeping",
      );
      assert(
        calls.some(
          (x) =>
            x.method === "POST" &&
            x.path === `/containers/orx-managed-${first}/stop?t=10`,
        ),
      );
      assert(
        !calls.some((x) => x.method === "DELETE"),
        "sleep never deletes containers or volumes",
      );
      const asleepRead = await fetch(origin + "/api/projects", {
        headers: { cookie: firstUser.cookie },
      });
      assert.equal(asleepRead.status, 503);
      assert.equal(asleepRead.headers.get("x-orx-runtime-pending"), "1");
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
            [first],
          )
        ).rows[0].status,
        "sleeping",
        "background reads must not wake compute",
      );
      const eventsController = new AbortController();
      const events = await fetch(origin + "/api/events", {
        headers: { cookie: firstUser.cookie },
        signal: eventsController.signal,
      });
      assert.equal(events.status, 200);
      assert.match(events.headers.get("content-type"), /text\/event-stream/);
      assert.match(
        new TextDecoder().decode((await events.body.getReader().read()).value),
        /^: connected/,
      );
      eventsController.abort();
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
            [first],
          )
        ).rows[0].status,
        "sleeping",
        "SSE must remain connected without acquiring compute",
      );
      const asleepWrite = await post(
        "/api/projects",
        { name: "execute only after ready" },
        firstUser.cookie,
      );
      assert.equal(asleepWrite.status, 503);
      assert.equal(asleepWrite.headers.get("x-orx-runtime-pending"), "1");
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
            [first],
          )
        ).rows[0].status,
        "waiting",
        "a submitted operation automatically requests compute",
      );
      const resumed = await post(
        "/api/platform/personal-space",
        {},
        firstUser.cookie,
      );
      assert.equal(resumed.status, 200);
      assert.equal(resumed.data.id, first);
      assert.equal(resumed.data.status, "waiting");
      await assert.rejects(
        leaseRuntime(pool, first, new EventEmitter()),
        /正在恢复/,
      );
      const next = (
        await pool.query(
          "SELECT workspace_id FROM workspace_runtimes WHERE status='queued'",
        )
      ).rows[0].workspace_id;
      assert.notEqual(
        next,
        first,
        "existing queue gets priority over a waking user",
      );
      await pool.query(
        "UPDATE workspace_runtimes SET last_requested_at=now()-interval '2 minutes' WHERE status='waiting' AND workspace_id<>$1",
        [first],
      );
      await pool.query(
        "UPDATE workspace_runtimes SET status='ready',last_used_at=now()-interval '5 minutes' WHERE workspace_id=$1",
        [next],
      );
      await schedule();
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM workspace_runtimes WHERE workspace_id=$1",
            [first],
          )
        ).rows[0].status,
        "queued",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM personal_spaces"))
          .rows[0].n,
        100,
      );
      // Concurrent repeat requests retain one logical space and one queue entry.
      const uid = (
        await pool.query(
          "SELECT user_id FROM personal_spaces WHERE workspace_id=$1",
          [first],
        )
      ).rows[0].user_id;
      const repeats = await Promise.all(
        Array.from({ length: 10 }, () =>
          transaction(pool, (db) => preparePersonalSpace(db, uid, 2)),
        ),
      );
      assert(repeats.every((x) => x === first));
      let executed = 0;
      app.tunnels.set(first, {
        ws: { terminate() {} },
        http: async (_req, res) => {
          executed++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        },
      });
      await pool.query(
        "UPDATE workspace_runtimes SET status='ready' WHERE workspace_id=$1",
        [first],
      );
      assert.equal(
        (
          await post(
            "/api/projects",
            { name: "execute only after ready" },
            firstUser.cookie,
          )
        ).status,
        200,
      );
      assert.equal(executed, 1);
      await pool.query(
        "UPDATE workspace_runtimes SET status='failed' WHERE workspace_id=$1",
        [first],
      );
      const failed = await post("/api/projects", {}, firstUser.cookie);
      assert.equal(failed.status, 503);
      assert.equal(
        failed.headers.get("x-orx-runtime-pending"),
        null,
        "genuine failures must not be replayed",
      );
      assert.equal(executed, 1);
    } finally {
      if (app) await app.close();
      else await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
