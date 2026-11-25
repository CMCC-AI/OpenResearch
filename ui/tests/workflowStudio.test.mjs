import assert from "node:assert/strict";
import test from "node:test";
import { addAgentTask, addExperimentTask, addForeachTask, addHumanTask, addRouteTask, addWaitTask, addWorkflowFrame, connectWorkflowTasks, createBlankDraft, createLiteratureDraft, reconnectWorkflowTasks, removeWorkflowFrame, removeWorkflowTask, updateWorkflowFrame, validateWorkflowDraft } from "../src/workflow/model.ts";
import { parseDestination } from "../src/workspaceState.ts";

function agentsFor(draft) {
  return draft.tasks.map((task) => ({ id: task.role, name: task.role, description: "", prompt: "", version: 0, builtIn: true, createdAt: 0, updatedAt: 0 }));
}

test("W1 template compiles into a valid complete expert DAG; the goal is a run input, not draft content", () => {
  const draft = createLiteratureDraft();
  assert.equal(draft.tasks.length, 9);
  assert.deepEqual(draft.tasks[1].dependsOn, [draft.tasks[0].id]);
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  assert.equal(draft.objective, "");
  assert.equal(draft.summary, "");
});

test("new workflows start from a blank canvas and the first added task lands at the grid origin", () => {
  const draft = createBlankDraft();
  // 自动保存下新草稿带默认名，可随时落库；研究负责人改名直接覆盖。
  assert.equal(draft.name, "未命名工作流");
  assert.deepEqual(draft.tasks, []);
  assert.deepEqual(draft.positions, {});
  const withTask = addAgentTask(draft, { id: "agent-solo", name: "Solo analyst", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 });
  assert.deepEqual(withTask.positions["task-1"], { x: 0, y: 0 });
  assert.deepEqual(validateWorkflowDraft(withTask, agentsFor(withTask)), []);
});

test("a dropped task takes the drop point; without one the next task still stacks below", () => {
  const draft = createBlankDraft();
  const solo = { id: "agent-solo", name: "Solo analyst", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
  const reviewer = { id: "agent-review", name: "Reviewer", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
  const placed = addAgentTask(draft, solo, { x: 320, y: 96 });
  assert.deepEqual(placed.positions["task-1"], { x: 320, y: 96 });
  // 拖放落点直接决定位置；缺省时仍按 x=0 纵向堆叠到现有最高节点下方。
  const stacked = addAgentTask(placed, reviewer);
  assert.deepEqual(stacked.positions["task-2"], { x: 0, y: 476 });
  assert.deepEqual(validateWorkflowDraft(stacked, agentsFor(stacked)), []);
});

test("canvas connections reject cycles and preserve parallel dependencies", () => {
  const draft = createLiteratureDraft();
  assert.throws(() => connectWorkflowTasks(draft, draft.tasks[2].id, draft.tasks[0].id), /循环/);
  const parallel = addAgentTask(draft, { id: "agent-custom", name: "Custom reviewer", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 });
  const connected = connectWorkflowTasks(parallel, draft.tasks[0].id, "task-10");
  assert.deepEqual(connected.tasks.at(-1).dependsOn, [draft.tasks[0].id]);
  assert.throws(() => connectWorkflowTasks(connected, "task-10", draft.tasks[0].id), /循环/);
});

test("dragging an edge endpoint reroutes it; swapping direction does not read as a cycle", () => {
  const draft = createLiteratureDraft();
  const [first, second, third] = draft.tasks.map((task) => task.id);
  assert.deepEqual(draft.tasks.find((task) => task.id === second).dependsOn, [first]);
  // 换下游：first→second 改接 first→third，second 不再依赖 first。
  const retargeted = reconnectWorkflowTasks(draft, { source: first, target: second }, first, third);
  assert.ok(retargeted.tasks.find((task) => task.id === third).dependsOn.includes(first));
  assert.deepEqual(retargeted.tasks.find((task) => task.id === second).dependsOn, []);
  // 换向：first→second 改成 second→first；先拆旧线再查循环，不允许误报。
  const swapped = reconnectWorkflowTasks(draft, { source: first, target: second }, second, first);
  assert.deepEqual(swapped.tasks.find((task) => task.id === first).dependsOn, [second]);
  assert.deepEqual(swapped.tasks.find((task) => task.id === second).dependsOn, []);
  // 端点没动：原样返回，不产生写入。
  assert.equal(reconnectWorkflowTasks(draft, { source: first, target: second }, first, second), draft);
  // 会成环的改接仍然拦截：second→third 改接到 second→first。
  assert.throws(() => reconnectWorkflowTasks(draft, { source: second, target: third }, second, first), /循环/);
  // 系统环节不是专家任务：改接到系统节点同样拒绝。
  assert.throws(() => reconnectWorkflowTasks(draft, { source: first, target: second }, ":system:G1", second), /不存在/);
});

test("removing a node removes incoming and outgoing edges without changing other tasks", () => {
  const draft = createLiteratureDraft();
  const removed = removeWorkflowTask(draft, draft.tasks[1].id);
  assert.ok(!removed.tasks.some((task) => task.id === draft.tasks[1].id));
  assert.deepEqual(removed.tasks[1].dependsOn, []);
  assert.equal(removed.positions[draft.tasks[1].id], undefined);
  // 画布草稿是自定义编排：删掉模板节点后结构仍合法，不做预设名册检查。
  assert.deepEqual(validateWorkflowDraft(removed, agentsFor(removed)), []);
});

test("workflow routes work at root and under the MobileSci prefix without reopening hidden skills", () => {
  assert.deepEqual(parseDestination("/projects/project/workflows"), { kind: "workflows", projectId: "project" });
  assert.deepEqual(parseDestination("/mobilesci/projects/project/workflows"), { kind: "workflows", projectId: "project" });
  assert.equal(parseDestination("/projects/project/skills"), null);
  // 成果页已下线：目的地解析不再认领该路径，旧地址由路由层重定向回项目会话。
  assert.equal(parseDestination("/projects/project/deliverables"), null);
});

test("W1 template enables task approval and verdict gating by default", () => {
  const draft = createLiteratureDraft();
  assert.equal(draft.tasks.find((task) => task.id === "search-strategy").requiresApproval, true);
  const review = draft.tasks.find((task) => task.id === "independent-review");
  assert.equal(review.gateDownstream, true);
  assert.equal(review.maxRework, 2);
  assert.equal(draft.tasks.find((task) => task.id === "citation-audit").gateDownstream, true);
});

test("drafts allow arbitrary expert subsets as custom compositions", () => {
  const draft = createLiteratureDraft();
  // 只留检索策略与文献发现：不需要补齐任何预设名册即可使用。
  const trimmed = { ...draft, tasks: draft.tasks.slice(0, 2) };
  assert.deepEqual(validateWorkflowDraft(trimmed, agentsFor(trimmed)), []);
});

test("input bindings and rework limits are validated against direct dependencies", () => {
  const draft = createLiteratureDraft();
  const write = draft.tasks.find((task) => task.id === "review-writing");
  // review-writing 的直接前置是 review-outline，其产物 outline/outline.md 是合法输入。
  write.inputs = ["outline/outline.md"];
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  write.inputs = ["synthesis/themes.md"];
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("synthesis/themes.md 不是直接前置任务的产物")));
  write.inputs = [];
  const review = draft.tasks.find((task) => task.id === "independent-review");
  review.gateDownstream = false;
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("设了自动返工") && error.includes("结论把关")));
  review.gateDownstream = true;
  review.maxRework = 4;
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("返工上限要在 0–3 之间")));
});

// —— 条件分流、汇合与阶段分组（批次一）——

const gateAgent = { id: "agent-gate", name: "Gate keeper", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
const fixAgent = { id: "agent-fix", name: "Fixer", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };
const keepAgent = { id: "agent-keep", name: "Keeper", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };

function routedDraft() {
  let draft = createBlankDraft();
  draft = addAgentTask(draft, gateAgent);
  draft = addAgentTask(draft, keepAgent);
  // 把关任务不能是根节点：task-1 → task-2（结论把关）→ route → 两条分支。
  draft = connectWorkflowTasks(draft, "task-1", "task-2");
  draft.tasks[1].gateDownstream = true;
  draft.tasks[1].outputs = ["design.md"];
  draft = addRouteTask(draft);
  const routeId = draft.tasks.at(-1).id;
  draft = connectWorkflowTasks(draft, "task-2", routeId);
  draft = addAgentTask(draft, fixAgent);
  draft = addAgentTask(draft, keepAgent);
  // 从分流节点连出的两条线：第一条自动标「成立」，第二条标「不成立」。
  draft = connectWorkflowTasks(draft, routeId, "task-4");
  draft = connectWorkflowTasks(draft, routeId, "task-5");
  draft = { ...draft, tasks: draft.tasks.map((task) => task.kind === "route" ? { ...task, route: { on: "verdict", source: "design.md", verdictIs: "blocked" } } : task) };
  return draft;
}

test("route nodes label the first outgoing branch then, the second else", () => {
  const draft = routedDraft();
  assert.equal(draft.tasks.find((task) => task.id === "task-4").routeBranch, "then");
  assert.equal(draft.tasks.find((task) => task.id === "task-5").routeBranch, "else");
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
});

test("route drafts refuse to save without both branches or a gated source", () => {
  const draft = routedDraft();
  // 拆掉「不成立」分支：两条分支都必须有后续任务。
  const missingElse = removeWorkflowTask(draft, "task-4");
  assert.ok(validateWorkflowDraft(missingElse, agentsFor(missingElse)).some((message) => message.includes("两条出路")));
  // 来源任务没开结论把关：分流没有可读取的结论。
  const ungated = { ...draft, tasks: draft.tasks.map((task) => task.id === "task-2" ? { ...task, gateDownstream: false } : task) };
  assert.ok(validateWorkflowDraft(ungated, agentsFor(ungated)).some((message) => message.includes("结论把关")));
  // 来源产物不属于任何前置任务：先连线再选结论。
  const foreign = { ...draft, tasks: draft.tasks.map((task) => task.kind === "route" ? { ...task, route: { on: "verdict", source: "other.md", verdictIs: "pass" } } : task) };
  assert.ok(validateWorkflowDraft(foreign, agentsFor(foreign)).some((message) => message.includes("结论还没有来源")));
  // 分流节点不产出文件。
  const withOutputs = { ...draft, tasks: draft.tasks.map((task) => task.kind === "route" ? { ...task, outputs: ["route.md"] } : task) };
  assert.ok(validateWorkflowDraft(withOutputs, agentsFor(withOutputs)).some((message) => message.includes("不产出文件")));
});

test("removing a route node clears stale branch labels on its children", () => {
  const draft = routedDraft();
  const removed = removeWorkflowTask(draft, draft.tasks.find((task) => task.kind === "route").id);
  assert.equal(removed.tasks.find((task) => task.id === "task-4").routeBranch, undefined);
  assert.equal(removed.tasks.find((task) => task.id === "task-5").routeBranch, undefined);
});

test("route fallback branch accepts then and else, rejects other values", () => {
  const draft = routedDraft();
  const rewrite = (defaultBranch) => ({ ...draft, tasks: draft.tasks.map((task) => task.kind === "route" ? { ...task, route: { ...task.route, defaultBranch } } : task) });
  const withThen = rewrite("then");
  assert.deepEqual(validateWorkflowDraft(withThen, agentsFor(withThen)), []);
  const withElse = rewrite("else");
  assert.deepEqual(validateWorkflowDraft(withElse, agentsFor(withElse)), []);
  const invalid = rewrite("both");
  assert.ok(validateWorkflowDraft(invalid, agentsFor(invalid)).some((message) => message.includes("兜底分支无效")));
});

test("join-any strategy needs at least two incoming connections", () => {
  let draft = createBlankDraft();
  draft = addAgentTask(draft, gateAgent);
  draft = addAgentTask(draft, fixAgent);
  draft = { ...draft, tasks: draft.tasks.map((task) => task.id === "task-2" ? { ...task, dependsOn: ["task-1"], waitFor: "any" } : task) };
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((message) => message.includes("只连了一个前置")));
  draft = { ...draft, tasks: draft.tasks.map((task) => task.id === "task-2" ? { ...task, dependsOn: ["task-1"], waitFor: undefined } : task) };
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
});

test("stage frames save, rename and enforce the cap", () => {
  let draft = createBlankDraft();
  draft = addAgentTask(draft, gateAgent);
  draft = addWorkflowFrame(draft, { id: "stage-1", title: "检索", x: 0, y: 0, width: 480, height: 360 });
  draft = updateWorkflowFrame(draft, "stage-1", { title: "检索与筛选" });
  assert.equal(draft.frames.at(-1).title, "检索与筛选");
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  for (let index = 2; index <= 13; index += 1) {
    draft = addWorkflowFrame(draft, { id: `stage-${index}`, title: `阶段 ${index}`, x: 0, y: 0, width: 480, height: 360 });
  }
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((message) => message.includes("阶段分组最多 12 个")));
  draft = removeWorkflowFrame(draft, "stage-13");
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  draft = removeWorkflowFrame(draft, "stage-12");
  assert.equal(draft.frames.length, 11);
});

// —— 逐项处理 foreach 与人工任务 human（批次二）——

const loopAgent = { id: "agent-loop", name: "Lister", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 };

function foreachDraft(source) {
  let draft = createBlankDraft();
  draft = addAgentTask(draft, loopAgent);
  draft.tasks[0].outputs = ["papers.md"];
  draft = addForeachTask(draft);
  const foreachId = draft.tasks.at(-1).id;
  draft = connectWorkflowTasks(draft, "task-1", foreachId);
  draft = { ...draft, tasks: draft.tasks.map((task) => task.kind === "foreach" ? { ...task, forEach: { ...task.forEach, source } } : task) };
  return draft;
}

test("foreach nodes validate list source, item template and failure policy", () => {
  const draft = foreachDraft("papers.md");
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  // 来源不是任何前置任务的产物。
  const foreign = foreachDraft("other.md");
  assert.ok(validateWorkflowDraft(foreign, agentsFor(foreign)).some((message) => message.includes("列表来源")));
  // 模板缺 {item} 占位。
  const noPlaceholder = foreachDraft("papers.md");
  noPlaceholder.tasks.find((task) => task.kind === "foreach").forEach.itemOutput = "readings/all.md";
  assert.ok(validateWorkflowDraft(noPlaceholder, agentsFor(noPlaceholder)).some((message) => message.includes("{item}")));
  // 模板路径越界。
  const escaping = foreachDraft("papers.md");
  escaping.tasks.find((task) => task.kind === "foreach").forEach.itemOutput = "../readings/{item}.md";
  assert.ok(validateWorkflowDraft(escaping, agentsFor(escaping)).some((message) => message.includes("相对路径")));
  // 逐项任务不产出文件。
  const withOutputs = foreachDraft("papers.md");
  withOutputs.tasks.find((task) => task.kind === "foreach").outputs = ["all.md"];
  assert.ok(validateWorkflowDraft(withOutputs, agentsFor(withOutputs)).some((message) => message.includes("不直接写产物")));
});

test("human nodes require exactly one output and refuse approval overlays", () => {
  let draft = createBlankDraft();
  draft = addHumanTask(draft);
  const human = draft.tasks.at(-1);
  assert.equal(human.outputs.length, 1);
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  const twoOutputs = { ...draft, tasks: draft.tasks.map((task) => task.kind === "human" ? { ...task, outputs: ["a.md", "b.md"] } : task) };
  assert.ok(validateWorkflowDraft(twoOutputs, agentsFor(twoOutputs)).some((message) => message.includes("只能填一个路径")));
  const withApproval = { ...draft, tasks: draft.tasks.map((task) => task.kind === "human" ? { ...task, requiresApproval: true } : task) };
  assert.ok(validateWorkflowDraft(withApproval, agentsFor(withApproval)).some((message) => message.includes("提交就算完成")));
});

// —— 实验节点 experiment 与事件等待 wait（批次三）——

test("experiment nodes declare outputs and refuse approval overlays", () => {
  let draft = createBlankDraft();
  draft = addExperimentTask(draft);
  const exp = draft.tasks.at(-1);
  assert.equal(exp.outputs.length, 1);
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  const noOutputs = { ...draft, tasks: draft.tasks.map((task) => task.kind === "experiment" ? { ...task, outputs: [] } : task) };
  assert.ok(validateWorkflowDraft(noOutputs, agentsFor(noOutputs)).some((message) => message.includes("1–30 个产物路径")));
  const withApproval = { ...draft, tasks: draft.tasks.map((task) => task.kind === "experiment" ? { ...task, requiresApproval: true } : task) };
  assert.ok(validateWorkflowDraft(withApproval, agentsFor(withApproval)).some((message) => message.includes("开跑前你已经确认过一次")));
});

test("wait nodes need a safe source path and bounded timeout", () => {
  let draft = createBlankDraft();
  draft = addWaitTask(draft);
  const wait = draft.tasks.at(-1);
  // 新建节点还没有等待路径：保存前必须补上。
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((message) => message.includes("还没填要等哪个文件")));
  wait.waitStep.source = "../escape.md";
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((message) => message.includes("相对路径")));
  wait.waitStep.source = "handoff/ready.md";
  wait.waitStep.timeoutMinutes = 25 * 60;
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((message) => message.includes("0–1440 分钟")));
  wait.waitStep.timeoutMinutes = 240;
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
});
