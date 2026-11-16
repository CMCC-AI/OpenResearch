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
  /** 声明要读取的上游产物路径，派发时自动注入专家开工指令。 */
  inputs?: string[];
  /** 完成后需主理人在人工确认页批准才放行下游。 */
  requiresApproval?: boolean;
  /** 结论把关：完成时读取 <首个产物>.verdict.json，有问题时暂停下游任务。 */
  gateDownstream?: boolean;
  /** 结论为阻塞时自动带意见返工上游的轮数上限（0–3）。 */
  maxRework?: number;
}

/** 结论把关允许的最大自动返工轮数，与 Rust 侧 MAX_REWORK 保持一致。 */
export const MAX_REWORK = 3;

export interface FlowPoint { x: number; y: number }
export interface FlowViewport { x: number; y: number; zoom: number }

/** 草稿流程标记：literature 是旧数据兼容取值；提交时一律按自定义编排（workflow:null）处理。 */
export type WorkflowIdentity = "literature" | "custom";

export interface WorkflowDraftInput {
  name: string;
  /** 兼容字段：研究目标已移到提交运行时，新保存的草稿恒为空字符串。 */
  objective: string;
  /** 兼容字段：计划摘要由服务端在提交时生成，新保存的草稿恒为空字符串。 */
  summary: string;
  workflow: WorkflowIdentity;
  tasks: WorkflowTask[];
  positions: Record<string, FlowPoint>;
  viewport?: FlowViewport | null;
}

export interface WorkflowDraft extends WorkflowDraftInput {
  id: string;
  /** 工作流库是共享的：这里只记录创建来源项目（"" 表示全局创建），不限制谁能使用。 */
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
  ["as-independent-reviewer", "independent-review", "独立检查论证、证据覆盖、引用支持、负面结果与研究限制，列出需要处理的问题。", "review/independent.md"],
  ["as-quality-citation-auditor", "citation-audit", "逐项核验正文声明与原文定位、实验证据和推论边界，输出引用审计记录。", "audit/citations.md"],
  ["as-research-package-curator", "research-package", "整理最终综述、证据、审查记录、失败与限制，形成成果归档清单。", "package/manifest.md"],
] as const;

export function createBlankDraft(): WorkflowDraftInput {
  // 新建工作流从空白画布开始：名称与任务都为空，由主理人自行组合专家。
  // 空草稿不能保存入库（名称非空由后端校验、任务非空由提交校验），只作为编辑器初始状态。
  return {
    name: "",
    objective: "",
    summary: "",
    workflow: "custom",
    tasks: [],
    positions: {},
    viewport: null,
  };
}

export function createLiteratureDraft(): WorkflowDraftInput {
  // 文献综述模板：不再作为新建默认，仅供测试当作结构完整的夹具；节点可自由增删重连，
  // 草稿按自定义编排提交，不绑定预设契约。
  // 默认展示三种控制属性：检索策略需主理人确认，审稿阻塞时自动返工写作，审计阻塞时拦截下游。
  const controls: Partial<Record<string, Pick<WorkflowTask, "requiresApproval" | "gateDownstream" | "maxRework">>> = {
    "search-strategy": { requiresApproval: true },
    "independent-review": { gateDownstream: true, maxRework: 2 },
    "citation-audit": { gateDownstream: true },
  };
  const tasks: WorkflowTask[] = literatureTasks.map(([role, id, brief, output], index) => ({
    id,
    role,
    brief,
    dependsOn: index ? [literatureTasks[index - 1][1]] : [],
    outputs: [output],
    ...controls[id],
  }));
  return {
    name: "系统文献综述",
    objective: "",
    summary: "",
    workflow: "custom",
    tasks,
    positions: gridPositions(tasks),
    viewport: null,
  };
}

function gridPositions(tasks: WorkflowTask[]): Record<string, FlowPoint> {
  return Object.fromEntries(tasks.map((task, index) => [task.id, { x: (index % 3) * 320, y: Math.floor(index / 3) * 380 }]));
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

export function addAgentTask(draft: WorkflowDraftInput, agent: WorkflowAgent, position?: FlowPoint): WorkflowDraftInput {
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
      // 拖拽时用落点直接放置；缺省时 -380 下探使空白画布的第一个任务落在 (0, 0)，之后始终排在现有最高节点下方。
      [id]: position ?? { x: 0, y: Math.max(-380, ...Object.values(draft.positions).map((point) => point.y)) + 380 },
    },
  };
}

export function removeWorkflowTask(draft: WorkflowDraftInput, id: string): WorkflowDraftInput {
  const positions = { ...draft.positions };
  delete positions[id];
  delete positions[`:system:G5:${id}`];
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

/** 拖动已有连线端点改接专家：先移除旧线再按新端点连线，换向（A→B 改为 B→A）不误报循环。 */
export function reconnectWorkflowTasks(
  draft: WorkflowDraftInput,
  oldEdge: { source: string; target: string },
  nextSource: string,
  nextTarget: string,
): WorkflowDraftInput {
  if (!draft.tasks.some((task) => task.id === oldEdge.source) || !draft.tasks.some((task) => task.id === oldEdge.target)) {
    throw new Error("这条连线不再存在，请刷新后重试");
  }
  if (oldEdge.source === nextSource && oldEdge.target === nextTarget) return draft;
  const withoutOld: WorkflowDraftInput = {
    ...draft,
    tasks: draft.tasks.map((task) => task.id === oldEdge.target ? { ...task, dependsOn: task.dependsOn.filter((id) => id !== oldEdge.source) } : task),
  };
  return connectWorkflowTasks(withoutOld, nextSource, nextTarget);
}

export function validateWorkflowDraft(draft: WorkflowDraftInput, agents: WorkflowAgent[]): string[] {
  const errors: string[] = [];
  // 报错要能和画布对上：节点卡片展示「专家名 + 任务 ID」，这里用同样的写法指代节点。
  const taskLabel = (task: WorkflowTask) => {
    const name = agents.find((agent) => agent.id === task.role)?.name;
    return name && name !== task.role ? `${name}（${task.id}）` : task.id;
  };
  if (!draft.tasks.length) errors.push("至少需要一个 Agent 任务");
  if (draft.tasks.length > 40) errors.push("工作流最多包含 40 个任务");
  const ids = new Set(draft.tasks.map((task) => task.id));
  if (ids.size !== draft.tasks.length) errors.push("任务 ID 重复");
  const knownAgents = new Set(agents.map((agent) => agent.id));
  const outputs = new Set<string>();
  for (const task of draft.tasks) {
    const label = taskLabel(task);
    if (!task.id || task.id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(task.id)) errors.push(`任务 ID 无效：${task.id || "（空）"}`);
    if (!knownAgents.has(task.role)) errors.push(`${label} 选择了不存在的专家：${task.role}`);
    if (!task.brief.trim()) errors.push(`${label} 缺少任务简报`);
    if (!task.outputs.length) errors.push(`${label} 至少需要一个产物路径`);
    for (const output of task.outputs) {
      if (!output || output.startsWith("/") || output.includes("..") || output.includes("\\") || output.includes(":")) errors.push(`${label} 的产物路径无效：${output || "（空）"}`);
      if (outputs.has(output)) errors.push(`产物路径重复：${output}`);
      outputs.add(output);
    }
    for (const dependency of task.dependsOn) if (!ids.has(dependency)) errors.push(`${label} 依赖了已删除或不存在的前置任务：${dependency}`);
    const depOutputs = new Set(task.dependsOn.flatMap((dependency) => draft.tasks.find((t) => t.id === dependency)?.outputs ?? []));
    const seenInputs = new Set<string>();
    for (const input of task.inputs ?? []) {
      if (!depOutputs.has(input)) errors.push(`${label} 的输入 ${input} 必须来自直接前置任务的产物（先连线，再勾选）`);
      if (seenInputs.has(input)) errors.push(`${label} 的输入重复：${input}`);
      seenInputs.add(input);
    }
    const maxRework = task.maxRework ?? 0;
    if (!Number.isInteger(maxRework) || maxRework < 0 || maxRework > MAX_REWORK) errors.push(`${label} 的返工上限需为 0–${MAX_REWORK} 的整数`);
    if (maxRework > 0 && !task.gateDownstream) errors.push(`${label} 设置了返工上限，需要同时开启结论把关`);
    if (task.gateDownstream && !task.dependsOn.length) errors.push(`${label} 开启了结论把关，但没有任何前置任务：从上游连一条线进来，或关闭结论把关`);
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
  // 画布草稿按自定义编排提交：专家与依赖由主理人自由组合，不做预设名册检查。
  // W1–W4 预设契约只约束聊天里 AI 自动路由登记的计划。
  return [...new Set(errors)];
}
