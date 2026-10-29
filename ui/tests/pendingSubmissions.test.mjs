import assert from "node:assert/strict";
import test from "node:test";
import { createPendingJournal, pendingOwner, pendingScope, pendingKey, rescopePendingSignature, recoveredSettings,
  samePendingComposer, PendingConflictError, beginPendingFlight, hasPendingFlight, subscribePendingFlights } from "../src/pendingSubmissions.ts";

export function pendingFixture() {
  const owner = pendingOwner("https://accounts.example", "user");
  const scope = pendingScope(owner, "/mobilesci", "runtime:database", "project");
  return { owner, scope, key: pendingKey(scope, "session"), id: "original", sessionId: "session", mode: "steer",
    signature: JSON.stringify({ sessionId: "session", workspace: ["workspace", 1, "sessions", "project"], text: "研究说明", settings: { model: null, permissionMode: null, reasoningLevel: null, planMode: false } }),
    composer: { draft: "研究说明", attachments: [], annotations: [{ id: "note", text: "原文" }], workMode: "team" },
    wire: { images: [{ mediaType: "application/pdf", dataBase64: "", materialId: "registered-original" }], options: { model: null, planMode: false }, annotations: [{ text: "原文" }] },
  };
}
function fixture() {
  const rows = new Map();
  const storage = {
    read: async key => rows.get(key),
    put: async row => { if (rows.has(row.key) && rows.get(row.key).id !== row.id) throw new PendingConflictError(); rows.set(row.key, row); },
    remove: async (key, id) => { if (rows.get(key)?.id === id) rows.delete(key); },
    clearOwner: async owner => { for (const [key, value] of rows) if (value.owner === owner) rows.delete(key); },
  };
  return { rows, storage, journal: createPendingJournal(storage), row: pendingFixture() };
}

test("remount and refresh recover the original identity, mode, settings and registered materials", async () => {
  const { storage, journal, row } = fixture();
  await journal.save(row);
  const reloaded = await createPendingJournal(storage).read(row.scope, row.sessionId);
  assert.equal(reloaded.id, "original"); assert.equal(reloaded.mode, "steer");
  assert.deepEqual(reloaded.wire, row.wire);
  const signature = rescopePendingSignature(reloaded.signature, ["workspace", 4, "sessions", "project"]);
  assert.equal(JSON.parse(signature).workspace[1], 4);
  assert.equal(JSON.parse(signature).text, "研究说明");
  assert.equal(recoveredSettings(signature).model, null);
  assert.equal(recoveredSettings(signature).planMode, false);
});

test("account, account service, app base, runtime, project and session isolate pending records", async () => {
  const { journal, row } = fixture(); await journal.save(row);
  for (const scope of [
    pendingScope(pendingOwner("https://accounts.example", "other"), "/mobilesci", "runtime:database", "project"),
    pendingScope(pendingOwner("https://other.example", "user"), "/mobilesci", "runtime:database", "project"),
    pendingScope(row.owner, "", "runtime:database", "project"), pendingScope(row.owner, "/mobilesci", "other-runtime", "project"),
    pendingScope(row.owner, "/mobilesci", "runtime:database", "other-project"),
  ]) assert.equal(await journal.read(scope, row.sessionId), null);
  assert.equal(await journal.read(row.scope, "other-session"), null);
});

test("an unresolved request cannot be replaced, and an old response cannot delete its successor", async () => {
  const { journal, row } = fixture(); await journal.save(row);
  await assert.rejects(journal.save({ ...row, id: "new" }), PendingConflictError);
  assert.equal((await journal.read(row.scope, row.sessionId)).id, "original");
  await journal.remove(row.scope, row.sessionId, row.id);
  await journal.save({ ...row, id: "new" });
  await journal.remove(row.scope, row.sessionId, row.id);
  assert.equal((await journal.read(row.scope, row.sessionId)).id, "new");
});

test("logout removes the actor's records without deleting another actor's work", async () => {
  const { journal, row } = fixture(); await journal.save(row);
  const owner = pendingOwner("https://accounts.example", "other");
  const scope = pendingScope(owner, "", "runtime", "project");
  await journal.save({ ...row, owner, scope, key: pendingKey(scope, row.sessionId) });
  await journal.clearOwner(row.owner);
  assert.equal(await journal.read(row.scope, row.sessionId), null);
  assert.ok(await journal.read(scope, row.sessionId));
});

test("malformed records cannot restore composer state or cross the owner boundary", async () => {
  const { journal, rows, row } = fixture();
  for (const bad of [{ ...row, owner: "other" }, { ...row, signature: "{" }, { ...row, mode: "automatic" },
    { ...row, signature: JSON.stringify({ sessionId: "other", workspace: [], text: "" }) },
    { ...row, composer: { ...row.composer, annotations: [{ id: "a", text: 1 }] } }, { ...row, wire: null }]) {
    rows.set(row.key, bad); await assert.rejects(journal.read(row.scope, row.sessionId), /记录无效/);
  }
});

test("composer comparison preserves edits and strips detached DOM ranges on restoration", async () => {
  const { journal, row } = fixture();
  row.composer.annotations[0].range = { detached: true };
  await journal.save(row);
  const restored = await journal.read(row.scope, row.sessionId);
  assert.equal(restored.composer.annotations[0].range, undefined);
  assert.ok(samePendingComposer(restored.composer, row.composer));
  assert.equal(samePendingComposer(restored.composer, { ...row.composer, draft: "新的编辑" }), false);
  assert.equal(samePendingComposer(restored.composer, { ...row.composer, attachments: [{ dataUrl: "data:,different", mediaType: "text/plain", size: 9 }] }), false);
});

test("live sends survive route changes and stale flight finalizers cannot retire a new send", () => {
  const key = pendingKey("scope", "session"); let changes = 0;
  const unsubscribe = subscribePendingFlights(changed => { assert.equal(changed, key); changes++; });
  const first = beginPendingFlight(key, "first");
  assert.ok(hasPendingFlight(key));
  assert.throws(() => beginPendingFlight(key, "second"), PendingConflictError);
  first(); const second = beginPendingFlight(key, "second"); first();
  assert.ok(hasPendingFlight(key)); assert.equal(changes, 1);
  second(); assert.equal(hasPendingFlight(key), false); assert.equal(changes, 2);
  unsubscribe();
});
