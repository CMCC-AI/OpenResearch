import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "../src/db.mjs";
import { configuration, createPlatform } from "../src/server.mjs";
import { hash } from "../src/security.mjs";

test(
  "account recovery and administrator boundaries",
  { timeout: 60000 },
  async (t) => {
    assert.ok(process.env.DATABASE_URL, "Use the dedicated test database");
    const owner = createPool(process.env.DATABASE_URL);
    const schema = `accounts_${randomUUID().replaceAll("-", "")}`;
    await owner.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = createPool(url.href);
    let app;
    try {
      await migrate(pool);
      await migrate(pool);
      const config = configuration({
        DATABASE_URL: url.href,
        PLATFORM_ORIGIN: "http://localhost:5300",
      });
      const mails = [];
      config.sendPasswordReset = async (mail) => {
        mails.push(mail);
      };
      app = await createPlatform(config, pool);
      app.server.listen(0, "127.0.0.1");
      await once(app.server, "listening");
      const origin = `http://localhost:${app.server.address().port}`;
      config.origin = new URL(origin);
      async function request(
        path,
        { method = "GET", data, cookie, source = origin } = {},
      ) {
        const res = await fetch(origin + "/api/platform" + path, {
          method,
          headers: {
            origin: source,
            ...(data ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie } : {}),
          },
          body: data ? JSON.stringify(data) : undefined,
        });
        return {
          status: res.status,
          data: await res.json(),
          cookie: res.headers.get("set-cookie")?.split(";")[0],
        };
      }
      const password = "Initial test password 2026!";
      const replacement = "Replacement test password 2026!";
      const signup = (address, extra = {}) =>
        request("/register", {
          method: "POST",
          data: {
            name: "Researcher <script>",
            email: address,
            password,
            ...extra,
          },
        });
      const login = (address, pwd = password) =>
        request("/login", {
          method: "POST",
          data: { email: address, password: pwd },
        });
      async function forgot(address) {
        const before = mails.length;
        const res = await request("/password/forgot", {
          method: "POST",
          data: { email: address },
        });
        for (let i = 0; i < 30 && mails.length === before; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        return res;
      }
      const secret = () =>
        new URLSearchParams(new URL(mails.at(-1).url).hash.slice(1)).get(
          "reset",
        );
      const redeem = (value, pwd = replacement) =>
        request("/password/reset", {
          method: "POST",
          data: { token: value, password: pwd },
        });
      const user = await signup("researcher@test.invalid", { isAdmin: true });
      const admin = await signup("admin@test.invalid");
      assert.equal(user.status, 201);
      await pool.query(
        "UPDATE platform_users SET is_admin=true WHERE email='admin@test.invalid'",
      );
      await t.test(
        "registration signs in and cannot self-assign administration",
        async () => {
          const profile = await request("/me", { cookie: user.cookie });
          assert.equal(profile.status, 200);
          assert.equal(profile.data.isAdmin, false);
          const caps = await request("/capabilities", { cookie: user.cookie });
          assert.equal(
            caps.data.openResearchAppUrl,
            "http://127.0.0.1:4791/projects",
          );
          assert.equal((await request("/admin/users")).status, 401);
          assert.equal(
            (await request("/admin/users", { cookie: user.cookie })).status,
            403,
          );
        },
      );
      await t.test(
        "administrator sees paged metadata without credential material",
        async () => {
          const response = await request("/admin/users?q=researcher%40", {
            cookie: admin.cookie,
          });
          assert.equal(response.status, 200);
          assert.equal(response.data.total, 1);
          assert.equal(response.data.summary.total, 2);
          assert.equal(response.data.summary.admins, 1);
          assert.equal(response.data.users[0].email, "researcher@test.invalid");
          for (const row of response.data.users) {
            assert.ok(!("password_hash" in row));
            assert.ok(!("password_version" in row));
          }
          assert.equal(
            (await request("/admin/users?page=0", { cookie: admin.cookie }))
              .status,
            400,
          );
          assert.equal(
            (await request("/admin/users?page=2", { cookie: admin.cookie }))
              .data.users.length,
            0,
          );
          assert.equal(
            (
              await request("/admin/users", {
                method: "POST",
                cookie: admin.cookie,
                data: {},
              })
            ).status,
            405,
          );
        },
      );
      await t.test(
        "recovery response does not disclose registration and stores only a token digest",
        async () => {
          const known = await forgot("researcher@test.invalid");
          const unknown = await request("/password/forgot", {
            method: "POST",
            data: { email: "unknown@test.invalid" },
          });
          assert.equal(known.status, 200);
          assert.deepEqual(known, unknown);
          assert.equal(mails.length, 1);
          const url = new URL(mails[0].url);
          assert.equal(url.origin, origin);
          assert.equal(url.pathname, "/_account/login");
          assert.equal(url.search, "");
          const stored = await pool.query(
            "SELECT token_hash FROM password_reset_tokens",
          );
          assert.equal(stored.rows[0].token_hash, hash(secret()));
          assert.notEqual(stored.rows[0].token_hash, secret());
          assert.equal(
            (
              await request("/password/reset", {
                method: "POST",
                source: "http://evil.test",
                data: { token: secret(), password: replacement },
              })
            ).status,
            403,
          );
          assert.equal((await redeem(secret(), "short")).status, 400);
        },
      );
      await t.test(
        "one-use recovery revokes existing sessions and accepts only the new password",
        async () => {
          const code = secret();
          const [raceLogin, ...results] = await Promise.all([
            login("researcher@test.invalid"),
            redeem(code),
            redeem(code),
          ]);
          if (raceLogin.status === 200)
            assert.equal(
              (await request("/me", { cookie: raceLogin.cookie })).status,
              401,
            );
          assert.deepEqual(results.map((x) => x.status).sort(), [200, 400]);
          assert.equal(
            (await request("/me", { cookie: user.cookie })).status,
            401,
          );
          assert.equal((await login("researcher@test.invalid")).status, 401);
          assert.equal(
            (await login("researcher@test.invalid", replacement)).status,
            200,
          );
          assert.equal((await redeem(code)).status, 400);
        },
      );
      await t.test(
        "new requests supersede previous links and expired links fail",
        async () => {
          await pool.query("DELETE FROM auth_limits");
          await forgot("researcher@test.invalid");
          const previous = secret();
          await forgot("researcher@test.invalid");
          const current = secret();
          assert.equal((await redeem(previous)).status, 400);
          await pool.query(
            "UPDATE password_reset_tokens SET expires_at=now()-interval '1 second'",
          );
          assert.equal((await redeem(current)).status, 400);
        },
      );
      await t.test(
        "password changes invalidate outstanding recovery links",
        async () => {
          await pool.query("DELETE FROM auth_limits");
          const signed = await login("researcher@test.invalid", replacement);
          await forgot("researcher@test.invalid");
          const pending = secret();
          const changed = await request("/password", {
            method: "POST",
            cookie: signed.cookie,
            data: { current: replacement, password },
          });
          assert.equal(changed.status, 200);
          assert.equal((await redeem(pending)).status, 400);
        },
      );
      await t.test(
        "disabled users and delivery failures do not yield usable reset tokens",
        async () => {
          await pool.query("DELETE FROM auth_limits");
          await pool.query(
            "UPDATE platform_users SET disabled=true WHERE email='researcher@test.invalid'",
          );
          const count = mails.length;
          const response = await forgot("researcher@test.invalid");
          assert.equal(response.status, 200);
          assert.equal(mails.length, count);
          config.sendPasswordReset = async () => {
            throw new Error("test delivery failure");
          };
          await forgot("admin@test.invalid");
          const failure = await pool.query(
            "SELECT count(*)::int n FROM audit_events WHERE action='password.reset.delivery_failed'",
          );
          assert.equal(failure.rows[0].n, 1);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM password_reset_tokens",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "unconfigured SMTP is explicit and forgot requests are rate-limited",
        async () => {
          config.sendPasswordReset = null;
          assert.equal(
            (await request("/auth-options")).data.passwordRecovery,
            false,
          );
          assert.equal((await forgot("admin@test.invalid")).status, 503);
          config.sendPasswordReset = async () => {};
          await pool.query("DELETE FROM auth_limits");
          const statuses = [];
          for (let i = 0; i < 4; i++)
            statuses.push(
              (
                await request("/password/forgot", {
                  method: "POST",
                  data: { email: "missing@test.invalid" },
                })
              ).status,
            );
          assert.deepEqual(statuses, [200, 200, 200, 429]);
        },
      );
    } finally {
      if (app) await app.close();
      else await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
    }
  },
);
