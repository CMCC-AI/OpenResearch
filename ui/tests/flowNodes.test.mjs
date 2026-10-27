import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { reconcileFlowNodes } from "../src/flowNodes.ts";

const require = createRequire(import.meta.url);
const { applyNodeChanges } = require("@xyflow/react");
const { adoptUserNodes, nodeHasDimensions } = createRequire(require.resolve("@xyflow/react"))("@xyflow/system");
const node = (id = "expert", label = "执行中") => ({ id, type: "expert", position: { x: 100, y: 200 }, data: { label } });
const measure = (nodes) => applyNodeChanges(nodes.map(({ id }) => ({ id, type: "dimensions", dimensions: { width: 224, height: 48 } })), nodes);

function adopt(nodes, lookup = new Map()) {
  adoptUserNodes(nodes, lookup, new Map(), { checkEquality: true });
  return lookup;
}

test("polling no longer hides measured nodes in the installed React Flow renderer", () => {
  let current = measure([node()]);
  const lookup = adopt(current);
  const handleBounds = { source: [], target: [] };
  lookup.get("expert").internals.handleBounds = handleBounds;
  // Replacing a controlled node without its measurement is the disappearing-DAG regression.
  const broken = adopt([node("expert", "已验收")]);
  assert.equal(nodeHasDimensions(broken.get("expert")), false);
  for (let tick = 0; tick < 20; tick++) {
    current = reconcileFlowNodes(current, [node("expert", `状态刷新 ${tick}`)]);
    adopt(current, lookup);
    assert.equal(nodeHasDimensions(lookup.get("expert")), true);
    assert.equal(lookup.get("expert").internals.handleBounds, handleBounds);
    assert.equal(lookup.get("expert").data.label, `状态刷新 ${tick}`);
  }
});

test("selection and layout updates retain dimensions while using fresh domain state", () => {
  const current = measure([node()]);
  const incoming = [{ ...node(), selected: true, position: { x: -280, y: 0 } }];
  const updated = reconcileFlowNodes(current, incoming);
  assert.deepEqual(updated[0].measured, { width: 224, height: 48 });
  assert.equal(updated[0].selected, true);
  assert.deepEqual(updated[0].position, { x: -280, y: 0 });
  assert.equal(incoming[0].measured, undefined);
});

test("new, removed, and changed-type nodes cannot inherit unrelated measurements", () => {
  const current = measure([node("keep"), node("removed"), node("changed")]);
  const incoming = [node("keep"), node("new"), { ...node("changed"), type: "other" }];
  const updated = reconcileFlowNodes(current, incoming);
  assert.deepEqual(updated.map(({ id }) => id), ["keep", "new", "changed"]);
  assert.ok(updated[0].measured);
  assert.equal(updated[1].measured, undefined);
  assert.equal(updated[2].measured, undefined);
  const explicit = { ...node("keep"), measured: { width: 300, height: 60 } };
  assert.deepEqual(reconcileFlowNodes(current, [explicit])[0].measured, explicit.measured);
});
