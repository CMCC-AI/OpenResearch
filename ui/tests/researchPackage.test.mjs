import assert from "node:assert/strict";
import test from "node:test";
import { researchPackageUrl } from "../src/research.ts";
const study = { id: "study", mode: "team", status: "active", plans: [{ version: 2, tasks: [] }], claims: [], deliverySnapshot: { scopeHash: "confirmed-scope", archive: { bytes: 200, sha256: "archive" } }, decisions: [{ id: "delivery", gate: "G4", version: 2, status: "approved", scopeHash: "confirmed-scope" }] };
test("only the prepared current approved scope exposes a package link", () => {
  assert.equal(researchPackageUrl(study), "/api/research/studies/study/package");
  assert.equal(researchPackageUrl({ ...study, status: "stopped" }), "/api/research/studies/study/package");
  for (const status of ["pending", "rejected", "superseded"]) assert.equal(researchPackageUrl({ ...study, decisions: [{ ...study.decisions[0], status }] }), null);
  assert.equal(researchPackageUrl({ ...study, deliverySnapshot: undefined }), null);
  assert.equal(researchPackageUrl({ ...study, deliverySnapshot: { scopeHash: "old-scope" } }), null);
  assert.equal(researchPackageUrl({ ...study, decisions: [{ ...study.decisions[0], version: 1 }] }), null);
});
test("proposal delivery uses G3 and cannot inherit the ordinary G4 link", () => {
  assert.equal(researchPackageUrl({ ...study, mode: "proposal" }), null);
  assert.equal(researchPackageUrl({ ...study, mode: "proposal", decisions: [{ ...study.decisions[0], gate: "G3" }] }), "/api/research/studies/study/package");
});
