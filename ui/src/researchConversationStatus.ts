import { currentDecisions, researchPackageUrl, type ResearchStudy } from "./research.ts";

export type ResearchConversationStatus = {
  kind: "working" | "experts" | "confirmation" | "attention" | "complete" | "paused" | "idle";
  label: string;
  placeholder?: string;
};

/** Describe the whole study without treating an idle lead as a completed study. */
export function researchConversationStatus(study: ResearchStudy, {
  busy, stopping, waitingForInput, busySessions, runs, unavailable = false,
}: {
  busy: boolean;
  stopping: boolean;
  waitingForInput: boolean;
  busySessions: ReadonlySet<string>;
  runs: readonly { id: string; status: string }[];
  unavailable?: boolean;
}): ResearchConversationStatus {
  if (unavailable) return { kind: "attention", label: "研究状态暂不可用 · 点击查看" };
  if (study.status === "stopped") return { kind: "idle", label: "本轮研究已停止" };
  if (study.modelBlock) return { kind: "attention", label: "模型额度已用完 · 换模型后继续" };
  if (study.status === "paused") return { kind: "paused", label: "研究已暂停 · 点击继续按钮恢复" };
  if (stopping) return { kind: "working", label: "正在停止当前回复…" };
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const decisions = currentDecisions(study);
  const activeRuns = runs.filter((run) => !["done", "failed", "cancelled"].includes(run.status));
  const activeTasks = tasks.filter((task) => task.state === "running"
    || Boolean(task.sessionId && task.sessionId !== study.sessionId && busySessions.has(task.sessionId)));
  const pending = decisions.filter((decision) => decision.status === "pending");
  if (pending.length || waitingForInput) return {
    kind: "confirmation",
    label: `${pending.length ? `待你确认 · ${pending.length} 项` : "等你回复"}${activeTasks.length ? ` · ${activeTasks.length} 项专家任务处理中` : ""}`,
  };
  if (busy) return { kind: "working", label: "正在处理…" };
  if (activeTasks.length) return {
    kind: "experts",
    label: `${activeTasks.length} 项任务处理中`,
    placeholder: "任务正在处理，你可以补充要求或提出问题…",
  };
  if (activeRuns.length) return {
    kind: "experts", label: `正在等待实验结果 · ${activeRuns.length} 个实验进行中`,
    placeholder: "实验正在进行，你可以补充要求或提出问题…",
  };
  if (decisions.some((decision) => decision.status === "rejected")
    || tasks.some((task) => ["failed", "cancelled"].includes(task.state))) {
    return { kind: "attention", label: "研究需要调整 · 查看任务与确认反馈" };
  }
  const awaitingHuman = tasks.find((task) => task.state === "awaiting");
  if (awaitingHuman) {
    return { kind: "confirmation", label: `等你完成一项 · 在研究清单提交${activeTasks.length ? ` · ${activeTasks.length} 项专家任务处理中` : ""}` };
  }
  if (tasks.length && tasks.every((task) => task.state === "completed" || task.state === "skipped")) {
    if (study.evidenceReviewRequired) return { kind: "attention", label: "证据已修订 · 等待重新审查与交付确认" };
    if (tasks.some(task => task.verdict?.status === "blocked")) return { kind: "attention", label: "专家结论有问题 · 等待处理" };
    return researchPackageUrl(study) && !study.deliveryError
      ? { kind: "complete", label: `本轮研究已完成 · 查看成果${study.deliveryNotice ? " · 工作文件有改动" : ""}` }
      : { kind: "attention", label: study.deliveryError ? `交付确认受阻 · ${study.deliveryError}` : "本轮任务已验收 · 交付确认尚未生成" };
  }
  return { kind: "idle", label: tasks.length ? "研究流程未完成 · 等待下一步处理" : "研究已就绪 · 等待明确计划" };
}
