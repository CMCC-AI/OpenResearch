import { currentDecisions, deliveryGate, researchWorkflowMode, type ResearchStudy } from "./research.ts";

export type ResearchConversationStatus = {
  kind: "working" | "experts" | "confirmation" | "attention" | "complete" | "idle";
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
  if (unavailable) return { kind: "attention", label: "专家团状态暂不可用 · 点击查看" };
  if (study.status === "stopped") return { kind: "idle", label: "本轮研究已停止" };
  if (stopping) return { kind: "working", label: "正在停止主理人的当前回复…" };
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const decisions = currentDecisions(study);
  const activeRuns = runs.filter((run) => !["done", "failed", "cancelled"].includes(run.status));
  const activeTasks = tasks.filter((task) => task.state === "running"
    || Boolean(task.sessionId && task.sessionId !== study.sessionId && busySessions.has(task.sessionId)));
  const pending = decisions.filter((decision) => decision.status === "pending");
  if (pending.length || waitingForInput) return {
    kind: "confirmation",
    label: `${pending.length ? `待你确认 · ${pending.length} 项` : "主理人正在等待你的回复"}${activeTasks.length ? ` · ${activeTasks.length} 项专家任务处理中` : ""}`,
  };
  if (busy) return { kind: "working", label: "主理人正在处理…" };
  if (activeTasks.length) return {
    kind: "experts",
    label: `主理人正在等待专家结果 · ${activeTasks.length} 项任务处理中`,
    placeholder: "专家正在处理，你可以补充要求或提出问题…",
  };
  if (activeRuns.length) return {
    kind: "experts", label: `专家团正在等待实验结果 · ${activeRuns.length} 个实验进行中`,
    placeholder: "实验正在进行，你可以补充要求或提出问题…",
  };
  if (decisions.some((decision) => decision.status === "rejected")
    || tasks.some((task) => ["failed", "cancelled"].includes(task.state))) {
    return { kind: "attention", label: "研究需要调整 · 查看任务与确认反馈" };
  }
  if (tasks.length && tasks.every((task) => task.state === "completed")) {
    return decisions.some((decision) => decision.gate === deliveryGate(researchWorkflowMode(study)) && decision.status === "approved")
      ? { kind: "complete", label: "本轮研究已完成" }
      : { kind: "attention", label: study.deliveryError ? `交付确认受阻 · ${study.deliveryError}` : "本轮任务已验收 · 交付确认尚未生成" };
  }
  return { kind: "idle", label: tasks.length ? "专家团流程未完成 · 等待下一步处理" : "专家团已就绪 · 等待明确研究计划" };
}
