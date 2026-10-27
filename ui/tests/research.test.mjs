import assert from "node:assert/strict";
import test from "node:test";
import { currentDecisions, researchProgress, expertRoles } from "../src/research.ts";

test("only decisions for the current plan are actionable", () => {
  const study = { plans: [{ version: 1 }, { version: 2 }], decisions: [{ id: "old-approved", version: 1, status: "approved" }, { id: "new-pending", version: 2, status: "pending" }] };
  assert.deepEqual(currentDecisions(study).map((d) => d.id), ["new-pending"]);
});
test("task progress counts actual selected tasks, not the 20-role catalog", () => {
  const study = { plans: [{ version: 1, tasks: [{ state: "completed" }, { state: "failed" }, { state: "running" }] }] };
  assert.deepEqual(researchProgress(study), { completed: 1, total: 3 });
  assert.deepEqual(researchProgress({ plans: [] }), { completed: 0, total: 0 });
  assert.equal(Object.keys(expertRoles).length, 20);
});

const { researchAttention, researchWorkflow, researchTaskStatus, researchDagLayout } = await import("../src/research.ts");
function task(id, role, dependsOn = [], state = "pending") {
  return { id, role, dependsOn, state, brief: id, outputs: [`${id}.md`], artifacts: [], runIds: [], sessionId: null, summary: null };
}
function study(tasks = [], decisions = []) {
  return { id: "test", mode: "team", status: "active", plans: tasks.length ? [{ version: 2, tasks }] : [], decisions, claims: [] };
}
function gate(name, status, experiment = null, version = 2) {
  return { id: `${name}-${experiment}`, gate: name, status, version, scope: JSON.stringify({ experimentId: experiment }) };
}
test("overview exposes the full path before tasks exist without inventing task progress", () => {
  const value = study();
  const stages = researchWorkflow(value);
  assert.equal(stages.length, 7);
  assert.equal(stages[0].state, "running");
  assert.equal(stages.filter((stage) => stage.state === "completed").length, 0);
  assert.match(researchAttention(value), /目标与材料/);
});
test("current phase distinguishes independent review, blocking gates, and stopped work", () => {
  const value = study([task("review", "as-independent-reviewer", [], "running")], [gate("G1", "approved"), gate("G4", "pending")]);
  assert.equal(researchWorkflow(value).find((stage) => stage.id === "review").state, "running");
  assert.equal(researchWorkflow(value).find((stage) => stage.id === "delivery").state, "blocked");
  assert.match(researchAttention(value), /G4/);
  value.status = "stopped";
  assert.equal(researchWorkflow(value).find((stage) => stage.id === "review").state, "stopped");
  assert.equal(researchAttention(value), "研究已停止");
});
test("dependency graph preserves parallel branches and out-of-order task declarations", () => {
  const tasks = [task("merge", "as-result-analyst", ["left", "right"]), task("right", "as-experiment-designer", ["root"]), task("root", "as-asset-auditor"), task("left", "as-literature-researcher", ["root"])];
  const nodes = researchDagLayout(tasks);
  const positions = Object.fromEntries(nodes.map((node) => [node.id, node]));
  assert.equal(positions.left.x, positions.right.x);
  assert.notEqual(positions.left.y, positions.right.y);
  assert.ok(positions.root.x < positions.left.x);
  assert.ok(positions.left.x < positions.merge.x);
  assert.equal(researchDagLayout([task("cycle", "as-result-analyst", ["cycle"])]).length, 1);
});
test("task states check their own experiment approval rather than another task's gates", () => {
  const operator = task("run", "as-experiment-operator");
  operator.runContract = { experimentId: "own-exp" };
  const value = study([operator], [gate("G1", "approved"), gate("G2", "approved", "other-exp"), gate("G3", "approved", "other-exp")]);
  assert.equal(researchTaskStatus(value, operator).state, "blocked");
  value.decisions.push(gate("G2", "approved", "own-exp"), gate("G3", "approved", "own-exp"));
  assert.match(researchTaskStatus(value, operator).label, /已就绪/);
  operator.dependsOn = ["unfinished"];
  assert.match(researchTaskStatus(value, operator).label, /前置/);
  operator.state = "completed";
  assert.equal(researchTaskStatus(value, operator).state, "completed");
});
test("plan revision and non-experimental consultations do not inherit obsolete phase completion", () => {
  const value = study([task("design", "as-experiment-designer")], [gate("G4", "approved", null, 1), gate("G1", "pending")]);
  value.mode = "design";
  assert.equal(researchWorkflow(value).find((stage) => stage.id === "approval").state, "optional");
  assert.equal(researchWorkflow(value).find((stage) => stage.id === "delivery").state, "waiting");
  assert.match(researchAttention(value), /G1/);
});


const { consultationModules, consultationCoverage } = await import("../src/research.ts");
test("consultation previews distinguish mandatory review from optional roles without authorizing experiments", () => {
  assert.deepEqual(consultationModules.design.requiredRoles, []);
  assert.deepEqual(consultationModules.diagnosis.requiredRoles, []);
  assert.deepEqual(consultationModules.review.requiredRoles, ["as-independent-reviewer", "as-quality-citation-auditor"]);
  for (const module of [consultationModules.design, consultationModules.diagnosis, consultationModules.review]) {
    const roles = module.steps.flatMap((step) => step.roles);
    assert.equal(module.steps.length, 4);
    assert.ok(roles.every((role) => role in expertRoles));
    assert.ok(!roles.includes("as-experiment-operator"));
    assert.ok(module.requiredRoles.every((role) => roles.includes(role)));
  }
});
test("a preview with no registered plan does not fabricate assignments or dispatches", () => {
  const value = { ...study(), mode: "diagnosis" };
  const coverage = consultationCoverage(value);
  assert.deepEqual(coverage.roles, []);
  assert.equal(coverage.total, 0);
  assert.equal(coverage.dispatched, 0);
  assert.equal(coverage.completed, 0);
  assert.ok(coverage.unselected.includes("as-experiment-diagnostician"));
});
test("actual assignments count repeated roles once and dispatches by bound sessions, including failures", () => {
  const a = task("a", "as-experiment-diagnostician", [], "failed");
  a.sessionId = "real-child-a";
  const b = task("b", "as-experiment-diagnostician");
  const c = task("c", "as-result-analyst", [], "completed");
  c.sessionId = "real-child-c";
  const value = { ...study([a, b, c]), mode: "diagnosis" };
  const coverage = consultationCoverage(value);
  assert.deepEqual(coverage.roles, ["as-experiment-diagnostician", "as-result-analyst"]);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.dispatched, 2);
  assert.equal(coverage.completed, 1);
  assert.ok(!coverage.unselected.includes("as-experiment-diagnostician"));
});
test("module assignment and execution summaries ignore old plan assignments", () => {
  const old = task("old", "as-code-data-engineer", [], "completed");
  old.sessionId = "old-child";
  const value = { ...study([task("current", "as-feasibility-advisor")]), mode: "design" };
  value.plans.unshift({ version: 1, tasks: [old] });
  const coverage = consultationCoverage(value);
  assert.deepEqual(coverage.roles, ["as-feasibility-advisor"]);
  assert.equal(coverage.dispatched, 0);
  assert.equal(coverage.completed, 0);
  assert.ok(coverage.unselected.includes("as-code-data-engineer"));
});


const { researchTeamGraph, researchTeamLevels, researchTeamEdges } = await import("../src/research.ts");
test("CMCC capability panorama includes all 20 experts without inventing executions", () => {
  const graph = researchTeamGraph(null);
  assert.equal(graph.nodes.length, 20);
  assert.deepEqual(new Set(graph.nodes.map((node) => node.role)), new Set(Object.keys(expertRoles)));
  assert.ok(graph.nodes.every((node) => node.state === "optional" && node.label === "能力预览" && node.tasks.length === 0));
  const ranks = new Map(researchTeamLevels.flatMap((level, rank) => level.map((role) => [role, rank])));
  assert.ok(researchTeamEdges.every(([source, target]) => ranks.get(source) <= ranks.get(target)));
  const topologyTasks = researchTeamLevels.flat().map((role) => task(role, role, researchTeamEdges.filter(([, target]) => target === role).map(([source]) => source)));
  const layout = new Map(researchDagLayout(topologyTasks).map((node) => [node.id, node.x]));
  assert.ok(researchTeamEdges.every(([source, target]) => layout.get(source) < layout.get(target)));
});
test("panorama overlays current plan and does not hide repeated role tasks or failures", () => {
  const done = task("main", "as-experiment-operator", [], "completed");
  const running = task("retry", "as-experiment-operator", ["main"], "running");
  const value = study([done, running]);
  const graph = researchTeamGraph(value);
  const operator = graph.nodes.find((node) => node.role === "as-experiment-operator");
  assert.equal(operator.tasks.length, 2);
  assert.equal(operator.state, "running");
  assert.match(operator.label, /1\/2/);
  assert.equal(graph.nodes.find((node) => node.role === "as-intent-router").label, "本次未安排");
  value.status = "stopped";
  assert.equal(researchTeamGraph(value).nodes.find((node) => node.role === "as-experiment-operator").state, "stopped");
});
test("actual DAG preserves task identities and real edges even when a role repeats", () => {
  const value = study([task("a", "as-code-data-engineer"), task("b", "as-code-data-engineer", ["a"]), task("c", "as-result-analyst", ["b"])]);
  const graph = researchTeamGraph(value, true);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["a", "b", "c"]);
  assert.deepEqual(graph.edges, [{ source: "a", target: "b" }, { source: "b", target: "c" }]);
  assert.ok(graph.nodes[0].y < graph.nodes[1].y && graph.nodes[1].y < graph.nodes[2].y);
  assert.equal(researchTeamGraph(null, true).nodes.length, 0);
});

const { researchPresets, presetWorkflowModes, deliveryGate } = await import("../src/research.ts");
test("original preset profiles cover W1–W4 and share execution and delivery rules", () => {
  assert.deepEqual(presetWorkflowModes, ["literature", "reproduction", "analysis", "proposal"]);
  for (const [mode, profile] of Object.entries(researchPresets)) {
    assert.ok(profile.requiredRoles.every((role) => role in expertRoles));
    assert.ok(profile.steps.flatMap((step) => step.roles).every((role) => role in expertRoles));
    assert.equal(deliveryGate(mode), profile.deliveryGate);
    assert.ok(profile.dependencies.every(([a, b]) => profile.requiredRoles.includes(a) && profile.requiredRoles.includes(b)));
    assert.equal(profile.allowsExperiments, mode === "reproduction");
  }
  assert.ok(researchPresets.literature.forbiddenRoles.includes("as-methodology-designer"));
  assert.ok(!researchPresets.proposal.requiredRoles.includes("as-independent-reviewer"));
});
test("W4 G3 means completed plan delivery, not experiment authorization or G4 publication", () => {
  const value = { ...study([task("plan", "as-experiment-designer", [], "completed")], [gate("G1", "approved"), gate("G3", "pending")]), mode: "proposal" };
  assert.equal(researchWorkflow(value).find((s) => s.id === "approval").state, "optional");
  assert.equal(researchWorkflow(value).find((s) => s.id === "delivery").state, "blocked");
  value.decisions[1].status = "approved";
  assert.equal(researchWorkflow(value).find((s) => s.id === "delivery").state, "completed");
  assert.match(researchAttention(value), /方案已确认.*未授权/);
  value.plans.push({ version: 3, tasks: value.plans[0].tasks });
  assert.doesNotMatch(researchAttention(value), /已确认/);
});

test("automatic routing reads the current versioned workflow without changing the team category", () => {
  const value = study([task("design", "as-experiment-designer", [], "completed")], [gate("G1", "approved"), gate("G3", "approved")]);
  value.plans[0].workflow = "proposal";
  assert.equal(value.mode, "team");
  assert.match(researchAttention(value), /方案已确认.*未授权/);
  assert.equal(researchWorkflow(value).find((s) => s.id === "delivery").state, "completed");
  value.plans.push({ version: 3, workflow: "literature", tasks: [] });
  assert.doesNotMatch(researchAttention(value), /方案已确认/);
});

test("research duration advances only during measured active time and keeps unknown history unknown", async () => {
  const { researchDuration } = await import("../src/research.ts");
  const metrics = { activeDurationMs: 62000, measuredAt: 100000, running: true };
  assert.equal(researchDuration(metrics, 103000), "1分05秒");
  assert.equal(researchDuration({ ...metrics, running: false }, 999999), "1分02秒");
  assert.equal(researchDuration({ ...metrics, activeDurationMs: null }, 103000), "—");
  assert.equal(researchDuration(undefined, 103000), "—");
  assert.equal(researchDuration({ ...metrics, activeDurationMs: 3660000, running: false }), "1小时01分");
});
