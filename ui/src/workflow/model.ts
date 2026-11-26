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
  /** 技能包里的文件数（含 SKILL.md）；内置技能没有这个字段。 */
  files?: number | null;
  updatedAt?: number | null;
  /** 历史上传：按需绑定上线前已存在，保留全局生效。 */
  legacyGlobal?: boolean;
  /** 绑定的项目 id 列表（生效范围）。 */
  boundProjects?: string[];
  /** 绑定的自定义专家 id 列表（生效范围）。 */
  boundAgents?: string[];
}

/** 详情页用的技能全貌：正文、文件清单，以及是否允许在页内修改。 */
export interface WorkflowSkillDetail {
  name: string;
  description: string;
  source: "builtin" | "user";
  origin?: string | null;
  bytes: number;
  files: { path: string; bytes: number }[];
  updatedAt?: number | null;
  /** SKILL.md 去掉 frontmatter 后的 Markdown 正文。 */
  body: string;
  editable: boolean;
}

export interface WorkflowAgent {
  id: string;
  name: string;
  description: string;
  /** 角色提示词；内置专家的提示词由核心调优维护，后端不下发。 */
  prompt?: string;
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

/** 研究负责人提交的 MCP 提案：用户在聊天卡片确认后才写入登记表。 */
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
  /** 完成后需研究负责人在人工确认页批准才放行下游。 */
  requiresApproval?: boolean;
  /** 结论把关：完成时读取 <首个产物>.verdict.json，有问题时暂停下游任务。 */
  gateDownstream?: boolean;
  /** 结论为阻塞时自动带意见返工上游的轮数上限（0–3）。 */
  maxRework?: number;
  /** 节点类型：缺省为专家任务；"route" 条件分流；"foreach" 逐项处理；"human" 研究负责人亲自完成；"experiment" 实验执行；"wait" 事件等待。 */
  kind?: "agent" | "route" | "foreach" | "human" | "experiment" | "wait";
  /** kind = "route" 时的条件定义。defaultBranch：结论拿不到时（上游失败或被跳过）的兜底分支，缺省为一直等。 */
  route?: { on: "verdict" | "failure"; source?: string; verdictIs?: "pass" | "blocked"; defaultBranch?: "then" | "else" };
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
    /** 部分失败策略：缺省暂停等待研究负责人；"skip" 跳过该项继续剩余项。 */
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

/** 工作流挑选界面的统一搜索：名称与任务说明都参与匹配，大小写不敏感；空关键词原样返回。 */
export function searchWorkflows(drafts: WorkflowDraft[], keyword: string): WorkflowDraft[] {
  const query = keyword.trim().toLowerCase();
  if (!query) return drafts;
  return drafts.filter((draft) => draft.name.toLowerCase().includes(query) || draft.tasks.some((task) => task.brief.toLowerCase().includes(query)));
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

/** 自动保存下编辑器不再强制先命名：新草稿先用默认名落库，研究负责人随时可以改名。 */
export const DEFAULT_WORKFLOW_NAME = "未命名工作流";

export function createBlankDraft(): WorkflowDraftInput {
  // 新建工作流从空白画布开始：任务为空，由研究负责人自行组合专家；名称先用默认名，
  // 编辑器里的改动由自动保存落库，改名直接覆盖。
  return {
    name: DEFAULT_WORKFLOW_NAME,
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
  // 默认展示三种控制属性：检索策略需研究负责人确认，审稿阻塞时自动返工写作，审计阻塞时拦截下游。
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

/** AI 排流程的返回：名称加一组节点（专家任务 + 可选的人工/逐项/分流节点）。后端只保证结构与引用合法，不带画布坐标。 */
export interface GeneratedWorkflowDraft {
  name: string;
  tasks: WorkflowTask[];
}

/** 同一层的任务并排展开的间距：对齐现有网格的 320 列距，节点宽 256，互不遮挡。 */
const LAYER_PEER_GAP = 320;
/** 层与层之间的间距：节点高度随内容变化，留出简报折叠后仍不重叠的距离。 */
const LAYER_STEP = 300;
/**
 * 排版时假设的画布形状（宽 ÷ 高）。编辑器是「节点库 | 画布 | 属性栏」三栏，画布实测
 * 约 460×670，是个竖长的区域——流程自上而下走能用上它更长的那条边。这个值只在两种
 * 排法之间做比较用，不参与实际渲染；窗口变化时 fitView 自己会再适配。
 */
const CANVAS_ASPECT = 460 / 670;

/** 每个任务所在的层：= 它最晚完成的前置所在层 + 1。成环等不到前置的任务兜底落回第 0 层。 */
function dependencyRanks(tasks: WorkflowTask[]): Map<string, number> {
  const ranks = new Map<string, number>();
  const remaining = new Set(tasks.map((task) => task.id));
  while (remaining.size) {
    let advanced = false;
    for (const task of tasks) {
      if (!remaining.has(task.id) || task.dependsOn.some((id) => remaining.has(id))) continue;
      ranks.set(task.id, Math.max(-1, ...task.dependsOn.filter((id) => ranks.has(id)).map((id) => ranks.get(id)!)) + 1);
      remaining.delete(task.id);
      advanced = true;
    }
    // 一份坏草稿不该把界面卡死：剩下的都在环里，直接放到起点层。
    if (!advanced) { for (const id of remaining) ranks.set(id, 0); break; }
  }
  return ranks;
}

/**
 * 按依赖分层排版：同一层的任务按声明顺序并排。方向按流程形状和画布形状一起选——
 * 画布打开时要把整张图放进视野，能放多大取决于内容的长边落在画布的哪条边上。
 * 所以分别算「流程横着走」和「流程竖着走」各能得到的缩放，取大的那个。
 */
export function layeredPositions(tasks: WorkflowTask[]): Record<string, FlowPoint> {
  const ranks = dependencyRanks(tasks);
  const widthOf = new Map<number, number>();
  let layerCount = 0;
  for (const rank of ranks.values()) {
    widthOf.set(rank, (widthOf.get(rank) ?? 0) + 1);
    layerCount = Math.max(layerCount, rank + 1);
  }
  const widest = Math.max(0, ...widthOf.values());
  // 内容在「流程方向」与「并排方向」上各占多长。
  const along = layerCount * LAYER_STEP;
  const across = widest * LAYER_PEER_GAP;
  // 画布按上面的比例归一成「宽 = CANVAS_ASPECT、高 = 1」；放进视野的缩放是两个方向里更紧的那个。
  const fitZoom = (wide: number, tall: number) => Math.min(CANVAS_ASPECT / wide, 1 / tall);
  // 横排：流程方向占画布的宽边。竖排：流程方向占画布的高边。
  const horizontal = fitZoom(along, across) >= fitZoom(across, along);
  const seen = new Map<number, number>();
  return Object.fromEntries(tasks.map((task) => {
    const rank = ranks.get(task.id) ?? 0;
    const peer = seen.get(rank) ?? 0;
    seen.set(rank, peer + 1);
    const flow = rank * LAYER_STEP;
    const side = peer * LAYER_PEER_GAP;
    return [task.id, horizontal ? { x: flow, y: side } : { x: side, y: flow }];
  }));
}

/**
 * AI 生成的任务组 → 可直接进编辑器的完整草稿。坐标按依赖分层补齐；名称用模型给的，
 * 空则落回默认名；目标与摘要是提交运行时才收集的内容，这里保持为空。
 */
export function generatedToDraftInput(generated: GeneratedWorkflowDraft): WorkflowDraftInput {
  return {
    name: generated.name.trim() || DEFAULT_WORKFLOW_NAME,
    objective: "",
    summary: "",
    workflow: "custom",
    tasks: generated.tasks,
    positions: layeredPositions(generated.tasks),
    viewport: null,
    frames: [],
  };
}

/**
 * 从流式回复的累计文本里取出已经写完的任务。模型一次输出一个 JSON 对象，
 * 任务在 "tasks" 数组里按顺序到达：只收花括号配平的完整对象，尾部没写完的
 * 留到下一次；缺 id/brief 的跳过（控制节点没有 role，按 kind 保留）。最终仍以后端的结构校验结果为准。
 */
export function parsePartialTasks(text: string): WorkflowTask[] {
  const key = text.indexOf('"tasks"');
  if (key < 0) return [];
  const open = text.indexOf("[", key);
  if (open < 0) return [];
  const tasks: WorkflowTask[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const task = parseStreamedTask(text.slice(start, index + 1));
        if (task && !seen.has(task.id)) {
          seen.add(task.id);
          tasks.push(task);
        }
        start = -1;
      }
    } else if (char === "]" && depth === 0) {
      break;
    }
  }
  return tasks;
}

const STREAMED_CONTROL_KINDS = new Set(["route", "foreach", "human", "experiment", "wait"]);

function parseStreamedTask(raw: string): WorkflowTask | null {
  let value: Partial<WorkflowTask>;
  try {
    value = JSON.parse(raw) as Partial<WorkflowTask>;
  } catch {
    return null;
  }
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  // 控制节点没有专家角色，但同样要在流式预览里出现；专家任务仍要求角色。
  const kind = typeof value.kind === "string" && STREAMED_CONTROL_KINDS.has(value.kind)
    ? value.kind as WorkflowTask["kind"]
    : undefined;
  if (!kind && (typeof value.role !== "string" || !value.role.trim())) return null;
  if (typeof value.brief !== "string") return null;
  const strings = (input: unknown) =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  const object = (input: unknown) => input && typeof input === "object" && !Array.isArray(input) ? input : null;
  // 流式 JSON 里分支用模型协议的 "branch"；草稿字段叫 routeBranch。
  const rawBranch = (value as { branch?: unknown }).branch;
  const branch = value.routeBranch === "then" || value.routeBranch === "else"
    ? value.routeBranch
    : rawBranch === "then" || rawBranch === "else" ? rawBranch : undefined;
  return {
    id: value.id.trim(),
    role: kind ? "" : (value.role as string).trim(),
    brief: value.brief,
    dependsOn: strings(value.dependsOn),
    outputs: strings(value.outputs),
    ...(kind ? { kind } : {}),
    ...(object(value.route) ? { route: value.route } : {}),
    ...(object(value.forEach) ? { forEach: value.forEach } : {}),
    ...(branch ? { routeBranch: branch } : {}),
    ...(value.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(value.gateDownstream === true ? { gateDownstream: true } : {}),
    ...(object(value.waitStep) ? { waitStep: value.waitStep } : {}),
  };
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
  // 报错要能和画布对上：卡片上显示的就是节点名（专家名或自起的名称），这里只用名字指代节点。
  // 内部 ID 不进报错——画布上看不到它，写出来只会增加阅读负担。
  const taskLabel = (task: WorkflowTask) => {
    if (task.kind === "route") return `「${task.brief.trim() || "条件分流"}」`;
    if (task.kind === "foreach") return `「${task.brief.trim() || "逐项处理"}」`;
    if (task.kind === "human") return `「${task.brief.trim() || "人工任务"}」`;
    if (task.kind === "experiment") return `「${task.brief.trim() || "实验节点"}」`;
    if (task.kind === "wait") return `「${task.brief.trim() || "事件等待"}」`;
    const name = agents.find((agent) => agent.id === task.role)?.name;
    return `「${name?.trim() || task.role || task.id}」`;
  };
  const routeById = new Map(draft.tasks.filter((task) => task.kind === "route").map((task) => [task.id, task]));
  if (!draft.tasks.length) errors.push("画布上还没有任务：从左侧拖一个专家进来，或点「AI 排流程」用一句话生成。");
  if (draft.tasks.length > 40) errors.push("任务太多了：一个工作流最多 40 个任务，先合并或删掉一些。");
  const ids = new Set(draft.tasks.map((task) => task.id));
  if (ids.size !== draft.tasks.length) errors.push("有两个任务的内部编号重复：删掉其中一个，再加回来。");
  const knownAgents = new Set(agents.map((agent) => agent.id));
  const outputs = new Set<string>();
  for (const task of draft.tasks) {
    const label = taskLabel(task);
    if (!task.id || task.id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(task.id)) errors.push(`任务的内部编号无效（当前：${task.id || "空"}）：只能用字母、数字、下划线和短横线，最多 80 个字符。`);
    const isRoute = task.kind === "route";
    if (isRoute) {
      // 分流节点的规则：不选专家、不产出文件、必须有前置和条件，两条分支都要有后续。
      if (task.role) errors.push(`${label}是分流节点，只负责走哪条路，不用选专家：删掉这个节点，重新拖一个「条件分流」。`);
      if (task.outputs.length) errors.push(`${label}是分流节点，不产出文件：删掉这个节点，重新拖一个「条件分流」。`);
      if (!task.brief.trim()) errors.push(`${label}还没起名：在右侧「名称」里写一个，方便在画布上认出它。`);
      const route = task.route;
      // 判断依据要读前置结论时，下面「结论还没有来源」已经说了怎么连线，这里不再重复。
      if (!task.dependsOn.length && route?.on !== "verdict") errors.push(`${label}还没有前置任务：先从上游连一条线进来。`);
      if (!route) {
        errors.push(`${label}还没设置判断依据：在右侧「判断依据」里选一项。`);
      } else if (route.on === "verdict") {
        if (route.verdictIs !== "pass" && route.verdictIs !== "blocked") errors.push(`${label}的成立条件只能是「通过」或「有问题」：在右侧重新选一次。`);
        const owner = draft.tasks.find((candidate) => candidate.outputs.includes(route.source ?? ""));
        if (!route.source || !owner) errors.push(`${label}要读的结论还没有来源：先把它连到会给出结论的任务，再在右侧「读取哪个结论」里选。`);
        else {
          if (!task.dependsOn.includes(owner.id)) errors.push(`${label}只能读直接相连任务的结论：先把它和${taskLabel(owner)}连起来。`);
          if (!owner.gateDownstream) errors.push(`${label}想读${taskLabel(owner)}的结论，但那个任务没开「结论把关」：先给它打开，或换一处结论来源。`);
        }
      } else if (route.on === "failure") {
        if (route.source || route.verdictIs) errors.push(`${label}按「上游任务失败」判断，不用再选读哪个结论：这两项清空即可。`);
      } else {
        errors.push(`${label}的判断依据无效：在右侧「判断依据」里重新选。`);
      }
      if (route && route.defaultBranch && route.defaultBranch !== ROUTE_THEN && route.defaultBranch !== ROUTE_ELSE) errors.push(`${label}的兜底分支无效：在右侧「上游拿不到结论时走哪条」里重新选。`);
      if (task.forEach) errors.push(`${label}是分流节点，用不到逐项处理：删掉这个节点，重新拖一个「条件分流」。`);
      if (task.waitStep) errors.push(`${label}是分流节点，用不到事件等待：删掉这个节点，重新拖一个「条件分流」。`);
    } else if (task.kind === "foreach") {
      // 逐项任务的规则：不选专家、不产出文件，列表来源来自直接前置，模板必须含 {item}。
      if (task.role) errors.push(`${label}是逐项任务，会按清单一项一项执行，不用选专家：删掉这个节点，重新拖一个「逐项处理」。`);
      if (task.outputs.length) errors.push(`${label}是逐项任务，不直接写产物：每一项的文件按右侧「逐项产物模板」生成。`);
      if (!task.brief.trim()) errors.push(`${label}还没起名：在右侧「名称」里写一个，方便在画布上认出它。`);
      // 清单来源必须来自直接前置：下面的来源检查会一并说明怎么连线，这里不重复提示「没有前置任务」。
      if (task.route) errors.push(`${label}是逐项任务，用不到分流条件：删掉这个节点，重新拖一个「逐项处理」。`);
      if (task.routeBranch) errors.push(`${label}是逐项任务，不用标「成立 / 不成立」：删掉这个节点，重新拖一个「逐项处理」。`);
      if (task.waitStep) errors.push(`${label}是逐项任务，用不到事件等待：删掉这个节点，重新拖一个「逐项处理」。`);
      const forEach = task.forEach;
      if (!forEach) {
        errors.push(`${label}缺少逐项设置：删掉这个节点，重新拖一个「逐项处理」。`);
      } else {
        const owner = draft.tasks.find((candidate) => candidate.outputs.includes(forEach.source));
        if (!forEach.source || !owner) errors.push(`${label}还不知道按哪份清单逐项执行：先把它连到会产出清单的任务，再在右侧「列表来源」里选那份清单。`);
        else {
          if (!task.dependsOn.includes(owner.id)) errors.push(`${label}选的清单不在它的前置任务里：先把它和${taskLabel(owner)}连起来，或在「列表来源」里换一份。`);
        }
        if (!forEach.itemOutput.includes("{item}")) errors.push(`${label}的逐项产物模板里没有 {item}：每一项都会写到同一个文件，把 {item} 放回路径里，比如 readings/{item}.md。`);
        else if (forEach.itemOutput.replace("{item}", "x").startsWith("/") || forEach.itemOutput.replace("{item}", "x").includes("..")) errors.push(`${label}的逐项产物模板要用研究目录里的相对路径：不能以 / 开头，也不能带 ..。`);
        if (!forEach.itemBrief?.trim()) errors.push(`${label}还没写逐项简报：每一项要做什么，写在右侧「逐项简报」里。`);
        if (forEach.onFailure && forEach.onFailure !== "pause" && forEach.onFailure !== "skip") errors.push(`${label}的「某项失败时」只有两个选择：暂停等你处理，或跳过这一项。`);
      }
      if (task.requiresApproval || task.gateDownstream || (task.maxRework ?? 0) > 0) {
        errors.push(`${label}是逐项任务，没有「完成后确认 / 结论把关 / 返工」：删掉这个节点，重新拖一个「逐项处理」。`);
      }
    } else if (task.kind === "human") {
      // 人工任务的规则：用户亲自完成，提交即验收，不叠加确认或把关。
      if (task.role) errors.push(`${label}是人工任务，由你亲自完成，不用选专家：删掉这个节点，重新拖一个「人工任务」。`);
      if (task.outputs.length !== 1) errors.push(`${label}的「产出文件」只能填一个路径：你提交的内容会写进这个文件。`);
      if (task.requiresApproval) errors.push(`${label}是人工任务，提交就算完成，不用再设「完成后确认」：这处设置要去掉（删掉节点重新拖一个即可）。`);
      if (task.gateDownstream || (task.maxRework ?? 0) > 0) errors.push(`${label}是人工任务，不支持「结论把关」或「返工」：删掉这个节点，重新拖一个「人工任务」。`);
      if (task.route || task.forEach || task.waitStep || task.routeBranch) errors.push(`${label}是人工任务，用不到分流、逐项、等待或分支：删掉这个节点，重新拖一个「人工任务」。`);
    } else if (task.kind === "experiment") {
      // 实验节点的规则：无专家、声明运行产物；契约绑定与 G2/G3 授权沿用运行流程。
      if (task.role) errors.push(`${label}是实验节点，由系统直接运行，不用选专家：删掉这个节点，重新拖一个「实验节点」。`);
      if (!task.outputs.length || task.outputs.length > 30) errors.push(`${label}需要声明 1–30 个产物路径（每行一个）：跑完后系统逐个检查是否生成。`);
      if (task.requiresApproval) errors.push(`${label}是实验节点，开跑前你已经确认过一次，跑完不再停：这处「完成后确认」要去掉（删掉节点重新拖一个即可）。`);
      if (task.gateDownstream || (task.maxRework ?? 0) > 0) errors.push(`${label}是实验节点，不支持「结论把关」或「返工」：删掉这个节点，重新拖一个「实验节点」。`);
      if (task.route || task.forEach || task.waitStep || task.routeBranch) errors.push(`${label}是实验节点，用不到分流、逐项、等待或分支：删掉这个节点，重新拖一个「实验节点」。`);
    } else if (task.kind === "wait") {
      // 等待节点的规则：等研究目录下路径出现，超时转失败等待研究负责人。
      if (task.role) errors.push(`${label}是等待节点，只负责等文件出现，不用选专家：删掉这个节点，重新拖一个「事件等待」。`);
      if (task.outputs.length) errors.push(`${label}是等待节点，不产出文件：删掉这个节点，重新拖一个「事件等待」。`);
      if (task.requiresApproval || task.gateDownstream || (task.maxRework ?? 0) > 0) errors.push(`${label}是等待节点，不支持「完成后确认 / 结论把关 / 返工」：删掉这个节点，重新拖一个「事件等待」。`);
      if (task.route || task.forEach || task.routeBranch) errors.push(`${label}是等待节点，用不到分流、逐项或分支：删掉这个节点，重新拖一个「事件等待」。`);
      const waitStep = task.waitStep;
      if (!waitStep) {
        errors.push(`${label}缺少等待设置：删掉这个节点，重新拖一个「事件等待」。`);
      } else {
        if (!waitStep.source) errors.push(`${label}还没填要等哪个文件：在右侧「等待出现的文件」里填上路径，文件一出现就继续。`);
        if (waitStep.source && (waitStep.source.startsWith("/") || waitStep.source.includes(".."))) errors.push(`${label}的等待路径要用研究目录里的相对路径：不能以 / 开头，也不能带 ..。`);
        const timeout = waitStep.timeoutMinutes ?? 0;
        if (!Number.isInteger(timeout) || timeout < 0 || timeout > 24 * 60) errors.push(`${label}的超时要在 0–1440 分钟之间（0 表示一直等）。`);
      }
    } else {
      if (!knownAgents.has(task.role)) errors.push(`${label}选的专家已经不在了：在右侧「Agent」里换一位。`);
      if (!task.brief.trim()) errors.push(`${label}还没写任务简报：在右侧「任务简报」里写清楚要它做什么。`);
      if (!task.outputs.length) errors.push(`${label}还没写产物：在右侧「声明产物」里写上它会生成的文件路径。`);
      if (task.route) errors.push(`${label}不是分流节点，用不到分流条件：这处设置要去掉（删掉节点重新拖一个即可）。`);
      if (task.forEach) errors.push(`${label}不是逐项任务，用不到逐项处理：这处设置要去掉（删掉节点重新拖一个即可）。`);
      if (task.waitStep) errors.push(`${label}不是等待节点，用不到事件等待：这处设置要去掉（删掉节点重新拖一个即可）。`);
    }
    for (const output of task.outputs) {
      if (!output || output.startsWith("/") || output.includes("..") || output.includes("\\") || output.includes(":")) errors.push(`${label}的产物路径无效（${output || "空"}）：要填研究目录里的相对路径，不能以 / 开头，也不能带 .. \\ :。`);
      if (outputs.has(output)) errors.push(`有两个任务要把结果写进同一个文件（${output}）：改掉其中一个路径。`);
      outputs.add(output);
    }
    for (const dependency of task.dependsOn) if (!ids.has(dependency)) errors.push(`${label}连着一个已经不存在的任务（${dependency}）：重新连一条线，或删掉这条线。`);
    if (task.routeBranch && task.routeBranch !== ROUTE_THEN && task.routeBranch !== ROUTE_ELSE) {
      errors.push(`${label}的「成立 / 不成立」标记无效：在右侧重新选一个。`);
    }
    if (task.routeBranch && !task.dependsOn.some((dependency) => routeById.has(dependency))) {
      errors.push(`${label}标了「成立 / 不成立」，但它的前置里没有分流节点：先连一个分流节点，或去掉这个标记。`);
    }
    const waitFor = task.waitFor;
    if (waitFor && waitFor !== "all" && waitFor !== "any") errors.push(`${label}的汇合方式无效：在右侧「汇合方式」里重新选。`);
    if (waitFor === "any" && task.dependsOn.length < 2) errors.push(`${label}选了「任一前置完成即继续」，但只连了一个前置：再连一个，或改回「等全部前置完成」。`);
    const depOutputs = new Set(task.dependsOn.flatMap((dependency) => draft.tasks.find((t) => t.id === dependency)?.outputs ?? []));
    const seenInputs = new Set<string>();
    for (const input of task.inputs ?? []) {
      if (!depOutputs.has(input)) errors.push(`${label}的输入 ${input} 不是直接前置任务的产物：先把它连到产出这个文件的任务，再回来勾选。`);
      if (seenInputs.has(input)) errors.push(`${label}重复勾了同一个输入：${input}。`);
      seenInputs.add(input);
    }
    const maxRework = task.maxRework ?? 0;
    if (!Number.isInteger(maxRework) || maxRework < 0 || maxRework > MAX_REWORK) errors.push(`${label}的返工上限要在 0–${MAX_REWORK} 之间：在右侧「结论有问题时自动返工」里重新选。`);
    if (maxRework > 0 && !task.gateDownstream) errors.push(`${label}设了自动返工，但没开「结论把关」：返工由结论触发，先打开结论把关。`);
    if (task.gateDownstream && !task.dependsOn.length) errors.push(`${label}开了「结论把关」，但前面没有任务可把关：先连一个前置任务进来，或关掉结论把关。`);
    if (isRoute && (task.requiresApproval || task.gateDownstream || (task.maxRework ?? 0) > 0)) {
      errors.push(`${label}是分流节点，不支持「完成后确认 / 结论把关 / 返工」：删掉这个节点，重新拖一个「条件分流」。`);
    }
  }
  // 分支拓扑：每个分流节点的两条分支都要有后续任务，「不成立」即默认出口，必须显式存在。
  for (const route of routeById.values()) {
    const children = draft.tasks.filter((task) => task.dependsOn.includes(route.id));
    const hasThen = children.some((child) => child.routeBranch === ROUTE_THEN);
    const hasElse = children.some((child) => child.routeBranch === ROUTE_ELSE);
    if (children.some((child) => !child.routeBranch)) errors.push(`${taskLabel(route)}后面的任务还没定走「成立」还是「不成立」：选中那个任务，在右侧选一条分支。`);
    if (!children.length || !hasThen || !hasElse) errors.push(`${taskLabel(route)}要有两条出路：「成立」和「不成立」各连一个后续任务。`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { errors.push("任务的连线绕成了圈：删掉多余的一条线，让流程只往一个方向走。"); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    draft.tasks.find((task) => task.id === id)?.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  draft.tasks.forEach((task) => visit(task.id));
  // 阶段分组框只占画布空间，与后端约定同一套上限。
  if ((draft.frames?.length ?? 0) > 12) errors.push("阶段分组最多 12 个：先合并或删掉一些。");
  for (const frame of draft.frames ?? []) {
    if (!frame.title.trim() || frame.title.length > 60) errors.push(`阶段分组的名称要 1–60 个字符（当前：${frame.title || frame.id}）。`);
    if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width < 160 || frame.height < 120 || frame.width > 6000 || frame.height > 6000) errors.push(`阶段分组「${frame.title}」的尺寸超出了画布范围：拖动右下角把它调小。`);
  }
  // 画布草稿按自定义编排提交：专家与依赖由研究负责人自由组合，不做预设名册检查。
  // W1–W4 预设契约只约束聊天里 AI 自动路由登记的计划。
  return [...new Set(errors)];
}
