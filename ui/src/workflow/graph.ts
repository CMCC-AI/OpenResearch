import { currentDecisions, type ResearchStudy, type WorkflowState } from "../research.ts";
import type { FlowPoint, WorkflowTask } from "./model.ts";

// 冒号不属于合法任务 ID；展示节点沿用 positions 保存，不进入 tasks 或批准范围。
export const systemNodeIds = { input: ":system:input", scope: ":system:G1", delivery: ":system:G4", output: ":system:output" };
export const approvalNodeId = (taskId: string) => `:system:G5:${taskId}`;

export interface SystemNodeData extends Record<string, unknown> {
  kind: "input" | "approval" | "output";
  title: string;
  description: string;
  gate?: string;
  taskId?: string;
  label: string;
  state?: WorkflowState;
  /** 拖入画布的系统环节携带删除回调；运行视图与任务检查点不提供。 */
  onDelete?: () => void;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  // 只有原有任务依赖可编辑，展示端点和实际依赖分开记录。
  dependency?: { source: string; target: string };
  /** 分流节点连出的线携带分支标记，画布据此标注「成立 / 不成立」。 */
  branch?: "then" | "else";
}

// 三个固定系统节点的说明集中在这里：画布渲染与节点库静态展示共用，避免两处文案漂移。
function fixedChainCatalog(): { id: string; data: SystemNodeData }[] {
  return [
    { id: systemNodeIds.scope, data: { kind: "approval", title: "G1 · 研究范围确认", description: "主理人批准当前计划后启动专家任务", gate: "G1", label: "运行时确认" } },
    { id: systemNodeIds.delivery, data: { kind: "approval", title: "G4 · 交付确认", description: "全部任务验收、结论与证据检查通过后，确认成果交付", gate: "G4", label: "运行时确认" } },
    { id: systemNodeIds.output, data: { kind: "output", title: "研究交付", description: "交付确认后在当前对话查看研究成果", label: "运行时生成" } },
  ];
}

/** 空白画布不渲染固定链路；节点库选中这些系统节点时，用这份静态说明展示属性面板。 */
export function fixedSystemData(id: string): SystemNodeData | null {
  return fixedChainCatalog().find((node) => node.id === id)?.data ?? null;
}

export interface WorkflowGraphOptions {
  /** 固定链路（G1→G4→交付）渲染策略："always"（默认，运行视图）始终渲染；
   *  "never"（编辑画布）只在主理人把环节拖入画布后渲染——positions 里的 :system: 坐标键即“已放置”。 */
  fixedChain?: "always" | "never";
}

export function buildWorkflowGraph(tasks: WorkflowTask[], positions: Record<string, FlowPoint>, options: WorkflowGraphOptions = {}) {
  const taskPositions = tasks.map((task, index) => positions[task.id] ?? { x: (index % 3) * 320, y: Math.floor(index / 3) * 380 });
  const minX = Math.min(0, ...taskPositions.map((p) => p.x));
  const minY = Math.min(0, ...taskPositions.map((p) => p.y));
  const maxY = Math.max(0, ...taskPositions.map((p) => p.y));
  const occupied = taskPositions.map((p) => ({ ...p, height: 180 }));
  const systemNodes: { id: string; position: FlowPoint; data: SystemNodeData }[] = [];
  function add(id: string, fallback: FlowPoint, data: SystemNodeData) {
    let position = positions[id];
    if (!position) {
      position = { ...fallback };
      while (occupied.some((p) => Math.abs(p.x - position!.x) < 280 && position!.y < p.y + p.height + 20 && position!.y + 140 > p.y - 20)) position.y += 180;
    }
    occupied.push({ ...position, height: 140 });
    systemNodes.push({ id, position, data });
  }
  const chainAlways = (options.fixedChain ?? "always") === "always";
  // never 模式按“存在即渲染”：positions 里留有坐标的系统节点才上画布，节点不凭空出现。
  const placed = (id: string) => positions[id] !== undefined;
  const showFixed = (id: string) => chainAlways || placed(id);
  const fixedData = new Map(fixedChainCatalog().map((node) => [node.id, node.data]));
  // 旧 :system:input 坐标可继续读取保存；运行输入来自当前聊天，不再生成可见输入节点。
  if (showFixed(systemNodeIds.scope)) add(systemNodeIds.scope, { x: minX, y: minY - 180 }, fixedData.get(systemNodeIds.scope)!);
  for (const [index, task] of tasks.entries()) {
    if (task.requiresApproval) add(approvalNodeId(task.id), { x: taskPositions[index].x, y: taskPositions[index].y + 200 }, {
      kind: "approval", title: "任务后人工确认", description: `确认 ${task.id} 的产物后放行下游任务`, gate: `G5:${task.id}`, taskId: task.id, label: "运行时确认",
    });
  }
  if (showFixed(systemNodeIds.delivery)) add(systemNodeIds.delivery, { x: minX, y: maxY + 400 }, fixedData.get(systemNodeIds.delivery)!);
  // 研究交付缺省挂在交付确认下方；单独放置时以现有最底部节点为基准。
  if (showFixed(systemNodeIds.output)) add(systemNodeIds.output, { x: minX, y: (systemNodes.at(-1)?.position.y ?? maxY + 400) + 180 }, fixedData.get(systemNodeIds.output)!);

  const edges: WorkflowGraphEdge[] = [];
  function edge(source: string, target: string, dependency?: WorkflowGraphEdge["dependency"]) {
    const sourceTask = byId.get(source);
    const targetTask = byId.get(target);
    edges.push({
      id: dependency ? `${dependency.source}->${dependency.target}` : `:system:${source}->${target}`,
      source,
      target,
      dependency,
      branch: sourceTask?.kind === "route" ? (targetTask?.routeBranch === "else" ? "else" : targetTask?.routeBranch === "then" ? "then" : undefined) : undefined,
    });
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const hasDownstream = new Set(tasks.flatMap((task) => task.dependsOn));
  // 系统连线跟随已放置/已渲染的系统节点：never 模式下没放置就不画约束线。
  const scopeRendered = showFixed(systemNodeIds.scope);
  const deliveryRendered = showFixed(systemNodeIds.delivery);
  for (const task of tasks) {
    if (scopeRendered && !task.dependsOn.length) edge(systemNodeIds.scope, task.id);
    for (const source of task.dependsOn) edge(byId.get(source)?.requiresApproval ? approvalNodeId(source) : source, task.id, { source, target: task.id });
    if (task.requiresApproval) edge(task.id, approvalNodeId(task.id));
    // 现有 G5 约束下游派发，G4 自身并不额外要求叶子任务的 G5。
    if (deliveryRendered && !hasDownstream.has(task.id)) edge(task.id, systemNodeIds.delivery);
  }
  if (!tasks.length && scopeRendered && deliveryRendered) edge(systemNodeIds.scope, systemNodeIds.delivery);
  if (deliveryRendered && showFixed(systemNodeIds.output)) edge(systemNodeIds.delivery, systemNodeIds.output);
  return { systemNodes, edges, taskPositions };
}

/** 运行视图只读现有决定；草稿绝不显示“已批准”。 */
export function systemNodeForStudy(data: SystemNodeData, study: ResearchStudy): SystemNodeData {
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const task = data.taskId ? tasks.find((item) => item.id === data.taskId) : undefined;
  const decisions = currentDecisions(study);
  const decision = [...decisions].reverse().find((item) => item.gate === data.gate && (!task || taskScopeMatches(item.scope, task.id, task.summary, task.artifacts)));
  let state: WorkflowState = "waiting";
  let label = data.kind === "input" ? "来自本次研究" : data.kind === "output" ? "等待交付确认" : "等待生成确认项";
  if (data.kind === "input") state = "completed";
  if (decision) {
    state = decision.status === "approved" ? "completed" : "blocked";
    label = decision.status === "approved" ? "已批准当前版本" : decision.status === "rejected" ? "已拒绝 · 等待处理" : "等待主理人确认";
  }
  if (task && task.state !== "completed") { state = "waiting"; label = "等待任务产物验收"; }
  if (data.gate === "G4" || data.kind === "output") {
    const delivered = decisions.some((item) => item.gate === "G4" && item.status === "approved" && item.scopeHash === study.deliverySnapshot?.scopeHash) && !study.evidenceReviewRequired;
    if (data.kind === "output" && delivered) { state = "completed"; label = "成果已确认"; }
    if (study.evidenceReviewRequired || study.deliveryError) { state = "blocked"; label = study.evidenceReviewRequired ? "证据已变化 · 等待重新审查" : "交付受阻 · 查看人工确认"; }
    else if (data.gate === "G4" && decision?.status === "approved" && !delivered) { state = "waiting"; label = "等待交付完成"; }
  }
  if (study.status === "stopped" && state !== "completed") { state = "stopped"; label = "研究已停止"; }
  return { ...data, state, label };
}

function taskScopeMatches(scope: string, id: string, summary: string | null, artifacts: { path: string; sha256: string; bytes: number }[]): boolean {
  try {
    const parsed = JSON.parse(scope);
    return parsed.taskId === id && parsed.summary === summary && Array.isArray(parsed.artifacts) && parsed.artifacts.length === artifacts.length
      && parsed.artifacts.every((item: { path: string; sha256: string; bytes: number }, index: number) => item.path === artifacts[index].path && item.sha256 === artifacts[index].sha256 && item.bytes === artifacts[index].bytes);
  } catch { return false; }
}
