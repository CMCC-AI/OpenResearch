import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { FileInput, PackageCheck, ShieldCheck, Trash2 } from "lucide-react";
import type { SystemNodeData } from "./graph";

export type SystemNode = Node<SystemNodeData, "system">;

export function SystemNodeCard({ data, selected }: NodeProps<SystemNode>) {
  const Icon = data.kind === "input" ? FileInput : data.kind === "output" ? PackageCheck : ShieldCheck;
  const tone = data.state === "completed" ? "text-accent-green" : data.state === "blocked" ? "text-accent-amber" : "text-subtext";
  return <div className={`group relative w-64 rounded-lg border bg-background p-3 shadow-sm ${selected ? "border-primary ring-2 ring-primary/20" : "border-border"}`}>
    {data.kind !== "input" && <Handle type="target" position={Position.Top} isConnectable={false} />}
    {data.onDelete && <button type="button" className="nodrag absolute end-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-subtext hover:border-accent-red hover:text-accent-red group-hover:flex" aria-label={`删除节点 ${data.title}`} title="删除节点" onClick={data.onDelete}><Trash2 size={12} /></button>}
    <div className="flex items-start gap-2.5">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface ${tone}`}><Icon size={15} aria-hidden="true" /></span>
      <div className="min-w-0"><strong className="block text-sm text-text">{data.title}</strong><span className="text-xs text-subtext">{data.taskId ? "任务检查点" : "系统节点"}</span></div>
    </div>
    <p className="mb-2 mt-2 text-xs leading-4 text-subtext">{data.description}</p>
    <span className={`text-xs ${tone}`}>{data.label}</span>
    {data.kind !== "output" && <Handle type="source" position={Position.Bottom} isConnectable={false} />}
  </div>;
}
