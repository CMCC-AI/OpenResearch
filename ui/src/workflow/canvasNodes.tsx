import type { ReactNode } from "react";
import { Handle, NodeResizeControl, Position, type Node, type NodeProps } from "@xyflow/react";
import { Bot, FileText, FlaskConical, Hourglass, ListOrdered, RefreshCw, ShieldCheck, Split, Trash2, UserRound } from "lucide-react";
import { workflowTone, type WorkflowState } from "../research";
import type { SystemNode } from "./SystemNode";

// 编辑画布与运行视图（工作流侧栏）共用的节点卡片：同一卡片既画草稿也画执行状态。
// 节点 data 的回调均可选：编辑画布传入删除/改派回调；运行视图（工作流侧栏）只读，不带回调也不渲染删除按钮。
// state 由运行视图传入，卡片按执行状态着色；编辑画布不传，保持草稿外观。
export type AgentNodeData = {
  taskId: string;
  roleName: string;
  brief: string;
  outputCount: number;
  dependencyCount: number;
  requiresApproval: boolean;
  gateDownstream: boolean;
  maxRework: number;
  state?: WorkflowState;
  onDelete?: () => void;
};
export type AgentNode = Node<AgentNodeData, "agent">;

// 任务节点统一外壳：六类卡片共用同一套边框、宽度、选中态与头部/页脚解剖，
// 节点身份由图标与配色区分，正文与页脚内容由各类节点填入。
function TaskNodeCard({ selected, icon, accent, title, taskId, onDelete, state, children, footer }: {
  selected: boolean;
  icon: ReactNode;
  accent: string;
  title: string;
  taskId: string;
  onDelete?: () => void;
  state?: WorkflowState;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const tone = state ? workflowTone[state] : "";
  return <div className={`group relative w-64 rounded-lg border shadow-sm transition-shadow ${tone || "bg-background"} ${selected ? "border-primary ring-2 ring-primary/20" : tone ? "" : "border-border hover:shadow-control-subtle"} ${state === "running" && !selected ? "ring-2 ring-primary" : ""}`}>
    <Handle type="target" position={Position.Top} />
    <div className="flex items-center gap-2.5 px-3 pb-1.5 pt-2.5">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${accent}`} aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm text-text">{title}</strong>
      </div>
      {onDelete && <button type="button" className="nodrag absolute end-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-subtext hover:border-accent-red hover:text-accent-red group-hover:flex" aria-label={`删除节点 ${taskId}`} title="删除节点" onClick={onDelete}>
        <Trash2 size={12} />
      </button>}
    </div>
    {children}
    {footer && <div className="border-t border-border px-3 py-1.5 text-xs text-subtext">{footer}</div>}
    <Handle type="source" position={Position.Bottom} />
  </div>;
}

// 页脚元信息行：与专家卡片同一套「产物 + 前置」解剖。
function TaskNodeMeta({ output, dependencyCount }: { output?: ReactNode; dependencyCount: number }) {
  return <div className="flex items-center gap-3">
    {output && <span className="flex min-w-0 items-center gap-1">{output}</span>}
    <span className="shrink-0">{dependencyCount ? `前置 ${dependencyCount} 项` : "无前置"}</span>
  </div>;
}

export function AgentNodeCard({ data, selected }: NodeProps<AgentNode>) {
  return <TaskNodeCard
    selected={selected}
    icon={<Bot size={15} />}
    accent="bg-primary/10 text-primary"
    title={data.roleName}
    taskId={data.taskId}
    onDelete={data.onDelete}
    state={data.state}
    footer={<TaskNodeMeta output={<><FileText size={12} aria-hidden="true" />{data.outputCount} 个产物</>} dependencyCount={data.dependencyCount} />}
  >
    {data.brief && <p className="mb-2 line-clamp-2 px-3 text-xs leading-4 text-subtext">{data.brief}</p>}
    {(data.requiresApproval || data.gateDownstream) && <div className="flex flex-wrap gap-1 px-3 pb-1.5">
      {data.requiresApproval && <span className="flex items-center gap-1 rounded bg-accent-amber-subtle px-1.5 py-0.5 text-xs text-accent-amber" title="完成后需研究负责人确认才放行下游"><ShieldCheck size={11} aria-hidden="true" />需研究负责人确认</span>}
      {data.gateDownstream && <span className="flex items-center gap-1 rounded bg-primary-subtle px-1.5 py-0.5 text-xs text-primary" title={data.maxRework > 0 ? `结论没通过时暂停下游任务，自动返工最多 ${data.maxRework} 轮` : "结论没通过时暂停下游任务"}><Split size={11} aria-hidden="true" />结论把关{data.maxRework > 0 && <span className="flex items-center gap-0.5"><RefreshCw size={10} aria-hidden="true" />≤{data.maxRework}轮</span>}</span>}
    </div>}
  </TaskNodeCard>;
}

// 条件分流节点：引擎在运行时判定条件并放行其中一条分支，画布上先行声明条件与两条出口。
export type RouteNodeData = {
  taskId: string;
  brief: string;
  condition: string;
  thenTargets: string;
  elseTargets: string;
  state?: WorkflowState;
  onDelete?: () => void;
};
export type RouteNode = Node<RouteNodeData, "route">;

export function RouteNodeCard({ data, selected }: NodeProps<RouteNode>) {
  return <TaskNodeCard
    selected={selected}
    icon={<Split size={15} />}
    accent="bg-primary/10 text-primary"
    title={data.brief || "条件分流"}
    taskId={data.taskId}
    onDelete={data.onDelete}
    state={data.state}
    footer={<div className="flex flex-col gap-0.5">
      <span className="truncate">成立 → {data.thenTargets || "未连接"}</span>
      <span className="truncate">不成立 → {data.elseTargets || "未连接"}</span>
    </div>}
  >
    <p className="mb-2 line-clamp-2 px-3 text-xs leading-4 text-subtext">{data.condition}</p>
  </TaskNodeCard>;
}

// 阶段分组框：纯展示容器，放在其他节点下层，可拖动、可调整大小。
export type FrameNodeData = {
  frameId: string;
  title: string;
  /** 编辑画布传入改名/缩放回调；运行视图只读，不提供。 */
  onChange?: (update: { title?: string; width?: number; height?: number }) => void;
  onDelete?: () => void;
};
export type FrameNode = Node<FrameNodeData, "frame">;

export function FrameNodeCard({ data, selected }: NodeProps<FrameNode>) {
  return <div className={`relative h-full w-full rounded-xl border-2 border-dashed ${selected ? "border-subtext bg-surface/60" : "border-border bg-surface/40"}`}>
    {data.onChange && selected && <NodeResizeControl minWidth={160} minHeight={120} className="!border-none" />}
    <span className="pointer-events-none absolute -top-3 start-3 max-w-[calc(100%-1.5rem)] truncate rounded bg-background px-1.5 text-xs text-subtext">{data.title}</span>
  </div>;
}

// 逐项处理节点：引擎按上游清单串行逐项派发，全部完成后放行下游。
export type ForeachNodeData = {
  taskId: string;
  brief: string;
  condition: string;
  itemOutput: string;
  dependencyCount: number;
  state?: WorkflowState;
  onDelete?: () => void;
};
export type ForeachNode = Node<ForeachNodeData, "foreach">;

export function ForeachNodeCard({ data, selected }: NodeProps<ForeachNode>) {
  return <TaskNodeCard
    selected={selected}
    icon={<ListOrdered size={15} />}
    accent="bg-primary/10 text-primary"
    title={data.brief || "逐项处理"}
    taskId={data.taskId}
    onDelete={data.onDelete}
    state={data.state}
    footer={<TaskNodeMeta output={<><FileText size={12} aria-hidden="true" /><span className="truncate font-mono">{data.itemOutput || "逐项产物"}</span></>} dependencyCount={data.dependencyCount} />}
  >
    <p className="mb-2 line-clamp-2 px-3 text-xs leading-4 text-subtext">{data.condition}</p>
  </TaskNodeCard>;
}

// 人工任务节点：用户在研究面板亲自提交产出后流程继续。
export type HumanNodeData = {
  taskId: string;
  brief: string;
  output: string;
  dependencyCount: number;
  state?: WorkflowState;
  onDelete?: () => void;
};
export type HumanNode = Node<HumanNodeData, "human">;

export function HumanNodeCard({ data, selected }: NodeProps<HumanNode>) {
  return <TaskNodeCard
    selected={selected}
    icon={<UserRound size={15} />}
    accent="bg-accent-amber-subtle text-accent-amber"
    title={data.brief || "人工任务"}
    taskId={data.taskId}
    onDelete={data.onDelete}
    state={data.state}
    footer={<TaskNodeMeta output={<><FileText size={12} aria-hidden="true" /><span className="truncate font-mono">{data.output}</span></>} dependencyCount={data.dependencyCount} />}
  >
    <p className="mb-2 line-clamp-2 px-3 text-xs leading-4 text-subtext">研究负责人亲自完成：提交后流程继续</p>
  </TaskNodeCard>;
}

// 实验节点：G2/G3 批准后引擎按已批准契约自动提交运行，按声明产物验收。
export type ExperimentNodeData = {
  taskId: string;
  brief: string;
  outputCount: number;
  dependencyCount: number;
  state?: WorkflowState;
  onDelete?: () => void;
};
export type ExperimentNode = Node<ExperimentNodeData, "experiment">;

export function ExperimentNodeCard({ data, selected }: NodeProps<ExperimentNode>) {
  return <TaskNodeCard
    selected={selected}
    icon={<FlaskConical size={15} />}
    accent="bg-accent-green-subtle text-accent-green"
    title={data.brief || "实验节点"}
    taskId={data.taskId}
    onDelete={data.onDelete}
    state={data.state}
    footer={<TaskNodeMeta output={<><FileText size={12} aria-hidden="true" />{data.outputCount} 个产物</>} dependencyCount={data.dependencyCount} />}
  >
    <p className="mb-2 line-clamp-2 px-3 text-xs leading-4 text-subtext">你确认后系统自动开跑，跑完检查产物文件</p>
  </TaskNodeCard>;
}

// 事件等待节点：等研究目录下路径出现，超时转失败等待研究负责人。
export type WaitNodeData = {
  taskId: string;
  brief: string;
  condition: string;
  dependencyCount: number;
  state?: WorkflowState;
  onDelete?: () => void;
};
export type WaitNode = Node<WaitNodeData, "wait">;

export function WaitNodeCard({ data, selected }: NodeProps<WaitNode>) {
  return <TaskNodeCard
    selected={selected}
    icon={<Hourglass size={15} />}
    accent="bg-primary/10 text-primary"
    title={data.brief || "事件等待"}
    taskId={data.taskId}
    onDelete={data.onDelete}
    state={data.state}
    footer={<TaskNodeMeta dependencyCount={data.dependencyCount} />}
  >
    <p className="mb-2 line-clamp-2 px-3 text-xs leading-4 text-subtext">{data.condition}</p>
  </TaskNodeCard>;
}

// 编辑画布与运行视图（工作流侧栏）共用同一套节点类型：同一卡片既画草稿也画执行状态。
export type WorkflowCanvasNode = AgentNode | SystemNode | RouteNode | FrameNode | ForeachNode | HumanNode | ExperimentNode | WaitNode;
