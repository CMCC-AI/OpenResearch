import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Tunnel, MAX_BODY } from "../src/tunnel.mjs";
import {
  permitted,
  passwordHash,
  verifyPassword,
  hostWorkspace,
  sessionCookie,
  workspaceEntryOrigin,
  browserSessionOrigin,
} from "../src/security.mjs";
import { configuration } from "../src/server.mjs";
test("cancelling an overloaded stream does not crash the gateway", () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.bufferedAmount = MAX_BODY + 1;
  let terminated = false;
  socket.terminate = () => {
    terminated = true;
  };
  const tunnel = new Tunnel(socket);
  tunnel.pending.set("test", {});
  assert.doesNotThrow(() => tunnel.cancel("test"));
  assert.ok(terminated);
  assert.equal(tunnel.pending.size, 0);
});
test("private space gateway blocks machine administration and path confusion", () => {
  for (const method of ["GET", "POST", "DELETE"])
    for (const path of [
      "/api/internal/permissions",
      "/api/remote/sessions",
      "/api/update",
      "/api/settings/data-dir",
      "/api/git/install",
      "/api/settings/ssh",
      "/api/projects/%2e%2e/settings/env",
      "//api/projects",
      "/api/projects\\foo",
    ])
      assert.equal(permitted(method, path), false);
  assert.equal(permitted("POST", "/api/chat/sessions/x/message"), true);
  assert.equal(permitted("GET", "/api/events"), true);
});
test("passwords salted and verified using bounded scrypt", async () => {
  const password = "a strong test password";
  const a = await passwordHash(password),
    b = await passwordHash(password);
  assert.notEqual(a, b);
  assert.ok(await verifyPassword(password, a));
  assert.equal(await verifyPassword("wrong", a), false);
  assert.equal(await verifyPassword(password, null), false);
  await assert.rejects(passwordHash("short"));
});
test("origins and cookies are host-scoped, public HTTP rejected", () => {
  const config = { origin: new URL("https://research.example") };
  assert.equal(hostWorkspace(config, "research.example"), null);
  assert.equal(
    hostWorkspace(
      config,
      "11111111-1111-1111-1111-111111111111.research.example",
    ),
    "11111111-1111-1111-1111-111111111111",
  );
  for (const host of [
    "evil.example",
    "research.example.evil.test",
    "a.b.research.example",
  ])
    assert.throws(() => hostWorkspace(config, host));
  assert.throws(() =>
    configuration({
      DATABASE_URL: "postgres://unused",
      PLATFORM_ORIGIN: "http://research.example",
    }),
  );
  assert.equal(
    configuration({
      DATABASE_URL: "postgres://unused",
      PLATFORM_ORIGIN: "http://localhost:5300",
      OPENRESEARCH_APP_ORIGIN: "http://localhost:5202",
    }).appOrigin,
    "http://localhost:5202",
  );
  assert.throws(() =>
    configuration({
      DATABASE_URL: "postgres://unused",
      PLATFORM_ORIGIN: "http://localhost:5300",
      OPENRESEARCH_APP_ORIGIN: "http://untrusted.example",
    }),
  );
  const cookie = sessionCookie("test", true);
  assert.ok(cookie.startsWith("__Host-"));
  assert.ok(cookie.includes("Secure"));
  assert.ok(!cookie.includes("Domain="));
});
test("MobileSci entry uses its configured base path", () => {
  const env = {
    DATABASE_URL: "postgres://unused",
    PLATFORM_ORIGIN: "http://localhost:5300",
    OPENRESEARCH_APP_ORIGIN: "http://localhost:5202",
    OPENRESEARCH_APP_PATH: "/mobilesci",
  };
  assert.equal(configuration(env).appEntry, "http://localhost:5202/mobilesci");
  assert.throws(() =>
    configuration({ ...env, OPENRESEARCH_APP_PATH: "/other" }),
  );
});
test("workspace entry accepts only explicit or embedded same-origin navigation", () => {
  const expected = "http://workspace.localhost:5300";
  assert.doesNotThrow(() =>
    workspaceEntryOrigin({ headers: { origin: expected } }, expected),
  );
  assert.doesNotThrow(() =>
    workspaceEntryOrigin(
      {
        headers: {
          origin: "null",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
        },
      },
      expected,
    ),
  );
  for (const headers of [
    { origin: "null" },
    {
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
    },
    {
      origin: "null",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    },
    { origin: "http://evil.example" },
  ])
    assert.throws(() => workspaceEntryOrigin({ headers }, expected));
});

test("public HTTP needs exact explicit origin approval", () => {
  const origin = "http://61.136.101.179:20281";
  const env = {
    DATABASE_URL: "postgres://test:test@localhost/test",
    PLATFORM_ORIGIN: origin,
    OPENRESEARCH_APP_ORIGIN: origin,
    DEEPLIT_ORIGIN: origin,
    DEEPLIT_SSO_CLIENT_SECRET: "x".repeat(32),
  };
  assert.throws(() => configuration(env), /HTTPS/);
  const allowed = { ...env, PLATFORM_INSECURE_PUBLIC_ORIGIN: origin };
  assert.equal(configuration(allowed).secure, false);
  for (const OPENRESEARCH_APP_ORIGIN of [
    "http://61.136.101.179:20282",
    `${origin}/extra`,
    "http://user@61.136.101.179:20281",
  ])
    assert.throws(() => configuration({ ...allowed, OPENRESEARCH_APP_ORIGIN }));
});

test("browser session reads accept same-origin GETs without Origin, but reject foreign reads and headerless writes", () => {
  const origin = "http://61.136.101.179:20281";
  const request = { method: "GET", headers: { host: "61.136.101.179:20281" } };
  assert.doesNotThrow(() => browserSessionOrigin(request, origin));
  assert.doesNotThrow(() =>
    browserSessionOrigin(
      {
        ...request,
        headers: { ...request.headers, "sec-fetch-site": "same-origin" },
      },
      origin,
    ),
  );
  for (const req of [
    { ...request, method: "POST" },
    { ...request, headers: { host: "evil.test" } },
    {
      ...request,
      headers: { ...request.headers, "sec-fetch-site": "cross-site" },
    },
    { ...request, headers: { ...request.headers, origin: "http://evil.test" } },
  ])
    assert.throws(() => browserSessionOrigin(req, origin), { status: 403 });
});
