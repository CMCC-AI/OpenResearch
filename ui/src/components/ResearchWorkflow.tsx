import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, CheckCircle2, Circle, CircleDot, GitBranch, ShieldCheck, Users, X } from "lucide-react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { consultationCoverage, researchWorkflowMode, expertRoles, researchAttention, currentDecisions, researchDagLayout, researchModes, researchProgress, researchTaskStatus, researchWorkflow, workflowStateNames, type ResearchStudy, type ResearchTask, type WorkflowState } from "../research";
import { ResearchModulePreview } from "./ResearchModulePreview";
import { ResearchJourneyIntro } from "./ResearchJourneyIntro";
import { useDialogFocus } from "./useDialogFocus";
import { Button, IconButton } from "./ui";

export const workflowTone: Record<WorkflowState, string> = {
  completed: "border-accent-green bg-accent-green-subtle text-accent-green",
  running: "border-primary bg-primary-subtle text-primary",
  blocked: "border-accent-amber bg-accent-amber-subtle text-accent-amber",
  waiting: "border-border bg-background text-subtext",
  optional: "border-border bg-surface text-muted",
  stopped: "border-border bg-surface text-subtext",
};
function StateIcon({ state }: { state: WorkflowState }) {
  const Icon = state === "completed" ? CheckCircle2 : state === "running" ? CircleDot : state === "blocked" ? ShieldCheck : Circle;
  return <Icon size={16} className="shrink-0" aria-hidden="true" />;
}

type TaskNode = Node<{ task: ResearchTask; state: WorkflowState; label: string; onSelect: (id: string) => void }, "researchTask">;
function ExpertTaskNode({ data, selected }: NodeProps<TaskNode>) {
  return <button type="button" aria-pressed={selected} onClick={() => data.onSelect(data.task.id)} className={`nodrag w-64 rounded-lg border p-3 text-start shadow-sm ${workflowTone[data.state]} ${selected ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <div className="flex items-center gap-2"><StateIcon state={data.state} /><strong className="truncate text-sm">{expertRoles[data.task.role] ?? data.task.role}</strong></div>
    <p className="mt-1 truncate text-xs text-subtext">{data.task.id}</p>
    <p className="mt-2 line-clamp-2 text-xs text-text">{data.task.brief}</p>
    <p className="mt-2 text-xs font-medium">{data.label}</p>
    <Handle type="source" position={Position.Right} />
  </button>;
}
const nodeTypes = { researchTask: ExpertTaskNode };

export function ResearchWorkflowDialog({ study, runs, decisionCards, actions, onClose, onOpenSession, embedded = false }: {
  embedded?: boolean;
  study: ResearchStudy;
  runs: { id: string; status: string; cancelRequested?: boolean }[];
  decisionCards: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose);
  const [layer, setLayer] = useState<"preview" | "plan" | "execution">(() => !study.plans.length ? "preview" : currentDecisions(study).some((decision) => decision.gate === "G1" && decision.status === "pending") ? "plan" : "execution");
  const [view, setView] = useState<"dag" | "list">("dag");
  const [selected, setSelected] = useState<string | null>(null);
  const tasks = study.plans.at(-1)?.tasks ?? [];
  const progress = researchProgress(study);
  const coverage = consultationCoverage(study);
  const workflowMode = researchWorkflowMode(study);
  const stages = researchWorkflow(study);
  const selectedTask = tasks.find((task) => task.id === selected);
  const nodes = useMemo(() => researchDagLayout(tasks).map((position): TaskNode => {
    const task = tasks.find((task) => task.id === position.id)!;
    return { id: task.id, type: "researchTask", position: { x: position.x, y: position.y }, data: { task, ...researchTaskStatus(study, task), onSelect: setSelected }, selected: task.id === selected, ariaLabel: `${expertRoles[task.role] ?? task.role} · ${task.id} · ${researchTaskStatus(study, task).label}` };
  }), [study, tasks, selected]);
  const edges = useMemo(() => tasks.flatMap((task) => task.dependsOn.map((id) => ({
    id: `${id}->${task.id}`, source: id, target: task.id,
    animated: task.state === "running" && study.status !== "stopped",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: tasks.find((entry) => entry.id === id)?.state === "completed" ? "var(--primary)" : "var(--border)" },
  }))), [tasks, study.status]);
  const content = <div ref={embedded ? undefined : ref} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={titleId} tabIndex={-1} className={`flex min-h-0 w-full flex-col overflow-hidden bg-background text-text ${embedded ? "h-full" : "max-h-full max-w-6xl rounded-xl border border-border shadow-elevated"}`} onClick={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4">
        <div><div className="flex items-center gap-2"><Users size={20} className="text-primary" /><h2 id={titleId} className="font-semibold">{researchModes[workflowMode]} · 研究流程</h2></div><p role="status" className="mt-1 text-sm text-subtext">{researchAttention(study)} · {progress.completed}/{progress.total} 个任务已验收{study.plans.length ? ` · 计划 v${study.plans.at(-1)?.version}` : ""}</p></div>
        <IconButton data-initial-focus aria-label={embedded ? "返回专家团流程图" : "关闭研究流程"} onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-4 sm:p-5">
        <p className="text-sm text-text">{study.objective}</p>
        <nav className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="研究模块三层展示">
          {([
            { id: "preview", title: "1 · 模块预览",  },
            { id: "plan", title: "2 · 本次分工",  },
            { id: "execution", title: "3 · 实际执行与成果",  },
          ] as const).map((item) => <button key={item.id} type="button" aria-pressed={layer === item.id} onClick={() => setLayer(item.id)} className={`rounded-lg border p-3 text-start focus-visible:outline-2 focus-visible:outline-primary ${layer === item.id ? "border-primary bg-primary-subtle" : "border-border bg-surface"}`}><strong className="text-sm">{item.title}</strong></button>)}
        </nav>
        {layer === "preview" && (workflowMode === "team" ? <ResearchJourneyIntro /> : <ResearchModulePreview mode={workflowMode} />)}
        {layer === "plan" && <section aria-label="本次专家分工" className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">本次具体计划{study.plans.length > 0 ? ` · v${study.plans.at(-1)?.version}` : " · 尚未登记"}</h3>
          {!tasks.length ? <p className="rounded-lg border border-dashed border-border p-5 text-sm text-subtext">暂无计划</p> : <>
            <p className="text-xs text-subtext">本次安排 {coverage.roles.length} 类专家、{coverage.total} 个任务。</p>
            <div className="rounded-lg border border-border bg-surface p-3"><h4 className="text-sm font-medium">安排依据与研究范围</h4><p className="mt-2 whitespace-pre-wrap text-sm text-subtext">{study.plans.at(-1)?.summary}</p></div>
            <ol className="grid gap-2 sm:grid-cols-2">{tasks.map((task) => <li key={task.id} className="rounded-lg border border-border p-3 text-sm"><strong>{expertRoles[task.role] ?? task.role}</strong><span className="ms-2 text-xs text-muted">{task.id}</span><p className="mt-2 whitespace-pre-wrap">{task.brief}</p><p className="mt-2 text-xs text-subtext">前置任务：{task.dependsOn.map((id) => { const parent = tasks.find((entry) => entry.id === id); return parent ? `${expertRoles[parent.role] ?? parent.role}（${id}）` : id; }).join("、") || "无，可独立开始"}</p><p className="mt-1 text-xs text-subtext">交付要求：{task.outputs.join("、")}</p></li>)}</ol>
            {coverage.unselected.length > 0 && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs text-subtext">本次未安排专家（{coverage.unselected.length} 类）</summary><p className="mt-2 text-xs leading-relaxed text-subtext">{coverage.unselected.map((role) => expertRoles[role] ?? role).join("、")}</p></details>}
          </>}
          {decisionCards}
        </section>}
        {layer === "execution" && <>
        <section aria-label="实际执行概览" className="rounded-lg border border-border bg-surface p-3"><h3 className="text-sm font-medium">实际执行概览</h3><p className="mt-2 text-sm">{coverage.dispatched}/{coverage.total} 个任务已派发 · {coverage.completed} 个任务产物已验收</p></section>
        {study.mode === "team" && <section aria-label="完整研究路径">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">完整研究路径</h3></div>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {stages.map((stage, index) => <li key={stage.id} className={`rounded-lg border p-3 ${workflowTone[stage.state]}`}>
              <div className="flex items-center gap-2"><span className="text-xs font-mono">{String(index + 1).padStart(2, "0")}</span><StateIcon state={stage.state} /><strong className="text-sm">{stage.title}</strong>{index < stages.length - 1 && <ArrowRight size={14} className="ml-auto shrink-0" aria-hidden="true" />}</div>
              <p className="mt-2 text-xs leading-relaxed text-subtext">{stage.description}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs"><span>{stage.decisions.some((decision) => decision.status === "pending") ? "等待你的确认" : workflowStateNames[stage.state]}</span>{stage.gates.length > 0 && <span className="font-medium">{stage.gates.join(" / ")}</span>}{stage.tasks.length > 0 && <span>{stage.tasks.filter((task) => task.state === "completed").length}/{stage.tasks.length} 任务</span>}</div>
            </li>)}
          </ol>
        </section>}
        {decisionCards}
        <section aria-label="当前计划专家任务">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="flex items-center gap-2 text-sm font-medium"><GitBranch size={16} />当前计划 · 专家任务 DAG</h3></div>
            <div className="flex gap-1" role="group" aria-label="专家任务展示方式"><Button size="small" aria-pressed={view === "dag"} onClick={() => setView("dag")}>依赖图</Button><Button size="small" aria-pressed={view === "list"} onClick={() => setView("list")}>任务列表</Button></div>
          </div>
          <div className="mb-2 flex flex-wrap gap-3 text-xs text-subtext" aria-label="状态图例">{(["completed", "running", "blocked", "waiting"] as const).map((state) => <span key={state} className={`flex items-center gap-1 rounded border px-2 py-1 ${workflowTone[state]}`}><StateIcon state={state} />{workflowStateNames[state]}</span>)}</div>
          {!tasks.length ? <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center"><Users size={24} className="mx-auto mb-2 text-primary" /><p className="text-sm">主理人正在制定计划</p></div> : <>
            {view === "dag" ? <div className="h-96 overflow-hidden rounded-lg border border-border bg-surface [&_.react-flow__controls-button]:bg-background [&_.react-flow__controls-button]:text-text [&_.react-flow__controls-button]:border-border [&_.react-flow__controls-button_svg]:fill-current" aria-label="专家任务依赖图">
              <ReactFlow key={`${study.id}-${study.plans.at(-1)?.version}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.3} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, node) => setSelected(node.id)} proOptions={{ hideAttribution: true }}><Background /><Controls showInteractive={false} /></ReactFlow>
            </div> : <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{tasks.map((task) => {
              const status = researchTaskStatus(study, task);
              return <li key={task.id}><button type="button" aria-pressed={selected === task.id} onClick={() => setSelected(task.id)} className={`w-full rounded-lg border p-3 text-start ${workflowTone[status.state]} ${selected === task.id ? "ring-2 ring-primary" : ""}`}><strong className="text-sm">{expertRoles[task.role] ?? task.role}</strong><p className="mt-1 text-xs">{task.id} · {status.label}</p><p className="mt-1 text-xs text-subtext">前置：{task.dependsOn.join("、") || "无"}</p></button></li>;
            })}</ul>}
            {selectedTask ? <TaskDetails study={study} task={selectedTask} runs={runs} onOpenSession={onOpenSession ? (id) => { onClose(); onOpenSession(id); } : undefined} /> : null}
          </>}
        </section>
        {study.claims.length > 0 && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">证据声明（{study.claims.length}）</summary>{study.claims.map((claim) => <div key={claim.id} className="mt-2 border-t border-border py-2 text-sm"><p>{claim.text}</p><p className="text-xs text-subtext">{claim.support === "experiment" ? "实验关联证据" : claim.support === "paper" ? "论文原文声明" : "推测"} · {claim.source} {claim.location}</p>{claim.excerpt && <pre className="mt-1 whitespace-pre-wrap text-xs">{claim.excerpt}</pre>}</div>)}</details>}
        </>}
        {layer === "execution" && study.plans.at(-1)?.summary && <details className="text-sm"><summary className="cursor-pointer text-subtext">查看研究计划说明</summary><p className="mt-2 whitespace-pre-wrap">{study.plans.at(-1)?.summary}</p></details>}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-3">{actions}</footer>
    </div>;
  return embedded ? content : createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>{content}</div>, document.body);
}
export function TaskDetails({ study, task, runs, onOpenSession }: { study: ResearchStudy; task: ResearchTask; runs: { id: string; status: string; cancelRequested?: boolean }[]; onOpenSession?: (sessionId: string) => void }) {
  return <section className="mt-3 rounded-lg border border-primary bg-primary-subtle p-4 text-sm" aria-label={`任务详情 ${task.id}`}>
    <div className="flex flex-wrap justify-between gap-2"><strong>{expertRoles[task.role] ?? task.role} · {task.id}</strong><span className="text-primary">{researchTaskStatus(study, task).label}</span></div>
    <p className="mt-2 whitespace-pre-wrap">{task.brief}</p>
    <p className="mt-2 flex items-center gap-1 text-xs text-subtext"><ArrowRight size={12} />前置任务：{task.dependsOn.join("、") || "无"}</p>
    <p className="mt-1 text-xs text-subtext">要求产物：{task.outputs.join("、")}</p>
    <div className="mt-3 rounded border border-border bg-background p-3"><p className="text-xs text-subtext">{task.sessionId ? "已派发至真实专家会话" : "尚未派发，未绑定专家会话"}</p>{task.sessionId && <><p className="mt-1 break-all font-mono text-xs text-muted">{task.sessionId}</p>{onOpenSession && <Button size="small" className="mt-2" onClick={() => onOpenSession(task.sessionId!)}>查看专家会话</Button>}</>}</div>
    {task.artifacts.length > 0 ? <ul className="mt-2 flex flex-col gap-1 text-xs text-accent-green" aria-label="已验收产物">{task.artifacts.map((artifact) => <li key={artifact.path} className="break-all">{artifact.path} · {artifact.bytes} 字节</li>)}</ul> : <p className="mt-2 text-xs text-muted">暂无已验收产物</p>}
    {task.summary && <p className="mt-2 whitespace-pre-wrap">{task.summary}</p>}
    {task.runIds.map((id) => { const run = runs.find((entry) => entry.id === id); return <p key={id} className="mt-2 break-all font-mono text-xs">Run {id} · {run?.status ?? "状态未知"}{run?.cancelRequested ? " · 已请求取消" : ""}</p>; })}
  </section>;
}
