import assert from "node:assert/strict";
import test from "node:test";
import { approvalNodeId, buildWorkflowGraph, systemNodeForStudy, systemNodeIds } from "../src/workflow/graph.ts";
import { createLiteratureDraft, removeWorkflowTask } from "../src/workflow/model.ts";

test("system graph preserves the executable DAG, input bindings and saved positions", () => {
  const draft = createLiteratureDraft();
  const saved = structuredClone(draft);
  const graph = buildWorkflowGraph(draft.tasks, draft.positions);
  assert.deepEqual(draft, saved);
  assert.equal(graph.systemNodes.length, 4);
  assert.ok(!graph.systemNodes.some(node => node.id === systemNodeIds.input));
  assert.deepEqual(graph.edges.flatMap(edge => edge.dependency ? [edge.dependency] : []), draft.tasks.flatMap(task => task.dependsOn.map(source => ({ source, target: task.id }))));
  assert.ok(graph.edges.some(edge => edge.source === approvalNodeId("search-strategy") && edge.target === "literature-discovery"));
  assert.ok(graph.edges.some(edge => edge.source === systemNodeIds.scope && edge.target === "search-strategy"));
  for (const node of graph.systemNodes) assert.ok(!draft.tasks.some(task => task.id === node.id));
  assert.deepEqual(graph.taskPositions, draft.tasks.map(task => draft.positions[task.id]));
  draft.positions[systemNodeIds.scope] = { x: -900, y: -500 };
  assert.deepEqual(buildWorkflowGraph(draft.tasks, draft.positions).systemNodes.find(node => node.id === systemNodeIds.scope).position, { x: -900, y: -500 });
});

test("parallel roots and leaves retain system boundaries without inventing a leaf approval requirement", () => {
  const tasks = ["a", "b"].map(id => ({ id, role: "expert", brief: "task", outputs: [`${id}.md`], dependsOn: [], requiresApproval: true }));
  const graph = buildWorkflowGraph(tasks, {});
  for (const task of tasks) {
    assert.ok(graph.edges.some(edge => edge.source === systemNodeIds.scope && edge.target === task.id));
    assert.ok(graph.edges.some(edge => edge.source === task.id && edge.target === systemNodeIds.delivery));
    assert.ok(!graph.edges.some(edge => edge.source === approvalNodeId(task.id) && edge.target === systemNodeIds.delivery));
  }
  const empty = buildWorkflowGraph([], {});
  assert.equal(empty.systemNodes.length, 3);
  assert.equal(empty.edges.length, 2);
});

test("removing a task removes its checkpoint layout but preserves other system coordinates", () => {
  const draft = createLiteratureDraft();
  draft.positions[approvalNodeId("search-strategy")] = { x: 500, y: 500 };
  draft.positions[systemNodeIds.input] = { x: -100, y: -100 };
  const removed = removeWorkflowTask(draft, "search-strategy");
  assert.equal(removed.positions[approvalNodeId("search-strategy")], undefined);
  assert.deepEqual(removed.positions[systemNodeIds.input], draft.positions[systemNodeIds.input]);
  assert.ok(!buildWorkflowGraph(removed.tasks, removed.positions).systemNodes.some(node => node.id === approvalNodeId("search-strategy")));
});

function fixture() {
  const task = { ...createLiteratureDraft().tasks[0], state: "completed", summary: "accepted", artifacts: [{ path: "result.md", sha256: "current", bytes: 10 }], runIds: [], sessionId: null };
  const study = { id: "study", sessionId: "session", mode: "literature", objective: "A run goal", status: "active", plans: [{ version: 2, workflow: "literature", summary: "plan", tasks: [task] }], decisions: [], claims: [] };
  const scope = JSON.stringify({ taskId: task.id, summary: task.summary, artifacts: task.artifacts });
  const decision = { id: "decision", version: 2, gate: `G5:${task.id}`, scope, scopeHash: "scope", status: "approved", reason: null };
  const data = buildWorkflowGraph([task], {}).systemNodes.find(node => node.data.taskId === task.id).data;
  return { task, study, decision, data };
}

test("runtime checkpoint approvals are tied to current plan, artifacts and summary", () => {
  const { task, study, decision, data } = fixture();
  study.decisions = [decision];
  assert.equal(systemNodeForStudy(data, study).state, "completed");
  task.artifacts[0].sha256 = "changed";
  assert.equal(systemNodeForStudy(data, study).state, "waiting");
  task.artifacts[0].sha256 = "current";
  task.summary = "changed";
  assert.equal(systemNodeForStudy(data, study).state, "waiting");
  task.summary = "accepted";
  decision.version = 1;
  assert.equal(systemNodeForStudy(data, study).state, "waiting");
  decision.version = 2;
  decision.status = "superseded";
  assert.equal(systemNodeForStudy(data, study).state, "waiting");
});

test("pending and rejected checkpoints stay blocked, and an archived attempt cannot appear approved", () => {
  const { task, study, decision, data } = fixture();
  study.decisions = [decision];
  for (const status of ["pending", "rejected"]) {
    decision.status = status;
    assert.equal(systemNodeForStudy(data, study).state, "blocked");
  }
  decision.status = "approved";
  task.state = "pending";
  assert.equal(systemNodeForStudy(data, study).state, "waiting");
  study.status = "stopped";
  assert.equal(systemNodeForStudy(data, study).state, "stopped");
});

test("delivery only displays approval for the current confirmed package and valid evidence", () => {
  const { study } = fixture();
  const graph = buildWorkflowGraph([], {});
  const data = graph.systemNodes.find(node => node.id === systemNodeIds.output).data;
  const gate = graph.systemNodes.find(node => node.id === systemNodeIds.delivery).data;
  study.decisions = [{ version: 2, gate: "G4", status: "approved", scopeHash: "old" }];
  study.deliverySnapshot = { scopeHash: "current" };
  assert.equal(systemNodeForStudy(data, study).state, "waiting");
  assert.equal(systemNodeForStudy(gate, study).state, "waiting");
  study.decisions[0].scopeHash = "current";
  assert.equal(systemNodeForStudy(data, study).state, "completed");
  study.evidenceReviewRequired = true;
  assert.equal(systemNodeForStudy(data, study).state, "blocked");
});
