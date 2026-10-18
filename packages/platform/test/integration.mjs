import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createPool, migrate } from "../src/db.mjs";
import { createPlatform, configuration } from "../src/server.mjs";
import { connectRunner } from "../src/runner.mjs";
import { id, passwordHash, pkce, token, hash } from "../src/security.mjs";

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
                ...(origin === null ? {} : { origin }),
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
      await t.test(
        "registration owns a personal space without allocating compute",
        async () => {
          const registered = await request("/api/platform/register", {
            method: "POST",
            data: {
              name: "New researcher",
              email: "new-researcher@test.invalid",
              password,
            },
          });
          assert.equal(registered.status, 201, JSON.stringify(registered.data));
          assert.ok(registered.cookie);
          const profile = await request("/api/platform/me", {
            cookie: registered.cookie,
          });
          assert.equal(profile.status, 200);
          assert.equal(profile.data.email, "new-researcher@test.invalid");
          const memberships = await pool.query(
            "SELECT count(*)::int AS n FROM memberships WHERE user_id=$1",
            [profile.data.id],
          );
          assert.equal(memberships.rows[0].n, 0);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM personal_spaces WHERE user_id=$1",
                [profile.data.id],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM workspace_runtimes r JOIN personal_spaces p ON p.workspace_id=r.workspace_id WHERE p.user_id=$1",
                [profile.data.id],
              )
            ).rows[0].n,
            0,
          );
          const browserSession = await request(
            "/api/platform/browser-session",
            {
              cookie: registered.cookie,
              origin: config.appOrigin,
            },
          );
          assert.equal(browserSession.status, 200);
          assert.equal(
            browserSession.data.user.email,
            "new-researcher@test.invalid",
          );
          assert.equal(
            browserSession.headers["access-control-allow-origin"],
            config.appOrigin,
          );
          assert.equal(
            (
              await request("/api/platform/browser-session", {
                cookie: registered.cookie,
                origin: "http://evil.test",
              })
            ).status,
            403,
          );
          const duplicate = await request("/api/platform/register", {
            method: "POST",
            data: {
              name: "Duplicate",
              email: "new-researcher@test.invalid",
              password,
            },
          });
          assert.equal(duplicate.status, 409);
          const loggedOut = await request("/api/platform/browser-logout", {
            method: "POST",
            cookie: registered.cookie,
            origin: config.appOrigin,
          });
          assert.equal(loggedOut.status, 200);
          assert.equal(
            (
              await request("/api/platform/browser-session", {
                cookie: registered.cookie,
                origin: config.appOrigin,
              })
            ).status,
            401,
          );
        },
      );
      const alice = await login("alice"),
        bob = await login("bob");
      await t.test(
        "public shared research space admits only its owner",
        async () => {
          config.researchOwnerEmail = "alice@test.invalid";
          const appOrigin = config.appOrigin;
          config.appOrigin = config.origin.origin;
          try {
            for (const site of [undefined, "same-origin"]) {
              assert.equal(
                (
                  await request("/api/platform/browser-session", {
                    cookie: alice,
                    origin: null,
                    headers: site ? { "sec-fetch-site": site } : {},
                  })
                ).status,
                200,
              );
            }
            assert.equal(
              (
                await request("/api/platform/browser-session", {
                  cookie: alice,
                  origin: null,
                  headers: { "sec-fetch-site": "cross-site" },
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await request("/api/platform/browser-logout", {
                  method: "POST",
                  cookie: alice,
                  origin: null,
                })
              ).status,
              403,
            );
            assert.equal(
              (await request("/api/auth/sso/authorize", { cookie: bob }))
                .status,
              403,
            );
            assert.equal(
              (
                await request("/api/platform/browser-session", {
                  cookie: alice,
                  origin: config.appOrigin,
                })
              ).status,
              200,
            );
            assert.equal(
              (
                await request("/api/platform/browser-session", {
                  cookie: bob,
                  origin: config.appOrigin,
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await request("/api/platform/browser-session", {
                  origin: config.appOrigin,
                })
              ).status,
              401,
            );
          } finally {
            config.researchOwnerEmail = "";
            config.appOrigin = appOrigin;
          }
        },
      );
      assert.equal((await request("/")).status, 200);
      await t.test(
        "prefixed literature SSO keeps callback and web entry under its basePath",
        async () => {
          const previous = config.deepLiterature;
          config.deepLiterature = {
            ...previous,
            path: "/deepxiv",
            webUrl: `${previous.origin}/deepxiv`,
          };
          try {
            const context = await request("/api/platform/browser-session", {
              cookie: alice,
              origin: config.appOrigin,
            });
            assert.equal(
              context.data.deepLiteratureUrl,
              `${previous.origin}/deepxiv`,
            );
            const query = new URLSearchParams({
              client_id: "deeplit",
              redirect_uri: `${previous.origin}/deepxiv/api/auth/openresearch/callback`,
              state: "p".repeat(43),
              code_challenge: pkce("q".repeat(43)),
              code_challenge_method: "S256",
            });
            const result = await request(`/api/auth/sso/authorize?${query}`, {
              cookie: alice,
            });
            assert.equal(result.status, 303);
            assert.equal(
              new URL(result.headers.location).pathname,
              "/deepxiv/api/auth/openresearch/callback",
            );
            query.set(
              "redirect_uri",
              `${previous.origin}/api/auth/openresearch/callback`,
            );
            assert.equal(
              (
                await request(`/api/auth/sso/authorize?${query}`, {
                  cookie: alice,
                })
              ).status,
              400,
            );
          } finally {
            config.deepLiterature = previous;
          }
        },
      );
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
        const dockerBridgeIntrospection = await request(
          "/api/auth/sso/session",
          {
            method: "POST",
            host: `host.docker.internal:${port}`,
            data: {
              subject: aliceSso.subject,
              sessionId: aliceSso.sessionId,
            },
            headers: ssoHeaders,
          },
        );
        assert.equal(dockerBridgeIntrospection.status, 200);
        assert.equal(
          dockerBridgeIntrospection.data.data.email,
          "alice@test.invalid",
        );
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
      await t.test(
        "owner deletes a workspace with exact-name confirmation",
        async () => {
          const doomed = await workspace(alice, "Disposable workspace");
          assert.equal(
            (
              await request(`/api/platform/workspaces/${doomed}`, {
                method: "DELETE",
                cookie: alice,
                data: { name: "wrong name" },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${doomed}`, {
                method: "DELETE",
                cookie: bob,
                data: { name: "Disposable workspace" },
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${doomed}/runner`, {
                method: "POST",
                cookie: alice,
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${doomed}`, {
                method: "DELETE",
                cookie: alice,
                data: { name: "Disposable workspace" },
              })
            ).status,
            200,
          );
          assert.deepEqual(
            (
              await request("/api/platform/workspaces", { cookie: alice })
            ).data.map((row) => row.id),
            [a],
          );
          assert.equal(
            (
              await request(`/api/platform/workspaces/${doomed}/runner`, {
                cookie: alice,
              })
            ).status,
            404,
          );
        },
      );
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
      await t.test("private space settings respect ownership", async () => {
        const route = `/api/platform/workspaces/${a}`;
        assert.equal(
          (
            await request(route, {
              method: "PATCH",
              cookie: bob,
              data: { name: "Forbidden" },
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await request(route, {
              method: "PATCH",
              cookie: alice,
              data: { name: "  " },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(route, {
              method: "PATCH",
              cookie: alice,
              data: { name: "Renamed research" },
            })
          ).data.name,
          "Renamed research",
        );
      });
      const aSession = await enter(alice, a),
        bSession = await enter(bob, b);
      await t.test(
        "managed workspace queues provisioning without exposing credentials",
        async () => {
          const create = () =>
            request("/api/platform/workspaces", {
              method: "POST",
              cookie: alice,
              data: { name: "Managed test", mode: "managed" },
            });
          assert.equal((await create()).status, 409);
          config.managed = true;
          const created = await create();
          assert.equal(created.status, 201);
          const route = `/api/platform/workspaces/${created.data.id}`;
          assert.equal(
            (await request(`${route}/runtime`, { cookie: alice })).data.status,
            "queued",
          );
          assert.equal(
            (await request(`${route}/runtime`, { cookie: bob })).status,
            404,
          );
          assert.equal(
            (
              await request(`${route}/runner`, {
                method: "POST",
                cookie: alice,
              })
            ).status,
            409,
          );
          await pool.query(
            "UPDATE workspace_runtimes SET status='failed' WHERE workspace_id=$1",
            [created.data.id],
          );
          assert.equal(
            (
              await request(`${route}/runtime`, {
                method: "POST",
                cookie: alice,
              })
            ).data.status,
            "queued",
          );
          assert.equal(
            (
              await request(route, {
                method: "DELETE",
                cookie: alice,
                data: { name: "Managed test" },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT desired FROM workspace_runtimes WHERE workspace_id=$1",
                [created.data.id],
              )
            ).rows[0].desired,
            "deleted",
          );
          config.managed = false;
        },
      );
      await t.test(
        "private hosted spaces are idempotent, owner-only and cannot be shared",
        async () => {
          config.privateSpaces = true;
          config.managed = true;
          try {
            const create = (cookie) =>
              request("/api/platform/personal-space", {
                method: "POST",
                cookie,
              });
            const [a, again, b] = await Promise.all([
              create(alice),
              create(alice),
              create(bob),
            ]);
            assert.equal(a.status, 200, JSON.stringify(a.data));
            assert.equal(again.data.id, a.data.id);
            assert.equal(b.status, 200, JSON.stringify(b.data));
            assert.notEqual(a.data.id, b.data.id);
            assert.equal(
              (
                await request(`/api/platform/workspaces/${a.data.id}/launch`, {
                  method: "POST",
                  cookie: bob,
                })
              ).status,
              404,
            );
            assert.equal(
              (
                await request(`/api/platform/workspaces/${a.data.id}/invites`, {
                  method: "POST",
                  cookie: alice,
                  data: { email: "bob@test.invalid", role: "editor" },
                })
              ).status,
              404,
            );
            assert.equal(
              (
                await request("/api/platform/invites/accept", {
                  method: "POST",
                  cookie: bob,
                  data: { token: "unused" },
                })
              ).status,
              404,
            );
            // Even an old shared membership must not expose another user's private space.
            await pool.query("INSERT INTO memberships VALUES($1,$2,'viewer')", [
              a.data.id,
              users.bob,
            ]);
            assert.equal(
              (
                await request(`/api/platform/workspaces/${a.data.id}/launch`, {
                  method: "POST",
                  cookie: bob,
                })
              ).status,
              404,
            );
            const list = await request("/api/platform/workspaces", {
              cookie: bob,
            });
            assert(!list.data.some((w) => w.id === a.data.id));
            const freshLogin = await login("alice");
            const hostedSession = (await enter(freshLogin, a.data.id)).cookie;
            const context = await request("/_platform/context", {
              host: `${a.data.id}.${portal}`,
              cookie: hostedSession,
            });
            assert.equal(context.data.user.id, users.alice);
            assert.equal(context.data.privateSpaces, true);
            assert.equal(
              (
                await request("/_platform/logout", {
                  method: "POST",
                  host: `${a.data.id}.${portal}`,
                  origin: `http://${a.data.id}.${portal}`,
                  cookie: hostedSession,
                })
              ).status,
              200,
            );
            assert.equal(
              (await request("/api/platform/me", { cookie: freshLogin }))
                .status,
              401,
            );
            assert.equal(
              (
                await request("/_platform/context", {
                  host: `${a.data.id}.${portal}`,
                  cookie: hostedSession,
                })
              ).status,
              401,
            );
            for (const space of [a.data.id, b.data.id]) {
              const cookie = space === a.data.id ? alice : bob;
              assert.equal(
                (
                  await request(`/api/platform/workspaces/${space}`, {
                    method: "DELETE",
                    cookie,
                    data: { name: "我的科研空间" },
                  })
                ).status,
                200,
              );
            }
          } finally {
            config.privateSpaces = false;
            config.managed = false;
          }
        },
      );
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
      const emptyRunner = await request(
        `/api/platform/workspaces/${a}/runner`,
        { cookie: alice },
      );
      assert.equal(emptyRunner.status, 200);
      assert.deepEqual(emptyRunner.data, {
        issued: false,
        online: false,
        lastSeen: null,
        expiresAt: null,
      });
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
      const connectedRunner = await request(
        `/api/platform/workspaces/${a}/runner`,
        { cookie: alice },
      );
      assert.equal(connectedRunner.status, 200);
      assert.equal(connectedRunner.data.issued, true);
      assert.equal(connectedRunner.data.online, true);
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
      await t.test(
        "shared-origin research routes only by account and registration owns space before compute",
        async () => {
          config.sharedOriginSpaces = true;
          config.privateSpaces = true;
          config.managed = true;
          config.managedCapacity = 2;
          config.researchOwnerEmail = "alice@test.invalid";
          await pool.query(
            "INSERT INTO personal_spaces VALUES($1,$2),($3,$4)",
            [users.alice, a, users.bob, b],
          );
          await pool.query(
            "INSERT INTO workspace_runtimes(workspace_id,status) VALUES($1,'ready'),($2,'ready')",
            [a, b],
          );
          try {
            assert.equal((await request("/api/projects")).status, 401);
            for (const [cookie, expected] of [
              [alice, "only-a"],
              [bob, "only-b"],
            ]) {
              const projects = await request(`/api/projects?workspace=${a}`, {
                cookie,
                headers: { "x-workspace-id": a },
              });
              assert.equal(projects.status, 200, JSON.stringify(projects.data));
              assert.equal(projects.data.projects[0].id, expected);
              assert.equal(projects.data.cookie, null);
              assert.equal(projects.data.authorization, null);
            }
            assert.equal(
              (
                await request("/api/projects", {
                  method: "POST",
                  cookie: bob,
                  origin: "https://evil.test",
                  data: {},
                })
              ).status,
              403,
            );
            assert.equal(
              (await request("/api/settings/data-dir", { cookie: alice }))
                .status,
              403,
            );
            const session = await request("/api/platform/catalog-session", {
              cookie: bob,
              origin: config.appOrigin,
            });
            assert.equal(session.data.canAccessResearch, true);
            assert.equal(session.data.privateResearch, true);
            const created = await request("/api/platform/register", {
              method: "POST",
              data: { email: "lazy@test.invalid", name: "Lazy user", password },
            });
            assert.equal(created.status, 201);
            const initial = await request("/api/platform/personal-space", {
              cookie: created.cookie,
            });
            assert.equal(initial.status, 200);
            assert.equal(initial.data.status, "not_started");
            assert.equal(
              (
                await request("/api/platform/personal-space", {
                  method: "POST",
                  cookie: created.cookie,
                  data: {},
                })
              ).status,
              409,
            );
            const again = await request("/api/platform/personal-space", {
              cookie: created.cookie,
            });
            assert.equal(again.data.id, initial.data.id);
            assert.equal(again.data.status, "not_started");
            const ws = new WebSocket(
              `ws://127.0.0.1:${port}/api/projects/p/terminal`,
              {
                headers: {
                  host: portal,
                  cookie: bob,
                  origin: config.origin.origin,
                },
              },
            );
            sockets.push(ws);
            await once(ws, "open");
            const message = once(ws, "message");
            ws.send("own terminal");
            assert.equal((await message)[0].toString(), "own terminal");
            ws.close();
            const temporaryUser = (
              await request("/api/platform/me", { cookie: created.cookie })
            ).data.id;
            const temporaryToken = token();
            const publicOrigin = new URL("http://61.136.101.179:20281");
            await pool.query(
              "INSERT INTO platform_sessions(token_hash,user_id,host,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
              [hash(temporaryToken), temporaryUser, publicOrigin.host],
            );
            const previousOrigin = config.origin;
            config.origin = publicOrigin;
            try {
              const removed = await request(
                `/api/platform/workspaces/${initial.data.id}`,
                {
                  method: "DELETE",
                  cookie: `orx_session=${temporaryToken}`,
                  host: publicOrigin.host,
                  origin: publicOrigin.origin,
                  data: { name: "我的科研空间" },
                },
              );
              assert.equal(removed.status, 200, JSON.stringify(removed.data));
            } finally {
              config.origin = previousOrigin;
            }
            assert.equal(
              (await request("/api/platform/me", { cookie: created.cookie }))
                .status,
              401,
            );
            assert.equal(
              (await request("/api/projects", { cookie: alice })).status,
              200,
            );
            assert.equal(
              (await request("/api/projects", { cookie: bob })).status,
              200,
            );
          } finally {
            config.sharedOriginSpaces = false;
            config.privateSpaces = false;
            config.managed = false;
            config.managedCapacity = 4;
            config.researchOwnerEmail = "";
            await pool.query(
              "DELETE FROM personal_spaces WHERE workspace_id=ANY($1::uuid[])",
              [[a, b]],
            );
            await pool.query(
              "DELETE FROM workspace_runtimes WHERE workspace_id=ANY($1::uuid[])",
              [[a, b]],
            );
          }
        },
      );
      await t.test(
        "retired team APIs cannot grant access, even to administrators",
        async () => {
          // Legacy rows and already-issued sessions must not bypass creator ownership.
          await pool.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
            a,
            users.bob,
          ]);
          await pool.query(
            "UPDATE platform_users SET is_admin=true WHERE id=$1",
            [users.bob],
          );
          const legacyToken = token();
          const legacyCookie = `orx_session=${legacyToken}`;
          await pool.query(
            "INSERT INTO platform_sessions(token_hash,user_id,host,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
            [hash(legacyToken), users.bob, aHost],
          );
          const legacyGrant = id();
          await pool.query(
            "INSERT INTO sso_grants(id,client,root_session_hash,user_id,workspace_id,expires_at) VALUES($1,'deeplit',$2,$3,$4,now()+interval '1 hour')",
            [legacyGrant, hash(legacyToken), users.bob, a],
          );
          try {
            for (const cookie of [alice, bob]) {
              for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
                for (const suffix of [
                  "members",
                  `members/${users.bob}`,
                  "invites",
                ]) {
                  assert.equal(
                    (
                      await request(`/api/platform/workspaces/${a}/${suffix}`, {
                        method,
                        cookie,
                        data: { email: "carol@test.invalid", role: "owner" },
                      })
                    ).status,
                    404,
                  );
                }
              }
            }
            for (const cookie of [undefined, alice, bob]) {
              assert.equal(
                (
                  await request("/api/platform/invites/accept", {
                    method: "POST",
                    cookie,
                    data: { token: "legacy", name: "Carol", password },
                  })
                ).status,
                404,
              );
            }
            for (const role of ["owner", "editor", "viewer"]) {
              await pool.query(
                "UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2",
                [a, users.bob, role],
              );
              const list = await request("/api/platform/workspaces", {
                cookie: bob,
              });
              assert(!list.data.some((w) => w.id === a));
              assert.equal(
                (
                  await request(`/api/platform/workspaces/${a}/launch`, {
                    method: "POST",
                    cookie: bob,
                  })
                ).status,
                404,
              );
              for (const path of [
                "/api/projects",
                "/_platform/context",
                "/api/events",
              ]) {
                assert.equal(
                  (await request(path, { host: aHost, cookie: legacyCookie }))
                    .status,
                  404,
                );
              }
            }
            assert.equal(
              (
                await request("/api/auth/sso/session", {
                  method: "POST",
                  data: { subject: users.bob, sessionId: legacyGrant },
                  headers: {
                    "x-sso-client-secret": config.deepLiterature.secret,
                  },
                })
              ).status,
              401,
            );
            const ownAdministration = await request(
              "/api/platform/admin/users",
              {
                host: bHost,
                cookie: bSession.cookie,
                origin: `http://${bHost}`,
              },
            );
            assert.equal(ownAdministration.status, 200);
            assert.equal(ownAdministration.data.summary.admins, 1);
            assert.equal(
              (
                await request("/api/platform/admin/users", {
                  host: aHost,
                  cookie: legacyCookie,
                  origin: `http://${aHost}`,
                })
              ).status,
              404,
            );
            const ownerList = await request("/api/platform/workspaces", {
              cookie: alice,
            });
            assert(ownerList.data.some((w) => w.id === a));
            assert(!("role" in ownerList.data[0]));
            // Ownership works without any old membership record.
            await pool.query(
              "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
              [a, users.alice],
            );
            assert.equal(
              (
                await request("/api/projects", {
                  host: aHost,
                  cookie: aSession.cookie,
                })
              ).status,
              200,
            );
          } finally {
            await pool.query(
              "UPDATE platform_users SET is_admin=false WHERE id=$1",
              [users.bob],
            );
          }
        },
      );
      await t.test(
        "terminal relayed only for the private space owner",
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
              cookie: bSession.cookie,
              origin: `http://${aHost}`,
            },
          });
          denied.on("error", () => {});
          sockets.push(denied);
          const [error] = await once(denied, "error");
          assert.match(error.message, /401/);
        },
      );
      let streaming;
      const streamSession = await enter(await login("alice"), a);
      await t.test("SSE uses authorized tunnel", async () => {
        streaming = await new Promise((resolve, reject) => {
          const req = http.get(
            {
              host: "127.0.0.1",
              port,
              path: "/api/events",
              headers: { host: aHost, cookie: streamSession.cookie },
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
        "owner logout closes streams and denies new requests",
        async () => {
          const closed = new Promise((resolve) => {
            streaming.res.on("error", () => {});
            streaming.res.once("close", resolve);
          });
          assert.equal(
            (
              await request("/_platform/logout", {
                method: "POST",
                host: aHost,
                origin: `http://${aHost}`,
                cookie: streamSession.cookie,
              })
            ).status,
            200,
          );
          await closed;
          assert.equal(
            (
              await request("/api/projects", {
                host: aHost,
                cookie: streamSession.cookie,
              })
            ).status,
            401,
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
