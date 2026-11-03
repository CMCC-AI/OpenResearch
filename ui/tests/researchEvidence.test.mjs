import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { researchAttention, researchTaskStatus, researchWorkflow } from "../src/research.ts";

const source = readFileSync(new URL("../src/components/ResearchEvidence.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exports = {};
const realRequire = createRequire(import.meta.url);
new Function("require", "exports", code)(id => id === "./MaterialCitationSource" ? { MaterialCitationSource: ({ citation }) => React.createElement("button", null, `查看原文选区：${citation.path}`) } : id === "../readOnlyApi" ? { getReadOnlyApi: () => null } : realRequire(id), exports);
const claim = id => ({ id, text: `statement-${id}`, support: "inference", source: "hypothesis" });
const study = { status: "active", mode: "team", claims: [claim("old"), claim("new")], decisions: [], plans: [] };
const render = value => renderToStaticMarkup(React.createElement(exports.ResearchEvidence, { study: value }));

test("legacy studies show every statement as current and empty studies remain empty", () => {
  const html = render(study);
  assert.match(html, /当前证据声明（2）/);
  assert.doesNotMatch(html, /历史声明|需要主理人/);
  assert.equal(render({ ...study, claims: [] }), "");
});

test("amended statements remain in an explicit audit section with escaped reasons", () => {
  const html = render({ ...study, activeClaimIds: ["new"], evidenceReviewRequired: true, claimChanges: [{ claimId: "old", action: "replaced", replacementId: "new", reason: "<script>bad</script>", revision: 1, actorSessionId: "lead", planVersion: 2 }] });
  const [current, history] = html.split("历史声明（1）");
  assert.match(current, /当前证据声明（1）/);
  assert.match(current, /statement-new/);
  assert.doesNotMatch(current, /statement-old/);
  assert.match(history, /statement-old/);
  assert.match(history, /不参与当前交付/);
  assert.match(history, /已替代/);
  assert.match(history, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /重新独立审查/);
  assert.match(render({ ...study, activeClaimIds: [], claimChanges: study.claims.map(c => ({ claimId: c.id, action: "withdrawn", reason: "撤回", revision: 1 })) }), /当前没有有效声明/);
});

test("stale accepted reviews no longer present the current evidence as reviewed", () => {
  const task = { id: "review", role: "as-independent-reviewer", state: "completed", dependsOn: [], outputs: [], artifacts: [], runIds: [] };
  const amended = { ...study, evidenceReviewRequired: true, staleReviewTaskIds: ["review"], plans: [{ version: 1, tasks: [task] }] };
  assert.match(researchAttention(amended), /证据已修订/);
  assert.equal(researchTaskStatus(amended, task).state, "blocked");
  assert.equal(researchTaskStatus({ ...amended, staleReviewTaskIds: [] }, task).state, "completed");
  assert.equal(researchWorkflow(amended).find(stage => stage.id === "review").state, "blocked");
  assert.equal(researchWorkflow(amended).find(stage => stage.id === "delivery").state, "blocked");
});


test("canonical sources stay accessible for current and retired statements without inventing legacy links", () => {
  const value = { ...study, activeClaimIds: ["new"], claimChanges: [{ claimId: "old", action: "withdrawn", reason: "retired" }], claims: study.claims.map(c => ({ ...c, materialCitation: { readEventId: c.id, path: `资料/${c.id}.txt` } })) };
  const [current, history] = render(value).split("历史声明（1）");
  assert.match(current, /查看原文选区：资料\/new.txt/);
  assert.doesNotMatch(current, /查看原文选区：资料\/old.txt/);
  assert.match(history, /查看原文选区：资料\/old.txt/);
  assert.doesNotMatch(render(study), /查看原文选区/);
});
