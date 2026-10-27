import presets from "./researchWorkflows.json" with { type: "json" };

export type PresetWorkflowMode = keyof typeof presets;
export const presetWorkflowModes = Object.keys(presets) as PresetWorkflowMode[];
export const researchPresets = presets;
/** Legacy modes remain readable for existing studies. */
export type ResearchMode = PresetWorkflowMode | "team" | "design" | "diagnosis" | "review";
export const researchModes: Record<ResearchMode, string> = {
  literature: presets.literature.title, reproduction: presets.reproduction.title, analysis: presets.analysis.title, proposal: presets.proposal.title,
  team: "专家团模式", design: "方案设计会诊", diagnosis: "失败异常诊断", review: "独立审稿与引用核验",
};
export const researchStates: Record<string, string> = {
  pending: "待执行", running: "执行中 / 待验收", completed: "产物已验收", failed: "未通过", cancelled: "已取消",
};
export const gateNames: Record<string, string> = { G1: "研究范围与目标", G2: "资源与权限", G3: "实验方案与执行", G4: "研究包交付" };
export interface ResearchTask {
  id: string; role: string; brief: string; dependsOn: string[]; outputs: string[];
  state: string; sessionId: string | null; summary: string | null;
  runContract?: { experimentId: string } | null;
  artifacts: { path: string; sha256: string; bytes: number }[]; runIds: string[];
}
export interface ResearchDecision {
  id: string; gate: string; version: number; scope: string; scopeHash: string;
  status: "pending" | "approved" | "rejected"; reason: string | null;
}
export interface ResearchStudy {
  id: string; sessionId: string; mode: ResearchMode; objective: string; status: string;
  plans: { version: number; workflow?: PresetWorkflowMode | null; summary: string; tasks: ResearchTask[] }[];
  decisions: ResearchDecision[];
  claims: { id: string; text: string; support: string; source: string; location?: string; runId?: string; excerpt?: string }[];
}
export interface ResearchMetrics {
  activeDurationMs: number | null;
  tokenCount: number | null;
  tokenCountComplete: boolean;
  measuredAt: number;
  running: boolean;
}

export function researchDuration(metrics: ResearchMetrics | null | undefined, now = Date.now()): string {
  if (metrics?.activeDurationMs == null) return "—";
  const seconds = Math.max(0, Math.floor((metrics.activeDurationMs + (metrics.running ? Math.max(0, now - metrics.measuredAt) : 0)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}小时${String(minutes).padStart(2, "0")}分` : `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
}

/** Category stays fixed; automatic routing is versioned with the plan. */
export function researchWorkflowMode(study: ResearchStudy): ResearchMode {
  return study.mode === "team" ? study.plans.at(-1)?.workflow ?? "team" : study.mode;
}
export function currentDecisions(study: ResearchStudy): ResearchDecision[] {
  const version = study.plans.at(-1)?.version;
  return study.decisions.filter((decision) => decision.version === version);
}
export function researchProgress(study: ResearchStudy) {
  const tasks = study.plans.at(-1)?.tasks ?? [];
  return { completed: tasks.filter((task) => task.state === "completed").length, total: tasks.length };
}

export const expertRoles: Record<string, string> = {
  "as-asset-auditor": "科研资产审计专家",
  "as-code-data-engineer": "科研代码工程专家",
  "as-evidence-writer": "证据写作专家",
  "as-experiment-designer": "实验设计专家",
  "as-experiment-diagnostician": "实验诊断专家",
  "as-experiment-operator": "实验执行专家",
  "as-feasibility-advisor": "科研可行性顾问",
  "as-figure-citation-editor": "图表引用编辑专家",
  "as-independent-reviewer": "独立审稿专家",
  "as-intent-router": "科研需求识别专家",
  "as-literature-researcher": "论文发现专家",
  "as-literature-strategist": "文献检索策略专家",
  "as-methodology-designer": "方法论设计专家",
  "as-outline-architect": "论证大纲专家",
  "as-paper-evidence-analyst": "论文证据分析专家",
  "as-quality-citation-auditor": "引用审计专家",
  "as-research-package-curator": "研究包归档专家",
  "as-research-planner": "研究规划专家",
  "as-research-synthesizer": "研究综合专家",
  "as-result-analyst": "结果分析专家",
};

export type WorkflowState = "waiting" | "running" | "completed" | "blocked" | "optional" | "stopped";
export const workflowStateNames: Record<WorkflowState, string> = {
  waiting: "待推进", running: "进行中", completed: "已完成", blocked: "待处理", optional: "按需安排", stopped: "已停止",
};
export const researchStages = [
  { id: "intake", title: "目标与材料", description: "澄清目标，盘点已有论文、代码和数据", gates: [], roles: ["as-intent-router", "as-asset-auditor", "as-research-planner"] },
  { id: "scope", title: "范围确认", description: "确认研究边界、交付物和停止条件", gates: ["G1"], roles: [] },
  { id: "design", title: "文献与方案", description: "检索证据，设计方法、基线与评价方案", gates: [], roles: ["as-literature-researcher", "as-literature-strategist", "as-paper-evidence-analyst", "as-feasibility-advisor", "as-methodology-designer", "as-experiment-designer", "as-code-data-engineer", "as-outline-architect"] },
  { id: "approval", title: "实验授权", description: "确认算力资源、代码版本和运行方案", gates: ["G2", "G3"], roles: [] },
  { id: "execution", title: "实验与论证", description: "运行实验，分析结果并形成有证据的结论", gates: [], roles: ["as-experiment-operator", "as-experiment-diagnostician", "as-result-analyst", "as-research-synthesizer", "as-evidence-writer", "as-figure-citation-editor"] },
  { id: "review", title: "独立审查", description: "独立审稿与引用核验，反馈阻塞问题", gates: [], roles: ["as-independent-reviewer", "as-quality-citation-auditor"] },
  { id: "delivery", title: "研究交付", description: "归档产物和证据，确认研究包", gates: ["G4"], roles: ["as-research-package-curator"] },
] as const;

/** Derived from persisted facts; the overview is a guide, not a second scheduler. */
export function researchWorkflow(study: ResearchStudy) {
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const decisions = currentDecisions(study);
  const experimental = tasks.some((task) => task.role === "as-experiment-operator");
  return researchStages.map((originalStage) => {
    const stage = researchWorkflowMode(study) === "proposal" && originalStage.id === "delivery"
      ? { ...originalStage, title: "方案交付", description: "确认实验方案；不自动运行实验", gates: ["G3"] } : originalStage;
    const members = tasks.filter((task) => (stage.roles as readonly string[]).includes(task.role));
    const gates = decisions.filter((decision) => (stage.gates as readonly string[]).includes(decision.gate));
    const optional = stage.id === "approval" && (!experimental && (study.mode !== "team" || study.plans.length > 0));
    let state: WorkflowState = "waiting";
    if (optional) state = "optional";
    else if (members.some((task) => task.state === "failed" || task.state === "cancelled") || gates.some((gate) => gate.status === "rejected")) state = "blocked";
    else if (gates.some((gate) => gate.status === "pending")) state = "blocked";
    else if (members.some((task) => task.state === "running")) state = "running";
    else if ((members.length > 0 || gates.length > 0) && members.every((task) => task.state === "completed") && gates.every((gate) => gate.status === "approved") && (stage.id !== "delivery" || gates.some((gate) => gate.gate === deliveryGate(researchWorkflowMode(study))))) state = "completed";
    else if (stage.id === "intake" && tasks.length === 0) state = "running";
    else if (stage.id === "intake" && members.length === 0 && study.plans.length > 0) state = "completed";
    else if (members.length === 0 && stage.gates.length === 0 && study.plans.length > 0) state = "optional";
    if (study.status === "stopped" && state !== "completed" && state !== "optional") state = "stopped";
    return { ...stage, state, tasks: members, decisions: gates };
  });
}

export function researchAttention(study: ResearchStudy) {
  if (study.status === "stopped") return "研究已停止";
  const decisions = currentDecisions(study);
  const rejected = decisions.filter((decision) => decision.status === "rejected");
  if (rejected.length) return `${[...new Set(rejected.map((decision) => decision.gate))].join(" / ")} 已拒绝 · 等待调整计划`;
  const pending = decisions.filter((decision) => decision.status === "pending");
  if (pending.length) return `等待你确认 ${[...new Set(pending.map((decision) => decision.gate))].join(" / ")}`;
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const failed = tasks.filter((task) => ["failed", "cancelled"].includes(task.state));
  if (failed.length) return `${failed.length} 个任务需处理`;
  const active = tasks.filter((task) => task.state === "running");
  if (active.length) return `${active.length} 位专家执行中 / 待验收`;
  if (decisions.some((decision) => decision.gate === deliveryGate(researchWorkflowMode(study)) && decision.status === "approved")) return researchWorkflowMode(study) === "proposal" ? "实验方案已确认 · 未授权运行实验" : "当前研究包已批准";
  if (!tasks.length) return "主理人正在梳理目标与材料";
  if (tasks.every((task) => task.state === "completed")) return "任务已验收 · 等待研究包确认";
  return "计划已登记 · 等待推进就绪任务";
}

export function researchTaskStatus(study: ResearchStudy, task: ResearchTask): { state: WorkflowState; label: string } {
  if (task.state === "completed") return { state: "completed", label: "产物已验收" };
  if (study.status === "stopped") return { state: "stopped", label: "已停止" };
  if (task.state === "running") return { state: "running", label: "执行中 / 待验收" };
  if (["failed", "cancelled"].includes(task.state)) return { state: "blocked", label: researchStates[task.state] };
  const decisions = currentDecisions(study);
  if (!decisions.some((decision) => decision.gate === "G1" && decision.status === "approved")) return { state: "blocked", label: "等待 G1 范围确认" };
  const tasks = study.plans.at(-1)?.tasks ?? [];
  if (task.dependsOn.some((id) => tasks.find((entry) => entry.id === id)?.state !== "completed")) return { state: "waiting", label: "等待前置任务" };
  if (task.role === "as-experiment-operator") {
    const contract = task.runContract;
    if (!contract) return { state: "waiting", label: "等待准备运行契约" };
    const approvals = decisions.filter((decision) => {
      try { return JSON.parse(decision.scope).experimentId === contract.experimentId; } catch { return false; }
    });
    if (["G2", "G3"].some((gate) => !approvals.some((decision) => decision.gate === gate && decision.status === "approved"))) return { state: "blocked", label: "等待 G2 / G3 授权" };
  }
  return { state: "waiting", label: "已就绪 · 待派发" };
}

/** Topological ranks preserve real parallel branches, independent of plan order. */
export function researchDagLayout(tasks: ResearchTask[]) {
  const ranks = new Map<string, number>();
  const remaining = new Set(tasks.map((task) => task.id));
  while (remaining.size) {
    let advanced = false;
    for (const task of tasks) {
      if (!remaining.has(task.id) || task.dependsOn.some((id) => remaining.has(id))) continue;
      ranks.set(task.id, Math.max(0, ...task.dependsOn.map((id) => (ranks.get(id) ?? -1) + 1)));
      remaining.delete(task.id);
      advanced = true;
    }
    // A malformed legacy plan should never freeze the UI.
    if (!advanced) { for (const id of remaining) ranks.set(id, 0); break; }
  }
  const rows = new Map<number, number>();
  return tasks.map((task) => {
    const rank = ranks.get(task.id) ?? 0;
    const row = rows.get(rank) ?? 0;
    rows.set(rank, row + 1);
    return { id: task.id, x: rank * 300, y: row * 150 };
  });
}


export type ConsultationMode = Exclude<ResearchMode, "team">;
export const deliveryGate = (mode: ResearchMode) => mode in presets ? presets[mode as PresetWorkflowMode].deliveryGate : "G4";
export interface ConsultationModule {
  purpose: string;
  inputs: string;
  deliverables: string;
  requiredRoles: string[];
  steps: { title: string; description: string; roles: string[] }[];
}
/** Shared preset profiles plus read-only descriptions of legacy consultations. */
export const consultationModules: Record<ConsultationMode, ConsultationModule> = {
  ...presets,
  design: {
    purpose: "判断课题是否可行，形成可执行的研究方案。",
    inputs: "研究问题、已有论文 / 代码 / 数据、期望成果及时间或资源限制；缺失材料可先说明。",
    deliverables: "可行性建议、方法与基线、评价方案、风险和后续实验建议。",
    requiredRoles: [],
    steps: [
      { title: "理解目标与材料", description: "澄清研究问题，盘点已有资产。", roles: ["as-intent-router", "as-asset-auditor", "as-research-planner"] },
      { title: "查找与分析证据", description: "按需检索相关工作，核对可用证据。", roles: ["as-literature-strategist", "as-literature-researcher", "as-paper-evidence-analyst"] },
      { title: "评估与设计方案", description: "比较可行性，设计方法、基线和评价。", roles: ["as-feasibility-advisor", "as-methodology-designer", "as-experiment-designer", "as-code-data-engineer"] },
      { title: "汇总设计建议", description: "解释推荐方案、局限和下一步。", roles: ["as-research-synthesizer", "as-outline-architect", "as-evidence-writer"] },
    ],
  },
  diagnosis: {
    purpose: "分析已有失败或异常，给出可检查的原因假设与排查建议。",
    inputs: "异常现象、预期结果、日志、代码 / 数据版本及运行配置；请明确哪些材料尚不可用。",
    deliverables: "异常分析、证据与原因假设、排查顺序及补充验证建议。",
    requiredRoles: [],
    steps: [
      { title: "收集异常与上下文", description: "确认预期行为和可用运行材料。", roles: ["as-intent-router", "as-asset-auditor", "as-research-planner"] },
      { title: "检查代码与数据", description: "按需检查实现、输入和配置。", roles: ["as-code-data-engineer", "as-paper-evidence-analyst"] },
      { title: "分析原因与结果", description: "从实际证据提出原因假设，区分已证实与待验证。", roles: ["as-experiment-diagnostician", "as-result-analyst", "as-methodology-designer"] },
      { title: "形成排查建议", description: "汇总排查步骤和所需补充实验。", roles: ["as-research-synthesizer", "as-evidence-writer", "as-experiment-designer"] },
    ],
  },
  review: {
    purpose: "独立检查结论、论证和引用是否得到证据支持。",
    inputs: "待审报告 / 论文、引用来源、已有实验结果与日志，并说明希望重点审查的部分。",
    deliverables: "独立审稿报告、引用核验记录、阻塞问题与改进清单。",
    requiredRoles: ["as-independent-reviewer", "as-quality-citation-auditor"],
    steps: [
      { title: "盘点报告与证据", description: "整理待审结论及其来源。", roles: ["as-intent-router", "as-asset-auditor", "as-paper-evidence-analyst"] },
      { title: "独立审查论证", description: "检查方法、结论和研究局限，报告阻塞问题。", roles: ["as-independent-reviewer"] },
      { title: "核验引用", description: "在独立审稿之后审计引用与证据支持。", roles: ["as-quality-citation-auditor"] },
      { title: "汇总审查交付", description: "按需整理问题清单和审查产物。", roles: ["as-research-synthesizer", "as-figure-citation-editor", "as-research-package-curator"] },
    ],
  },
};
export function consultationCoverage(study: ResearchStudy) {
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const roles = [...new Set(tasks.map((task) => task.role))];
  const mode = researchWorkflowMode(study);
  const profile = mode === "team" ? null : consultationModules[mode];
  const candidates = profile ? [...new Set(profile.steps.flatMap((step) => step.roles))] : [];
  return {
    roles,
    unselected: candidates.filter((role) => !roles.includes(role)),
    dispatched: tasks.filter((task) => task.sessionId !== null && task.sessionId !== undefined).length,
    completed: tasks.filter((task) => task.state === "completed").length,
    total: tasks.length,
  };
}


// Adapted from App-CMCC ai-science/topology.ts: capability map, not runtime scheduling.
export const researchTeamLevels = [
  ["as-intent-router"],
  ["as-asset-auditor", "as-feasibility-advisor"],
  ["as-research-planner"],
  ["as-literature-strategist", "as-methodology-designer"],
  ["as-literature-researcher", "as-experiment-designer"],
  ["as-paper-evidence-analyst", "as-code-data-engineer"],
  ["as-research-synthesizer", "as-experiment-operator"],
  [
    "as-experiment-diagnostician",
    "as-result-analyst",
    "as-outline-architect",
  ],
  ["as-evidence-writer"],
  ["as-figure-citation-editor"],
  ["as-independent-reviewer"],
  ["as-quality-citation-auditor"],
  ["as-research-package-curator"],
] as const

export const researchTeamEdges = [
  ["as-intent-router", "as-asset-auditor"],
  ["as-intent-router", "as-feasibility-advisor"],
  ["as-intent-router", "as-research-planner"],
  ["as-asset-auditor", "as-research-planner"],
  ["as-feasibility-advisor", "as-research-planner"],
  ["as-research-planner", "as-literature-strategist"],
  ["as-research-planner", "as-methodology-designer"],
  ["as-literature-strategist", "as-literature-researcher"],
  ["as-literature-researcher", "as-paper-evidence-analyst"],
  ["as-paper-evidence-analyst", "as-research-synthesizer"],
  ["as-methodology-designer", "as-experiment-designer"],
  ["as-experiment-designer", "as-code-data-engineer"],
  ["as-code-data-engineer", "as-experiment-operator"],
  ["as-experiment-operator", "as-experiment-diagnostician"],
  ["as-experiment-operator", "as-result-analyst"],
  ["as-research-synthesizer", "as-outline-architect"],
  ["as-result-analyst", "as-outline-architect"],
  ["as-outline-architect", "as-evidence-writer"],
  ["as-evidence-writer", "as-figure-citation-editor"],
  ["as-figure-citation-editor", "as-independent-reviewer"],
  ["as-independent-reviewer", "as-quality-citation-auditor"],
  ["as-quality-citation-auditor", "as-research-package-curator"],
] as const


export function researchTeamGraph(study: ResearchStudy | null, actual = false) {
  const tasks = study?.plans.at(-1)?.tasks ?? [];
  const status = (members: ResearchTask[]) => {
    if (!members.length) return { state: "optional" as WorkflowState, label: study?.plans.length ? "本次未安排" : "能力预览" };
    const states = members.map((task) => researchTaskStatus(study!, task));
    const completed = members.filter((task) => task.state === "completed").length;
    const current = states.find((entry) => entry.state === "running") ?? states.find((entry) => entry.state === "blocked") ?? states.find((entry) => entry.state === "stopped") ?? states.find((entry) => entry.state === "waiting") ?? states[0];
    return { state: current.state, label: members.length === 1 ? current.label : `${completed}/${members.length} 已验收 · ${current.label}` };
  };
  if (!actual) return {
    nodes: researchTeamLevels.flatMap((level, rank) => level.map((role, index) => {
      const members = tasks.filter((task) => task.role === role);
      return { id: role, role, tasks: members, ...status(members), x: (index - (level.length - 1) / 2) * 280, y: rank * 65 };
    })),
    edges: researchTeamEdges.map(([source, target]) => ({ source, target })),
  };
  const positions = researchDagLayout(tasks);
  const ranks = [...new Set(positions.map((node) => node.x))].sort((a, b) => a - b);
  return {
    nodes: positions.map((position) => {
      const members = positions.filter((node) => node.x === position.x);
      const index = members.findIndex((node) => node.id === position.id);
      const task = tasks.find((entry) => entry.id === position.id)!;
      return { id: task.id, role: task.role, tasks: [task], ...status([task]), x: (index - (members.length - 1) / 2) * 280, y: ranks.indexOf(position.x) * 85 };
    }),
    edges: tasks.flatMap((task) => task.dependsOn.map((source) => ({ source, target: task.id }))),
  };
}
