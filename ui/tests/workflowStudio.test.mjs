import assert from "node:assert/strict";
import test from "node:test";
import { addAgentTask, connectWorkflowTasks, createBlankDraft, createLiteratureDraft, reconnectWorkflowTasks, removeWorkflowTask, validateWorkflowDraft } from "../src/workflow/model.ts";
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
  assert.equal(draft.name, "");
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
  assert.deepEqual(parseDestination("/projects/project/deliverables"), { kind: "deliverables", projectId: "project" });
  assert.deepEqual(parseDestination("/mobilesci/projects/project/deliverables"), { kind: "deliverables", projectId: "project" });
  assert.equal(parseDestination("/projects/project/skills"), null);
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
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("review-writing 的输入 synthesis/themes.md 必须来自直接前置任务的产物")));
  write.inputs = [];
  const review = draft.tasks.find((task) => task.id === "independent-review");
  review.gateDownstream = false;
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("设置了返工上限，需要同时开启结论把关")));
  review.gateDownstream = true;
  review.maxRework = 4;
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("返工上限需为 0–3 的整数")));
});
