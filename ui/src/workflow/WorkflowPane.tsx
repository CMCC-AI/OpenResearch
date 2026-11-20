// 工作流侧栏：在对话里用只读画布展示当前绑定工作流的编排与执行状态。
// 数据与专家团面板同源：study 提供计划任务、确认与交付状态，工作流草稿提供画布布局；
// 节点卡片复用编辑画布的节点类型（不带删除/编辑回调），进度图例与专家团面板保持同一套。
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Background, Controls, MarkerType, ReactFlow, useNodesState, type Edge } from "@xyflow/react";
import { Workflow as WorkflowIcon } from "lucide-react";
import { getResearchStudy, getWorkflow, listWorkflowAgents } from "../api";
import { workspaceKey } from "../queries/client";
import { researchDagLayout, researchProgress, researchTaskStatus, type ResearchTask, type WorkflowState } from "../research";
import { reconcileFlowNodes } from "../flowNodes";
import { Button } from "../components/ui";
import { LocateCurrent } from "../components/ResearchTeamDag";
import { TaskDetails } from "../components/ResearchWorkflow";
import { buildWorkflowGraph, systemNodeForStudy } from "./graph";
import { foreachConditionText, routeConditionText, waitConditionText, workflowNodeTypes, type WorkflowCanvasNode } from "./WorkflowCanvas";
import { ROUTE_ELSE, ROUTE_THEN, type WorkflowTask } from "./model";
import "../components/ResearchTeamDag.css";

function WorkflowRunGraph({ nodes: incoming, edges, currentIds, onSelect }: { nodes: WorkflowCanvasNode[]; edges: Edge[]; currentIds: string[]; onSelect: (id: string) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(incoming);
  useEffect(() => {
    // 侧栏每 2.5 秒刷新一次数据；reconcile 保住已测量的节点尺寸，避免画布抖动。
    setNodes((current) => reconcileFlowNodes(current, incoming));
  }, [incoming, setNodes]);
  return <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={workflowNodeTypes} fitView fitViewOptions={{ padding: 0.08, minZoom: 0.2, maxZoom: 1 }} minZoom={0.2} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} onNodeClick={(_, node) => onSelect(node.id)} proOptions={{ hideAttribution: true }}><Background /><Controls showInteractive={false} /><div className="absolute right-3 top-3 z-10"><LocateCurrent ids={currentIds} /></div></ReactFlow>;
}

function EmptyHint({ text }: { text: string }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center"><WorkflowIcon size={20} className="shrink-0 text-subtext" /><p className="m-0 max-w-64 text-sm leading-5 text-subtext">{text}</p></div>;
}

export function WorkflowPane({ sessionId, onOpenSession, onOpenStudio }: {
  sessionId: string | null;
  /** 点击专家任务节点后，在主对话打开它的执行会话。 */
  onOpenSession?: (id: string) => void;
  /** 侧栏只读；编辑回工作室。 */
  onOpenStudio: () => void;
}) {
  const studyQuery = useQuery({ queryKey: workspaceKey("researchStudy", sessionId), queryFn: ({ signal }) => getResearchStudy(sessionId!, signal), enabled: Boolean(sessionId), refetchInterval: (query) => ["active", "paused"].includes(query.state.data?.study?.status ?? "") ? 2500 : false });
  const study = studyQuery.data?.study ?? null;
  const plan = study?.plans.at(-1) ?? null;
  const tasks = plan?.tasks ?? [];
  const source = plan?.workflowSource ?? null;
  const draftQuery = useQuery({ queryKey: workspaceKey("workflowDraft", source?.id ?? "unbound"), queryFn: ({ signal }) => getWorkflow(source!.id, signal), enabled: Boolean(source?.id) });
  const agentsQuery = useQuery({ queryKey: workspaceKey("workflowAgents"), queryFn: ({ signal }) => listWorkflowAgents(signal) });
  const draft = draftQuery.data ?? null;
  const draftMissing = Boolean(source?.id) && draftQuery.isSuccess && !draft;
  const name = draft?.name ?? source?.name ?? null;
  const [selected, setSelected] = useState<string | null>(null);

  const agentNames = useMemo(() => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name])), [agentsQuery.data]);
  // 分流条件、逐项与等待定义只存在于草稿；计划任务只保留分支标记等执行字段，说明文案优先读草稿定义。
  const definitions = useMemo(() => new Map((draft?.tasks ?? []).map((task) => [task.id, task])), [draft]);
  const definitionOf = (task: ResearchTask): WorkflowTask => definitions.get(task.id) ?? task;

  // 布局优先用草稿保存的画布坐标；草稿被删或缺坐标时退回自动分层布局。
  // researchDagLayout 是横向分层（宽图），窄侧栏里转成纵向：层级向下走，同行任务横向排开。
  const graph = useMemo(() => {
    if (!study || !tasks.length) return null;
    const positions = draft?.positions && Object.keys(draft.positions).length > 0
      ? draft.positions
      : Object.fromEntries(researchDagLayout(tasks).map((point) => {
        const rank = Math.round(point.x / 300);
        const row = Math.round(point.y / 150);
        return [point.id, { x: row * 320, y: rank * 220 }];
      }));
    return buildWorkflowGraph(tasks, positions, { fixedChain: "always" });
  }, [study, tasks, draft]);

  const stateById = useMemo(() => {
    const states = new Map<string, WorkflowState>();
    if (study) for (const task of tasks) states.set(task.id, researchTaskStatus(study, task).state);
    return states;
  }, [study, tasks]);

  const nodes = useMemo<WorkflowCanvasNode[]>(() => {
    if (!graph || !study) return [];
    return [
      ...(draft?.frames ?? []).map((frame): WorkflowCanvasNode => ({
        id: `frame:${frame.id}`,
        type: "frame",
        position: { x: frame.x, y: frame.y },
        width: frame.width,
        height: frame.height,
        zIndex: 0,
        ariaLabel: `阶段分组 ${frame.title}`,
        data: { frameId: frame.id, title: frame.title },
      })),
      ...tasks.map((task, index): WorkflowCanvasNode => {
        const state = researchTaskStatus(study, task).state;
        const ariaLabel = `${task.brief || task.id} · ${researchTaskStatus(study, task).label}`;
        const common = { id: task.id, position: graph.taskPositions[index], selected: selected === task.id, ariaLabel };
        if (task.kind === "route") {
          const children = tasks.filter((candidate) => candidate.dependsOn.includes(task.id));
          const names = (branch: string) => children
            .filter((candidate) => (candidate.routeBranch ?? ROUTE_THEN) === branch)
            .map((candidate) => candidate.agent?.name ?? agentNames.get(candidate.role) ?? candidate.id)
            .join("、");
          return { ...common, type: "route", ariaLabel: `条件分流 ${ariaLabel}`, data: { taskId: task.id, brief: task.brief, condition: routeConditionText(definitionOf(task)), thenTargets: names(ROUTE_THEN), elseTargets: names(ROUTE_ELSE), state } };
        }
        if (task.kind === "foreach") return { ...common, type: "foreach", ariaLabel: `逐项处理 ${ariaLabel}`, data: { taskId: task.id, brief: task.brief, condition: foreachConditionText(definitionOf(task)), itemOutput: task.forEach?.itemOutput ?? "", dependencyCount: task.dependsOn.length, state } };
        if (task.kind === "experiment") return { ...common, type: "experiment", ariaLabel: `实验节点 ${ariaLabel}`, data: { taskId: task.id, brief: task.brief, outputCount: task.outputs.length, dependencyCount: task.dependsOn.length, state } };
        if (task.kind === "wait") return { ...common, type: "wait", ariaLabel: `事件等待 ${ariaLabel}`, data: { taskId: task.id, brief: task.brief, condition: waitConditionText(definitionOf(task)), dependencyCount: task.dependsOn.length, state } };
        if (task.kind === "human") return { ...common, type: "human", ariaLabel: `人工任务 ${ariaLabel}`, data: { taskId: task.id, brief: task.brief, output: task.outputs[0] ?? "产物", dependencyCount: task.dependsOn.length, state } };
        return { ...common, type: "agent", ariaLabel: `专家任务 ${ariaLabel}`, data: { taskId: task.id, roleName: task.agent?.name ?? agentNames.get(task.role) ?? task.role, brief: task.brief, outputCount: task.outputs.length, dependencyCount: task.dependsOn.length, requiresApproval: !!task.requiresApproval, gateDownstream: !!task.gateDownstream, maxRework: task.maxRework ?? 0, state } };
      }),
      ...graph.systemNodes.map((node): WorkflowCanvasNode => ({ ...node, type: "system", selected: selected === node.id, ariaLabel: node.data.title, data: systemNodeForStudy(node.data, study) })),
    ];
  }, [graph, study, tasks, draft, definitions, selected, agentNames]);

  const edges = useMemo<Edge[]>(() => {
    if (!graph || !study) return [];
    const states = new Map(stateById);
    for (const node of graph.systemNodes) states.set(node.id, systemNodeForStudy(node.data, study).state ?? "waiting");
    return graph.edges.map((edge) => {
      const sourceState = states.get(edge.source);
      const targetState = states.get(edge.target);
      const active = targetState === "running" || targetState === "blocked" || (sourceState === "completed" && targetState === "completed");
      return { ...edge, id: `${edge.source}->${edge.target}`, type: "smoothstep", interactionWidth: 24, animated: targetState === "running", markerEnd: { type: MarkerType.ArrowClosed },
        label: edge.branch ? (edge.branch === ROUTE_THEN ? "成立" : "不成立") : undefined,
        labelShowBg: true, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
        labelStyle: { fontSize: 11, fill: edge.branch === ROUTE_ELSE ? "var(--color-subtext)" : "var(--color-text)" },
        style: { stroke: active ? "var(--primary)" : "var(--border)", strokeWidth: active ? 2 : 1.5, strokeDasharray: edge.dependency ? undefined : "5 4" } };
    });
  }, [graph, study, stateById]);

  const currentIds = useMemo(() => {
    if (!graph || !study) return [];
    return [...tasks.filter((task) => ["running", "blocked"].includes(researchTaskStatus(study, task).state)).map((task) => task.id),
      ...graph.systemNodes.filter((node) => systemNodeForStudy(node.data, study).state === "blocked").map((node) => node.id)];
  }, [graph, study, tasks]);

  const selectedTask = tasks.find((task) => task.id === selected) ?? null;
  const selectedSystem = graph?.systemNodes.find((node) => node.id === selected) ?? null;
  const systemSelection = selectedSystem && study ? systemNodeForStudy(selectedSystem.data, study) : null;
  const progress = study ? researchProgress(study) : { completed: 0, total: 0 };
  const statusLine = !study ? "尚未开始研究" : draftMissing ? "原工作流已被删除 · 画布显示当前执行计划" : source ? "已绑定 · 这个对话不再更换" : "未绑定工作流 · 显示当前执行计划";

  return <div className="flex h-full min-h-0 flex-col bg-background text-text">
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary"><WorkflowIcon size={16} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1"><h2 className="m-0 truncate text-base font-normal">工作流 · {name ?? "未绑定"}</h2><p role="status" className="m-0 text-xs text-subtext">{statusLine}</p></div>
      <Button size="small" variant="ghost" onClick={onOpenStudio}>打开工作室</Button>
    </header>
    {!sessionId ? <EmptyHint text="开始对话后，这里会显示绑定的工作流画布。" /> : studyQuery.isPending ? <p className="p-4 text-sm text-subtext">正在读取工作流状态…</p> : studyQuery.error ? <div role="alert" className="p-4 text-sm text-accent-red">工作流状态读取失败：{studyQuery.error.message}<Button size="small" className="ms-2" onClick={() => void studyQuery.refetch()}>重试</Button></div> : !graph ? <EmptyHint text="这个对话还没有工作流画布。在输入框切换到「工作流模式」后，画布会显示在这里。" /> : <>
      <div className="relative min-h-32 flex-1 border-b border-border" aria-label="工作流画布">
        <WorkflowRunGraph key={`${study?.id ?? "preview"}-${plan?.version ?? 0}`} nodes={nodes} edges={edges} currentIds={currentIds} onSelect={setSelected} />
      </div>
      <div className="research-team-progress flex shrink-0 flex-wrap items-center gap-3 border-t border-border">
        <div className="flex min-w-0 flex-1 items-center gap-2"><span className="shrink-0 text-sm text-text"><span className="text-primary">{progress.completed}</span>/{progress.total} 已验收</span><div className="research-team-progress-track h-2 min-w-12 flex-1 overflow-hidden rounded-full" role="progressbar" aria-label="专家任务验收进度" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.completed}><div className="h-full rounded-full bg-primary" style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></div></div>
        <div className="flex flex-wrap gap-3 text-xs text-subtext" aria-label="任务状态图例">{[{ label: "执行中", state: "running" }, { label: "已验收", state: "completed" }, { label: "已跳过", state: "optional" }, { label: "待处理", state: "blocked" }, { label: "未安排", state: "waiting" }].map((item) => <span key={item.state} className="flex items-center gap-1.5"><span data-state={item.state} className="research-team-legend-dot size-2 shrink-0 rounded-full" />{item.label}</span>)}</div>
      </div>
      <section hidden={!selected} className="max-h-60 shrink-0 overflow-y-auto border-t border-border p-3" aria-label="节点详情">
        {systemSelection ? <div className="flex flex-col items-start gap-2 text-sm"><strong>{systemSelection.title} · {systemSelection.label}</strong><p className="m-0 text-subtext">{systemSelection.description}</p></div>
          : selectedTask ? <TaskDetails study={study!} task={selectedTask} runs={studyQuery.data?.runs ?? []} onOpenSession={onOpenSession} /> : null}
      </section>
    </>}
  </div>;
}
