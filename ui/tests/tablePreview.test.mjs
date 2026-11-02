import assert from "node:assert/strict";
import test from "node:test";
import { visibleTableRows } from "../src/tablePreview.ts";

test("numeric preview sorting preserves source text, stable identity and blank placement", () => {
  const rows = [["loss"], ["10"], ["2"], [""], ["2.0"], ["1e-1"]];
  const original = structuredClone(rows);
  const ascending = visibleTableRows(rows, "", { column: 0, descending: false }, true);
  assert.deepEqual(ascending.map((row) => row.index), [5, 2, 4, 1, 3]);
  assert.deepEqual(visibleTableRows(rows, "", { column: 0, descending: true }, true).map((row) => row.index), [1, 2, 4, 5, 3]);
  assert.equal(ascending[2].cells[0], "2.0");
  assert.deepEqual(rows, original);
});

test("filter searches original cells and headerless input keeps its first record", () => {
  const rows = [["来源", "值"], ["中文论文", "1.50"], ["Other", "2"]];
  assert.deepEqual(visibleTableRows(rows, "1.50", null, true).map((row) => row.index), [1]);
  assert.deepEqual(visibleTableRows(rows, "中文", null, true).map((row) => row.index), [1]);
  assert.deepEqual(visibleTableRows(rows, "other", null, true).map((row) => row.index), [2]);
  assert.deepEqual(visibleTableRows(rows, "", null, false).map((row) => row.index), [0, 1, 2]);
  assert.deepEqual(visibleTableRows(rows, "missing", null, false), []);
});
