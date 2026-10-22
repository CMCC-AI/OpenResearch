import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkReleaseEvidence } from "./check-release-evidence.mjs";
const revision = "a".repeat(40);
const log = Buffer.from("isolated candidate check completed successfully");
const digest = createHash("sha256").update(log).digest("hex");
const names = ["rust-fmt", "rust-clippy", "rust-tests", "ui-typecheck", "ui-tests", "ui-build", "platform-integration", "browser-login-upload-reconnect", "upgrade-restore"];
const fixture = () => ({ formatVersion: 1, revision, components: Object.fromEntries(["workbench", "platform", "literature"].map(name => [name, { version: "candidate", revision, artifact: name + ".tar", artifactSha256: digest }])), checks: names.map(name => ({ name, revision, exitCode: 0, command: name, sha256: digest, log: name + ".log" })) });
test("release gate binds all services and checks to immutable candidate evidence", async () => {
  const result = await checkReleaseEvidence(fixture(), "/bundle", revision, async () => log);
  assert.equal(result.checks, 9);
});
test("missing, skipped, stale and modified evidence cannot authorize a release", async () => {
  for (const mutate of [e => e.checks.pop(), e => {e.checks[0].skipped = true}, e => {e.checks[0].exitCode = 1}, e => {e.components.platform.revision = "b".repeat(40)}, e => {e.checks[0].log = "../outside"}, e => {e.checks[0].sha256 = "b".repeat(64)}, e => {e.checks.push({ ...e.checks[0] })}, e => {e.checks[0].revision = "b".repeat(40)}, e => {e.components.workbench.artifactSha256 = "b".repeat(64)}, e => {e.components.platform.artifact = "../outside.tar"}]) {
    const evidence = fixture();mutate(evidence);
    await assert.rejects(checkReleaseEvidence(evidence, "/bundle", revision, async () => log));
  }
});
