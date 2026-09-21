import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createPool, migrate } from "../src/db.mjs";
import { createPlatform, configuration } from "../src/server.mjs";
import { connectRunner } from "../src/runner.mjs";
import { id, passwordHash, pkce } from "../src/security.mjs";

test(
  "PostgreSQL multi-user authorization and outbound executor",
  { timeout: 60000 },
  async (t) => {
    assert.ok(
      process.env.DATABASE_URL,
      "Use the dedicated development database",
    );
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(process.env.DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = createPool(url.href);
    let app;
    const sockets = [],
      backends = [];
    try {
      await migrate(pool);
      const password = "Test-only research password 2026!";
      const encoded = await passwordHash(password),
        users = { alice: id(), bob: id() };
      for (const [name, uid] of Object.entries(users))
        await pool.query(
          "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
          [uid, `${name}@test.invalid`, name, encoded],
        );
      const config = configuration({
        DATABASE_URL: url.href,
        PLATFORM_ORIGIN: "http://localhost:5300",
        DEEPLIT_ORIGIN: "http://localhost:3000",
        DEEPLIT_SSO_CLIENT_SECRET:
          "integration-test-sso-secret-with-32-characters",
      });
      app = await createPlatform(config, pool);
      app.server.listen(0, "127.0.0.1");
      await once(app.server, "listening");
      const port = app.server.address().port;
      config.origin = new URL(`http://localhost:${port}`);
      const portal = config.origin.host;
      async function request(
        path,
        {
          method = "GET",
          data,
          cookie,
          host = portal,
          origin = config.origin.origin,
          raw,
          headers = {},
        } = {},
      ) {
        return new Promise((resolve, reject) => {
          const payload =
            raw ?? (data === undefined ? undefined : JSON.stringify(data));
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path,
              method,
              headers: {
                host,
                origin,
                ...(cookie ? { cookie } : {}),
                ...(payload
                  ? {
                      "content-type": raw
                        ? "application/x-www-form-urlencoded"
                        : "application/json",
                      "content-length": Buffer.byteLength(payload),
                    }
                  : {}),
                ...headers,
              },
            },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                let data;
                try {
                  data = JSON.parse(text);
                } catch {
                  data = text;
                }
                resolve({
                  status: res.statusCode,
                  data,
                  headers: res.headers,
                  cookie: res.headers["set-cookie"]?.[0].split(";")[0],
                });
              });
            },
          );
          req.on("error", reject);
          if (payload) req.write(payload);
          req.end();
        });
      }
      async function login(name) {
        const r = await request("/api/platform/login", {
          method: "POST",
          data: { email: `${name}@test.invalid`, password },
        });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return r.cookie;
      }
      const alice = await login("alice"),
        bob = await login("bob");
      assert.equal((await request("/")).status, 200);
      let aliceSso;
      await t.test("DeepLiterature SSO is PKCE-bound and one-use", async () => {
        const state = "s".repeat(43),
          verifier = "v".repeat(43),
          redirectUri = "http://localhost:3000/api/auth/openresearch/callback",
          query = new URLSearchParams({
            client_id: "deeplit",
            redirect_uri: redirectUri,
            state,
            code_challenge: pkce(verifier),
            code_challenge_method: "S256",
          });
        const anonymous = await request(`/api/auth/sso/authorize?${query}`);
        assert.equal(anonymous.status, 303);
        assert.match(anonymous.headers.location, /continue=/);
        const pkceAttempt = await request(`/api/auth/sso/authorize?${query}`, {
          cookie: alice,
        });
        const consumedCode = new URL(
          pkceAttempt.headers.location,
        ).searchParams.get("code");
        const ssoHeaders = {
          "x-sso-client-secret":
            "integration-test-sso-secret-with-32-characters",
        };
        assert.equal(
          (
            await request("/api/auth/sso/exchange", {
              method: "POST",
              data: {
                code: consumedCode,
                verifier: "x".repeat(43),
                redirectUri,
                state,
              },
              headers: ssoHeaders,
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request("/api/auth/sso/exchange", {
              method: "POST",
              data: { code: consumedCode, verifier, redirectUri, state },
              headers: ssoHeaders,
            })
          ).status,
          401,
        );
        const authorized = await request(`/api/auth/sso/authorize?${query}`, {
          cookie: alice,
        });
        assert.equal(authorized.status, 303);
        const code = new URL(authorized.headers.location).searchParams.get(
          "code",
        );
        assert.match(code, /^[A-Za-z0-9_-]{43}$/);
        const exchange = (extra = {}) =>
          request("/api/auth/sso/exchange", {
            method: "POST",
            data: { code, verifier, redirectUri, state },
            headers: { ...ssoHeaders, ...extra },
          });
        assert.equal(
          (
            await exchange({
              "x-sso-client-secret": "wrong-client-secret-value-over-32-chars",
            })
          ).status,
          401,
        );
        const exchanged = await exchange();
        assert.equal(exchanged.status, 200, JSON.stringify(exchanged.data));
        assert.equal(exchanged.data.data.subject, users.alice);
        assert.equal(exchanged.data.data.requestId, state);
        aliceSso = exchanged.data.data;
        assert.equal((await exchange()).status, 401);
        const introspection = await request("/api/auth/sso/session", {
          method: "POST",
          data: {
            subject: aliceSso.subject,
            sessionId: aliceSso.sessionId,
          },
          headers: ssoHeaders,
        });
        assert.equal(introspection.status, 200);
        assert.equal(introspection.data.data.email, "alice@test.invalid");
      });
      async function workspace(cookie, name) {
        const r = await request("/api/platform/workspaces", {
          method: "POST",
          cookie,
          data: { name },
        });
        assert.equal(r.status, 201);
        return r.data.id;
      }
      const a = await workspace(alice, "Alice research"),
        b = await workspace(bob, "Bob research"),
        aHost = `${a}.${portal}`,
        bHost = `${b}.${portal}`;
      async function enter(cookie, w) {
        const r = await request(`/api/platform/workspaces/${w}/launch`, {
          method: "POST",
          cookie,
        });
        assert.equal(r.status, 200);
        const ticket = r.data.ticket;
        const entry = await request("/_platform/enter", {
          host: `${w}.${portal}`,
        });
        assert.equal(entry.status, 200);
        const entered = await request("/_platform/enter", {
          method: "POST",
          host: `${w}.${portal}`,
          origin: "null",
          raw: `ticket=${ticket}`,
          headers: {
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
          },
        });
        assert.equal(entered.status, 303, JSON.stringify(entered.data));
        return { ...entered, ticket };
      }
      const aSession = await enter(alice, a),
        bSession = await enter(bob, b);
      await t.test(
        "anonymous, CSRF, IDOR and host-scoped sessions",
        async () => {
          assert.equal((await request("/api/platform/workspaces")).status, 401);
          assert.equal(
            (
              await request("/api/platform/workspaces", {
                method: "POST",
                cookie: alice,
                origin: "https://attacker.invalid",
                data: { name: "evil" },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${b}/launch`, {
                method: "POST",
                cookie: alice,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await request("/_platform/context", {
                host: bHost,
                cookie: aSession.cookie,
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await request("/_platform/enter", {
                method: "POST",
                host: aHost,
                origin: "null",
                raw: `ticket=${aSession.ticket}`,
                headers: {
                  "sec-fetch-site": "same-origin",
                  "sec-fetch-mode": "navigate",
                },
              })
            ).status,
            401,
          );
          assert.equal(
            (await request("/healthz", { host: "attacker.invalid" })).status,
            421,
          );
          assert.deepEqual(
            (
              await request("/api/platform/workspaces", { cookie: alice })
            ).data.map((x) => x.id),
            [a],
          );
        },
      );
      async function backend(name) {
        const server = http.createServer((req, res) => {
          if (req.url === "/api/events") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ name })}\n\n`);
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              projects: [{ id: name, name }],
              origin: req.headers.origin,
              cookie: req.headers.cookie ?? null,
              authorization: req.headers.authorization ?? null,
            }),
          );
        });
        const ws = new WebSocketServer({ server });
        ws.on("connection", (socket) =>
          socket.on("message", (data, binary) => socket.send(data, { binary })),
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        backends.push({ server, ws });
        return `http://127.0.0.1:${server.address().port}`;
      }
      const upstreamA = await backend("only-a"),
        upstreamB = await backend("only-b");
      async function runner(cookie, w, upstream) {
        const r = await request(`/api/platform/workspaces/${w}/runner`, {
          method: "POST",
          cookie,
        });
        assert.equal(r.status, 201);
        const socket = connectRunner({
          platform: config.origin.origin,
          connect: `http://127.0.0.1:${port}`,
          credential: r.data.token,
          upstream,
        });
        sockets.push(socket);
        await once(socket, "open");
        return { socket, token: r.data.token };
      }
      const ar = await runner(alice, a, upstreamA);
      await runner(bob, b, upstreamB);
      await t.test(
        "tunnel routes to assigned executor and strips browser credentials",
        async () => {
          const ra = await request("/api/projects", {
              host: aHost,
              cookie: aSession.cookie,
            }),
            rb = await request("/api/projects", {
              host: bHost,
              cookie: bSession.cookie,
            });
          assert.equal(ra.status, 200, JSON.stringify(ra.data));
          assert.equal(ra.data.projects[0].id, "only-a");
          assert.equal(rb.data.projects[0].id, "only-b");
          assert.equal(ra.data.cookie, null);
          assert.equal(ra.data.authorization, null);
          assert.equal(ra.data.origin, upstreamA);
          assert.equal(
            (
              await request("/api/internal/permissions", {
                method: "POST",
                host: aHost,
                cookie: aSession.cookie,
                origin: `http://${aHost}`,
                data: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/projects", {
                method: "POST",
                host: aHost,
                cookie: aSession.cookie,
                origin: "https://evil.invalid",
                data: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/projects", {
                method: "POST",
                host: aHost,
                cookie: aSession.cookie,
                origin: `http://${aHost}`,
                data: { name: "allowed" },
              })
            ).status,
            200,
          );
        },
      );
      let viewer;
      await t.test(
        "invitation creates an account without public registration",
        async () => {
          const issued = await request(
            `/api/platform/workspaces/${a}/invites`,
            {
              method: "POST",
              cookie: alice,
              data: { email: "carol@test.invalid", role: "viewer" },
            },
          );
          const invite = new URLSearchParams(
            new URL(issued.data.url).hash.slice(1),
          ).get("invite");
          const accepted = await request("/api/platform/invites/accept", {
            method: "POST",
            data: { token: invite, name: "Carol", password },
          });
          assert.equal(accepted.status, 200);
          const carol = await login("carol");
          const list = await request("/api/platform/workspaces", {
            cookie: carol,
          });
          assert.deepEqual(
            list.data.map((w) => [w.id, w.role]),
            [[a, "viewer"]],
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${b}/launch`, {
                method: "POST",
                cookie: carol,
              })
            ).status,
            404,
          );
          assert.equal(
            (await request("/api/platform/login", { method: "POST", data: [] }))
              .status,
            400,
          );
        },
      );
      await t.test(
        "one-use email-bound invitation and read-only role",
        async () => {
          const r = await request(`/api/platform/workspaces/${a}/invites`, {
            method: "POST",
            cookie: alice,
            data: { email: "bob@test.invalid", role: "viewer" },
          });
          assert.equal(r.status, 201);
          const invite = new URLSearchParams(
            new URL(r.data.url).hash.slice(1),
          ).get("invite");
          assert.equal(
            (
              await request("/api/platform/invites/accept", {
                method: "POST",
                cookie: alice,
                data: { token: invite },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/platform/invites/accept", {
                method: "POST",
                cookie: bob,
                data: { token: invite },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/api/platform/invites/accept", {
                method: "POST",
                cookie: bob,
                data: { token: invite },
              })
            ).status,
            400,
          );
          viewer = await enter(bob, a);
          assert.equal(
            (
              await request("/api/projects", {
                host: aHost,
                cookie: viewer.cookie,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/api/projects", {
                host: aHost,
                cookie: viewer.cookie,
                method: "POST",
                origin: `http://${aHost}`,
                data: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/settings/env", {
                host: aHost,
                cookie: viewer.cookie,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${a}/runner`, {
                method: "POST",
                cookie: bob,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/settings/ui-state", {
                method: "POST",
                host: aHost,
                cookie: viewer.cookie,
                origin: `http://${aHost}`,
                data: { workspace: { lastLocation: "/discover" } },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/api/settings/ui-state", {
                host: aHost,
                cookie: aSession.cookie,
              })
            ).data.workspace,
            null,
          );
          assert.equal(
            (
              await request("/api/settings/ui-state", {
                host: aHost,
                cookie: viewer.cookie,
              })
            ).data.workspace.lastLocation,
            "/discover",
          );
          assert.equal(
            (
              await request(
                `/api/platform/workspaces/${a}/members/${users.alice}`,
                { method: "DELETE", cookie: alice },
              )
            ).status,
            409,
          );
        },
      );
      await t.test(
        "terminal relayed for editor and rejected for viewer",
        async () => {
          const target = `ws://127.0.0.1:${port}/api/projects/p/terminal`;
          const ws = new WebSocket(target, {
            headers: {
              host: aHost,
              cookie: aSession.cookie,
              origin: `http://${aHost}`,
            },
          });
          sockets.push(ws);
          await once(ws, "open");
          const message = once(ws, "message");
          ws.send("hello research");
          assert.equal((await message)[0].toString(), "hello research");
          ws.close();
          const denied = new WebSocket(target, {
            headers: {
              host: aHost,
              cookie: viewer.cookie,
              origin: `http://${aHost}`,
            },
          });
          denied.on("error", () => {});
          sockets.push(denied);
          const [error] = await once(denied, "error");
          assert.match(error.message, /403/);
        },
      );
      let streaming;
      await t.test("SSE uses authorized tunnel", async () => {
        streaming = await new Promise((resolve, reject) => {
          const req = http.get(
            {
              host: "127.0.0.1",
              port,
              path: "/api/events",
              headers: { host: aHost, cookie: viewer.cookie },
            },
            (res) => {
              res.once("data", (data) => {
                assert.match(data.toString(), /only-a/);
                resolve({ req, res });
              });
            },
          );
          req.on("error", reject);
        });
      });
      await t.test(
        "member removal closes streams and denies new requests",
        async () => {
          const closed = new Promise((resolve) => {
            streaming.res.on("error", () => {});
            streaming.res.once("close", resolve);
          });
          assert.equal(
            (
              await request(
                `/api/platform/workspaces/${a}/members/${users.bob}`,
                { method: "DELETE", cookie: alice },
              )
            ).status,
            200,
          );
          await closed;
          assert.equal(
            (
              await request("/api/projects", {
                host: aHost,
                cookie: viewer.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${a}/launch`, {
                method: "POST",
                cookie: bob,
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        "executor revocation and logout invalidate credentials",
        async () => {
          assert.equal(
            (
              await request(`/api/platform/workspaces/${a}/runner`, {
                method: "DELETE",
                cookie: alice,
              })
            ).status,
            200,
          );
          const denied = connectRunner({
            platform: config.origin.origin,
            credential: ar.token,
            upstream: upstreamA,
          });
          sockets.push(denied);
          const [error] = await once(denied, "error");
          assert.match(error.message, /401/);
          const audit = await request(`/api/platform/workspaces/${a}/audit`, {
            cookie: alice,
          });
          assert.ok(audit.data.some((row) => row.action === "runner.revoke"));
          assert.equal(
            (
              await request("/api/platform/logout", {
                method: "POST",
                cookie: alice,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/_platform/context", {
                host: aHost,
                cookie: aSession.cookie,
              })
            ).status,
            401,
          );
          assert.equal(
            (await request("/api/platform/me", { cookie: alice })).status,
            401,
          );
          assert.equal(
            (
              await request("/api/auth/sso/session", {
                method: "POST",
                data: {
                  subject: aliceSso.subject,
                  sessionId: aliceSso.sessionId,
                },
                headers: {
                  "x-sso-client-secret":
                    "integration-test-sso-secret-with-32-characters",
                },
              })
            ).status,
            401,
          );
        },
      );
      if (process.env.ORX_TEST_UPSTREAM)
        await t.test(
          "real OpenResearch read-only smoke through the authenticated gateway",
          async () => {
            const live = await workspace(bob, "Read-only live smoke");
            await runner(bob, live, process.env.ORX_TEST_UPSTREAM);
            const entry = await enter(bob, live),
              host = `${live}.${portal}`;
            assert.equal(
              (await request("/api/health", { host, cookie: entry.cookie }))
                .status,
              200,
            );
            const projects = await request("/api/projects", {
              host,
              cookie: entry.cookie,
            });
            assert.equal(projects.status, 200);
            assert.ok(Array.isArray(projects.data.projects));
            assert.equal(
              (await request("/_orx/runtime", { host, cookie: entry.cookie }))
                .data.kind,
              "local",
            );
            const html = await request("/projects", {
              host,
              cookie: entry.cookie,
            });
            assert.equal(html.status, 200);
            assert.match(html.data, /type="module"/);
          },
        );
      await t.test(
        "DeepLiterature logout revokes portal and workspace sessions",
        async () => {
          const state = "l".repeat(43),
            verifier = "z".repeat(43),
            redirectUri =
              "http://localhost:3000/api/auth/openresearch/callback",
            query = new URLSearchParams({
              client_id: "deeplit",
              redirect_uri: redirectUri,
              state,
              code_challenge: pkce(verifier),
              code_challenge_method: "S256",
            });
          const authorized = await request(`/api/auth/sso/authorize?${query}`, {
            cookie: bob,
          });
          const code = new URL(authorized.headers.location).searchParams.get(
            "code",
          );
          const headers = {
            "x-sso-client-secret":
              "integration-test-sso-secret-with-32-characters",
          };
          const exchange = await request("/api/auth/sso/exchange", {
            method: "POST",
            data: { code, verifier, redirectUri, state },
            headers,
          });
          const identity = exchange.data.data;
          assert.equal(
            (
              await request("/api/auth/sso/logout", {
                method: "POST",
                data: {
                  subject: identity.subject,
                  sessionId: identity.sessionId,
                },
                headers,
              })
            ).status,
            200,
          );
          assert.equal(
            (await request("/api/platform/me", { cookie: bob })).status,
            401,
          );
          assert.equal(
            (
              await request("/_platform/context", {
                host: bHost,
                cookie: bSession.cookie,
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await request("/api/auth/sso/session", {
                method: "POST",
                data: {
                  subject: identity.subject,
                  sessionId: identity.sessionId,
                },
                headers,
              })
            ).status,
            401,
          );
        },
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      for (const { server, ws } of backends) {
        for (const s of ws.clients) s.terminate();
        ws.close();
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      if (app) await app.close();
      else await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
