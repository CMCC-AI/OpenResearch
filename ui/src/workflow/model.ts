export interface WorkflowAgentSkill {
  name: string;
  description: string;
}

/** 能力库技能条目：内置 orx-* 模块与用户技能合并后的只读视图。 */
export interface WorkflowLibrarySkill {
  name: string;
  description?: string | null;
  source: "builtin" | "user";
  /** 镜像来源（某个 coding agent 或插件）；上传技能没有该字段。 */
  origin?: string | null;
  bytes?: number | null;
  updatedAt?: number | null;
  /** 历史上传：按需绑定上线前已存在，保留全局生效。 */
  legacyGlobal?: boolean;
  /** 绑定的项目 id 列表（生效范围）。 */
  boundProjects?: string[];
  /** 绑定的自定义专家 id 列表（生效范围）。 */
  boundAgents?: string[];
}

export interface WorkflowAgent {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** 挂载的 MCP 服务 id；内置专家为空数组。 */
  mcpServers?: string[];
  /** 挂载的上传技能名；内置专家为空数组。派发该专家的会话自动携带这些技能。 */
  userSkills?: string[];
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
  mcpServers: string[];
  userSkills: string[];
}

/** MCP 服务登记条目；命令与环境变量存本机 config_dir/mcp.json（0600），不入库不进工作树。 */
export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  description: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerInput {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  description: string;
  enabled: boolean;
}

/** 主理人提交的 MCP 提案：用户在聊天卡片确认后才写入登记表。 */
export interface McpProposal {
  id: string;
  sessionId: string;
  name: string;
  payload: McpServerInput | null;
  rationale: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedAt: number | null;
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
  /** 节点类型：缺省为专家任务；"route" 条件分流；"foreach" 逐项处理；"human" 主理人亲自完成；"experiment" 实验执行；"wait" 事件等待。 */
  kind?: "agent" | "route" | "foreach" | "human" | "experiment" | "wait";
  /** kind = "route" 时的条件定义。 */
  route?: { on: "verdict" | "failure"; source?: string; verdictIs?: "pass" | "blocked" };
  /** 分流节点直接下游的分支标记：then（成立）/ else（不成立）。 */
  routeBranch?: "then" | "else";
  /** 多前置汇合策略：缺省等全部完成；"any" 任一完成即继续。 */
  waitFor?: "all" | "any";
  /** kind = "foreach" 时的逐项处理定义（首批为串行执行）。 */
  forEach?: {
    /** 读取的列表产物路径（直接前置任务的产物，其旁存在 .items.json 清单）。 */
    source: string;
    /** 逐项产物模板，必须含 {item} 占位，如 readings/{item}.md。 */
    itemOutput: string;
    /** 每项派发给专家的简报；{item} 会替换为该项标题。 */
    itemBrief: string;
    /** 部分失败策略：缺省暂停等待主理人；"skip" 跳过该项继续剩余项。 */
    onFailure?: "pause" | "skip";
  } | null;
  /** kind = "wait" 时的等待定义：等研究目录下路径出现，超时转失败。 */
  waitStep?: { source: string; timeoutMinutes?: number } | null;
}

/** 阶段分组框：纯展示，只存画布位置，不进入执行计划与批准范围。 */
export interface WorkflowFrame {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 结论把关允许的最大自动返工轮数，与 Rust 侧 MAX_REWORK 保持一致。 */
export const MAX_REWORK = 3;
/** 分流节点的分支标记取值。 */
export const ROUTE_THEN = "then";
export const ROUTE_ELSE = "else";

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
  /** 阶段分组框；旧草稿没有此字段，读取时按空数组处理。 */
  frames?: WorkflowFrame[];
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
    frames: [],
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

export function addRouteTask(draft: WorkflowDraftInput, position?: FlowPoint): WorkflowDraftInput {
  let index = draft.tasks.length + 1;
  while (draft.tasks.some((task) => task.id === `route-${index}`)) index++;
  const id = `route-${index}`;
  return {
    ...draft,
    tasks: [...draft.tasks, {
      id,
      role: "",
      brief: "条件分流",
      dependsOn: [],
      outputs: [],
      kind: "route",
      route: { on: "verdict", source: "", verdictIs: "pass" },
    }],
    positions: {
      ...draft.positions,
      [id]: position ?? { x: 0, y: Math.max(-380, ...Object.values(draft.positions).map((point) => point.y)) + 380 },
    },
  };
}

export function addWorkflowFrame(draft: WorkflowDraftInput, frame: WorkflowFrame): WorkflowDraftInput {
  return { ...draft, frames: [...(draft.frames ?? []), frame] };
}

export function addForeachTask(draft: WorkflowDraftInput, position?: FlowPoint): WorkflowDraftInput {
  let index = draft.tasks.length + 1;
  while (draft.tasks.some((task) => task.id === `loop-${index}`)) index++;
  const id = `loop-${index}`;
  return {
    ...draft,
    tasks: [...draft.tasks, {
      id,
      role: "",
      brief: "逐项处理",
      dependsOn: [],
      outputs: [],
      kind: "foreach",
      forEach: { source: "", itemOutput: "readings/{item}.md", itemBrief: "逐项处理：{item}", onFailure: "pause" },
    }],
    positions: {
      ...draft.positions,
      [id]: position ?? { x: 0, y: Math.max(-380, ...Object.values(draft.positions).map((point) => point.y)) + 380 },
    },
  };
}

export function addHumanTask(draft: WorkflowDraftInput, position?: FlowPoint): WorkflowDraftInput {
  let index = draft.tasks.length + 1;
  while (draft.tasks.some((task) => task.id === `mine-${index}`)) index++;
  const id = `mine-${index}`;
  return {
    ...draft,
    tasks: [...draft.tasks, {
      id,
      role: "",
      brief: "等你完成的一项",
      dependsOn: [],
      outputs: [`${id}.md`],
      kind: "human",
    }],
    positions: {
      ...draft.positions,
      [id]: position ?? { x: 0, y: Math.max(-380, ...Object.values(draft.positions).map((point) => point.y)) + 380 },
    },
  };
}

/** 人工任务的产物路径默认取任务 id，属性面板可改；这里先占位，保存前由校验提示补全。 */
export function humanOutputDraftPath(task: WorkflowTask): string {
  return task.outputs[0] ?? `${task.id}.md`;
}

export function addExperimentTask(draft: WorkflowDraftInput, position?: FlowPoint): WorkflowDraftInput {
  let index = draft.tasks.length + 1;
  while (draft.tasks.some((task) => task.id === `exp-${index}`)) index++;
  const id = `exp-${index}`;
  return {
    ...draft,
    tasks: [...draft.tasks, {
      id,
      role: "",
      brief: "运行实验",
      dependsOn: [],
      outputs: [`${id}/metrics.md`],
      kind: "experiment",
    }],
    positions: {
      ...draft.positions,
      [id]: position ?? { x: 0, y: Math.max(-380, ...Object.values(draft.positions).map((point) => point.y)) + 380 },
    },
  };
}

export function addWaitTask(draft: WorkflowDraftInput, position?: FlowPoint): WorkflowDraftInput {
  let index = draft.tasks.length + 1;
  while (draft.tasks.some((task) => task.id === `await-${index}`)) index++;
  const id = `await-${index}`;
  return {
    ...draft,
    tasks: [...draft.tasks, {
      id,
      role: "",
      brief: "等待结果文件",
      dependsOn: [],
      outputs: [],
      kind: "wait",
      waitStep: { source: "", timeoutMinutes: 240 },
    }],
    positions: {
      ...draft.positions,
      [id]: position ?? { x: 0, y: Math.max(-380, ...Object.values(draft.positions).map((point) => point.y)) + 380 },
    },
  };
}

export function updateWorkflowFrame(draft: WorkflowDraftInput, id: string, update: Partial<WorkflowFrame>): WorkflowDraftInput {
  return { ...draft, frames: (draft.frames ?? []).map((frame) => frame.id === id ? { ...frame, ...update } : frame) };
}

export function removeWorkflowFrame(draft: WorkflowDraftInput, id: string): WorkflowDraftInput {
  return { ...draft, frames: (draft.frames ?? []).filter((frame) => frame.id !== id) };
}

export function removeWorkflowTask(draft: WorkflowDraftInput, id: string): WorkflowDraftInput {
  const positions = { ...draft.positions };
  delete positions[id];
  delete positions[`:system:G5:${id}`];
  const remaining = draft.tasks.filter((task) => task.id !== id);
  const isRoute = (taskId: string) => remaining.find((task) => task.id === taskId)?.kind === "route";
  return {
    ...draft,
    // 删除分流节点后，原先指向它的分支标记一并失效。
    tasks: remaining.map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dependency) => dependency !== id),
      routeBranch: task.dependsOn.some((dependency) => dependency !== id && isRoute(dependency)) ? task.routeBranch : undefined,
    })),
    positions,
  };
}

export function connectWorkflowTasks(draft: WorkflowDraftInput, source: string, target: string): WorkflowDraftInput {
  if (source === target) throw new Error("任务不能依赖自身");
  const sourceTask = draft.tasks.find((task) => task.id === source);
  const targetTask = draft.tasks.find((task) => task.id === target);
  if (!sourceTask || !targetTask) throw new Error("依赖任务不存在");
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
    tasks: draft.tasks.map((task) => {
      if (task.id !== target) return task;
      const updated = { ...task, dependsOn: [...task.dependsOn, source] };
      // 从分流节点连出的线自动打分支标记：第一条「成立」，第二条「不成立」，可在属性面板改。
      if (sourceTask.kind === "route" && !updated.routeBranch) {
        const hasThen = draft.tasks.some((candidate) => candidate.dependsOn.includes(source) && candidate.routeBranch === ROUTE_THEN);
        updated.routeBranch = hasThen ? ROUTE_ELSE : ROUTE_THEN;
      }
      return updated;
    }),
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
    if (task.kind === "route") return `${task.brief || "条件分流"}（${task.id}）`;
    if (task.kind === "foreach") return `${task.brief || "逐项处理"}（${task.id}）`;
    if (task.kind === "human") return `${task.brief || "人工任务"}（${task.id}）`;
    if (task.kind === "experiment") return `${task.brief || "实验节点"}（${task.id}）`;
    if (task.kind === "wait") return `${task.brief || "事件等待"}（${task.id}）`;
    const name = agents.find((agent) => agent.id === task.role)?.name;
    return name && name !== task.role ? `${name}（${task.id}）` : task.id;
  };
  const routeById = new Map(draft.tasks.filter((task) => task.kind === "route").map((task) => [task.id, task]));
  if (!draft.tasks.length) errors.push("至少需要一个 Agent 任务");
  if (draft.tasks.length > 40) errors.push("工作流最多包含 40 个任务");
  const ids = new Set(draft.tasks.map((task) => task.id));
  if (ids.size !== draft.tasks.length) errors.push("任务 ID 重复");
  const knownAgents = new Set(agents.map((agent) => agent.id));
  const outputs = new Set<string>();
  for (const task of draft.tasks) {
    const label = taskLabel(task);
    if (!task.id || task.id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(task.id)) errors.push(`任务 ID 无效：${task.id || "（空）"}`);
    const isRoute = task.kind === "route";
    if (isRoute) {
      // 分流节点的规则：不选专家、不产出文件、必须有前置和条件，两条分支都要有后续。
      if (task.role) errors.push(`${label} 是分流节点，不选择专家`);
      if (task.outputs.length) errors.push(`${label} 是分流节点，不产出文件`);
      if (!task.brief.trim()) errors.push(`${label} 缺少名称说明`);
      if (!task.dependsOn.length) errors.push(`${label} 还没有前置任务：先从上游连一条线进来`);
      const route = task.route;
      if (!route) {
        errors.push(`${label} 缺少分流条件`);
      } else if (route.on === "verdict") {
        if (route.verdictIs !== "pass" && route.verdictIs !== "blocked") errors.push(`${label} 的结论条件只允许「通过」或「有问题」`);
        const owner = draft.tasks.find((candidate) => candidate.outputs.includes(route.source ?? ""));
        if (!route.source || !owner) errors.push(`${label} 的条件来源不是任何前置任务的产物：先连线，再选择要读取的结论`);
        else {
          if (!task.dependsOn.includes(owner.id)) errors.push(`${label} 的条件来源必须来自直接前置任务的产物`);
          if (!owner.gateDownstream) errors.push(`产物 ${route.source} 所在任务未开启结论把关，分流没有可读取的结论`);
        }
      } else if (route.on === "failure") {
        if (route.source || route.verdictIs) errors.push(`${label} 的「上游失败」条件不需要选择来源产物或结论值`);
      } else {
        errors.push(`${label} 的条件类型无效`);
      }
      if (task.forEach) errors.push(`${label} 是分流节点，不能配置逐项处理`);
      if (task.waitStep) errors.push(`${label} 是分流节点，不能配置事件等待`);
    } else if (task.kind === "foreach") {
      // 逐项任务的规则：不选专家、不产出文件，列表来源来自直接前置，模板必须含 {item}。
      if (task.role) errors.push(`${label} 是逐项任务，不选择专家`);
      if (task.outputs.length) errors.push(`${label} 是逐项任务，不直接声明产物：逐项产物由模板按项展开`);
      if (!task.brief.trim()) errors.push(`${label} 缺少名称说明`);
      if (!task.dependsOn.length) errors.push(`${label} 还没有前置任务：先从上游连一条线进来`);
      if (task.route) errors.push(`${label} 是逐项任务，不能配置分流条件`);
      if (task.routeBranch) errors.push(`${label} 是逐项任务，不设置分支标记`);
      if (task.waitStep) errors.push(`${label} 是逐项任务，不能配置事件等待`);
      const forEach = task.forEach;
      if (!forEach) {
        errors.push(`${label} 缺少逐项处理定义`);
      } else {
        const owner = draft.tasks.find((candidate) => candidate.outputs.includes(forEach.source));
        if (!forEach.source || !owner) errors.push(`${label} 的列表来源不是任何前置任务的产物：先连线，再选择要逐项处理的清单`);
        else {
          if (!task.dependsOn.includes(owner.id)) errors.push(`${label} 的列表来源必须来自直接前置任务的产物`);
        }
        if (!forEach.itemOutput.includes("{item}")) errors.push(`${label} 的产物模板必须包含 {item} 占位`);
        else if (forEach.itemOutput.replace("{item}", "x").startsWith("/") || forEach.itemOutput.replace("{item}", "x").includes("..")) errors.push(`${label} 的产物模板路径越界`);
        if (!forEach.itemBrief?.trim()) errors.push(`${label} 缺少逐项简报`);
        if (forEach.onFailure && forEach.onFailure !== "pause" && forEach.onFailure !== "skip") errors.push(`${label} 的失败策略无效`);
      }
      if (task.requiresApproval || task.gateDownstream || (task.maxRework ?? 0) > 0) {
        errors.push(`${label} 是逐项任务，不支持完成后确认、结论把关或返工`);
      }
      if (task.waitStep) errors.push(`${label} 是逐项任务，不能配置事件等待`);
    } else if (task.kind === "human") {
      // 人工任务的规则：主理人亲自完成，提交即验收，不叠加确认或把关。
      if (task.role) errors.push(`${label} 是人工任务，不选择专家`);
      if (task.outputs.length !== 1) errors.push(`${label} 需要恰好一个产物路径：主理人的提交会写入它`);
      if (task.requiresApproval) errors.push(`${label} 是人工任务，不需要完成后确认：主理人提交本身就是产出`);
      if (task.gateDownstream || (task.maxRework ?? 0) > 0) errors.push(`${label} 是人工任务，不支持结论把关或返工`);
      if (task.route || task.forEach || task.waitStep || task.routeBranch) errors.push(`${label} 是人工任务，不支持分流、逐项、等待或分支配置`);
    } else if (task.kind === "experiment") {
      // 实验节点的规则：无专家、声明运行产物；契约绑定与 G2/G3 授权沿用运行流程。
      if (task.role) errors.push(`${label} 是实验节点，不选择专家：运行由引擎按已批准的契约提交`);
      if (!task.outputs.length || task.outputs.length > 30) errors.push(`${label} 需要 1–30 个产物路径：运行结束后按它们验收`);
      if (task.requiresApproval) errors.push(`${label} 是实验节点，不需要完成后确认：G2/G3 批准即授权运行`);
      if (task.gateDownstream || (task.maxRework ?? 0) > 0) errors.push(`${label} 是实验节点，不支持结论把关或返工`);
      if (task.route || task.forEach || task.waitStep || task.routeBranch) errors.push(`${label} 是实验节点，不支持分流、逐项、等待或分支配置`);
    } else if (task.kind === "wait") {
      // 等待节点的规则：等研究目录下路径出现，超时转失败等待主理人。
      if (task.role) errors.push(`${label} 是等待节点，不选择专家`);
      if (task.outputs.length) errors.push(`${label} 是等待节点，不产出文件`);
      if (task.requiresApproval || task.gateDownstream || (task.maxRework ?? 0) > 0) errors.push(`${label} 是等待节点，不支持完成后确认、结论把关或返工`);
      if (task.route || task.forEach || task.routeBranch) errors.push(`${label} 是等待节点，不支持分流、逐项或分支配置`);
      const waitStep = task.waitStep;
      if (!waitStep) {
        errors.push(`${label} 缺少等待定义`);
      } else {
        if (!waitStep.source) errors.push(`${label} 缺少等待路径：先填要等待出现的文件`);
        if (waitStep.source && (waitStep.source.startsWith("/") || waitStep.source.includes(".."))) errors.push(`${label} 的等待路径越界`);
        const timeout = waitStep.timeoutMinutes ?? 0;
        if (!Number.isInteger(timeout) || timeout < 0 || timeout > 24 * 60) errors.push(`${label} 的超时需为 0–1440 分钟（0 表示不限时）`);
      }
    } else {
      if (!knownAgents.has(task.role)) errors.push(`${label} 选择了不存在的专家：${task.role}`);
      if (!task.brief.trim()) errors.push(`${label} 缺少任务简报`);
      if (!task.outputs.length) errors.push(`${label} 至少需要一个产物路径`);
      if (task.route) errors.push(`${label} 不是分流节点，不能配置分流条件`);
      if (task.forEach) errors.push(`${label} 不是逐项任务，不能配置逐项处理`);
      if (task.waitStep) errors.push(`${label} 不是等待节点，不能配置事件等待`);
    }
    for (const output of task.outputs) {
      if (!output || output.startsWith("/") || output.includes("..") || output.includes("\\") || output.includes(":")) errors.push(`${label} 的产物路径无效：${output || "（空）"}`);
      if (outputs.has(output)) errors.push(`产物路径重复：${output}`);
      outputs.add(output);
    }
    for (const dependency of task.dependsOn) if (!ids.has(dependency)) errors.push(`${label} 依赖了已删除或不存在的前置任务：${dependency}`);
    if (task.routeBranch && task.routeBranch !== ROUTE_THEN && task.routeBranch !== ROUTE_ELSE) {
      errors.push(`${label} 的分支标记无效`);
    }
    if (task.routeBranch && !task.dependsOn.some((dependency) => routeById.has(dependency))) {
      errors.push(`${label} 标记了分支，但它的前置里没有分流节点`);
    }
    const waitFor = task.waitFor;
    if (waitFor && waitFor !== "all" && waitFor !== "any") errors.push(`${label} 的汇合策略无效`);
    if (waitFor === "any" && task.dependsOn.length < 2) errors.push(`${label} 的汇合策略「任一完成」需要至少两条前置连线`);
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
    if (isRoute && (task.requiresApproval || task.gateDownstream || (task.maxRework ?? 0) > 0)) {
      errors.push(`${label} 是分流节点，不支持完成后确认、结论把关或返工`);
    }
  }
  // 分支拓扑：每个分流节点的两条分支都要有后续任务，「不成立」即默认出口，必须显式存在。
  for (const route of routeById.values()) {
    const children = draft.tasks.filter((task) => task.dependsOn.includes(route.id));
    const hasThen = children.some((child) => child.routeBranch === ROUTE_THEN);
    const hasElse = children.some((child) => child.routeBranch === ROUTE_ELSE);
    if (children.some((child) => !child.routeBranch)) errors.push(`${taskLabel(route)} 有后续任务还没标记走「成立」还是「不成立」分支`);
    if (!children.length || !hasThen || !hasElse) errors.push(`${taskLabel(route)} 需要「成立」和「不成立」两条分支都有后续任务`);
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
  // 阶段分组框只占画布空间，与后端约定同一套上限。
  if ((draft.frames?.length ?? 0) > 12) errors.push("工作流最多包含 12 个阶段分组");
  for (const frame of draft.frames ?? []) {
    if (!frame.title.trim() || frame.title.length > 60) errors.push(`阶段分组「${frame.title || frame.id}」的名称需要为 1–60 个字符`);
    if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width < 160 || frame.height < 120 || frame.width > 6000 || frame.height > 6000) errors.push(`阶段分组「${frame.title}」的尺寸无效`);
  }
  // 画布草稿按自定义编排提交：专家与依赖由主理人自由组合，不做预设名册检查。
  // W1–W4 预设契约只约束聊天里 AI 自动路由登记的计划。
  return [...new Set(errors)];
}
