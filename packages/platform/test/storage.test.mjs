import test from "node:test";
import assert from "node:assert/strict";
import { storageAccess, storageSettings } from "../src/storage.mjs";

test("only system administrators can inspect a shared server's storage", async () => {
  const shared = { researchOwnerEmail: "owner@test.invalid" };
  const forbiddenFetch = () => {
    throw Error("Should not contact the backend");
  };
  for (const config of [
    {},
    { managed: true },
    { privateSpaces: true },
    shared,
  ]) {
    const result = await storageSettings(
      config,
      { is_admin: false },
      forbiddenFetch,
    );
    assert.equal(result.canInspect, false);
    assert.ok(!("current" in result));
    assert.equal(result.readOnly, true);
  }
  assert.equal(storageAccess(shared, { is_admin: true }).canInspect, true);
  assert.equal(
    storageAccess(shared, { is_admin: true }, true).canInspect,
    false,
  );
  assert.equal(
    storageAccess({ privateSpaces: true }, { is_admin: true }).canInspect,
    false,
  );
});

test("administrator inspection is fixed to loopback and exposes only approved fields", async () => {
  const result = await storageSettings(
    { researchOwnerEmail: "owner@test.invalid" },
    { is_admin: true },
    async (url, options) => {
      assert.equal(url, "http://127.0.0.1:4791/api/settings/data-dir");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined);
      return Response.json({
        current: "/server/research",
        source: "env",
        defaultPath: "/private/home",
        secret: "never exposed",
      });
    },
  );
  assert.deepEqual(result, {
    managed: true,
    canInspect: true,
    readOnly: true,
    current: "/server/research",
    source: "env",
  });
});

test("upstream errors and redirects do not leak HTML or internal error details", async () => {
  for (const response of [
    new Response("<html>nginx</html>", { status: 404 }),
    Response.json({ current: 42, source: "env" }),
    new Response("<html>nginx</html>", {
      headers: { "content-type": "text/html" },
    }),
  ]) {
    await assert.rejects(
      storageSettings(
        { researchOwnerEmail: "owner@test.invalid" },
        { is_admin: true },
        async () => response,
      ),
      (error) => error.status === 502 && !error.message.includes("nginx"),
    );
  }
});
