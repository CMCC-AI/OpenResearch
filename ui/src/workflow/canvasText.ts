import type { WorkflowTask } from "./model";

// 拖拽添加节点时 dataTransfer 里携带的数据类型，以及节点库里可拖入的类别。
// 拖拽添加专家任务时，dataTransfer 里携带 agent id 的数据类型。
export const AGENT_MIME = "application/x-orx-agent";
// 拖拽添加系统环节（G1/G4）时，携带系统节点 id。
export const SYSTEM_MIME = "application/x-orx-system-node";
// 拖拽添加条件分流节点时使用；阶段分组通过按钮添加，不需要拖拽 MIME。
export const ROUTE_MIME = "application/x-orx-route-node";
// 拖拽添加逐项处理 / 人工任务 / 实验节点 / 事件等待节点时使用。
export const FOREACH_MIME = "application/x-orx-foreach-node";
export const HUMAN_MIME = "application/x-orx-human-node";
export const EXPERIMENT_MIME = "application/x-orx-experiment-node";
export const WAIT_MIME = "application/x-orx-wait-node";

export function routeConditionText(task: WorkflowTask): string {
  if (!task.route) return "还没设置判断依据";
  if (task.route.on === "failure") return "任一直接前置执行失败即走「成立」分支";
  return `前置结论为「${task.route.verdictIs === "blocked" ? "有问题" : "通过"}」时走「成立」分支`;
}

export function waitConditionText(task: WorkflowTask): string {
  const waitStep = task.waitStep;
  if (!waitStep?.source) return "还没填要等哪个文件";
  const timeout = waitStep.timeoutMinutes ? `超时 ${waitStep.timeoutMinutes} 分钟转失败` : "不限时等待";
  return `等待「${waitStep.source}」出现 · ${timeout}`;
}

export function foreachConditionText(task: WorkflowTask): string {
  const forEach = task.forEach;
  if (!forEach?.source) return "还没选清单：先连线，再在右侧选「列表来源」";
  const policy = forEach.onFailure === "skip" ? "某项失败时跳过继续" : "某项失败时暂停等待研究负责人";
  return `按「${forEach.source}」的清单逐项执行 · ${policy}`;
}
