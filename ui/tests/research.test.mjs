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
  assert.match(researchAttention(value), /成果交付/);
  value.status = "paused";
  assert.equal(researchAttention(value), "研究已暂停 · 可继续");
  assert.equal(researchTaskStatus(value, task("review", "as-independent-reviewer", [], "running")).state, "stopped");
  assert.equal(researchTaskStatus(value, task("review", "as-independent-reviewer", [], "running")).label, "已暂停");
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
  assert.match(researchAttention(value), /研究范围与目标/);
});

test("verdict gating, task approval, and bounded rework surface as task states", async () => {
  const { gateDisplayName } = await import("../src/research.ts");
  assert.equal(gateDisplayName("G5:review"), "任务确认 · review");
  assert.equal(gateDisplayName("G1"), "研究范围与目标");
  const write = task("write", "as-evidence-writer", [], "pending");
  write.reworkCount = 1;
  write.maxRework = 2;
  const review = task("review", "as-independent-reviewer", ["write"], "completed");
  review.verdict = { status: "blocked", reasons: ["缺少对照"], path: "review.md.verdict.json", sha256: "abc" };
  const strategy = task("strategy", "as-literature-strategist", [], "completed");
  strategy.requiresApproval = true;
  const next = task("next", "as-research-synthesizer", ["strategy"]);
  const value = study([write, review, strategy, next], [gate("G1", "approved")]);
  assert.equal(researchTaskStatus(value, review).state, "blocked");
  assert.match(researchTaskStatus(value, review).label, /结论有问题/);
  assert.equal(researchTaskStatus(value, write).state, "running");
  assert.match(researchTaskStatus(value, write).label, /返工修订中 · 第 1 轮/);
  assert.equal(researchTaskStatus(value, strategy).state, "blocked");
  assert.match(researchTaskStatus(value, strategy).label, /等待你批准/);
  assert.match(researchTaskStatus(value, next).label, /等待你确认 文献检索策略专家/);
  value.decisions.push({ id: "g5", gate: "G5:strategy", status: "approved", version: 2, scope: "{}" });
  assert.equal(researchTaskStatus(value, strategy).label, "产物已验收");
  assert.match(researchTaskStatus(value, next).label, /已就绪/);
  // 结论通过后阻塞解除。
  review.verdict = { status: "pass", reasons: [], path: "review.md.verdict.json", sha256: "abc" };
  assert.match(researchTaskStatus(value, review).label, /已验收/);
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

const { researchArtifactLabel, researchOutcome, researchProcessSummary, researchReviewSummary } = await import("../src/research.ts");
test("outcome leads with the research conclusion instead of the gate report", () => {
  const file = (path, bytes = 500) => ({ path, sha256: "x", bytes });
  const draft = { ...task("draft", "as-experiment-designer"), state: "completed", summary: "写了一句结论", artifacts: [file("draft/one-liner.md", 1200)] };
  const review = { ...task("review", "as-independent-reviewer", ["draft"]), state: "completed", reworkCount: 1, verdict: { status: "pass", reasons: [], path: "review/verdict.md.verdict.json", sha256: "x" }, artifacts: [file("review/verdict.md", 300)] };
  const route = { ...task("route", "", ["review"], "completed"), kind: "route" };
  const pass = { ...task("pass", "as-research-synthesizer", ["route"]), state: "completed", summary: "通过报告", artifacts: [file("pass/result.md", 508)] };
  const fallback = { ...task("fallback", "as-research-synthesizer", ["route"], "skipped"), artifacts: [] };
  const value = study([draft, review, route, pass, fallback]);
  const outcome = researchOutcome(value);
  // 验收关的报告是过程记录，不能顶替研究结论。
  assert.equal(outcome.conclusion.artifact.path, "draft/one-liner.md");
  assert.equal(researchArtifactLabel("draft/one-liner.md"), "一句话结论");
  assert.equal(researchArtifactLabel("review/verdict.md"), "复核意见");
  assert.equal(researchArtifactLabel("writing/review.md"), "研究正文");
  assert.deepEqual(outcome.reviews.map((item) => item.artifact.path).sort(), ["pass/result.md", "review/verdict.md"]);
  assert.equal(outcome.counts.reworkRounds, 1);
  assert.equal(outcome.counts.verdict, "pass");
  assert.equal(outcome.counts.skipped, 1);
  assert.equal(researchProcessSummary(value), "实验设计专家 → 独立审稿专家 → 条件分流 → 研究综合专家；另有 1 步未走");
  assert.equal(researchReviewSummary(value), "已通过独立复核；期间退回修订 1 轮。");
});
test("review-only flows keep their review records as the deliverable", () => {
  const review = { ...task("audit", "as-quality-citation-auditor"), state: "completed", artifacts: [{ path: "audit/citations.md", sha256: "x", bytes: 900 }] };
  const outcome = researchOutcome(study([review]));
  assert.equal(outcome.conclusion.artifact.path, "audit/citations.md");
  assert.equal(outcome.reviews.length, 0);
  assert.equal(outcome.deliverables.length, 1);
});
test("the written report outranks the package index for the conclusion slot", () => {
  const writer = { ...task("writing", "as-evidence-writer", ["synthesis"]), state: "completed", artifacts: [{ path: "writing/review.md", sha256: "x", bytes: 20000 }] };
  const curator = { ...task("package", "as-research-package-curator", ["writing"]), state: "completed", artifacts: [{ path: "package/manifest.md", sha256: "x", bytes: 800 }] };
  const outcome = researchOutcome(study([writer, curator]));
  assert.equal(outcome.conclusion.artifact.path, "writing/review.md");
  assert.equal(outcome.conclusion.label, "研究正文");
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
  assert.equal(researchDuration({ ...metrics, activeDurationComplete: false }, 103000), "≥1分05秒");
  assert.equal(researchDuration({ ...metrics, activeDurationComplete: false, running: false }, 999999), "≥1分02秒");
  assert.equal(researchDuration({ ...metrics, activeDurationComplete: true, running: false }, 999999), "1分02秒");
});

test("skipped tasks and route decisions read as plain-language statuses", () => {
  const skipped = { ...task("fix", "as-research-synthesizer", [], "skipped") };
  const status = researchTaskStatus(study([skipped]), skipped);
  assert.equal(status.state, "optional");
  assert.equal(status.label, "已跳过 · 分流未走此分支");
  const routed = { ...task("brancher", "", ["design"], "completed"), kind: "route", routeDecision: { outcome: "matched", basis: "上游结论为 blocked", decidedAt: 1 } };
  const routedStatus = researchTaskStatus(study([routed]), routed);
  assert.equal(routedStatus.state, "completed");
  assert.match(routedStatus.label, /成立/);
  assert.match(routedStatus.label, /blocked/);
  // 跳过的前置不阻塞下游状态判断；全部完成或跳过即视为流程走完。
  const downstream = { ...task("next", "as-research-synthesizer", ["fix"]) };
  const value = study([{ ...skipped }, downstream], [gate("G1", "approved")]);
  assert.equal(researchTaskStatus(value, downstream).state, "waiting");
  assert.deepEqual(researchProgress({ plans: [{ version: 1, tasks: [{ state: "completed" }, { state: "skipped" }, { state: "pending" }] }] }), { completed: 2, total: 3 });
});

test("awaiting human tasks and foreach progress read as plain-language statuses", () => {
  const human = { ...task("confirm", "", [], "awaiting"), kind: "human", brief: "给出评价标准" };
  const status = researchTaskStatus(study([human]), human);
  assert.equal(status.state, "blocked");
  assert.match(status.label, /等你完成/);
  assert.match(status.label, /评价标准/);
  const foreach = { ...task("readings", "", [], "running"), kind: "foreach", foreachItems: [{ id: "a" }, { id: "b" }], foreachRuns: [{ itemId: "a", ok: true }] };
  const foreachStatus = researchTaskStatus(study([foreach]), foreach);
  assert.equal(foreachStatus.state, "running");
  assert.match(foreachStatus.label, /第 2\/2 项/);
  // 总览提示等主理人完成的人工任务。
  const value = study([human, { ...task("next", "as-research-synthesizer", ["confirm"]) }], [gate("G1", "approved")]);
  assert.match(researchAttention(value), /等你完成/);
});

test("artifact body links resolve to registered study artifacts, not dead anchors", async () => {
  const { resolveArtifactLinkPath } = await import("../src/research.ts");
  const paths = new Set(["audit/citations.md", "review/independent.md", "writing/review.md", "package/manifest.md"]);
  // manifest 内的研究根相对链接按字面命中；带 URL 编码或 artifacts/ 前缀的也归一。
  assert.equal(resolveArtifactLinkPath("audit/citations.md", "package/manifest.md", paths), "audit/citations.md");
  assert.equal(resolveArtifactLinkPath("%E5%86%99%E4%BD%9C.md", "package/manifest.md", new Set(["写作.md"])), "写作.md");
  assert.equal(resolveArtifactLinkPath("artifacts/review/independent.md", "package/manifest.md", paths), "review/independent.md");
  // 目录相对链接从当前产物所在目录回退解析。
  assert.equal(resolveArtifactLinkPath("../writing/review.md", "package/manifest.md", paths), "writing/review.md");
  // 未登记或越出研究根的链接返回 null，由调用方保持纯文本。
  assert.equal(resolveArtifactLinkPath("external/notes.md", "package/manifest.md", paths), null);
  assert.equal(resolveArtifactLinkPath("../../outside.md", "package/manifest.md", paths), null);
});
test("approval scope summaries count people, branches and outputs instead of template prose", async () => {
  const { researchScopeSentence, researchScopeControls, researchScopeOutline, isTemplatePlanSummary } = await import("../src/research.ts");
  const tasks = [
    { id: "draft", role: "as-experiment-designer", outputs: ["draft/one-liner.md"] },
    { id: "review", role: "as-independent-reviewer", gateDownstream: true, maxRework: 1, outputs: ["review/verdict.md"] },
    { id: "route", kind: "route", outputs: [] },
    { id: "pass", role: "as-research-synthesizer", outputs: ["pass/result.md"] },
    { id: "fallback", role: "as-research-synthesizer", outputs: ["fallback/result.md"] },
  ];
  assert.equal(researchScopeSentence(tasks, "G1"), "将执行 5 个步骤：3 位专家参与，预计最多 4 份文件。");
  assert.equal(researchScopeControls(tasks), "含 1 处条件分流 · 1 项结论把关（最多返工 1 轮）");
  assert.equal(researchScopeSentence([], "G1"), "");
  assert.equal(researchScopeSentence([{ id: "collect", kind: "human", outputs: ["notes/points.md"] }], "G1"), "将执行 1 个步骤，都由你亲自完成，预计产出 1 份文件。");
  // G4 按已登记产物计数，不把未走分支的声明产物算进去。
  assert.equal(researchScopeSentence([{ id: "package", artifacts: [{ path: "a.md" }, { path: "b.md" }] }], "G4"), "本次交付覆盖 1 个步骤，产出 2 份文件。");
  assert.equal(researchScopeOutline(tasks).outputs.length, 4);
  assert.equal(isTemplatePlanSummary("围绕目标「x」，按「y」流程执行 1 个专家任务，各任务按依赖顺序登记产物。"), true);
  assert.equal(isTemplatePlanSummary("这是主理人写的真实研究边界与停止条件。"), false);
});
