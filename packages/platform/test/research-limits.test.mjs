import test from "node:test";
import assert from "node:assert/strict";
import { researchLimit } from "../src/research-limits.mjs";

test("activity floods cannot exhaust session reads or human decision writes", () => {
  const activity = researchLimit("GET", "/api/projects/activity");
  const sessions = researchLimit("GET", "/api/chat/sessions");
  const decision = researchLimit(
    "POST",
    "/api/research/studies/study/decisions/gate",
  );
  assert.equal(
    new Set([activity.bucket, sessions.bucket, decision.bucket]).size,
    3,
  );
  assert.equal(activity.maximum, 120);
  assert.equal(sessions.maximum, 600);
  assert.equal(decision.maximum, 600);
  assert.deepEqual(
    researchLimit("GET", "/api/research/sessions/lead"),
    sessions,
  );
  assert.deepEqual(
    researchLimit("HEAD", "/api/projects/p/files/file"),
    sessions,
  );
});
