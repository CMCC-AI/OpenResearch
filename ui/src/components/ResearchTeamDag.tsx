import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { CircleDot, Focus, Users, X } from "lucide-react";
import { currentDecisions, expertRoles, gateNames, researchAttention, researchProgress, researchTeamGraph, researchWorkflow, researchStages, workflowStateNames, type ResearchStudy, type ResearchTask, type WorkflowState } from "../research";
import { TaskDetails, workflowTone } from "./ResearchWorkflow";
import { Button, IconButton } from "./ui";
import { useDialogFocus } from "./useDialogFocus";

type ExpertNode = Node<{ role: string; state: WorkflowState; label: string; onSelect: (id: string) => void }, "expert">;
function ExpertPill({ id, data, selected }: NodeProps<ExpertNode>) {
  return <button type="button" aria-pressed={selected} onClick={() => data.onSelect(id)} title={`${expertRoles[data.role] ?? data.role} · ${data.label}`} className={`nodrag flex h-12 w-56 items-center gap-2 rounded-full border px-2 text-start shadow-sm ${workflowTone[data.state]} ${data.state === "running" ? "ring-2 ring-primary" : ""} ${selected ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
    <Handle id="up" type="target" position={Position.Top} className="opacity-0" />
    <Handle id="side-target" type="target" position={Position.Left} className="opacity-0" />
    <Handle id="side-source" type="source" position={Position.Right} className="opacity-0" />
    <img src={`/research-experts/${data.role}.png`} alt="" className="h-9 w-9 shrink-0 rounded-full border border-border bg-background object-cover" />
    <span className="min-w-0 flex-1"><strong className="block truncate text-xs text-text">{expertRoles[data.role] ?? data.role}</strong><span className="mt-0.5 block truncate text-xs">{data.label}</span></span>
    {data.state === "running" && <CircleDot size={15} className="shrink-0 text-primary" />}
    <Handle id="down" type="source" position={Position.Bottom} className="opacity-0" />
  </button>;
}
type StageNode = Node<{ title: string; description: string; state: WorkflowState; count: number; onSelect: (id: string) => void }, "stage">;
function StagePill({ id, data, selected }: NodeProps<StageNode>) {
  return <button type="button" aria-pressed={selected} onClick={() => data.onSelect(id)} className={`nodrag w-64 rounded-xl border px-3 py-2 text-start ${workflowTone[data.state]} ${selected ? "ring-2 ring-primary" : ""}`}>
    <Handle id="up" type="target" position={Position.Top} className="opacity-0" />
    <strong className="block text-sm">{data.title} · {workflowStateNames[data.state]}</strong>
    <span className="mt-1 block truncate text-xs text-subtext" title={data.description}>{data.description}</span>
    <span className="mt-2 block text-xs">{data.count} 项任务 · 点击查看专家与子流程</span>
    <Handle id="down" type="source" position={Position.Bottom} className="opacity-0" />
  </button>;
}
const nodeTypes = { expert: ExpertPill, stage: StagePill };
function LocateCurrent({ ids }: { ids: string[] }) {
  const flow = useReactFlow();
  return <Button size="small" disabled={!ids.length} onClick={() => void flow.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.6, maxZoom: 1, duration: 300 })}><Focus size={14} />定位当前</Button>;
}

export function ResearchTeamDagDialog({ study, runs, actions, onClose, onDetails, onOpenSession, embedded = false }: {
  embedded?: boolean;
  study: ResearchStudy | null;
  runs: { id: string; status: string; cancelRequested?: boolean }[];
  actions: ReactNode;
  onClose: () => void;
  onDetails: () => void;
  onOpenSession?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose);
  const [grouped, setGrouped] = useState(embedded);
  const [actual, setActual] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useMemo(() => researchTeamGraph(study, actual), [study, actual]);
  const stages = study ? researchWorkflow(study) : researchStages.map((stage) => ({ ...stage, state: "waiting" as WorkflowState, tasks: [], decisions: [] }));
  const stageSelection = grouped ? stages.find((stage) => stage.id === selected) : undefined;
  const expertCurrentIds = graph.nodes.filter((node) => node.state === "running" || node.state === "blocked").map((node) => node.id);
  const expertNodes: ExpertNode[] = graph.nodes.map((node) => ({ id: node.id, type: "expert", position: { x: node.x, y: node.y }, selected: selected === node.id, ariaLabel: `${expertRoles[node.role]} · ${node.id} · ${node.label}`, data: { role: node.role, state: node.state, label: actual ? `${node.id} · ${node.label}` : node.label, onSelect: setSelected } }));
  const expertEdges = graph.edges.map((edge) => {
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    const active = target?.state === "running" || target?.state === "blocked" || source?.state === "completed" && target?.state === "completed";
    return { ...edge, sourceHandle: source?.y === target?.y ? "side-source" : "down", targetHandle: source?.y === target?.y ? "side-target" : "up", id: `${edge.source}->${edge.target}`, type: "smoothstep", animated: target?.state === "running", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: active ? "var(--primary)" : "var(--border)", strokeWidth: active ? 2 : 1.5, strokeDasharray: actual ? undefined : "5 4" } };
  });
  const nodes: (ExpertNode | StageNode)[] = grouped ? stages.map((stage, index) => ({ id: stage.id, type: "stage", position: { x: 0, y: index * 104 }, selected: selected === stage.id, ariaLabel: `${stage.title} · ${workflowStateNames[stage.state]}`, data: { title: stage.title, description: stage.description, state: stage.state, count: stage.tasks.length, onSelect: setSelected } })) : expertNodes;
  const edges: Edge[] = grouped ? stages.slice(1).map((stage, index) => ({ id: `stage-${stage.id}`, source: stages[index].id, target: stage.id, sourceHandle: "down", targetHandle: "up", type: "smoothstep", animated: stage.state === "running", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: stage.state === "running" || stage.state === "blocked" ? "var(--primary)" : "var(--border)", strokeDasharray: "5 4" } })) : expertEdges;
  const currentIds = grouped ? stages.filter((stage) => stage.state === "running" || stage.state === "blocked").map((stage) => stage.id) : expertCurrentIds;
  const tasks = study?.plans.at(-1)?.tasks ?? [];
  const progress = study ? researchProgress(study) : { completed: 0, total: 0 };
  const selection = graph.nodes.find((node) => node.id === selected);
  const pending = study ? currentDecisions(study).filter((decision) => decision.status === "pending") : [];
  const artifacts = new Set(tasks.flatMap((task) => task.artifacts.map((artifact) => artifact.path))).size;
  const currentStages = study ? researchWorkflow(study).filter((stage) => stage.state === "running" || stage.state === "blocked").map((stage) => stage.title).join(" · ") : "尚未开始";
  const content = <div ref={embedded ? undefined : ref} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={titleId} tabIndex={-1} className={`flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-text ${embedded ? "" : "max-h-full max-w-6xl rounded-xl border border-border shadow-elevated"}`} onClick={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-3"><div><h2 id={titleId} className="flex items-center gap-2 font-semibold"><Users size={18} className="text-primary" />科研专家团 · DAG 全景</h2><p role="status" className="mt-1 text-xs text-subtext">{study ? researchAttention(study) : "完整专家能力图 · 尚未开始研究"}</p></div>{!embedded && <IconButton data-initial-focus aria-label="关闭专家团 DAG" onClick={onClose}><X size={18} /></IconButton>}</header>
      <div className="grid shrink-0 grid-cols-2 gap-2 p-3">{[
        { label: "本次专家", value: `${new Set(tasks.map((task) => task.role)).size} / 20 类` },
        { label: "任务验收", value: `${progress.completed} / ${progress.total}` },
        { label: "科研产物", value: `${artifacts} 个文件` },
        { label: "当前环节", value: currentStages || (study?.status === "stopped" ? "已停止" : "待推进") },
      ].map((stat) => <div key={stat.label} className="min-w-0 rounded-lg border border-border bg-surface p-2"><p className="text-xs text-subtext">{stat.label}</p><strong className="mt-1 block truncate text-sm" title={stat.value}>{stat.value}</strong></div>)}</div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pb-2"><div className="flex gap-1" role="group" aria-label="DAG 展示范围"><Button size="small" active={grouped} aria-pressed={grouped} onClick={() => { setGrouped(true); setSelected(null); }}>环节总览</Button><Button size="small" active={!grouped && !actual} aria-pressed={!grouped && !actual} onClick={() => { setGrouped(false); setActual(false); setSelected(null); }}>专家团全景</Button><Button size="small" active={!grouped && actual} aria-pressed={!grouped && actual} onClick={() => { setGrouped(false); setActual(true); setSelected(null); }}>本次任务依赖</Button></div><p className="text-xs text-subtext">{grouped ? "虚线为环节顺序指引；真实依赖请切换本次任务" : actual ? "实线为本次计划的真实前置依赖" : "虚线为参考流程；节点状态来自本次计划，未安排专家保留显示"}</p></div>
      <div className="relative min-h-64 flex-1 border-y border-border bg-canvas" aria-label="科研专家团纵向 DAG">
        {!grouped && actual && !tasks.length ? <p className="p-8 text-center text-sm text-subtext">尚未登记任务计划。切换“专家团全景”可查看所有专家与参考流程。</p> : <ReactFlow key={`${study?.id ?? "preview"}-${study?.plans.at(-1)?.version ?? 0}-${actual}-${grouped}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08, minZoom: grouped ? 0.8 : 0.25, maxZoom: 1 }} minZoom={0.25} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, node) => setSelected(node.id)} proOptions={{ hideAttribution: true }}><Background /><Controls showInteractive={false} /><div className="absolute right-3 top-3 z-10"><LocateCurrent ids={currentIds} /></div></ReactFlow>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-3 py-2"><span className="text-xs text-subtext">{progress.completed}/{progress.total} 已验收</span><div className="h-1.5 flex-1 rounded-full bg-surface" role="progressbar" aria-label="专家任务验收进度" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.completed}><div className="h-full rounded-full bg-primary" style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></div><span className="text-xs text-subtext">蓝：执行中 · 绿：已验收 · 橙：待处理 · 灰：未安排</span></div>
      {pending.length > 0 && <button type="button" onClick={onDetails} className="shrink-0 border-t border-border px-3 py-2 text-start text-xs text-accent-amber">等待你确认：{pending.map((decision) => gateNames[decision.gate]).join("、")} · 点击查看并确认</button>}
      <section className="max-h-60 shrink-0 overflow-y-auto border-t border-border p-3" aria-label="专家执行详情">
        {stageSelection ? <div><strong className="text-sm">{stageSelection.title}</strong><p className="mt-1 text-xs text-subtext">{stageSelection.description}</p><p className="mt-2 text-xs text-subtext">参考专家：{stageSelection.roles.map((role) => expertRoles[role]).join("、") || "主理人提交，用户确认"}</p>{stageSelection.tasks.length ? stageSelection.tasks.map((task) => study && <TaskDetails key={task.id} study={study} task={task} runs={runs} onOpenSession={onOpenSession} />) : <p className="mt-2 text-xs text-subtext">尚未安排专家任务，或此环节为人工确认。参考专家不代表已调用。</p>}<Button size="small" className="mt-2" onClick={() => { setGrouped(false); setActual(false); setSelected(null); }}>展开专家全景</Button></div> : !selection ? <p className="text-xs text-subtext">点击任一专家，查看本次职责、任务状态、会话与产物；滚轮缩放，拖动画布浏览。</p> : !selection.tasks.length ? <p className="text-sm text-subtext">{expertRoles[selection.role]} · {selection.label}。参考流程不代表已调用该专家。</p> : selection.tasks.map((task: ResearchTask) => study && <TaskDetails key={task.id} study={study} task={task} runs={runs} onOpenSession={onOpenSession ? (id) => { onClose(); onOpenSession(id); } : undefined} />)}
      </section>
      <footer className="flex shrink-0 flex-wrap gap-2 border-t border-border p-3"><Button size="small" onClick={onDetails}>查看分工与人工确认</Button>{actions}</footer>
    </div>;
  return embedded ? content : createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-5" onClick={onClose}>{content}</div>, document.body);
}
