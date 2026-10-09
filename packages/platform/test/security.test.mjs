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
test("viewer cannot mutate, spawn terminals, inspect credentials or use internal callbacks", () => {
  for (const [method, path] of [
    ["POST", "/api/projects"],
    ["GET", "/api/projects/x/terminal"],
    ["GET", "/api/settings/env"],
    ["GET", "/api/overleaf/settings"],
    ["POST", "/api/internal/permissions"],
    ["GET", "/api/files/abs"],
  ])
    assert.equal(permitted("viewer", method, path), false);
  for (const path of [
    "/api/projects",
    "/api/runs/a/log",
    "/api/chat/sessions/a/messages",
    "/api/events",
  ])
    assert.equal(permitted("viewer", "GET", path), true);
});
test("gateway blocks administration and path confusion for all roles", () => {
  for (const role of ["owner", "editor", "viewer"])
    for (const path of [
      "/api/internal/permissions",
      "/api/remote/sessions",
      "/api/update",
      "/api/settings/data-dir",
      "/api/git/install",
      "/api/projects/%2e%2e/settings/env",
      "//api/projects",
      "/api/projects\\foo",
    ])
      assert.equal(permitted(role, "GET", path), false);
  for (const role of ["owner", "editor", "viewer"])
    assert.equal(permitted(role, "POST", "/api/git/install"), false);
  assert.equal(
    permitted("editor", "POST", "/api/chat/sessions/x/message"),
    true,
  );
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
