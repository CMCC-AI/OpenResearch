import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_FILTERS,
  skillMatchesFilter,
  skillMatchesQuery,
  skillNameError,
  skillScopeSummary,
  skillSummary,
  skillTitle,
  skillUsage,
  skillUsageLabel,
} from "../src/workflow/skillLibrary.ts";

const builtin = { name: "orx-lit-review", description: "Explain concepts using original research evidence.", source: "builtin" };
const mine = { name: "my-lab", description: "整理实验记录：每次跑完自动归档。", source: "user" };
const blank = { name: "blank-skill", description: null, source: "user" };

test("内置技能用中文展示名，用户技能用自己的用途说明", () => {
  assert.equal(skillTitle(builtin), "文献证据");
  assert.equal(skillTitle(mine), "my-lab");
  assert.match(skillSummary(builtin), /原始文献/);
  assert.equal(skillSummary(blank), "还没有用途说明");
  assert.equal(skillSummary({ ...blank, origin: "Claude Code" }), "来自 Claude Code 的镜像技能");
});

test("搜索覆盖名称、展示名和用途；筛选区分我的与内置", () => {
  assert.ok(skillMatchesQuery(builtin, "文献"));
  assert.ok(skillMatchesQuery(builtin, "orx-lit"));
  assert.ok(skillMatchesQuery(mine, "实验记录"));
  assert.ok(skillMatchesQuery(mine, "  "));
  assert.ok(!skillMatchesQuery(mine, "图表"));
  assert.equal(SOURCE_FILTERS.length, 3);
  assert.ok(skillMatchesFilter(mine, "mine"));
  assert.ok(!skillMatchesFilter(mine, "builtin"));
  assert.ok(skillMatchesFilter(builtin, "builtin"));
  assert.ok(skillMatchesFilter(builtin, "all"));
});

test("生效状态只有内置/全局/自动携带/按需四种", () => {
  assert.deepEqual(skillUsage(builtin), { kind: "builtin" });
  assert.equal(skillUsageLabel(skillUsage(builtin)), "内置");
  assert.deepEqual(skillUsage({ ...mine, legacyGlobal: true }), { kind: "legacy" });
  assert.equal(skillUsageLabel(skillUsage({ ...mine, legacyGlobal: true })), "全局生效");
  assert.deepEqual(skillUsage({ ...mine, boundProjects: ["p1"], boundAgents: [] }), { kind: "bound", projects: 1, agents: 0 });
  assert.equal(skillUsageLabel(skillUsage({ ...mine, boundProjects: ["p1"], boundAgents: ["a1"] })), "自动携带");
  assert.deepEqual(skillUsage(mine), { kind: "on-demand" });
  assert.equal(skillUsageLabel(skillUsage(mine)), "按需使用");
  assert.match(skillScopeSummary("my-lab", skillUsage({ ...mine, boundProjects: ["p1"], boundAgents: ["a1"] })), /1 个项目、1 个专家/);
  assert.match(skillScopeSummary("my-lab", skillUsage(mine)), /\/my-lab/);
});

test("名称校验与服务端一致：slug、保留前缀、重名", () => {
  assert.match(skillNameError("", [], []), /起个名字/);
  assert.match(skillNameError("Bad Name", [], []), /小写字母/);
  assert.match(skillNameError("a--b", [], []), /小写字母/);
  assert.match(skillNameError("orx-paper", [], []), /保留/);
  assert.match(skillNameError("orx-paper", [], ["orx-paper"]), /保留/);
  assert.match(skillNameError("my-lab", ["my-lab"], []), /同名/);
  assert.equal(skillNameError("lit-gap-analysis", ["other"], ["orx-paper"]), null);
});
