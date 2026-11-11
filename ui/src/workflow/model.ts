import { researchPresets } from "../research.ts";

export interface WorkflowAgentSkill {
  name: string;
  description: string;
}

export interface WorkflowAgent {
  id: string;
  name: string;
  description: string;
  prompt: string;
  toolPermissions?: string[];
  skills?: WorkflowAgentSkill[];
  version: number;
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowAgentInput {
  name: string;
  description: string;
  prompt: string;
}

export interface WorkflowTask {
  id: string;
  role: string;
  brief: string;
  dependsOn: string[];
  outputs: string[];
  forceRerun?: boolean;
}

export interface FlowPoint { x: number; y: number }
export interface FlowViewport { x: number; y: number; zoom: number }

export interface WorkflowDraftInput {
  name: string;
  /** 兼容字段：研究目标已移到提交运行时，新保存的草稿恒为空字符串。 */
  objective: string;
  /** 兼容字段：计划摘要由服务端在提交时生成，新保存的草稿恒为空字符串。 */
  summary: string;
  workflow: "literature";
  tasks: WorkflowTask[];
  positions: Record<string, FlowPoint>;
  viewport?: FlowViewport | null;
}

export interface WorkflowDraft extends WorkflowDraftInput {
  id: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
}

const literatureTasks = [
  ["as-literature-strategist", "search-strategy", "制定可复现的检索问题、数据库、关键词、时间范围、纳入排除标准与去重规则。", "strategy/search.md"],
  ["as-literature-researcher", "literature-discovery", "按检索策略执行文献发现，记录检索式、命中量、筛选过程与排除原因。", "discovery/papers.md"],
  ["as-paper-evidence-analyst", "paper-evidence", "逐篇阅读入选论文，提取带页码或章节定位的方法、结果、限制与原文证据。", "evidence/papers.md"],
  ["as-research-synthesizer", "evidence-synthesis", "比较研究主题、方法、共识、争议与证据强弱，形成有来源的研究空白分析。", "synthesis/themes.md"],
  ["as-outline-architect", "review-outline", "基于证据综合组织综述论点、章节结构和引用映射。", "outline/outline.md"],
  ["as-evidence-writer", "review-writing", "按大纲撰写中文综述，区分原文声明、综合推论与研究空白，保留引用定位。", "writing/review.md"],
  ["as-independent-reviewer", "independent-review", "独立检查论证、证据覆盖、引用支持、负面结果与研究限制，列出阻塞问题。", "review/independent.md"],
  ["as-quality-citation-auditor", "citation-audit", "逐项核验正文声明与原文定位、实验证据和推论边界，输出引用审计记录。", "audit/citations.md"],
  ["as-research-package-curator", "research-package", "整理最终综述、证据、审查记录、失败与限制，形成研究包清单。", "package/manifest.md"],
] as const;

export function createLiteratureDraft(): WorkflowDraftInput {
  const tasks: WorkflowTask[] = literatureTasks.map(([role, id, brief, output], index) => ({
    id,
    role,
    brief,
    dependsOn: index ? [literatureTasks[index - 1][1]] : [],
    outputs: [output],
  }));
  return {
    name: "系统文献综述",
    objective: "",
    summary: "",
    workflow: "literature",
    tasks,
    positions: gridPositions(tasks),
    viewport: null,
  };
}

function gridPositions(tasks: WorkflowTask[]): Record<string, FlowPoint> {
  return Object.fromEntries(tasks.map((task, index) => [task.id, { x: (index % 3) * 300, y: Math.floor(index / 3) * 220 }]));
}

// 旧版默认草稿把任务排成一条 280px 间距的横排，fitView 被迫整体缩小、节点文字难以阅读；
// 识别该机器默认布局并换成网格，让已保存的旧草稿恢复时也能以可读缩放打开。
export function migrateDraftLayout(draft: WorkflowDraftInput): WorkflowDraftInput {
  const legacy = draft.tasks.length > 3 && draft.tasks.every((task, index) => {
    const position = draft.positions[task.id];
    return position?.y === 0 && position?.x === index * 280;
  });
  if (!legacy) return draft;
  return { ...draft, positions: gridPositions(draft.tasks), viewport: null };
}

export function addAgentTask(draft: WorkflowDraftInput, agent: WorkflowAgent): WorkflowDraftInput {
  let index = draft.tasks.length + 1;
  while (draft.tasks.some((task) => task.id === `task-${index}`)) index++;
  const id = `task-${index}`;
  return {
    ...draft,
    tasks: [...draft.tasks, {
      id,
      role: agent.id,
      brief: `请完成“${agent.name}”承担的科研任务，并记录使用的方法、证据和限制。`,
      dependsOn: [],
      outputs: [`${id}/result.md`],
    }],
    positions: {
      ...draft.positions,
      [id]: { x: (draft.tasks.length % 5) * 280, y: Math.floor(draft.tasks.length / 5) * 180 + 180 },
    },
  };
}

export function removeWorkflowTask(draft: WorkflowDraftInput, id: string): WorkflowDraftInput {
  const positions = { ...draft.positions };
  delete positions[id];
  return {
    ...draft,
    tasks: draft.tasks.filter((task) => task.id !== id).map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dependency) => dependency !== id),
    })),
    positions,
  };
}

export function connectWorkflowTasks(draft: WorkflowDraftInput, source: string, target: string): WorkflowDraftInput {
  if (source === target) throw new Error("任务不能依赖自身");
  const targetTask = draft.tasks.find((task) => task.id === target);
  if (!draft.tasks.some((task) => task.id === source) || !targetTask) throw new Error("依赖任务不存在");
  if (targetTask.dependsOn.includes(source)) return draft;
  const reachesTarget = (id: string, visited = new Set<string>()): boolean => {
    if (id === target) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return draft.tasks.find((task) => task.id === id)?.dependsOn.some((dependency) => reachesTarget(dependency, visited)) ?? false;
  };
  if (reachesTarget(source)) throw new Error("这条连线会形成循环依赖");
  return {
    ...draft,
    tasks: draft.tasks.map((task) => task.id === target ? { ...task, dependsOn: [...task.dependsOn, source] } : task),
  };
}

export function validateWorkflowDraft(draft: WorkflowDraftInput, agents: WorkflowAgent[]): string[] {
  const errors: string[] = [];
  if (!draft.tasks.length) errors.push("至少需要一个 Agent 任务");
  if (draft.tasks.length > 40) errors.push("工作流最多包含 40 个任务");
  const ids = new Set(draft.tasks.map((task) => task.id));
  if (ids.size !== draft.tasks.length) errors.push("任务 ID 重复");
  const knownAgents = new Set(agents.map((agent) => agent.id));
  const outputs = new Set<string>();
  for (const task of draft.tasks) {
    if (!task.id || task.id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(task.id)) errors.push(`任务 ID 无效：${task.id || "（空）"}`);
    if (!knownAgents.has(task.role)) errors.push(`${task.id} 使用了不存在的 Agent`);
    if (!task.brief.trim()) errors.push(`${task.id} 缺少任务简报`);
    if (!task.outputs.length) errors.push(`${task.id} 至少需要一个产物路径`);
    for (const output of task.outputs) {
      if (!output || output.startsWith("/") || output.includes("..") || output.includes("\\") || output.includes(":")) errors.push(`${task.id} 的产物路径无效`);
      if (outputs.has(output)) errors.push(`产物路径重复：${output}`);
      outputs.add(output);
    }
    for (const dependency of task.dependsOn) if (!ids.has(dependency)) errors.push(`${task.id} 依赖未知任务 ${dependency}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { errors.push(`任务依赖存在循环：${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    draft.tasks.find((task) => task.id === id)?.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  draft.tasks.forEach((task) => visit(task.id));
  for (const required of researchPresets.literature.requiredRoles) {
    if (!draft.tasks.some((task) => task.role === required)) errors.push(`W1 缺少必需专家：${required}`);
  }
  return [...new Set(errors)];
}
