import type { MaterialCitation } from "./materialCitation";
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
export const gateNames: Record<string, string> = { G1: "研究范围与目标", G2: "资源与权限", G3: "实验方案与执行", G4: "成果交付" };
/** G5:{任务id} 是任务确认门：任务完成后需研究负责人批准才放行下游。 */
export function gateDisplayName(gate: string): string {
  if (gate.startsWith("G5:")) return `任务确认 · ${gate.slice(3)}`;
  return gateNames[gate] ?? gate;
}
export interface ResearchTaskVerdict {
  status: "pass" | "blocked";
  reasons: string[];
  path: string;
  sha256: string;
}
export interface ResearchTask {
  id: string; role: string; brief: string; dependsOn: string[]; outputs: string[];
  state: string; sessionId: string | null; summary: string | null;
  previousSessions?: string[];
  attempts?: number;
  runContract?: { experimentId: string } | null;
  agent?: { id: string; name: string; version: number; prompt: string; mcpServers?: { id: string; name: string }[] | null } | null;
  artifacts: { path: string; sha256: string; bytes: number }[]; runIds: string[];
  inputs?: string[];
  requiresApproval?: boolean;
  gateDownstream?: boolean;
  maxRework?: number;
  verdict?: ResearchTaskVerdict | null;
  reworkCount?: number;
  reworkFeedback?: string | null;
  /** 节点类型：缺省为专家任务；"route" 分流；"foreach" 逐项处理；"human" 用户亲自完成；"experiment" 实验执行；"wait" 事件等待。 */
  kind?: "agent" | "route" | "foreach" | "human" | "experiment" | "wait";
  routeBranch?: "then" | "else";
  waitFor?: "all" | "any";
  routeDecision?: { outcome: "matched" | "unmatched" | "fallback"; basis: string; decidedAt: number } | null;
  forEach?: { source: string; itemOutput: string; itemBrief: string; onFailure?: "pause" | "skip" } | null;
  waitStep?: { source: string; timeoutMinutes?: number } | null;
  /** 事件等待开始计时的时间戳。 */
  waitStartedAt?: number | null;
  /** 逐项任务：就绪时固化的清单与已结束的迭代记录。 */
  foreachItems?: { id: string; title: string }[] | null;
  foreachRuns?: { itemId: string; itemTitle: string; ok: boolean; artifact?: { path: string } | null; summary?: string | null }[];
}
export interface ResearchDecision {
  id: string; gate: string; version: number; scope: string; scopeHash: string;
  status: "pending" | "approved" | "rejected" | "superseded"; reason: string | null;
}
export interface ResearchStudy {
  id: string; projectId: string; sessionId: string; mode: ResearchMode; objective: string; status: string;
  plans: { version: number; workflow?: PresetWorkflowMode | null; workflowSource?: { id: string; name: string; updatedAt: number } | null; summary: string; tasks: ResearchTask[] }[];
  decisions: ResearchDecision[];
  deliveryError?: string | null;
  /** 交付已确认、但工作区文件在确认后被改动；不是阻断错误。 */
  deliveryNotice?: string | null;
  /** deliveryNotice 的来源："human"（人工产物对账）或 "package"（交付包校验）；界面暂不消费。 */
  deliveryNoticeSource?: string | null;
  deliverySnapshot?: { scopeHash: string; identityHash: string; archive?: { formatVersion: number; sha256: string; bytes: number; manifestSha256: string } };
  claimRevision?: number;
  activeClaimIds?: string[];
  claimChanges?: ResearchClaimChange[];
  evidenceReviewRequired?: boolean;
  staleReviewTaskIds?: string[];
  claims: { id: string; text: string; support: string; source: string; location?: string; runId?: string; excerpt?: string; materialCitation?: MaterialCitation; metricCitation?: unknown }[];
}
export interface ResearchClaimChange {
  claimId: string; action: "withdrawn" | "replaced"; reason: string;
  actorSessionId: string; planVersion: number; revision: number;
  replacementId: string | null; claimHash: string; replacementHash: string | null;
  requestHash: string; changedAt: number;
}
export interface ResearchMetrics {
  activeDurationMs: number | null;
  activeDurationComplete?: boolean;
  tokenCount: number | null;
  tokenCountComplete: boolean;
  measuredAt: number;
  running: boolean;
}
/** 产物正文里的相对链接解析到验收登记的产物路径：先按研究根匹配，再按当前文件目录回退；
 * `artifacts/` 前缀（聊天引用约定）先剥掉。未命中登记清单的链接返回 null，由调用方保持纯文本。 */
export function resolveArtifactLinkPath(href: string, currentPath: string, paths: Set<string>): string | null {
  let candidate = href.replace(/^artifacts\//, "");
  try { candidate = decodeURIComponent(candidate); } catch { /* Keep literal registered paths. */ }
  if (paths.has(candidate)) return candidate;
  const base = currentPath.split("/").slice(0, -1);
  for (const segment of candidate.split("/")) {
    if (segment === "..") { if (!base.length) return null; base.pop(); }
    else if (segment && segment !== ".") base.push(segment);
  }
  const resolved = base.join("/");
  return paths.has(resolved) ? resolved : null;
}

export function researchDuration(metrics: ResearchMetrics | null | undefined, now = Date.now()): string {
  if (metrics?.activeDurationMs == null) return "—";
  const seconds = Math.max(0, Math.floor((metrics.activeDurationMs + (metrics.running ? Math.max(0, now - metrics.measuredAt) : 0)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const duration = hours ? `${hours}小时${String(minutes).padStart(2, "0")}分` : `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
  return `${metrics.activeDurationComplete === false ? "≥" : ""}${duration}`;
}

/** Category stays fixed; automatic routing is versioned with the plan. */
export function researchWorkflowMode(study: ResearchStudy): ResearchMode {
  return study.mode === "team" ? study.plans.at(-1)?.workflow ?? "team" : study.mode;
}
export function currentDecisions(study: ResearchStudy): ResearchDecision[] {
  const version = study.plans.at(-1)?.version;
  return study.decisions.filter((decision) => decision.version === version && decision.status !== "superseded");
}
export function researchProgress(study: ResearchStudy) {
  const tasks = study.plans.at(-1)?.tasks ?? [];
  // 进度按「已完成 + 已跳过」计：被分流跳过的任务对流程而言已经尘埃落定。
  return { completed: tasks.filter((task) => task.state === "completed" || task.state === "skipped").length, total: tasks.length };
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
  "as-research-package-curator": "成果归档专家",
  "as-research-planner": "研究规划专家",
  "as-research-synthesizer": "研究综合专家",
  "as-result-analyst": "结果分析专家",
};

/** 成果文件按内容角色分类：正文优先，审计、复核类文件归入过程记录。 */
const reviewArtifactPath = /(^|\/)(review|verdict|audit|check|gate|pass|fallback|rework)(\/|\.|$)/i;
const contentDirPath = /(^|\/)(writing|draft|synthesis|evidence|discovery|outline|strategy|package)\//i;
const reportArtifactPath = /(report|final|summary|conclusion|abstract|one[-_ ]?liner|result|deliverable|报告|结论|摘要)/i;
const indexArtifactPath = /(^|\/)(manifest|index|inventory)\.[^.]+$/i;
const reviewRoles = new Set(["as-independent-reviewer", "as-quality-citation-auditor"]);
/** 写作、汇总、归档类角色更可能产出最终交付；复核类角色产出过程记录。 */
const deliverableRoleWeight: Record<string, number> = {
  "as-research-package-curator": 40,
  "as-evidence-writer": 45,
  "as-research-synthesizer": 40,
  "as-result-analyst": 38,
  "as-outline-architect": 30,
  "as-literature-researcher": 25,
  "as-paper-evidence-analyst": 20,
  "as-experiment-operator": 18,
  "as-experiment-designer": 15,
  "as-code-data-engineer": 12,
  "as-figure-citation-editor": 10,
  "as-independent-reviewer": -20,
  "as-quality-citation-auditor": -15,
};
const artifactLabels: [RegExp, string][] = [
  [/(^|\/)one[-_ ]?liner\.[^.]+$/i, "一句话结论"],
  [/(^|\/)review\/verdict\.[^.]+$/i, "复核意见"],
  [/(^|\/)pass\/[^/]+\.[^.]+$/i, "通过报告"],
  [/(^|\/)fallback\/[^/]+\.[^.]+$/i, "阻塞说明"],
  [/(^|\/)audit\/[^/]+\.[^.]+$/i, "引用核验"],
  [/(^|\/)package\/manifest\.[^.]+$/i, "成果清单"],
  [/(^|\/)writing\/[^/]+\.[^.]+$/i, "研究正文"],
  [/(^|\/)draft\/[^/]+\.[^.]+$/i, "研究草稿"],
  [/(^|\/)synthesis\/[^/]+\.[^.]+$/i, "综合分析"],
  [/(^|\/)evidence\/[^/]+\.[^.]+$/i, "证据笔记"],
  [/(^|\/)discovery\/[^/]+\.[^.]+$/i, "文献清单"],
  [/(^|\/)strategy\/[^/]+\.[^.]+$/i, "检索策略"],
  [/(^|\/)outline\/[^/]+\.[^.]+$/i, "研究提纲"],
  [/(^|\/)review\/[^/]+\.[^.]+$/i, "审阅记录"],
  [/(^|\/)report\.[^.]+$/i, "研究报告"],
  [/(^|\/)verdict\.[^.]+$/i, "复核意见"],
  [/(^|\/)metrics?\.[^.]+$/i, "指标记录"],
  [/(^|\/)result\.[^.]+$/i, "结果报告"],
  [/(^|\/)manifest\.[^.]+$/i, "成果清单"],
  [/(^|\/)survey\.[^.]+$/i, "文献综述"],
];
/** 路径只用于兜底；用户优先看到的是文件在研究里的角色。 */
export function researchArtifactLabel(path: string): string {
  for (const [pattern, label] of artifactLabels) if (pattern.test(path)) return label;
  const name = path.split("/").at(-1) ?? path;
  return name.replace(/\.[^.\\/]+$/, "") || path;
}
export function researchFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export interface ResearchOutcomeFile {
  task: ResearchTask;
  artifact: ResearchTask["artifacts"][number];
  label: string;
  deliverable: boolean;
  score: number;
}
export interface ResearchOutcome {
  tasks: ResearchTask[];
  files: ResearchOutcomeFile[];
  conclusion: ResearchOutcomeFile | null;
  deliverables: ResearchOutcomeFile[];
  reviews: ResearchOutcomeFile[];
  counts: {
    steps: number; completed: number; skipped: number; experts: number; files: number;
    reworkRounds: number; transcripts: number;
    verdict: "pass" | "blocked" | "recorded" | null;
  };
}
/** 交付阅读顺序：先结论正文，再过程记录；复核报告不抢研究结论的位置。 */
export function researchOutcome(study: ResearchStudy): ResearchOutcome {
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const reviewMode = researchWorkflowMode(study) === "review";
  const raw = tasks.flatMap((task) => task.artifacts.map((artifact) => {
    const process = !reviewMode && (reviewRoles.has(task.role) || (reviewArtifactPath.test(artifact.path) && !contentDirPath.test(artifact.path)));
    const leaf = !tasks.some((candidate) => candidate.dependsOn.includes(task.id));
    const score = (deliverableRoleWeight[task.role] ?? 0)
      + (reportArtifactPath.test(artifact.path) ? 20 : 0)
      - (indexArtifactPath.test(artifact.path) ? 25 : 0)
      - (process ? 60 : 0)
      + (leaf ? 15 : 0)
      + Math.min(10, Math.floor(artifact.bytes / 2048));
    return { task, artifact, label: researchArtifactLabel(artifact.path), deliverable: !process, score };
  }));
  // 审稿、核验类流程没有正文，复核记录本身就是交付，不能全部降级为过程。
  const allProcess = raw.length > 0 && raw.every((file) => !file.deliverable);
  const files = raw.map((file) => allProcess ? { ...file, deliverable: true } : file);
  const reviewTasks = tasks.filter((task) => task.verdict || reviewRoles.has(task.role));
  const verdict: ResearchOutcome["counts"]["verdict"] = reviewTasks.some((task) => task.verdict?.status === "blocked") ? "blocked"
    : reviewTasks.some((task) => task.verdict?.status === "pass") ? "pass"
      : reviewTasks.length ? "recorded" : null;
  return {
    tasks, files,
    conclusion: [...files].sort((a, b) => b.score - a.score)[0] ?? null,
    deliverables: files.filter((file) => file.deliverable),
    reviews: files.filter((file) => !file.deliverable),
    counts: {
      steps: tasks.length,
      completed: tasks.filter((task) => task.state === "completed").length,
      skipped: tasks.filter((task) => task.state === "skipped").length,
      experts: new Set(tasks.filter((task) => task.role && (task.sessionId || task.state !== "pending")).map((task) => task.role)).size,
      files: files.length,
      reworkRounds: tasks.reduce((sum, task) => sum + Math.max(0, task.reworkCount ?? 0), 0),
      transcripts: tasks.filter((task) => task.sessionId).length,
      verdict,
    },
  };
}
/** 过程一句话：用户扫一眼就知道研究像人一样走了哪些环节，哪些没走。 */
export function researchProcessSummary(study: ResearchStudy): string {
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const walked = tasks.filter((task) => task.state !== "skipped");
  if (!walked.length) return "";
  const names = walked.slice(0, 8).map((task) => task.kind === "route" ? "条件分流"
    : task.kind === "human" ? "人工确认"
      : task.kind === "foreach" ? "逐项处理"
        : task.kind === "experiment" ? "实验执行"
          : task.agent?.name ?? expertRoles[task.role] ?? task.id);
  const skipped = tasks.length - walked.length;
  return `${names.join(" → ")}${walked.length > 8 ? " → …" : ""}${skipped ? `；另有 ${skipped} 步未走` : ""}`;
}
/** 可信度一句话：独立复核是否通过、退回修订过几轮。 */
export function researchReviewSummary(study: ResearchStudy): string {
  const { counts } = researchOutcome(study);
  if (!counts.verdict) return "";
  const rework = counts.reworkRounds ? `；期间退回修订 ${counts.reworkRounds} 轮` : "";
  if (counts.verdict === "blocked") return `独立复核发现了需要处理的问题${rework}。`;
  return `${counts.verdict === "pass" ? "已通过独立复核" : "已完成独立复核"}${rework}。`;
}

export interface ResearchScopeTask {
  id: string; brief?: string; kind?: string; role?: string;
  outputs?: string[]; dependsOn?: string[];
  requiresApproval?: boolean; gateDownstream?: boolean; maxRework?: number;
  artifacts?: { path: string; sha256?: string; bytes?: number }[];
}
export interface ResearchScopeOutline {
  steps: number; humanSteps: number; expertCount: number; routeSteps: number;
  gateSteps: number; maxRework: number; outputs: string[];
}
/** 审批范围的规模：人数、步骤、分支与产物，供审批卡说人话，不再复述模板句。 */
export function researchScopeOutline(tasks: ResearchScopeTask[]): ResearchScopeOutline {
  const routes = tasks.filter((task) => task.kind === "route").length;
  const artifacts = tasks.flatMap((task) => (task.artifacts ?? []).map((artifact) => artifact.path));
  const declared = tasks.flatMap((task) => task.outputs ?? []);
  return {
    steps: tasks.length,
    humanSteps: tasks.filter((task) => task.kind === "human").length,
    expertCount: new Set(tasks.map((task) => task.role).filter(Boolean)).size,
    routeSteps: routes,
    gateSteps: tasks.filter((task) => task.requiresApproval || task.gateDownstream || (task.maxRework ?? 0) > 0).length,
    maxRework: tasks.reduce((max, task) => Math.max(max, task.maxRework ?? 0), 0),
    outputs: [...new Set(artifacts.length ? artifacts : declared)],
  };
}
/** G1 说明接下来做什么，G4 说明交付覆盖什么；两者都不再重复计划模板。 */
export function researchScopeSentence(tasks: ResearchScopeTask[], gate: string): string {
  const outline = researchScopeOutline(tasks);
  if (!outline.steps) return "";
  const files = outline.outputs.length
    ? gate === "G4" ? `，产出 ${outline.outputs.length} 份文件` : `${outline.routeSteps ? "，预计最多" : "，预计产出"} ${outline.outputs.length} 份文件`
    : "";
  if (gate === "G4") return `本次交付覆盖 ${outline.steps} 个步骤${files}。`;
  if (outline.humanSteps === outline.steps) return `将执行 ${outline.steps} 个步骤，都由你亲自完成${files}。`;
  const people = [
    outline.expertCount ? `${outline.expertCount} 位专家参与` : null,
    outline.humanSteps ? `${outline.humanSteps} 项由你完成` : null,
  ].filter(Boolean);
  return `将执行 ${outline.steps} 个步骤${people.length ? `：${people.join("，")}` : ""}${files}。`;
}
export function researchScopeControls(tasks: ResearchScopeTask[]): string {
  const outline = researchScopeOutline(tasks);
  return [
    outline.routeSteps ? `含 ${outline.routeSteps} 处条件分流` : null,
    outline.gateSteps ? `${outline.gateSteps} 项结论把关${outline.maxRework ? `（最多返工 ${outline.maxRework} 轮）` : ""}` : null,
  ].filter(Boolean).join(" · ");
}
/** 研究负责人生成的通用计划说明；有结构化任务时不再把它整段展示给用户。 */
export function isTemplatePlanSummary(summary?: string | null): boolean {
  return Boolean(summary && summary.startsWith("围绕目标「") && summary.includes("各任务按依赖顺序登记产物"));
}


export type WorkflowState = "waiting" | "running" | "completed" | "blocked" | "optional" | "stopped";
export const workflowStateNames: Record<WorkflowState, string> = {
  waiting: "待推进", running: "进行中", completed: "已完成", blocked: "待处理", optional: "按需安排", stopped: "已停止",
};
/** Single state-to-colour language for every research view. */
export const workflowTone: Record<WorkflowState, string> = {
  completed: "border-accent-green bg-accent-green-subtle text-accent-green",
  running: "border-primary bg-primary-subtle text-primary",
  blocked: "border-accent-amber bg-accent-amber-subtle text-accent-amber",
  waiting: "border-border bg-background text-subtext",
  optional: "border-border bg-surface text-muted",
  stopped: "border-border bg-surface text-subtext",
};
export const researchStages = [
  { id: "intake", title: "目标与材料", description: "澄清目标，盘点已有论文、代码和数据", gates: [], roles: ["as-intent-router", "as-asset-auditor", "as-research-planner"] },
  { id: "scope", title: "范围确认", description: "确认研究边界、交付物和停止条件", gates: ["G1"], roles: [] },
  { id: "design", title: "文献与方案", description: "检索证据，设计方法、基线与评价方案", gates: [], roles: ["as-literature-researcher", "as-literature-strategist", "as-paper-evidence-analyst", "as-feasibility-advisor", "as-methodology-designer", "as-experiment-designer", "as-code-data-engineer", "as-outline-architect"] },
  { id: "approval", title: "实验授权", description: "确认算力资源、代码版本和运行方案", gates: ["G2", "G3"], roles: [] },
  { id: "execution", title: "实验与论证", description: "运行实验，分析结果并形成有证据的结论", gates: [], roles: ["as-experiment-operator", "as-experiment-diagnostician", "as-result-analyst", "as-research-synthesizer", "as-evidence-writer", "as-figure-citation-editor"] },
  { id: "review", title: "独立审查", description: "独立审稿与引用核验，提出需要处理的问题", gates: [], roles: ["as-independent-reviewer", "as-quality-citation-auditor"] },
  { id: "delivery", title: "研究交付", description: "归档产物和证据，确认成果交付", gates: ["G4"], roles: ["as-research-package-curator"] },
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
    else if ((members.length > 0 || gates.length > 0) && members.every((task) => task.state === "completed" || task.state === "skipped") && gates.every((gate) => gate.status === "approved") && (stage.id !== "delivery" || gates.some((gate) => gate.gate === deliveryGate(researchWorkflowMode(study))))) state = "completed";
    else if (stage.id === "intake" && tasks.length === 0) state = "running";
    else if (stage.id === "intake" && members.length === 0 && study.plans.length > 0) state = "completed";
    else if (members.length === 0 && stage.gates.length === 0 && study.plans.length > 0) state = "optional";
    if (study.evidenceReviewRequired && ["review", "delivery"].includes(stage.id)) state = "blocked";
    if (study.status === "stopped" && state !== "completed" && state !== "optional") state = "stopped";
    return { ...stage, state, tasks: members, decisions: gates };
  });
}

/** 确认门的提示名：任务确认带专家名，避免裸任务号出现在状态提示里。 */
function attentionGateName(study: ResearchStudy, gate: string): string {
  if (!gate.startsWith("G5:")) return gateDisplayName(gate);
  const id = gate.slice(3);
  const task = study.plans.at(-1)?.tasks.find((entry) => entry.id === id);
  return `任务确认 · ${task?.agent?.name ?? expertRoles[task?.role ?? ""] ?? id}`;
}

export function researchAttention(study: ResearchStudy) {
  if (study.status === "stopped") return "研究已停止";
  if (study.status === "paused") return "研究已暂停 · 可继续";
  const decisions = currentDecisions(study);
  const rejected = decisions.filter((decision) => decision.status === "rejected");
  if (rejected.length) return `${[...new Set(rejected.map((decision) => attentionGateName(study, decision.gate)))].join(" / ")} 已拒绝 · 等待调整计划`;
  const pending = decisions.filter((decision) => decision.status === "pending");
  if (pending.length) return `等待你确认 ${[...new Set(pending.map((decision) => attentionGateName(study, decision.gate)))].join(" / ")}`;
  if (study.evidenceReviewRequired) return "证据已修订 · 等待重新审查与交付确认";
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const failed = tasks.filter((task) => ["failed", "cancelled"].includes(task.state));
  if (failed.length) return `${failed.length} 个任务需处理`;
  const active = tasks.filter((task) => task.state === "running");
  if (active.length) return `${active.length} 位专家执行中 / 待验收`;
  if (decisions.some((decision) => decision.gate === deliveryGate(researchWorkflowMode(study)) && decision.status === "approved")) return `${researchWorkflowMode(study) === "proposal" ? "实验方案已确认 · 未授权运行实验" : "成果已确认"}${study.deliveryNotice ? " · 工作文件有改动" : ""}`;
  if (!tasks.length) return "研究负责人正在梳理目标与材料";
  const awaitingHuman = tasks.find((task) => task.state === "awaiting");
  if (awaitingHuman) return `等你完成一项 · ${awaitingHuman.brief.slice(0, 40)}`;
  if (tasks.every((task) => task.state === "completed" || task.state === "skipped")) return study.deliveryError ? `交付确认受阻 · ${study.deliveryError}` : "任务已验收 · 交付确认尚未生成";
  return "计划已登记 · 等待推进就绪任务";
}

export function researchTaskStatus(study: ResearchStudy, task: ResearchTask): { state: WorkflowState; label: string } {
  if (study.staleReviewTaskIds?.includes(task.id) && task.state === "completed") return { state: "blocked", label: "证据已修订 · 等待重新审查" };
  if (task.state === "skipped") return { state: "optional", label: "已跳过 · 分流未走此分支" };
  if (task.state === "awaiting") return { state: "blocked", label: `等你完成 · ${task.brief}` };
  if (task.state === "running" && task.kind === "experiment") return { state: "running", label: "实验运行中 · 结束后按产物验收" };
  if (task.state === "pending" && task.kind === "wait" && task.waitStep?.source) return { state: "waiting", label: `等待 ${task.waitStep.source} 出现` };
  if (task.state === "running" && task.kind === "foreach") {
    const done = task.foreachRuns?.length ?? 0;
    const total = task.foreachItems?.length ?? 0;
    return { state: "running", label: `逐项处理中 · 第 ${done + 1}/${total || "?"} 项` };
  }
  if (task.state === "completed" && task.kind === "route") {
    const decision = task.routeDecision;
    return decision?.outcome === "matched"
      ? { state: "completed", label: `已走「成立」分支 · ${decision.basis}` }
      : { state: "completed", label: `已走「不成立」分支 · ${decision?.basis ?? "等待判定"}` };
  }
  if (task.state === "completed") {
    if (task.verdict?.status === "blocked") return { state: "blocked", label: "结论有问题 · 等待研究负责人处理" };
    if (task.requiresApproval && !currentDecisions(study).some((decision) => decision.gate === `G5:${task.id}` && decision.status === "approved")) return { state: "blocked", label: "已验收 · 等待你批准" };
    return { state: "completed", label: "产物已验收" };
  }
  if (study.status === "paused") return { state: "stopped", label: "已暂停" };
  if (study.status === "stopped") return { state: "stopped", label: "已停止" };
  if (task.state === "running") return { state: "running", label: "执行中 / 待验收" };
  if (["failed", "cancelled"].includes(task.state)) return { state: "blocked", label: researchStates[task.state] };
  if (task.state === "pending" && (task.reworkCount ?? 0) > 0) return { state: "running", label: `返工修订中 · 第 ${task.reworkCount} 轮（上限 ${task.maxRework ?? 0} 轮）` };
  const decisions = currentDecisions(study);
  if (!decisions.some((decision) => decision.gate === "G1" && decision.status === "approved")) return { state: "blocked", label: "等待你确认研究范围" };
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const depTasks = task.dependsOn.map((id) => tasks.find((entry) => entry.id === id));
  // 被分流跳过的前置按「无需执行」处理：默认汇合下不阻塞派发。
  if (depTasks.some((dep) => dep?.state !== "completed" && dep?.state !== "skipped")) return { state: "waiting", label: "等待前置任务" };
  const blockedDep = depTasks.find((dep) => dep?.verdict?.status === "blocked");
  if (blockedDep) return { state: "blocked", label: `前置结论有问题 · ${blockedDep.agent?.name ?? expertRoles[blockedDep.role] ?? blockedDep.role}` };
  const unapprovedDep = depTasks.find((dep) => dep?.requiresApproval && !decisions.some((decision) => decision.gate === `G5:${dep.id}` && decision.status === "approved"));
  if (unapprovedDep) return { state: "blocked", label: `等待你确认 ${unapprovedDep.agent?.name ?? expertRoles[unapprovedDep.role] ?? unapprovedDep.role}` };
  if (task.role === "as-experiment-operator") {
    const contract = task.runContract;
    if (!contract) return { state: "waiting", label: "正在准备实验运行" };
    const approvals = decisions.filter((decision) => {
      try { return JSON.parse(decision.scope).experimentId === contract.experimentId; } catch { return false; }
    });
    if (["G2", "G3"].some((gate) => !approvals.some((decision) => decision.gate === gate && decision.status === "approved"))) return { state: "blocked", label: "等待 G2 / G3 授权" };
  }
  return { state: "waiting", label: "已就绪 · 即将开始" };
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
    deliverables: "独立审稿报告、引用核验记录、需要处理的问题与改进清单。",
    requiredRoles: ["as-independent-reviewer", "as-quality-citation-auditor"],
    steps: [
      { title: "盘点报告与证据", description: "整理待审结论及其来源。", roles: ["as-intent-router", "as-asset-auditor", "as-paper-evidence-analyst"] },
      { title: "独立审查论证", description: "检查方法、结论和研究局限，报告需要处理的问题。", roles: ["as-independent-reviewer"] },
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

/** Only the current confirmed scope may expose its prepared archive. */
export function researchPackageUrl(study: ResearchStudy): string | null {
  const snapshot = study.deliverySnapshot;
  if (!snapshot || !currentDecisions(study).some(decision => decision.gate === deliveryGate(researchWorkflowMode(study)) && decision.status === "approved" && decision.scopeHash === snapshot.scopeHash)) return null;
  return `/api/research/studies/${encodeURIComponent(study.id)}/package`;
}

/** 已确认交付的归档哈希；成果页与下载只从这个归档读字节。 */
export function researchDeliveryArchive(study: ResearchStudy): string | null {
  return researchPackageUrl(study) ? study.deliverySnapshot?.archive?.sha256 ?? null : null;
}
