import assert from "node:assert/strict";
import test from "node:test";
import { addAgentTask, connectWorkflowTasks, createLiteratureDraft, removeWorkflowTask, validateWorkflowDraft } from "../src/workflow/model.ts";
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

test("canvas connections reject cycles and preserve parallel dependencies", () => {
  const draft = createLiteratureDraft();
  assert.throws(() => connectWorkflowTasks(draft, draft.tasks[2].id, draft.tasks[0].id), /循环/);
  const parallel = addAgentTask(draft, { id: "agent-custom", name: "Custom reviewer", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1 });
  const connected = connectWorkflowTasks(parallel, draft.tasks[0].id, "task-10");
  assert.deepEqual(connected.tasks.at(-1).dependsOn, [draft.tasks[0].id]);
  assert.throws(() => connectWorkflowTasks(connected, "task-10", draft.tasks[0].id), /循环/);
});

test("removing a node removes incoming and outgoing edges without changing other tasks", () => {
  const draft = createLiteratureDraft();
  const removed = removeWorkflowTask(draft, draft.tasks[1].id);
  assert.ok(!removed.tasks.some((task) => task.id === draft.tasks[1].id));
  assert.deepEqual(removed.tasks[1].dependsOn, []);
  assert.equal(removed.positions[draft.tasks[1].id], undefined);
  assert.ok(validateWorkflowDraft(removed, agentsFor(removed)).some((error) => error.includes("as-literature-researcher")));
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

test("input bindings and rework limits are validated against direct dependencies", () => {
  const draft = createLiteratureDraft();
  const write = draft.tasks.find((task) => task.id === "review-writing");
  // review-writing 的直接前置是 review-outline，其产物 outline/outline.md 是合法输入。
  write.inputs = ["outline/outline.md"];
  assert.deepEqual(validateWorkflowDraft(draft, agentsFor(draft)), []);
  write.inputs = ["synthesis/themes.md"];
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("review-writing 的输入必须来自直接前置任务的产物")));
  write.inputs = [];
  const review = draft.tasks.find((task) => task.id === "independent-review");
  review.gateDownstream = false;
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("设置返工上限需要同时开启结论门控")));
  review.gateDownstream = true;
  review.maxRework = 4;
  assert.ok(validateWorkflowDraft(draft, agentsFor(draft)).some((error) => error.includes("返工上限需为 0–3 的整数")));
});
