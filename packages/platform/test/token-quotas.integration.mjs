import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrate } from "../src/db.mjs";
import { configuration, createPlatform } from "../src/server.mjs";
import { tokenQuotas } from "../src/token-quotas.mjs";
import { id, token, hash } from "../src/security.mjs";

test(
  "monthly user quotas enforce concurrent admission, trusted gateway accounting and administrator boundaries",
  { timeout: 90000 },
  async (t) => {
    assert.ok(process.env.DATABASE_URL, "Use a dedicated test database");
    const owner = createPool(process.env.DATABASE_URL),
      schema = "quota_" + randomUUID().replaceAll("-", "");
    const dir = await mkdtemp(join(tmpdir(), "quota-http-"));
    await owner.query(`CREATE SCHEMA ${schema}`);
    const dburl = new URL(process.env.DATABASE_URL);
    dburl.searchParams.set("options", `-c search_path=${schema}`);
    const pool = createPool(dburl.href);
    let app;
    let calls = 0,
      lastPayload,
      lastHeaders;
    const upstream = http.createServer(async (req, res) => {
      calls++;
      res.setHeader("x-request-id", "provider-trace-id");
      lastHeaders = req.headers;
      let data = "";
      for await (const part of req) data += part;
      lastPayload = JSON.parse(data);
      const mode = lastPayload.messages[0].content;
      if (mode === "reject") {
        res.writeHead(429);
        res.end("must-not-leak-UPSTREAM_KEY");
        return;
      }
      if (mode === "redirect") {
        res.writeHead(307, { location: "http://127.0.0.1:1/stolen" });
        res.end();
        return;
      }
      const usage = {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      };
      if (lastPayload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content: "科研" } }],
              usage: {
                prompt_tokens: 7,
                completion_tokens: 0,
                total_tokens: 7,
              },
            }) +
            "\r\n\r\n",
        );
        if (mode === "aborted") {
          const timer = setInterval(() => res.write(": keepalive\n\n"), 25);
          res.on("close", () => clearInterval(timer));
          return;
        }
        if (mode !== "missing")
          res.write("data: " + JSON.stringify({ choices: [], usage }) + "\n\n");
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          ...(mode === "missing" ? {} : { usage }),
        }),
      );
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      await migrate(pool);
      await migrate(pool);
      const file = join(dir, "models.json");
      await writeFile(
        file,
        JSON.stringify({
          models: [
            {
              id: "research",
              model: "upstream-model",
              apiKey: "UPSTREAM_KEY",
              headers: { "x-provider-secret": "PRIVATE_HEADER" },
              baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
              contextTokens: 100,
              maxOutputTokens: 20,
            },
          ],
        }),
      );
      const config = configuration({
        DATABASE_URL: dburl.href,
        PLATFORM_ORIGIN: "http://localhost:5300",
        PRIVATE_USER_SPACES: "true",
        MANAGED_EXECUTORS: "true",
        TOKEN_QUOTAS_ENABLED: "true",
        TOKEN_QUOTA_MODELS_FILE: file,
      });
      app = await createPlatform(config, pool);
      app.server.listen(0, "127.0.0.1");
      await once(app.server, "listening");
      const origin = `http://localhost:${app.server.address().port}`;
      config.origin = new URL(origin);
      const request = async (
        path,
        { method = "GET", data, cookie, secret, source = origin } = {},
      ) => {
        const res = await fetch(origin + path, {
          method,
          headers: {
            "user-agent": "OpenCode/quota-test",
            ...(source ? { origin: source } : {}),
            ...(data ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie } : {}),
            ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          },
          body: data ? JSON.stringify(data) : undefined,
        });
        return {
          status: res.status,
          data: res.status === 204 ? null : await res.json(),
          cookie: res.headers.get("set-cookie")?.split(";")[0],
          headers: res.headers,
        };
      };
      const signup = async (email, extra = {}) =>
        request("/api/platform/register", {
          method: "POST",
          data: {
            email,
            name: "Quota researcher",
            password: "Synthetic password 2026!",
            ...extra,
          },
        });
      const one = await signup("quota@example.com", {
          monthlyLimit: 999999999,
          isAdmin: true,
        }),
        two = await signup("admin@example.com");
      assert.equal(one.status, 201);
      assert.equal(two.status, 201);
      const user = (
        await pool.query(
          "SELECT id FROM platform_users WHERE email='quota@example.com'",
        )
      ).rows[0].id;
      const admin = (
        await pool.query(
          "UPDATE platform_users SET is_admin=true WHERE email='admin@example.com' RETURNING id",
        )
      ).rows[0].id;
      const workspace = (
        await pool.query(
          "SELECT workspace_id FROM personal_spaces WHERE user_id=$1",
          [user],
        )
      ).rows[0].workspace_id;
      const secret = token();
      await pool.query(
        "INSERT INTO runners(id,workspace_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [id(), workspace, hash(secret)],
      );
      const q = tokenQuotas(pool, 2000000);
      await t.test(
        "registration grant is monthly, idempotent, and existing users get one policy",
        async () => {
          const balance = await request("/api/platform/token-quota", {
            cookie: one.cookie,
          });
          assert.equal(balance.status, 200);
          assert.equal(balance.data.available, 2000000);
          assert.equal(balance.data.monthlyLimit, 2000000);
          assert.equal(
            (await request("/api/platform/me", { cookie: one.cookie })).data
              .isAdmin,
            false,
          );
          assert.equal(balance.data.timezone, "Asia/Shanghai");
          await q.balance(user);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM token_quota_accounts WHERE user_id=$1",
                [user],
              )
            ).rows[0].count,
            "1",
          );
          assert.equal((await signup("quota@example.com")).status, 409);
          assert.equal((await q.balance(user)).granted, 2000000);
        },
      );
      await t.test(
        "users cannot alter allowances; admin configuration is persistent and idempotent",
        async () => {
          const path = "/api/platform/admin/token-quotas";
          assert.equal(
            (
              await request(path + "?email=admin@example.com", {
                cookie: one.cookie,
              })
            ).status,
            403,
          );
          const data = {
            email: "quota@example.com",
            monthlyLimit: 200,
            reason: "test policy",
            idempotencyKey: id(),
          };
          assert.equal(
            (await request(path, { method: "POST", data, cookie: one.cookie }))
              .status,
            403,
          );
          assert.equal(
            (
              await request(path, {
                method: "POST",
                data,
                cookie: two.cookie,
                source: "https://evil.invalid",
              })
            ).status,
            403,
          );
          assert.equal(
            (await request(path, { method: "POST", data, cookie: two.cookie }))
              .status,
            200,
          );
          assert.equal(
            (await request(path, { method: "POST", data, cookie: two.cookie }))
              .status,
            200,
          );
          assert.equal(
            (
              await request(path, {
                method: "POST",
                data: { ...data, monthlyLimit: 201 },
                cookie: two.cookie,
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM token_quota_adjustments WHERE user_id=$1",
                [user],
              )
            ).rows[0].count,
            "1",
          );
          assert.equal((await q.balance(user)).monthlyLimit, 200);
        },
      );
      await t.test(
        "concurrent requests cannot spend the same unreserved tokens",
        async () => {
          const values = await Promise.allSettled([
            q.reserve(user, workspace, "research", 120),
            q.reserve(user, workspace, "research", 120),
          ]);
          assert.equal(
            values.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            values.find((r) => r.status === "rejected").reason.status,
            402,
          );
          const held = values.find((r) => r.status === "fulfilled").value;
          await assert.rejects(
            q.settle(held, 0, admin, "premature refund"),
            (e) => e.status === 409,
          );
          await q.settle(held, 15);
          await q.settle(held, 15);
          await assert.rejects(q.settle(held, 0), (e) => e.status === 409);
          assert.equal((await q.balance(user)).used, 15);
          assert.equal((await q.balance(user)).reserved, 0);
        },
      );
      const gateway = "/api/platform/model-gateway/v1";
      const call = (mode) =>
        request(gateway + "/chat/completions", {
          method: "POST",
          data: {
            model: "research",
            messages: [{ role: "user", content: mode }],
            max_tokens: 20,
          },
          secret,
          source: null,
        });
      await t.test(
        "gateway binds identity and model allowlist before dispatch; secret never enters generated config",
        async () => {
          const cfg = await request("/api/platform/runner/model-config", {
            secret,
            source: null,
          });
          assert.equal(cfg.status, 200);
          assert.ok(!JSON.stringify(cfg.data).includes("UPSTREAM_KEY"));
          assert.equal(
            (
              await request(gateway + "/models", {
                secret: token(),
                source: null,
              })
            ).status,
            401,
          );
          assert.equal(
            (await request(gateway + "/models", { cookie: one.cookie })).status,
            403,
          );
          const before = calls;
          assert.equal(
            (
              await request(gateway + "/chat/completions", {
                method: "POST",
                secret,
                source: null,
                data: { model: "unknown", messages: [] },
              })
            ).status,
            400,
          );
          assert.equal(calls, before);
          const result = await call("json");
          assert.equal(result.status, 200);
          assert.equal(lastHeaders.authorization, "Bearer UPSTREAM_KEY");
          assert.equal(
            lastHeaders["x-client-request-id"],
            result.headers.get("x-token-quota-request-id"),
          );
          assert.equal(
            (await q.requests(user)).find(
              (r) => r.id === lastHeaders["x-client-request-id"],
            ).upstream_request_id,
            "provider-trace-id",
          );
          assert.equal(lastPayload.model, "upstream-model");
          assert.equal(lastPayload.max_tokens, 20);
          assert.equal((await q.balance(user)).used, 25);
        },
      );
      await t.test(
        "streaming calls settle exactly once and request usage from the provider",
        async () => {
          const res = await fetch(origin + gateway + "/chat/completions", {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "research",
              messages: [{ role: "user", content: "stream" }],
              stream: true,
            }),
          });
          assert.equal(res.status, 200);
          const text = await res.text();
          assert.match(text, /科研/);
          assert.match(text, /\[DONE\]/);
          assert.equal(lastPayload.stream_options.include_usage, true);
          assert.equal((await q.balance(user)).used, 35);
          assert.equal((await q.balance(user)).reserved, 0);
        },
      );
      await t.test(
        "missing usage retains reservation, then blocks requests before spending upstream",
        async () => {
          assert.equal((await call("missing")).status, 200);
          assert.equal((await q.balance(user)).reserved, 120);
          const before = calls;
          const blocked = await call("json");
          assert.equal(blocked.status, 402);
          assert.equal(blocked.data.error.code, "insufficient_quota");
          assert.equal(calls, before);
          const pending = (await q.requests(user)).find(
            (r) => r.state === "pending",
          );
          assert.ok(pending);
          const data = {
            email: "quota@example.com",
            requestId: pending.id,
            actualTokens: 12,
            reason: "checked provider receipt",
          };
          assert.equal(
            (
              await request("/api/platform/admin/token-quotas/reconcile", {
                method: "POST",
                cookie: one.cookie,
                data,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/platform/admin/token-quotas/reconcile", {
                method: "POST",
                cookie: two.cookie,
                data,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/api/platform/admin/token-quotas/reconcile", {
                method: "POST",
                cookie: two.cookie,
                data,
              })
            ).status,
            200,
          );
          assert.equal((await q.balance(user)).used, 47);
          assert.equal((await q.balance(user)).reserved, 0);
        },
      );
      await t.test(
        "known provider rejection releases reservation without leaking provider errors",
        async () => {
          const result = await call("reject");
          assert.equal(result.status, 424);
          assert.ok(!JSON.stringify(result.data).includes("UPSTREAM_KEY"));
          assert.equal((await q.balance(user)).reserved, 0);
        },
      );
      await t.test(
        "redirects are not followed; uncertain requests remain reserved",
        async () => {
          const result = await call("redirect");
          assert.equal(result.status, 424); // uncertain failures must not trigger automatic retries
          const pending = (await q.requests(user)).find(
            (r) => r.state === "pending",
          );
          assert.ok(pending);
          await q.settle(
            pending.id,
            0,
            admin,
            "provider verified no inference",
          );
        },
      );
      await t.test(
        "client disconnect keeps unknown usage reserved for reconciliation",
        async () => {
          const res = await fetch(origin + gateway + "/chat/completions", {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "research",
              messages: [{ role: "user", content: "aborted" }],
              stream: true,
            }),
          });
          const reader = res.body.getReader();
          await reader.read();
          await reader.cancel();
          let pending;
          for (let n = 0; n < 100; n++) {
            pending = (await q.requests(user)).find(
              (r) => r.state === "pending",
            );
            if (pending) break;
            await new Promise((done) => setTimeout(done, 10));
          }
          assert.ok(pending);
          assert.equal((await q.balance(user)).reserved, 120);
          await q.settle(pending.id, 8, admin, "provider abort receipt");
        },
      );
      await t.test(
        "lowering the monthly policy never erases consumption and zero disables new calls",
        async () => {
          const used = (await q.balance(user)).used;
          await q.configure(user, admin, 0, "disabled allowance", id());
          assert.equal((await q.balance(user)).used, used);
          const before = calls;
          assert.equal((await call("json")).status, 402);
          assert.equal(calls, before);
          await q.configure(user, admin, 321, "monthly policy", id());
        },
      );
      await t.test(
        "gateway preserves multimodal content and thinking controls without exporting private headers",
        async () => {
          const messages = [
            {
              role: "user",
              content: [
                { type: "text", text: "describe" },
                {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,AA==" },
                },
              ],
            },
          ];
          const result = await request(
            "/api/platform/model-gateway/v1/chat/completions",
            {
              method: "POST",
              source: null,
              secret,
              data: {
                model: "research",
                messages,
                max_tokens: 20,
                thinking: { type: "enabled" },
                reasoning_effort: "high",
              },
            },
          );
          assert.equal(result.status, 200);
          assert.deepEqual(lastPayload.messages, messages);
          assert.deepEqual(lastPayload.thinking, { type: "enabled" });
          assert.equal(lastPayload.reasoning_effort, "high");
          assert.equal(lastHeaders["user-agent"], "OpenCode/quota-test");
          assert.equal(lastHeaders["x-provider-secret"], "PRIVATE_HEADER");
          const cfg = await request("/api/platform/runner/model-config", {
            source: null,
            secret,
          });
          assert.ok(!JSON.stringify(cfg.data).includes("PRIVATE_HEADER"));
        },
      );
      await t.test(
        "new Shanghai month starts at configured quota; late settlement stays in original month",
        async () => {
          const newcomer = id();
          await pool.query(
            "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
            [newcomer, "new-month@example.com", "month", "test only"],
          );
          await pool.query(
            "INSERT INTO token_quota_accounts(user_id,monthly_limit) VALUES($1,321)",
            [newcomer],
          );
          const old = (
            await pool.query(
              "SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai'-interval '1 month','YYYY-MM') AS period",
            )
          ).rows[0].period;
          await pool.query(
            "INSERT INTO token_quota_periods(user_id,period,granted,used,reserved) VALUES($1,$2,999,200,17)",
            [newcomer, old],
          );
          const req = id();
          await pool.query(
            "INSERT INTO token_quota_requests(id,user_id,period,workspace_id,model,reserved) VALUES($1,$2,$3,$4,$5,17)",
            [req, newcomer, old, workspace, "research"],
          );
          const now = await q.balance(newcomer);
          assert.notEqual(now.period, old);
          assert.equal(now.granted, 321);
          assert.equal(now.available, 321);
          await q.settle(req, 9);
          assert.equal((await q.balance(newcomer)).available, 321);
          const previous = (
            await pool.query(
              "SELECT used,reserved FROM token_quota_periods WHERE user_id=$1 AND period=$2",
              [newcomer, old],
            )
          ).rows[0];
          assert.equal(Number(previous.used), 209);
          assert.equal(Number(previous.reserved), 0);
        },
      );
      await t.test(
        "disabled account and expired runner cannot use platform-paid models",
        async () => {
          await pool.query(
            "UPDATE platform_users SET disabled=true WHERE id=$1",
            [user],
          );
          assert.equal((await call("json")).status, 401);
          await pool.query(
            "UPDATE platform_users SET disabled=false WHERE id=$1",
            [user],
          );
          await pool.query(
            "UPDATE runners SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",
            [workspace],
          );
          assert.equal((await call("json")).status, 401);
        },
      );
      await t.test(
        "workspace settings accept only the configured frontend origin for quota and password management",
        async () => {
          const newcomer = await signup("frontend-settings@example.com");
          assert.equal(newcomer.status, 201);
          const appOrigin = "http://localhost:5173";
          const previousOrigin = config.appOrigin;
          config.appOrigin = appOrigin;
          try {
            const own = await request("/api/platform/token-quota", {
              cookie: newcomer.cookie,
              source: appOrigin,
            });
            assert.equal(own.status, 200);
            assert.equal(own.data.monthlyLimit, 2000000);
            assert.equal(
              own.headers.get("access-control-allow-origin"),
              appOrigin,
            );
            assert.equal(
              (
                await request("/api/platform/token-quota", {
                  cookie: newcomer.cookie,
                  source: "http://evil.invalid",
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await request("/api/platform/admin/token-quotas", {
                  method: "OPTIONS",
                  source: appOrigin,
                })
              ).status,
              204,
            );
            const payload = {
              email: "frontend-settings@example.com",
              monthlyLimit: 1234,
              reason: "trusted frontend",
              idempotencyKey: id(),
            };
            assert.equal(
              (
                await request("/api/platform/admin/token-quotas", {
                  method: "POST",
                  cookie: two.cookie,
                  source: "http://evil.invalid",
                  data: payload,
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await request("/api/platform/admin/token-quotas", {
                  method: "POST",
                  cookie: two.cookie,
                  source: appOrigin,
                  data: payload,
                })
              ).status,
              200,
            );
            assert.equal(
              (
                await request("/api/platform/token-quota", {
                  cookie: newcomer.cookie,
                  source: appOrigin,
                })
              ).data.monthlyLimit,
              1234,
            );
            assert.equal(
              (
                await request("/api/platform/password", {
                  method: "POST",
                  cookie: newcomer.cookie,
                  source: "http://evil.invalid",
                  data: {
                    current: "Synthetic password 2026!",
                    password: "Trusted frontend password 2026!",
                  },
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await request("/api/platform/password", {
                  method: "POST",
                  cookie: newcomer.cookie,
                  source: appOrigin,
                  data: {
                    current: "Synthetic password 2026!",
                    password: "Trusted frontend password 2026!",
                  },
                })
              ).status,
              200,
            );
            assert.equal(
              (
                await request("/api/platform/token-quota", {
                  cookie: newcomer.cookie,
                  source: appOrigin,
                })
              ).status,
              401,
            );
          } finally {
            config.appOrigin = previousOrigin;
          }
        },
      );
    } finally {
      app?.server.closeAllConnections();
      await app?.close();
      upstream.closeAllConnections();
      await new Promise((done) => upstream.close(done));
      if (!app) await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
