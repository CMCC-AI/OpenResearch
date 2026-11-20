import assert from "node:assert/strict";
import test from "node:test";
import { searchWorkflows } from "../src/workflow/model.ts";

const draft = (id, name, briefs = []) => ({ id, name, tasks: briefs.map((brief, index) => ({ id: `t${index}`, role: "writer", brief, dependsOn: [], outputs: [] })) });
const library = [
  draft("a", "文献综述", ["按检索策略执行文献发现"]),
  draft("b", "复现流程", ["跑通论文实验"]),
  draft("c", "数据分析", ["整理文献表格与图表"]),
  draft("d", "RNA Seq Pipeline"),
];

test("an empty or blank keyword returns the full list", () => {
  assert.deepEqual(searchWorkflows(library, "").map((entry) => entry.id), ["a", "b", "c", "d"]);
  assert.deepEqual(searchWorkflows(library, "   ").map((entry) => entry.id), ["a", "b", "c", "d"]);
});
test("search matches workflow names and task briefs, case-insensitively", () => {
  // 「文献」同时命中名称（a）与任务说明（c）。
  assert.deepEqual(searchWorkflows(library, "文献").map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(searchWorkflows(library, "综述").map((entry) => entry.id), ["a"]);
  assert.deepEqual(searchWorkflows(library, "实验").map((entry) => entry.id), ["b"]);
  assert.deepEqual(searchWorkflows(library, "rna").map((entry) => entry.id), ["d"]);
  assert.deepEqual(searchWorkflows(library, "不存在").map((entry) => entry.id), []);
});
