import { fmtTokens } from "../api";
import { appHref } from "../appBasePath";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { CircleDot, X } from "lucide-react";
import { currentDecisions, expertRoles, researchAttention, researchProgress, researchTeamGraph, researchDuration, type ResearchMetrics, type ResearchStudy, type ResearchTask, type WorkflowState } from "../research";
import { TaskDetails, workflowTone } from "./ResearchWorkflow";
import { Button, IconButton } from "./ui";
import { useDialogFocus } from "./useDialogFocus";
import "./ResearchTeamDag.css";

type ExpertNode = Node<{ role: string; state: WorkflowState; label: string; onSelect: (id: string) => void }, "expert">;
function ExpertPill({ id, data, selected }: NodeProps<ExpertNode>) {
  return <button type="button" aria-pressed={selected} onClick={() => data.onSelect(id)} title={`${expertRoles[data.role] ?? data.role} · ${data.label}`} className={`nodrag flex h-12 w-56 items-center gap-2 rounded-full border px-2 text-start shadow-sm ${workflowTone[data.state]} ${data.state === "running" ? "ring-2 ring-primary" : ""} ${selected ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
    <Handle id="up" type="target" position={Position.Top} className="opacity-0" />
    <Handle id="side-target" type="target" position={Position.Left} className="opacity-0" />
    <Handle id="side-source" type="source" position={Position.Right} className="opacity-0" />
    <img src={appHref(`/research-experts/${data.role}.png`)} alt="" className="h-9 w-9 shrink-0 rounded-full border border-border bg-background object-cover" />
    <span className="min-w-0 flex-1"><strong className="block truncate text-xs text-text">{expertRoles[data.role] ?? data.role}</strong><span className="mt-0.5 block truncate text-xs">{data.label}</span></span>
    {data.state === "running" && <CircleDot size={15} className="shrink-0 text-primary" />}
    <Handle id="down" type="source" position={Position.Bottom} className="opacity-0" />
  </button>;
}
const nodeTypes = { expert: ExpertPill };
function LocateCurrent({ ids }: { ids: string[] }) {
  const flow = useReactFlow();
  return <Button size="small" className="research-team-locate" disabled={!ids.length} onClick={() => void flow.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.6, maxZoom: 1, duration: 300 })}><img src={appHref("/research-team/locate.svg")} alt="" width={16} height={16} />定位当前</Button>;
}

export function ResearchTeamDagDialog({ study, runs, metrics, actions, onClose, confirmationContent, onOpenSession, embedded = false }: {
  embedded?: boolean;
  metrics?: ResearchMetrics | null;
  study: ResearchStudy | null;
  runs: { id: string; status: string; cancelRequested?: boolean }[];
  actions: ReactNode;
  onClose: () => void;
  confirmationContent: ReactNode;
  onOpenSession?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose);
  const [view, setView] = useState<"overview" | "tasks" | "confirmation">("overview");
  const actual = view === "tasks";
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const metricClock = useRef({ value: metrics, receivedAt: Date.now() });
  if (metricClock.current.value !== metrics) metricClock.current = { value: metrics, receivedAt: Date.now() };
  useEffect(() => {
    if (!metrics?.running || metrics.activeDurationMs == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [metrics?.running, metrics?.activeDurationMs, metrics?.measuredAt]);
  const graph = useMemo(() => researchTeamGraph(study, actual), [study, actual]);
  const expertCurrentIds = graph.nodes.filter((node) => node.state === "running" || node.state === "blocked").map((node) => node.id);
  const expertNodes: ExpertNode[] = graph.nodes.map((node) => ({ id: node.id, type: "expert", position: { x: node.x, y: node.y }, selected: selected === node.id, ariaLabel: `${expertRoles[node.role]} · ${node.id} · ${node.label}`, data: { role: node.role, state: node.state, label: actual ? `${node.id} · ${node.label}` : node.label, onSelect: setSelected } }));
  const expertEdges = graph.edges.map((edge) => {
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    const active = target?.state === "running" || target?.state === "blocked" || source?.state === "completed" && target?.state === "completed";
    return { ...edge, sourceHandle: source?.y === target?.y ? "side-source" : "down", targetHandle: source?.y === target?.y ? "side-target" : "up", id: `${edge.source}->${edge.target}`, type: "smoothstep", animated: target?.state === "running", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: active ? "var(--primary)" : "var(--border)", strokeWidth: active ? 2 : 1.5, strokeDasharray: actual ? undefined : "5 4" } };
  });
  const tasks = study?.plans.at(-1)?.tasks ?? [];
  const progress = study ? researchProgress(study) : { completed: 0, total: 0 };
  const selection = graph.nodes.find((node) => node.id === selected);
  const pending = study ? currentDecisions(study).filter((decision) => decision.status === "pending") : [];
  const artifacts = new Set(tasks.flatMap((task) => task.artifacts.map((artifact) => artifact.path))).size;
  const content = <div ref={embedded ? undefined : ref} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={titleId} tabIndex={-1} className={`research-team flex h-full min-h-0 w-full flex-col overflow-x-hidden overflow-y-auto bg-background text-text ${embedded ? "" : "max-h-full max-w-6xl rounded-xl border border-border shadow-elevated"}`} onClick={(event) => event.stopPropagation()}>
      <header className="research-team-header flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-b border-border">
        <div className="min-w-0"><h2 id={titleId} className="flex items-center gap-2 text-base font-normal"><span className="research-team-icon flex shrink-0 items-center justify-center"><img src={appHref("/research-team/team.svg")} alt="" width={22} height={22} /></span>科研专家团 · {view === "confirmation" ? "人工确认" : "DAG 全景"}</h2><p role="status" className="research-team-attention text-xs">{study ? researchAttention(study) : "尚未开始研究"}</p></div>
        <dl className="research-team-stats grid min-w-0 flex-1 gap-2">{[
          { label: "研究时长", value: researchDuration(metrics, (metrics?.measuredAt ?? 0) + Math.max(0, now - metricClock.current.receivedAt)), tone: "duration" },
          { label: "Token消耗", value: metrics?.tokenCount == null ? "—" : `${metrics.tokenCountComplete ? "" : "≥"}${fmtTokens(metrics.tokenCount)}`, tone: "tokens" },
          { label: "科研产物", value: `${artifacts} 个文件`, tone: "artifacts" },
          { label: "专家数量", value: `${new Set(tasks.map((task) => task.role)).size}/20`, tone: "experts" },
        ].map((stat) => <div key={stat.label} data-tone={stat.tone} className="research-team-stat min-w-0 rounded-xl"><dt className="text-xs text-subtext">{stat.label}</dt><dd className="mt-1 truncate text-sm font-semibold tabular-nums">{stat.value}</dd></div>)}</dl>
        {!embedded && <IconButton data-initial-focus className="self-start" aria-label="关闭专家团 DAG" onClick={onClose}><X size={18} /></IconButton>}
      </header>
      <div className="research-team-toolbar flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border">
        <div className="flex flex-wrap gap-1" role="group" aria-label="专家团页面">{[
          { label: "专家团全景", active: view === "overview", select: () => setView("overview") },
          { label: "本次任务依赖", active: actual, select: () => setView("tasks") },
        ].map((tab) => <Button key={tab.label} variant="ghost" size="small" className="research-team-tab" active={tab.active} aria-pressed={tab.active} onClick={() => { tab.select(); setSelected(null); }}>{tab.label}</Button>)}<Button size="small" variant="ghost" className="research-team-tab" active={view === "confirmation"} aria-pressed={view === "confirmation"} onClick={() => { setView("confirmation"); setSelected(null); }}>人工确认{pending.length > 0 && <span className="ms-1 text-accent-amber">{pending.length}</span>}</Button></div>
      </div>
      {view === "confirmation" ? <section aria-label="人工确认" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-y border-border p-4">{confirmationContent}</section> : <>
      <div className="research-team-canvas relative min-h-32 flex-1 border-y border-border" aria-label="科研专家团纵向 DAG">
        {actual && !tasks.length ? <p className="p-8 text-center text-sm text-subtext">暂无任务计划</p> : <ReactFlow key={`${study?.id ?? "preview"}-${study?.plans.at(-1)?.version ?? 0}-${actual}`} nodes={expertNodes} edges={expertEdges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08, minZoom: 0.25, maxZoom: 1 }} minZoom={0.25} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, node) => setSelected(node.id)} proOptions={{ hideAttribution: true }}><Background /><Controls showInteractive={false} /><div className="absolute right-3 top-3 z-10"><LocateCurrent ids={expertCurrentIds} /></div></ReactFlow>}
      </div>
      <div className="research-team-progress flex shrink-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2"><span className="shrink-0 text-sm text-text"><span className="text-primary">{progress.completed}</span>/{progress.total} 已验收</span><div className="research-team-progress-track h-2 min-w-12 flex-1 overflow-hidden rounded-full" role="progressbar" aria-label="专家任务验收进度" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.completed}><div className="h-full rounded-full bg-primary" style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></div></div>
        <div className="flex flex-wrap gap-3 text-xs text-subtext" aria-label="任务状态图例">{[{ label: "执行中", state: "running" }, { label: "已验收", state: "completed" }, { label: "待处理", state: "blocked" }, { label: "未安排", state: "waiting" }].map((item) => <span key={item.state} className="flex items-center gap-1.5"><span data-state={item.state} className="research-team-legend-dot size-2 shrink-0 rounded-full" />{item.label}</span>)}</div>
      </div>
      <section hidden={!selected} className="max-h-60 shrink-0 overflow-y-auto border-t border-border p-3" aria-label="专家执行详情">
        {!selection ? null : !selection.tasks.length ? <p className="text-sm text-subtext">{expertRoles[selection.role]} · {selection.label}</p> : selection.tasks.map((task: ResearchTask) => study && <TaskDetails key={task.id} study={study} task={task} runs={runs} onOpenSession={onOpenSession ? (id) => { onClose(); onOpenSession(id); } : undefined} />)}
      </section>
      </>}
      <footer className="flex shrink-0 flex-wrap gap-2 border-t border-border p-3">{actions}</footer>
    </div>;
  return embedded ? content : createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-5" onClick={onClose}>{content}</div>, document.body);
}
