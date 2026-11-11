import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { Bot, CircleHelp, FileText, Plus, RefreshCw, ShieldCheck, Split, Trash2, X } from "lucide-react";
import { Button } from "../components/ui";
import { Switch } from "../components/ui/Switch";
import { addAgentTask, connectWorkflowTasks, removeWorkflowTask, MAX_REWORK, type FlowPoint, type WorkflowAgent, type WorkflowDraftInput, type WorkflowTask } from "./model";

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
      {data.gateDownstream && <span className="flex items-center gap-1 rounded bg-primary-subtle px-1.5 py-0.5 text-xs text-primary" title={data.maxRework > 0 ? `结论阻塞时拦截下游，自动返工上限 ${data.maxRework} 轮` : "结论阻塞时拦截下游派发"}><Split size={11} aria-hidden="true" />结论门控{data.maxRework > 0 && <span className="flex items-center gap-0.5"><RefreshCw size={10} aria-hidden="true" />≤{data.maxRework}轮</span>}</span>}
    </div>}
    <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-subtext">
      <span className="flex items-center gap-1"><FileText size={12} aria-hidden="true" />{data.outputCount} 个产物</span>
      <span>{data.dependencyCount ? `前置 ${data.dependencyCount} 项` : "无前置"}</span>
    </div>
    <Handle type="source" position={Position.Bottom} />
  </div>;
}

const nodeTypes = { agent: AgentNodeCard };

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
      <div><dt className="font-normal text-text">节点 = 一个专家任务</dt><dd className="m-0">每个节点回答「谁、做什么、产出什么」。从左侧专家库点击加入，选中后可在右侧修改任务简报和声明产物。</dd></div>
      <div><dt className="font-normal text-text">连线 = 执行顺序</dt><dd className="m-0">从上游节点底部圆点拖到下游节点顶部圆点，表示“先完成上游，再执行下游”。选中连线后按 Delete 可删除。</dd></div>
      <div><dt className="font-normal text-text">产物 = 可追溯的输出</dt><dd className="m-0">每个节点声明输出文件路径；提交后专家把结果写入研究目录，供下游专家与审查引用。</dd></div>
      <div><dt className="font-normal text-text">提交研究 = 登记为计划</dt><dd className="m-0">提交后草稿登记为研究计划并进入 G1 人工确认；批准前不会派发任何专家。</dd></div>
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
  const viewportDirty = useRef(false);
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const nodes = useMemo<AgentNode[]>(() => draft.tasks.map((task) => ({
    id: task.id,
    type: "agent",
    position: draft.positions[task.id] ?? { x: 0, y: 0 },
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
  })), [draft, selected, agentNames, onChange]);
  const edges = useMemo<Edge[]>(() => draft.tasks.flatMap((task) => task.dependsOn.map((source) => ({
    id: `${source}->${task.id}`,
    source,
    target: task.id,
    type: "smoothstep",
    interactionWidth: 24,
    markerEnd: { type: MarkerType.ArrowClosed },
  }))), [draft.tasks]);
  const selectedTask = draft.tasks.find((task) => task.id === selected) ?? null;
  const depOutputs = useMemo(() => (selectedTask
    ? [...new Set(selectedTask.dependsOn.flatMap((dependency) => draft.tasks.find((task) => task.id === dependency)?.outputs ?? []))]
    : []), [selectedTask, draft.tasks]);

  function updateTask(id: string, update: Partial<WorkflowTask>) {
    onChange({ ...draft, tasks: draft.tasks.map((task) => task.id === id ? { ...task, ...update } : task) });
  }

  function onNodesChange(changes: NodeChange<AgentNode>[]) {
    let next = draft;
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const positions = { ...next.positions, [change.id]: change.position as FlowPoint };
        next = { ...next, positions };
      } else if (change.type === "select") {
        setSelected(change.selected ? change.id : null);
      } else if (change.type === "remove") {
        next = removeWorkflowTask(next, change.id);
        if (selected === change.id) setSelected(null);
      }
    }
    if (next !== draft) onChange(next);
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    let next = draft;
    for (const change of changes) {
      if (change.type !== "remove") continue;
      const [source, target] = change.id.split("->");
      next = {
        ...next,
        tasks: next.tasks.map((task) => task.id === target ? { ...task, dependsOn: task.dependsOn.filter((id) => id !== source) } : task),
      };
    }
    if (next !== draft) onChange(next);
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

  function deleteTask(id: string) {
    onChange(removeWorkflowTask(draft, id));
    if (selected === id) setSelected(null);
  }

  return <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)_300px]">
    <aside className="min-h-0 overflow-y-auto border-b border-border p-3 xl:border-b-0 xl:border-e">
      <h2 className="m-0 mb-1 text-base font-normal text-subtext">专家节点库</h2>
      <p className="mt-0 text-sm leading-5 text-subtext">点击专家加入画布；内置专家与自定义 Agent 可混合编排。</p>
      <div className="flex flex-col gap-1">
        {agents.map((agent) => <button key={agent.id} type="button" className="flex items-start gap-2 rounded-md border border-transparent px-2 py-2 text-start hover:border-border hover:bg-surface" onClick={() => onChange(addAgentTask(draft, agent))}>
          <Bot size={15} className="mt-0.5 shrink-0 text-subtext" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-1"><strong className="block truncate text-sm font-normal text-text">{agent.name}</strong><Plus size={14} className="shrink-0 text-subtext" aria-hidden="true" /></span>
            <span className="block truncate text-xs text-subtext">{agent.description || (agent.builtIn ? "内置专家" : `自定义 v${agent.version}`)}</span>
          </span>
        </button>)}
      </div>
    </aside>
    <div className="workflow-canvas relative min-h-120 min-w-0 border-b border-border xl:border-b-0" aria-label="W1 工作流编辑画布">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        defaultViewport={draft.viewport ?? { x: 0, y: 0, zoom: 1 }}
        fitView={!draft.viewport}
        minZoom={0.2}
        maxZoom={1.5}
        connectionRadius={30}
        deleteKeyCode={["Backspace", "Delete"]}
        onMoveStart={() => { viewportDirty.current = true; }}
        onMoveEnd={(_, viewport) => {
          if (!viewportDirty.current) return;
          viewportDirty.current = false;
          onChange({ ...draft, viewport });
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!nodes.length && <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-subtext">画布还没有节点：从左侧「专家节点库」点击加入第一个专家。</div>}
      <div className="pointer-events-none absolute start-3 top-3 max-w-[calc(100%-6rem)] rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-subtext shadow-sm">拖动节点调整布局 · 从节点底部圆点拖到目标节点顶部完成连线 · Delete 删除选中项</div>
      <Button variant="ghost" className="absolute end-3 top-3" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}><CircleHelp size={14} />工作流说明</Button>
      {helpOpen && <WorkflowHelp onClose={() => setHelpOpen(false)} />}
      {error && <div role="alert" className="absolute inset-x-3 bottom-3 rounded-md border border-accent-red bg-background px-3 py-2 text-sm text-accent-red">{error}</div>}
    </div>
    <aside className="min-h-0 overflow-y-auto p-4 xl:border-s xl:border-border">
      {selectedTask ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><div><h2 className="m-0 text-base font-normal">{selectedTask.id}</h2><p className="mb-0 mt-1 text-sm text-subtext">任务 ID 在提交后保持不变</p></div><Button size="small" variant="danger" aria-label="删除任务" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">Agent<select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.role} onChange={(event) => updateTask(selectedTask.id, { role: event.target.value })}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="flex flex-col gap-1.5 text-sm">任务简报<textarea className="min-h-40 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={selectedTask.brief} maxLength={24000} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">声明产物（每行一个相对路径）<textarea className="min-h-24 resize-y rounded-md border border-border bg-background p-2.5 font-mono text-sm text-text outline-none focus:border-text" value={selectedTask.outputs.join("\n")} onChange={(event) => updateTask(selectedTask.id, { outputs: event.target.value.split("\n") })} /></label>
        <div className="flex flex-col gap-1.5 text-sm">
          <span>输入产物（勾选后派发时自动注入开工指令）</span>
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
            <Switch checked={!!selectedTask.requiresApproval} aria-label="完成后需主理人确认" title="该任务完成后暂停，主理人在人工确认页批准后才派发下游任务" onClick={() => updateTask(selectedTask.id, { requiresApproval: !selectedTask.requiresApproval })} />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm text-subtext">
            结论门控：阻塞时拦截下游
            <Switch checked={!!selectedTask.gateDownstream} aria-label="结论门控" title="完成时读取结论文件（通过/阻塞），阻塞时暂停下游派发并通知主理人" onClick={() => updateTask(selectedTask.id, { gateDownstream: !selectedTask.gateDownstream, maxRework: selectedTask.gateDownstream ? 0 : selectedTask.maxRework })} />
          </label>
          {selectedTask.gateDownstream && <label className="flex items-center justify-between gap-2 text-sm text-subtext">
            阻塞时自动返工上限
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.maxRework ?? 0} onChange={(event) => updateTask(selectedTask.id, { maxRework: Number(event.target.value) })}>
              {Array.from({ length: MAX_REWORK + 1 }, (_, rounds) => <option key={rounds} value={rounds}>{rounds === 0 ? "不自动返工" : `最多 ${rounds} 轮`}</option>)}
            </select>
          </label>}
          <p className="m-0 text-xs leading-4 text-subtext">开启返工后，结论为阻塞时系统自动带上阻塞原因重跑直接前置任务及下游，每轮独立留档；上限会计入 G1 确认范围。</p>
        </div>
        <div className="rounded-md border border-border bg-surface p-3 text-sm leading-5 text-subtext">前置任务：{selectedTask.dependsOn.length ? selectedTask.dependsOn.join("、") : "无"}<br />产物必须位于研究目录内，且不能与其他任务重复。</div>
      </div> : <div className="p-3 text-sm text-subtext"><h2 className="m-0 mb-2 text-base font-normal text-text">任务属性</h2><p>选择画布中的节点，编辑 Agent、任务简报和声明产物。</p><p>提交后进入现有 G1 确认；批准前不会派发专家。</p></div>}
    </aside>
  </div>;
}
