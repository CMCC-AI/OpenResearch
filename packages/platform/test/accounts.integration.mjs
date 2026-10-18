import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "../src/db.mjs";
import { configuration, createPlatform } from "../src/server.mjs";
import { hash, id, token } from "../src/security.mjs";

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
          data: res.status === 204 ? null : await res.json(),
          headers: res.headers,
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
        "storage access is authenticated, read-only and distinct from research ownership",
        async () => {
          assert.equal((await request("/storage")).status, 401);
          const local = await request("/storage", { cookie: admin.cookie });
          assert.deepEqual(local.data, {
            managed: false,
            canInspect: false,
            readOnly: true,
          });
          config.researchOwnerEmail = "researcher@test.invalid";
          try {
            const owner = await request("/storage", { cookie: user.cookie });
            assert.equal(owner.status, 200);
            assert.deepEqual(owner.data, {
              managed: true,
              canInspect: false,
              readOnly: true,
            });
            for (const method of ["POST", "PUT", "DELETE"]) {
              assert.equal(
                (
                  await request("/storage", {
                    method,
                    cookie: user.cookie,
                    data: { path: "/tmp/other" },
                  })
                ).status,
                405,
              );
            }
          } finally {
            delete config.researchOwnerEmail;
          }
        },
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
        "unified administration accepts only the configured app origin and live administrators",
        async () => {
          const allowed = await request("/admin/users", {
            cookie: admin.cookie,
            source: config.appOrigin,
          });
          assert.equal(allowed.status, 200);
          assert.equal(
            allowed.headers.get("access-control-allow-origin"),
            config.appOrigin,
          );
          assert.equal(
            allowed.headers.get("access-control-allow-credentials"),
            "true",
          );
          assert.equal(
            (
              await request("/admin/users", {
                method: "OPTIONS",
                source: config.appOrigin,
              })
            ).status,
            204,
          );
          assert.equal(
            (
              await request("/admin/users", {
                cookie: admin.cookie,
                source: "https://foreign.test",
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/admin/users", {
                cookie: user.cookie,
                source: config.appOrigin,
              })
            ).status,
            403,
          );
          assert.equal(
            (await request("/admin/users", { source: config.appOrigin }))
              .status,
            401,
          );
          await pool.query(
            "UPDATE platform_users SET is_admin=false WHERE email='admin@test.invalid'",
          );
          try {
            assert.equal(
              (
                await request("/admin/users", {
                  cookie: admin.cookie,
                  source: config.appOrigin,
                })
              ).status,
              403,
            );
          } finally {
            await pool.query(
              "UPDATE platform_users SET is_admin=true WHERE email='admin@test.invalid'",
            );
          }
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
      await t.test(
        "administrator password reset reauthenticates the actor and revokes target sessions and recovery",
        async () => {
          const operator = await signup("reset-operator@test.invalid");
          await pool.query(
            "UPDATE platform_users SET is_admin=true WHERE email='reset-operator@test.invalid'",
          );
          const target = await signup("reset-target@test.invalid");
          const targetId = (await request("/me", { cookie: target.cookie }))
            .data.id;
          const rootHash = hash(target.cookie.split("=")[1]);
          const child = token(),
            recovery = token(),
            grant = id();
          await pool.query(
            "INSERT INTO platform_sessions(token_hash,user_id,host,parent_hash,expires_at) VALUES($1,$2,'private.test',$3,now()+interval '1 hour')",
            [hash(child), targetId, rootHash],
          );
          await pool.query(
            "INSERT INTO password_reset_tokens(token_hash,user_id,password_version,expires_at) VALUES($1,$2,0,now()+interval '1 hour')",
            [hash(recovery), targetId],
          );
          await pool.query(
            "INSERT INTO sso_grants(id,client,root_session_hash,user_id,expires_at) VALUES($1,'deeplit',$2,$3,now()+interval '1 hour')",
            [grant, rootHash, targetId],
          );
          const route = `/admin/users/${targetId}/password`;
          const data = { password: replacement, adminPassword: password };
          assert.equal(
            (
              await request(route, {
                method: "POST",
                cookie: target.cookie,
                data,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(route, {
                method: "POST",
                cookie: operator.cookie,
                source: "https://evil.test",
                data,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(route, {
                method: "POST",
                cookie: operator.cookie,
                data: { ...data, password: "short" },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await request(route, {
                method: "POST",
                cookie: operator.cookie,
                data: { ...data, adminPassword: "incorrect-admin-password" },
              })
            ).status,
            403,
          );
          assert.equal(
            (await request("/me", { cookie: target.cookie })).status,
            200,
          );
          const reset = await request(route, {
            method: "POST",
            cookie: operator.cookie,
            data,
          });
          assert.equal(reset.status, 200, JSON.stringify(reset.data));
          assert.equal(reset.data.reauthenticate, false);
          assert.equal(
            (await request("/me", { cookie: target.cookie })).status,
            401,
          );
          assert.equal((await login("reset-target@test.invalid")).status, 401);
          assert.equal(
            (await login("reset-target@test.invalid", replacement)).status,
            200,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM platform_sessions WHERE token_hash=$1",
                [hash(child)],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM sso_grants WHERE id=$1",
                [grant],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM password_reset_tokens WHERE user_id=$1",
                [targetId],
              )
            ).rows[0].n,
            0,
          );
          const auditRow = (
            await pool.query(
              "SELECT resource FROM audit_events WHERE action='password.admin.reset' AND resource=$1",
              [targetId],
            )
          ).rows;
          assert.deepEqual(auditRow, [{ resource: targetId }]);
          const operatorId = (await request("/me", { cookie: operator.cookie }))
            .data.id;
          const self = await request(`/admin/users/${operatorId}/password`, {
            method: "POST",
            cookie: operator.cookie,
            data,
          });
          assert.equal(self.status, 200);
          assert.equal(self.data.reauthenticate, true);
          assert.equal(
            (await request("/me", { cookie: operator.cookie })).status,
            401,
          );
        },
      );
      await t.test(
        "offline administrator grant preserves password and is audited once",
        async () => {
          const account = "promoted@test.invalid";
          const registered = await signup(account);
          assert.equal(registered.status, 201);
          const before = (
            await pool.query(
              "SELECT password_hash,password_version FROM platform_users WHERE email=$1",
              [account],
            )
          ).rows[0];
          const grant = (address) =>
            promisify(execFile)(
              process.execPath,
              [
                fileURLToPath(new URL("../src/admin.mjs", import.meta.url)),
                "grant-admin",
                address,
              ],
              {
                env: { ...process.env, DATABASE_URL: url.href },
              },
            );
          await grant(account);
          await grant(account);
          const after = (
            await pool.query(
              "SELECT password_hash,password_version FROM platform_users WHERE email=$1",
              [account],
            )
          ).rows[0];
          assert.deepEqual(after, before);
          assert.equal(
            (await request("/me", { cookie: registered.cookie })).data.isAdmin,
            true,
          );
          assert.equal((await login(account)).status, 200);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM audit_events WHERE action='account.admin.grant'",
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(grant("missing@test.invalid"));
          await pool.query(
            "UPDATE platform_users SET disabled=true WHERE email=$1",
            [account],
          );
          await assert.rejects(grant(account));
        },
      );
      await t.test(
        "existing accounts receive one logical space without automatically allocating compute",
        async () => {
          const legacy = id();
          await pool.query(
            "INSERT INTO platform_users(id,email,name,password_hash) SELECT $1,'legacy@test.invalid','Legacy',password_hash FROM platform_users LIMIT 1",
            [legacy],
          );
          const command = (name, ...args) =>
            promisify(execFile)(
              process.execPath,
              [
                fileURLToPath(new URL("../src/admin.mjs", import.meta.url)),
                name,
                ...args,
              ],
              { env: { ...process.env, DATABASE_URL: url.href } },
            );
          await command("ensure-personal-spaces");
          const before = (
            await pool.query("SELECT * FROM personal_spaces ORDER BY user_id")
          ).rows;
          await command("ensure-personal-spaces");
          assert.deepEqual(
            (await pool.query("SELECT * FROM personal_spaces ORDER BY user_id"))
              .rows,
            before,
          );
          assert.equal(
            before.length,
            (await pool.query("SELECT count(*)::int n FROM platform_users"))
              .rows[0].n,
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM workspace_runtimes"))
              .rows[0].n,
            0,
          );
          const first = await command(
            "prepare-personal-space",
            "legacy@test.invalid",
          );
          const again = await command(
            "prepare-personal-space",
            "legacy@test.invalid",
          );
          assert.equal(first.stdout, again.stdout);
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
