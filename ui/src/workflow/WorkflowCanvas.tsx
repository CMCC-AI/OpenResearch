import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { Bot, CircleHelp, FileText, GripVertical, PackageCheck, Plus, RefreshCw, ShieldCheck, Split, Trash2, X } from "lucide-react";
import { Button } from "../components/ui";
import { Switch } from "../components/ui/Switch";
import { addAgentTask, connectWorkflowTasks, reconnectWorkflowTasks, removeWorkflowTask, MAX_REWORK, type FlowPoint, type WorkflowAgent, type WorkflowDraftInput, type WorkflowTask } from "./model";
import { approvalNodeId, buildWorkflowGraph, fixedSystemData, systemNodeIds } from "./graph";
import { SystemNodeCard, type SystemNode } from "./SystemNode";

// 拖拽添加专家任务时，dataTransfer 里携带 agent id 的数据类型。
const AGENT_MIME = "application/x-orx-agent";
// 拖拽添加系统环节（G1/G4/研究交付）时，携带系统节点 id。
export const SYSTEM_MIME = "application/x-orx-system-node";

type AgentNodeData = {
  taskId: string;
  roleName: string;
  brief: string;
  outputCount: number;
  dependencyCount: number;
  requiresApproval: boolean;
  gateDownstream: boolean;
  maxRework: number;
  onDelete: () => void;
};
type AgentNode = Node<AgentNodeData, "agent">;

function AgentNodeCard({ data, selected }: NodeProps<AgentNode>) {
  return <div className={`group relative w-64 rounded-lg border bg-background shadow-sm transition-shadow ${selected ? "border-primary ring-2 ring-primary/20" : "border-border hover:shadow-control-subtle"}`}>
    <Handle type="target" position={Position.Top} />
    <div className="flex items-start gap-2.5 px-3 pb-1.5 pt-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary" aria-hidden="true"><Bot size={15} /></span>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm text-text">{data.roleName}</strong>
        <span className="block truncate font-mono text-xs text-subtext">{data.taskId}</span>
      </div>
      <button type="button" className="nodrag absolute end-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-subtext hover:border-accent-red hover:text-accent-red group-hover:flex" aria-label={`删除节点 ${data.taskId}`} title="删除节点" onClick={data.onDelete}>
        <Trash2 size={12} />
      </button>
    </div>
    {data.brief && <p className="mb-2 line-clamp-2 px-3 text-xs leading-4 text-subtext">{data.brief}</p>}
    {(data.requiresApproval || data.gateDownstream) && <div className="flex flex-wrap gap-1 px-3 pb-1.5">
      {data.requiresApproval && <span className="flex items-center gap-1 rounded bg-accent-amber-subtle px-1.5 py-0.5 text-xs text-accent-amber" title="完成后需主理人确认才放行下游"><ShieldCheck size={11} aria-hidden="true" />需主理人确认</span>}
      {data.gateDownstream && <span className="flex items-center gap-1 rounded bg-primary-subtle px-1.5 py-0.5 text-xs text-primary" title={data.maxRework > 0 ? `结论没通过时暂停下游任务，自动返工最多 ${data.maxRework} 轮` : "结论没通过时暂停下游任务"}><Split size={11} aria-hidden="true" />结论把关{data.maxRework > 0 && <span className="flex items-center gap-0.5"><RefreshCw size={10} aria-hidden="true" />≤{data.maxRework}轮</span>}</span>}
    </div>}
    <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-subtext">
      <span className="flex items-center gap-1"><FileText size={12} aria-hidden="true" />{data.outputCount} 个产物</span>
      <span>{data.dependencyCount ? `前置 ${data.dependencyCount} 项` : "无前置"}</span>
    </div>
    <Handle type="source" position={Position.Bottom} />
  </div>;
}

type CanvasNode = AgentNode | SystemNode;
const nodeTypes = { agent: AgentNodeCard, system: SystemNodeCard };

function WorkflowHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div role="dialog" aria-label="工作流说明" className="absolute end-3 top-12 z-10 w-[min(26rem,calc(100%-1.5rem))] rounded-lg border border-border bg-background p-4 text-sm shadow-control-subtle">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="m-0 text-base font-normal">工作流是什么？</h2>
      <Button size="small" variant="ghost" aria-label="关闭说明" onClick={onClose}><X size={14} /></Button>
    </div>
    <dl className="m-0 flex flex-col gap-2.5 text-subtext">
      <div><dt className="font-normal text-text">节点 = 专家任务</dt><dd className="m-0">把左侧专家拖进画布即成一个任务节点；画布上只摆你添加的专家任务，节点描述谁做什么、产出什么；开启「完成后需主理人确认」会生成任务检查点。范围确认与交付确认在提交后的聊天与运行视图展示。</dd></div>
      <div><dt className="font-normal text-text">连线 = 先后顺序</dt><dd className="m-0">从上方专家的底部拖线到下方专家的顶部，表示「前者做完，后者才开始」。拖住实线两端的小圆点，可以把它改接到别的专家；选中实线后按 Delete 删除；虚线是系统自带的，不能改也不能删。系统环节（范围确认、交付确认、研究交付）不用手动连线：放进画布后，与任务的约束线自动生成。「需主理人确认」和「结论把关」决定下游任务什么时候开始。</dd></div>
      <div><dt className="font-normal text-text">产物 = 可追溯的输出</dt><dd className="m-0">每个节点声明输出文件路径；提交后专家把结果写入研究目录，供下游专家与审查引用。</dd></div>
      <div><dt className="font-normal text-text">在对话中使用</dt><dd className="m-0">把方法带回聊天，直接描述你的需求；AI 会给出执行计划，你确认后专家开始工作，进展和成果都在同一个对话里。</dd></div>
    </dl>
  </div>;
}

export function WorkflowCanvas({ draft, agents, onChange }: {
  draft: WorkflowDraftInput;
  agents: WorkflowAgent[];
  onChange: (draft: WorkflowDraftInput) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const viewportDirty = useRef(false);
  const flowRef = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  // 编辑画布只呈现主理人显式添加的内容：固定链路（G1/G4/交付）留在节点库说明与运行视图，不自动铺上画布。
  const graph = useMemo(() => buildWorkflowGraph(draft.tasks, draft.positions, { fixedChain: "never" }), [draft.tasks, draft.positions]);
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const nodes = useMemo<CanvasNode[]>(() => [...draft.tasks.map((task, index): AgentNode => ({
    id: task.id,
    type: "agent",
    position: graph.taskPositions[index],
    ariaLabel: `专家任务 ${task.id}`,
    selected: selected === task.id,
    data: {
      taskId: task.id,
      roleName: agentNames.get(task.role) ?? task.role,
      brief: task.brief,
      outputCount: task.outputs.length,
      dependencyCount: task.dependsOn.length,
      requiresApproval: !!task.requiresApproval,
      gateDownstream: !!task.gateDownstream,
      maxRework: task.maxRework ?? 0,
      onDelete: () => {
        onChange(removeWorkflowTask(draft, task.id));
        setSelected(null);
      },
    },
  })), ...graph.systemNodes.map((node): SystemNode => ({ ...node, type: "system", selected: selected === node.id, // 检查点随任务配置生成不可删；拖入的系统环节可删除。
    deletable: !node.data.taskId, connectable: false, ariaLabel: node.data.title,
    data: node.data.taskId ? node.data : { ...node.data, onDelete: () => removeSystemNode(node.id) } }))], [draft, graph, selected, agentNames, onChange]);
  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => ({
    ...edge,
    deletable: !!edge.dependency,
    // 只有任务依赖线可以拖端点改接；系统约束线保持固定。
    reconnectable: !!edge.dependency,
    type: "smoothstep",
    interactionWidth: 24,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: edge.dependency ? undefined : { strokeDasharray: "5 4" },
  })), [graph]);
  const selectedTask = draft.tasks.find((task) => task.id === selected) ?? null;
  // 空白画布不渲染固定链路：从节点库选中 G1/G4/交付时，用静态说明展示属性面板。
  const selectedSystem = graph.systemNodes.find((node) => node.id === selected)
    ?? (selected && fixedSystemData(selected) ? { id: selected, position: { x: 0, y: 0 }, data: fixedSystemData(selected)! } : null);
  const approvalTask = draft.tasks.find((task) => task.id === selectedSystem?.data.taskId);
  const depOutputs = useMemo(() => (selectedTask
    ? [...new Set(selectedTask.dependsOn.flatMap((dependency) => draft.tasks.find((task) => task.id === dependency)?.outputs ?? []))]
    : []), [selectedTask, draft.tasks]);

  function updateTask(id: string, update: Partial<WorkflowTask>) {
    onChange({ ...draft, tasks: draft.tasks.map((task) => task.id === id ? { ...task, ...update } : task) });
  }

  function onNodesChange(changes: NodeChange<CanvasNode>[]) {
    let next = draft;
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const positions = { ...next.positions, [change.id]: change.position as FlowPoint };
        next = { ...next, positions };
      } else if (change.type === "select") {
        setSelected(change.selected ? change.id : null);
      } else if (change.type === "remove") {
        if (next.tasks.some((task) => task.id === change.id)) {
          next = removeWorkflowTask(next, change.id);
          if (selected === change.id) setSelected(null);
        } else if (fixedSystemData(change.id) && next.positions[change.id] !== undefined) {
          // 拖入的系统环节可删除：移除坐标键即从画布撤下；未放置过的键删除时不产生写入。
          const positions = { ...next.positions };
          delete positions[change.id];
          next = { ...next, positions };
          if (selected === change.id) setSelected(null);
        }
      }
    }
    if (next !== draft) onChange(next);
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    let next = draft;
    for (const change of changes) {
      if (change.type !== "remove") continue;
      const dependency = graph.edges.find((edge) => edge.id === change.id)?.dependency;
      if (!dependency) continue;
      const { source, target } = dependency;
      next = {
        ...next,
        tasks: next.tasks.map((task) => task.id === target ? { ...task, dependsOn: task.dependsOn.filter((id) => id !== source) } : task),
      };
    }
    if (next !== draft) onChange(next);
  }

  function selectSystem(id: string) {
    setSelected(id);
    void flowRef.current?.fitView({ nodes: [{ id }], padding: 0.8, maxZoom: 1, duration: 250 });
  }

  function addApproval() {
    if (!selectedTask) return;
    updateTask(selectedTask.id, { requiresApproval: true });
    setSelected(approvalNodeId(selectedTask.id));
  }

  // 节点库的系统环节也可拖入画布：拖拽携带系统节点 id，点击仍用于查看说明。
  function dragSystem(id: string) {
    return (event: DragEvent<HTMLButtonElement>) => {
      event.dataTransfer.setData(SYSTEM_MIME, id);
      event.dataTransfer.effectAllowed = "copy";
    };
  }

  function connect(connection: Connection) {
    if (!connection.source || !connection.target) return;
    try {
      setError(null);
      onChange(connectWorkflowTasks(draft, connection.source, connection.target));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 拖动已有连线两端的改接点换专家：复用新增连线的校验，但先移除旧线再检查循环。
  function reconnect(oldEdge: Edge, connection: Connection) {
    if (!connection.source || !connection.target) return;
    try {
      setError(null);
      onChange(reconnectWorkflowTasks(draft, { source: oldEdge.source, target: oldEdge.target }, connection.source, connection.target));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function deleteTask(id: string) {
    onChange(removeWorkflowTask(draft, id));
    if (selected === id) setSelected(null);
  }

  // 拖入的系统环节可删除：移除坐标键即从画布撤下；未放置过的键删除时不产生写入。
  function removeSystemNode(id: string) {
    if (!fixedSystemData(id) || draft.positions[id] === undefined) return;
    const positions = { ...draft.positions };
    delete positions[id];
    onChange({ ...draft, positions });
    if (selected === id) setSelected(null);
  }

  function isLibraryDrag(event: DragEvent<HTMLDivElement>) {
    return event.dataTransfer.types.includes(AGENT_MIME) || event.dataTransfer.types.includes(SYSTEM_MIME);
  }

  function onDragOverCanvas(event: DragEvent<HTMLDivElement>) {
    if (!isLibraryDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function onDragLeaveCanvas(event: DragEvent<HTMLDivElement>) {
    // 经过画布内子元素时会触发 leave，只有真正拖出画布边界才熄灭提示。
    // 文件内 import 了 React Flow 的 Node 类型，这里用 globalThis.Node 指代 DOM 节点。
    if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDropActive(false);
  }

  function onDropCanvas(event: DragEvent<HTMLDivElement>) {
    if (!isLibraryDrag(event)) return;
    event.preventDefault();
    setDropActive(false);
    // 落点换算成画布坐标后作为节点位置：水平居中于光标（节点宽 256px），标题大致对准落点。
    const point = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const drop = point ? { x: point.x - 128, y: point.y - 24 } : undefined;
    const agent = agents.find((entry) => entry.id === event.dataTransfer.getData(AGENT_MIME));
    if (agent) {
      onChange(addAgentTask(draft, agent, drop));
      return;
    }
    const systemId = event.dataTransfer.getData(SYSTEM_MIME);
    if (!fixedSystemData(systemId)) return;
    // 系统环节“存在即渲染”：写入坐标键即放置，删除节点即移除。
    onChange({ ...draft, positions: { ...draft.positions, [systemId]: drop ?? { x: 0, y: 0 } } });
    setSelected(systemId);
  }

  // 窄于 xl 时三栏纵向堆叠并整页滚动；xl 起恢复三栏各自滚动，避免两栏被画布挤成细条。
  return <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 overflow-y-auto xl:auto-rows-auto xl:grid-cols-[240px_minmax(0,1fr)_300px] xl:overflow-hidden">
    <aside className="max-h-80 min-w-0 overflow-y-auto border-b border-border p-3 xl:max-h-none xl:min-h-0 xl:border-b-0 xl:border-e">
      <h2 className="m-0 mb-1 text-base font-normal">节点库</h2>
      <p className="mt-0 text-sm leading-5 text-subtext">把专家和系统环节拖进画布组合任务；点击条目查看说明。</p>
      <section aria-label="交付" className="mb-4">
        <h3 className="mb-1 text-sm font-normal text-subtext">交付</h3>
        <button type="button" draggable title="拖拽「研究交付」到画布放置；点击查看说明" onDragStart={dragSystem(systemNodeIds.output)} aria-pressed={selected === systemNodeIds.output} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-surface" onClick={() => selectSystem(systemNodeIds.output)}><PackageCheck size={15} className="shrink-0 text-subtext" />研究交付<span className="ms-auto text-xs text-subtext">系统</span></button>
      </section>
      <section aria-label="流程控制" className="mb-4">
        <h3 className="mb-1 text-sm font-normal text-subtext">流程控制</h3>
        {[{ id: systemNodeIds.scope, title: "G1 · 研究范围确认" }, { id: systemNodeIds.delivery, title: "G4 · 交付确认" }].map(({ id, title }) => <button key={id} type="button" draggable title={`拖拽「${title}」到画布放置；点击查看说明`} onDragStart={dragSystem(id)} aria-pressed={selected === id} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-surface" onClick={() => selectSystem(id)}><ShieldCheck size={15} className="shrink-0 text-subtext" />{title}</button>)}
        <button type="button" disabled={!selectedTask || !!selectedTask.requiresApproval} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-surface disabled:opacity-50" onClick={addApproval}><ShieldCheck size={15} className="shrink-0 text-subtext" />任务后人工确认<Plus size={14} className="ms-auto shrink-0 text-subtext" /></button>
        <p className="mx-2 my-1 text-xs leading-4 text-subtext">先选择专家任务，再为它设置人工确认。</p>
      </section>
      <section aria-label="专家任务">
      <h3 className="mb-1 text-sm font-normal text-subtext">专家任务</h3>
      <div className="flex flex-col gap-1">
        {agents.map((agent) => <div key={agent.id} draggable title={`拖拽「${agent.name}」到画布`} onDragStart={(event) => { event.dataTransfer.setData(AGENT_MIME, agent.id); event.dataTransfer.effectAllowed = "copy"; }} className="flex cursor-grab items-start gap-2 rounded-md border border-transparent px-2 py-2 text-start hover:border-border hover:bg-surface active:cursor-grabbing">
          <GripVertical size={15} className="mt-0.5 shrink-0 text-subtext" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-sm font-normal text-text">{agent.name}</strong>
            <span className="block truncate text-xs text-subtext">{agent.description || (agent.builtIn ? "内置专家" : `自定义 v${agent.version}`)}</span>
          </span>
        </div>)}
      </div>
      </section>
    </aside>
    <div className="workflow-canvas relative min-h-120 min-w-0 border-b border-border xl:min-h-0 xl:border-b-0" aria-label="W1 工作流编辑画布" onDragOver={onDragOverCanvas} onDragLeave={onDragLeaveCanvas} onDrop={onDropCanvas}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(flow) => { flowRef.current = flow; }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onReconnect={reconnect}
        reconnectRadius={16}
        defaultViewport={draft.viewport ?? { x: 0, y: 0, zoom: 1 }}
        fitView={!draft.viewport}
        minZoom={0.2}
        maxZoom={1.5}
        connectionRadius={30}
        deleteKeyCode={["Backspace", "Delete"]}
        onMoveStart={(event) => { if (event) viewportDirty.current = true; }}
        onMoveEnd={(_, viewport) => {
          if (!viewportDirty.current) return;
          viewportDirty.current = false;
          onChange({ ...draft, viewport });
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      {dropActive && <div aria-hidden="true" className="pointer-events-none absolute inset-2 z-20 rounded-lg border-2 border-dashed border-primary/60 bg-primary/5" />}
      {!draft.tasks.length && <div className="pointer-events-none absolute inset-x-3 top-14 text-center text-sm text-subtext">从左侧把专家拖到画布上，加入第一个专家。</div>}
      <div className="pointer-events-none absolute bottom-3 start-3 max-w-[min(26rem,calc(100%-6rem))] rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-subtext shadow-sm">从专家节点边缘圆点拖线；拖实线两端圆点可改接<br />系统环节不用手动连线，约束线自动生成 · 进展在聊天中展示</div>
      <Button variant="default" size="small" className="absolute end-3 top-3" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}><CircleHelp size={14} />工作流说明</Button>
      {helpOpen && <WorkflowHelp onClose={() => setHelpOpen(false)} />}
      {error && <div role="alert" className="absolute inset-x-3 bottom-3 rounded-md border border-accent-red bg-background px-3 py-2 text-sm text-accent-red">{error}</div>}
    </div>
    <aside className="p-4 xl:min-h-0 xl:overflow-y-auto xl:border-s xl:border-border">
      {selectedSystem ? <div className="flex flex-col gap-3 text-sm">
        <h2 className="m-0 text-base font-normal">{selectedSystem.data.title}</h2>
        <span className="text-xs text-subtext">{selectedSystem.data.taskId ? "任务检查点 · 随任务配置生成" : "系统环节 · 运行时执行"}</span>
        <p className="m-0 leading-5 text-subtext">{selectedSystem.data.description}</p>
        {selectedSystem.data.kind === "output" && <p className="m-0 leading-5 text-subtext">报告和阶段产物会在当前聊天展示；交付确认后可在项目的“研究成果”页查看与下载成果。</p>}
        {selectedSystem.data.gate && <p className="m-0 leading-5 text-subtext">在聊天里的确认卡片上批准或拒绝，可以写原因；批准只对当前这版计划或产物有效。</p>}
        {approvalTask && <><Button onClick={() => setSelected(approvalTask.id)}>查看任务 {approvalTask.id}</Button><Button onClick={() => { updateTask(approvalTask.id, { requiresApproval: false }); setSelected(approvalTask.id); }}>取消该任务的人工确认</Button></>}
        {!selectedSystem.data.taskId && <p className="m-0 text-xs leading-4 text-subtext">系统环节的连线由系统自动维护，不用手动拖线。</p>}
        {!selectedSystem.data.taskId && draft.positions[selectedSystem.id] !== undefined && <Button variant="danger" onClick={() => removeSystemNode(selectedSystem.id)}><Trash2 size={14} />从画布移除</Button>}
        <p className="m-0 rounded-md border border-border bg-surface p-3 text-xs leading-5 text-subtext">{selectedSystem.data.label}。此处是草稿设计，不表示已批准或已交付。</p>
      </div> : selectedTask ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><div><h2 className="m-0 text-base font-normal">{selectedTask.id}</h2><p className="mb-0 mt-1 text-sm text-subtext">任务 ID 在提交后保持不变</p></div><Button size="small" variant="danger" aria-label="删除任务" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">Agent<select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.role} onChange={(event) => updateTask(selectedTask.id, { role: event.target.value })}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="flex flex-col gap-1.5 text-sm">任务简报<textarea className="min-h-40 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={selectedTask.brief} maxLength={24000} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">声明产物（每行一个相对路径）<textarea className="min-h-24 resize-y rounded-md border border-border bg-background p-2.5 font-mono text-sm text-text outline-none focus:border-text" value={selectedTask.outputs.join("\n")} onChange={(event) => updateTask(selectedTask.id, { outputs: event.target.value.split("\n") })} /></label>
        <div className="flex flex-col gap-1.5 text-sm">
          <span>输入产物（勾选后，任务开始时会自动带上这些文件）</span>
          {depOutputs.length ? <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
            {depOutputs.map((output) => <label key={output} className="flex items-center gap-2 text-subtext">
              <input type="checkbox" className="accent-primary" checked={(selectedTask.inputs ?? []).includes(output)} onChange={(event) => {
                const current = selectedTask.inputs ?? [];
                updateTask(selectedTask.id, { inputs: event.target.checked ? [...current, output] : current.filter((path) => path !== output) });
              }} />
              <span className="min-w-0 truncate font-mono text-xs">{output}</span>
            </label>)}
          </div> : <span className="text-subtext">还没有直接前置任务：先连线，再从这里勾选要读取的上游产物。</span>}
        </div>
        <div className="flex flex-col gap-2.5 rounded-md border border-border p-3">
          <span className="text-sm text-text">流程控制</span>
          <label className="flex items-center justify-between gap-2 text-sm text-subtext">
            完成后需主理人确认
            <Switch checked={!!selectedTask.requiresApproval} aria-label="完成后需主理人确认" title="任务完成后先暂停，主理人批准后，下游任务才会开始" onClick={() => updateTask(selectedTask.id, { requiresApproval: !selectedTask.requiresApproval })} />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm text-subtext">
            结论把关：有问题时暂停下游
            <Switch checked={!!selectedTask.gateDownstream} aria-label="结论把关" title="任务完成时给出结论（通过/有问题）；有问题时下游任务先暂停，并通知主理人" onClick={() => updateTask(selectedTask.id, { gateDownstream: !selectedTask.gateDownstream, maxRework: selectedTask.gateDownstream ? 0 : selectedTask.maxRework })} />
          </label>
          {selectedTask.gateDownstream && <label className="flex items-center justify-between gap-2 text-sm text-subtext">
            结论有问题时自动返工
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.maxRework ?? 0} onChange={(event) => updateTask(selectedTask.id, { maxRework: Number(event.target.value) })}>
              {Array.from({ length: MAX_REWORK + 1 }, (_, rounds) => <option key={rounds} value={rounds}>{rounds === 0 ? "不自动返工" : `最多 ${rounds} 轮`}</option>)}
            </select>
          </label>}
          <p className="m-0 text-xs leading-4 text-subtext">开启后，如果任务结论有问题，系统会带着问题说明自动重跑它的前置任务和下游任务，每轮单独记录；这个轮数上限会写进你确认的计划。</p>
        </div>
        <div className="rounded-md border border-border bg-surface p-3 text-sm leading-5 text-subtext">{selectedTask.dependsOn.length > 0 && <>前置任务：{selectedTask.dependsOn.map((id) => draft.tasks.find((task) => task.id === id)).map((task) => task ? agentNames.get(task.role) ?? task.role : "").join("、")}<br /></>}产物必须位于研究目录内，且不能与其他任务重复。</div>
      </div> : <div className="p-3 text-sm text-subtext"><h2 className="m-0 mb-2 text-base font-normal text-text">节点属性</h2><p>选择专家任务编辑简报与产物；选择系统节点查看输入、确认或交付说明。</p><p>提交后会请你确认研究范围；你批准后专家才开始工作。</p></div>}
    </aside>
  </div>;
}
