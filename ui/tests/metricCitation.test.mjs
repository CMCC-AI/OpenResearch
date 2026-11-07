import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseMetricCitation } from "../src/metricCitation.ts";
const fixture = () => ({ selection: { evidenceId: "00000000-0000-4000-8000-000000000001", name: "accuracy", split: "validation", step: 0 }, snapshotSha256: "a".repeat(64), reportSha256: "b".repeat(64), sourceSha256: "c".repeat(64), commitSha: "d".repeat(40), runId: "run", experimentId: "exp", producerVersion: "synthetic-fixture", measuredAt: 1, registeredAt: 2, unit: "1", value: 0.9 });
const require = createRequire(import.meta.url), exported = {};
const source = readFileSync(new URL("../src/components/MetricCitationSource.tsx", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(id => id === "../metricCitation" ? { parseMetricCitation } : require(id), exported);
const render = citation => renderToStaticMarkup(React.createElement(exported.MetricCitationSource, { citation }));
test("metric citations show a fixed point and identity without normalizing units or fetching live data", () => {
  const original = globalThis.fetch;let calls = 0;
  globalThis.fetch = () => { calls++;throw Error("private fallback forbidden"); };
  try {
    const c = fixture();assert.deepEqual(parseMetricCitation(c),c);
    let html = render(c);assert.match(html,/accuracy · validation · step 0/);assert.match(html,/登记值：0.9 · 单位：1/);
    assert.ok(html.includes(c.snapshotSha256));assert.ok(html.includes(c.selection.evidenceId));assert.match(html,/历史核验记录/);assert.match(html,/不证明运行时/);
    c.value = 0;c.unit = "%";html = render(c);assert.match(html,/登记值：0 · 单位：%/);assert.equal(calls,0);
  } finally { globalThis.fetch = original; }
});
test("malformed historical citations fail visibly rather than rendering invented zeros or timestamps", () => {
  for (const [key,value] of [["value",null],["value","0.9"],["value",NaN],["value",Infinity],["snapshotSha256","bad"],["commitSha","abc"],["unit",""],["sourceSha256",null],["producerVersion","\n"],["measuredAt",9e15],["registeredAt",-1],["selection",{}]]) {
    const bad = {...fixture(),[key]:value};assert.equal(parseMetricCitation(bad),null,key);assert.match(render(bad),/信息不完整/);assert.doesNotMatch(render(bad),/登记值：/);
  }
  for (const step of [-1,0.1,Number.MAX_SAFE_INTEGER+1]) assert.equal(parseMetricCitation({...fixture(),selection:{...fixture().selection,step}}),null);
  const c=fixture();c.selection.name="<script>alert(1)</script>";assert.ok(!render(c).includes("<script>"));
});
