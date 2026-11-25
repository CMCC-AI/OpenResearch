import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Connection, type Edge, type EdgeChange, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import { FlaskConical, Frame, GripVertical, Hourglass, Info, ListOrdered, Plus, ShieldCheck, Split, Trash2, UserRound } from "lucide-react";
import { Button, Tooltip } from "../components/ui";
import { SwitchIndicator } from "../components/ui/Switch";
import { addAgentTask, addExperimentTask, addForeachTask, addHumanTask, addRouteTask, addWaitTask, addWorkflowFrame, connectWorkflowTasks, reconnectWorkflowTasks, removeWorkflowFrame, removeWorkflowTask, updateWorkflowFrame, MAX_REWORK, ROUTE_ELSE, ROUTE_THEN, type FlowPoint, type WorkflowAgent, type WorkflowDraftInput, type WorkflowFrame, type WorkflowTask } from "./model";
import { approvalNodeId, buildWorkflowGraph, fixedSystemData, systemNodeIds } from "./graph";
import type { SystemNode } from "./SystemNode";
import { AGENT_MIME, EXPERIMENT_MIME, FOREACH_MIME, HUMAN_MIME, ROUTE_MIME, SYSTEM_MIME, WAIT_MIME, foreachConditionText, routeConditionText, waitConditionText } from "./canvasText";
import type { AgentNode, ExperimentNode, ForeachNode, FrameNode, HumanNode, RouteNode, WaitNode, WorkflowCanvasNode } from "./canvasNodes";
import { workflowNodeTypes } from "./canvasNodeTypes";

const FRAME_PREFIX = "frame:";
const nodeTypes = workflowNodeTypes;


// 面板里的字段说明不铺开：标签保持一句话，细节挂到问号上，hover 或键盘聚焦时展开。
function FieldLabel({ children, hint }: { children: ReactNode; hint: string }) {
  return <span className="flex items-center gap-1">{children}<Tooltip content={hint}><Info size={13} className="text-subtext" aria-hidden="true" /></Tooltip></span>;
}

export function WorkflowCanvas({ draft, agents, onChange, preview = false }: {
  draft: WorkflowDraftInput;
  agents: WorkflowAgent[];
  onChange: (draft: WorkflowDraftInput) => void;
  /** 生成中的只读预览：禁止拖拽/连线/删除，也不写回草稿。 */
  preview?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // 连线选中态由受控组件自己保存：点选实线后按 Delete，React Flow 才知道要删哪些依赖线。
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // 右键连线的小菜单：记录边 id 与画布内坐标；实线给删除项，虚线只提示不可删。
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // 拖动中的节点坐标只留在画布本地：节点照常跟手，但不写回草稿，也不触发
  // 父级编辑器（页头、节点库、属性面板）重渲染和自动保存；松手才落一次。
  const [dragPositions, setDragPositions] = useState<Record<string, FlowPoint>>({});
  const dragPositionsRef = useRef<Record<string, FlowPoint>>({});
  const updateDragPositions = (update: (current: Record<string, FlowPoint>) => Record<string, FlowPoint>) => {
    const next = update(dragPositionsRef.current);
    dragPositionsRef.current = next;
    setDragPositions(next);
  };
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // 点菜单外、按 Esc、拖动画布时收起菜单。
  useEffect(() => {
    if (!edgeMenu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-edge-menu]")) return;
      setEdgeMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEdgeMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [edgeMenu]);
  const viewportDirty = useRef(false);
  const flowRef = useRef<ReactFlowInstance<WorkflowCanvasNode> | null>(null);
  // 生成预览每长出一个节点就重新装下整张图：fitView 只在挂载时生效，靠这里补。
  useEffect(() => {
    if (!preview || draft.tasks.length === 0) return;
    void flowRef.current?.fitView({ padding: 0.1, duration: 200 });
  }, [preview, draft.tasks.length]);
  // 编辑画布只呈现研究负责人显式添加的内容：固定确认环节（G1/G4）留在节点库说明与运行视图，研究交付只在运行视图出现，都不自动铺上画布。
  const graph = useMemo(() => buildWorkflowGraph(draft.tasks, draft.positions, { fixedChain: "never" }), [draft.tasks, draft.positions]);
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const baseNodes = useMemo<WorkflowCanvasNode[]>(() => [
    // 分组框最先入列：相同层级下先入列的节点画在下层，框垫在任务节点下面。
    ...(draft.frames ?? []).map((frame): FrameNode => ({
      id: `${FRAME_PREFIX}${frame.id}`,
      type: "frame",
      position: { x: frame.x, y: frame.y },
      width: frame.width,
      height: frame.height,
      zIndex: 0,
      ariaLabel: `阶段分组 ${frame.title}`,
      deletable: true,
      data: {
        frameId: frame.id,
        title: frame.title,
        onChange: (update) => onChange(updateWorkflowFrame(draft, frame.id, update)),
        onDelete: () => {
          onChange(removeWorkflowFrame(draft, frame.id));
          setSelected(null);
        },
      },
    })),
    ...draft.tasks.map((task): AgentNode | RouteNode | ForeachNode | HumanNode | ExperimentNode | WaitNode => {
      if (task.kind === "route") {
        const children = draft.tasks.filter((candidate) => candidate.dependsOn.includes(task.id));
        const names = (branch: string) => children
          .filter((candidate) => (candidate.routeBranch ?? ROUTE_THEN) === branch)
          .map((candidate) => agentNames.get(candidate.role) ?? candidate.id)
          .join("、");
        return {
          id: task.id,
          type: "route",
          position: graph.taskPositions[draft.tasks.indexOf(task)],
          ariaLabel: `条件分流 ${task.id}`,
          data: {
            taskId: task.id,
            brief: task.brief,
            condition: routeConditionText(task),
            thenTargets: names(ROUTE_THEN),
            elseTargets: names(ROUTE_ELSE),
            onDelete: () => {
              onChange(removeWorkflowTask(draft, task.id));
              setSelected(null);
            },
          },
        };
      }
      if (task.kind === "foreach") {
        return {
          id: task.id,
          type: "foreach",
          position: graph.taskPositions[draft.tasks.indexOf(task)],
          ariaLabel: `逐项处理 ${task.id}`,
          data: {
            taskId: task.id,
            brief: task.brief,
            condition: foreachConditionText(task),
            itemOutput: task.forEach?.itemOutput ?? "",
            dependencyCount: task.dependsOn.length,
            onDelete: () => {
              onChange(removeWorkflowTask(draft, task.id));
              setSelected(null);
            },
          },
        };
      }
      if (task.kind === "experiment") {
        return {
          id: task.id,
          type: "experiment",
          position: graph.taskPositions[draft.tasks.indexOf(task)],
          ariaLabel: `实验节点 ${task.id}`,
          data: {
            taskId: task.id,
            brief: task.brief,
            outputCount: task.outputs.length,
            dependencyCount: task.dependsOn.length,
            onDelete: () => {
              onChange(removeWorkflowTask(draft, task.id));
              setSelected(null);
            },
          },
        };
      }
      if (task.kind === "wait") {
        return {
          id: task.id,
          type: "wait",
          position: graph.taskPositions[draft.tasks.indexOf(task)],
          ariaLabel: `事件等待 ${task.id}`,
          data: {
            taskId: task.id,
            brief: task.brief,
            condition: waitConditionText(task),
            dependencyCount: task.dependsOn.length,
            onDelete: () => {
              onChange(removeWorkflowTask(draft, task.id));
              setSelected(null);
            },
          },
        };
      }
      if (task.kind === "human") {
        return {
          id: task.id,
          type: "human",
          position: graph.taskPositions[draft.tasks.indexOf(task)],
          ariaLabel: `人工任务 ${task.id}`,
          data: {
            taskId: task.id,
            brief: task.brief,
            output: task.outputs[0] ?? "产物",
            dependencyCount: task.dependsOn.length,
            onDelete: () => {
              onChange(removeWorkflowTask(draft, task.id));
              setSelected(null);
            },
          },
        };
      }
      return {
        id: task.id,
        type: "agent",
        position: graph.taskPositions[draft.tasks.indexOf(task)],
        ariaLabel: `专家任务 ${task.id}`,
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
      };
    }),
    ...graph.systemNodes.map((node): SystemNode => ({ ...node, type: "system", // 检查点随任务配置生成不可删；拖入的系统环节可删除。
      deletable: !node.data.taskId, connectable: false, ariaLabel: node.data.title,
      data: node.data.taskId ? node.data : { ...node.data, onDelete: () => removeSystemNode(node.id) } })),
  ], [draft, graph, agentNames, onChange]);
  // 选中态与拖动坐标都只改受影响的节点对象：其余节点保持引用不变，
  // 点一下或拖动一下不会让整张画布（每条边、每张卡）重画一遍。
  const nodes = useMemo<WorkflowCanvasNode[]>(() => {
    if (selected === null && !Object.keys(dragPositions).length) return baseNodes;
    return baseNodes.map((node) => {
      const position = dragPositions[node.id];
      const isSelected = node.id === selected;
      if (!position && Boolean(node.selected) === isSelected) return node;
      return { ...node, ...(position ? { position } : {}), selected: isSelected };
    });
  }, [baseNodes, dragPositions, selected]);
  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => {
    const selected = selectedEdges.has(edge.id);
    const dashed = !edge.dependency || edge.branch === ROUTE_ELSE;
    const style = {
      ...(dashed ? { strokeDasharray: "5 4" } : {}),
      ...(selected ? { stroke: "var(--primary)", strokeWidth: 2.5 } : {}),
    };
    return {
      ...edge,
      selected,
      deletable: !!edge.dependency,
      // 只有任务依赖线可以拖端点改接；系统约束线保持固定。
      reconnectable: !!edge.dependency,
      type: "smoothstep",
      interactionWidth: 24,
      markerEnd: { type: MarkerType.ArrowClosed, ...(selected ? { color: "var(--primary)" } : {}) },
      label: edge.branch ? (edge.branch === ROUTE_THEN ? "成立" : "不成立") : undefined,
      labelShowBg: true,
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
      labelStyle: { fontSize: 11, fill: edge.branch === ROUTE_ELSE ? "var(--color-subtext)" : "var(--color-text)" },
      style: Object.keys(style).length ? style : undefined,
    };
  }), [graph, selectedEdges]);
  const selectedTask = draft.tasks.find((task) => task.id === selected) ?? null;
  const selectedFrame = selected?.startsWith(FRAME_PREFIX)
    ? (draft.frames ?? []).find((frame) => frame.id === selected.slice(FRAME_PREFIX.length)) ?? null
    : null;
  // 分流节点的条件来源只允许「已开启结论把关」的直接前置产物。
  const gatedDepOutputs = useMemo(() => (selectedTask?.kind === "route"
    ? selectedTask.dependsOn.flatMap((dependency) => {
      const parent = draft.tasks.find((task) => task.id === dependency);
      return parent?.gateDownstream ? parent.outputs : [];
    })
    : []), [selectedTask, draft.tasks]);
  const routeParent = useMemo(() => (selectedTask?.routeBranch
    ? draft.tasks.find((task) => task.kind === "route" && selectedTask.dependsOn.includes(task.id)) ?? null
    : null), [selectedTask, draft.tasks]);
  const routeChildren = useMemo(() => (selectedTask?.kind === "route"
    ? draft.tasks.filter((task) => task.dependsOn.includes(selectedTask.id))
    : []), [selectedTask, draft.tasks]);
  // 空白画布不渲染固定链路：从节点库选中 G1/G4 时，用静态说明展示属性面板。
  const selectedSystem = graph.systemNodes.find((node) => node.id === selected)
    ?? (selected && fixedSystemData(selected) ? { id: selected, position: { x: 0, y: 0 }, data: fixedSystemData(selected)! } : null);
  const approvalTask = draft.tasks.find((task) => task.id === selectedSystem?.data.taskId);
  const depOutputs = useMemo(() => (selectedTask
    ? [...new Set(selectedTask.dependsOn.flatMap((dependency) => draft.tasks.find((task) => task.id === dependency)?.outputs ?? []))]
    : []), [selectedTask, draft.tasks]);

  function updateTask(id: string, update: Partial<WorkflowTask>) {
    onChange({ ...draft, tasks: draft.tasks.map((task) => task.id === id ? { ...task, ...update } : task) });
  }

  function onNodesChange(changes: NodeChange<WorkflowCanvasNode>[]) {
    let next = draft;
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        if (change.dragging) {
          // 拖动中：只更新画布本地坐标，节点照常跟手，但不写草稿、不触发自动保存。
          updateDragPositions((current) => ({ ...current, [change.id]: change.position as FlowPoint }));
          continue;
        }
        // 松手：撤掉本地覆盖，并把最终坐标一次性写回草稿。
        updateDragPositions((current) => {
          if (!current[change.id]) return current;
          const remaining = { ...current };
          delete remaining[change.id];
          return remaining;
        });
        if (change.id.startsWith(FRAME_PREFIX)) {
          // 分组框的坐标存在 frames 里，不进 positions。
          const frameId = change.id.slice(FRAME_PREFIX.length);
          next = updateWorkflowFrame(next, frameId, change.position as FlowPoint);
        } else {
          const positions = { ...next.positions, [change.id]: change.position as FlowPoint };
          next = { ...next, positions };
        }
      } else if (change.type === "dimensions" && change.resizing === false && change.id.startsWith(FRAME_PREFIX)) {
        // 缩放结束（resizing=false）时落一次最终尺寸，避免拖拽期间高频写入。
        const frameId = change.id.slice(FRAME_PREFIX.length);
        const width = change.dimensions?.width;
        const height = change.dimensions?.height;
        if (width != null && height != null) next = updateWorkflowFrame(next, frameId, { width, height });
      } else if (change.type === "select") {
        setSelected(change.selected ? change.id : null);
      } else if (change.type === "remove") {
        if (change.id.startsWith(FRAME_PREFIX)) {
          next = removeWorkflowFrame(next, change.id.slice(FRAME_PREFIX.length));
          if (selected === change.id) setSelected(null);
        } else if (next.tasks.some((task) => task.id === change.id)) {
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

  // 右键连线：把浏览器默认菜单换成画布内小菜单，坐标换成画布内偏移。
  function onEdgeContextMenu(event: ReactMouseEvent, edge: Edge) {
    event.preventDefault();
    const bounds = canvasRef.current?.getBoundingClientRect();
    setEdgeMenu({
      id: edge.id,
      x: bounds ? event.clientX - bounds.left : event.clientX,
      y: bounds ? event.clientY - bounds.top : event.clientY,
    });
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    let next = draft;
    let selection: Set<string> | null = null;
    for (const change of changes) {
      if (change.type === "select") {
        // 选中态只在组件内累积，批次处理完再一次性写回，避免每次点击都触发额外渲染。
        if (!selection) selection = new Set(selectedEdges);
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
        continue;
      }
      if (change.type !== "remove") continue;
      // 右键菜单正指向被删的线时随手收起，避免残留一条已不存在的边。
      setEdgeMenu((current) => (current?.id === change.id ? null : current));
      if (selection) selection.delete(change.id);
      else setSelectedEdges((current) => {
        if (!current.has(change.id)) return current;
        const cleaned = new Set(current);
        cleaned.delete(change.id);
        return cleaned;
      });
      const dependency = graph.edges.find((edge) => edge.id === change.id)?.dependency;
      if (!dependency) continue;
      const { source, target } = dependency;
      next = {
        ...next,
        tasks: next.tasks.map((task) => {
          if (task.id !== target) return task;
          const updated = { ...task, dependsOn: task.dependsOn.filter((id) => id !== source) };
          // 删掉分流连线后，若任务不再挂在任何分流下，分支标记随之失效。
          const stillRouted = updated.dependsOn.some((id) => next.tasks.find((candidate) => candidate.id === id)?.kind === "route");
          return stillRouted ? updated : { ...updated, routeBranch: undefined };
        }),
      };
    }
    if (selection) setSelectedEdges(selection);
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
    return event.dataTransfer.types.includes(AGENT_MIME) || event.dataTransfer.types.includes(SYSTEM_MIME) || event.dataTransfer.types.includes(ROUTE_MIME) || event.dataTransfer.types.includes(FOREACH_MIME) || event.dataTransfer.types.includes(HUMAN_MIME) || event.dataTransfer.types.includes(EXPERIMENT_MIME) || event.dataTransfer.types.includes(WAIT_MIME);
  }

  function onDragOverCanvas(event: DragEvent<HTMLDivElement>) {
    if (preview || !isLibraryDrag(event)) return;
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
    if (preview || !isLibraryDrag(event)) return;
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
    if (event.dataTransfer.getData(ROUTE_MIME)) {
      // 分流节点较窄（224px），落点水平居中对准光标。
      const routeDrop = point ? { x: point.x - 112, y: point.y - 24 } : undefined;
      const added = addRouteTask(draft, routeDrop);
      onChange(added);
      setSelected(added.tasks[added.tasks.length - 1].id);
      return;
    }
    if (event.dataTransfer.getData(FOREACH_MIME) || event.dataTransfer.getData(HUMAN_MIME) || event.dataTransfer.getData(EXPERIMENT_MIME) || event.dataTransfer.getData(WAIT_MIME)) {
      const at = point ? { x: point.x - 112, y: point.y - 24 } : undefined;
      const added = event.dataTransfer.getData(FOREACH_MIME)
        ? addForeachTask(draft, at)
        : event.dataTransfer.getData(HUMAN_MIME)
          ? addHumanTask(draft, at)
          : event.dataTransfer.getData(EXPERIMENT_MIME)
            ? addExperimentTask(draft, at)
            : addWaitTask(draft, at);
      onChange(added);
      setSelected(added.tasks[added.tasks.length - 1].id);
      return;
    }
    const systemId = event.dataTransfer.getData(SYSTEM_MIME);
    if (!fixedSystemData(systemId)) return;
    // 系统环节“存在即渲染”：写入坐标键即放置，删除节点即移除。
    onChange({ ...draft, positions: { ...draft.positions, [systemId]: drop ?? { x: 0, y: 0 } } });
    setSelected(systemId);
  }

  // 阶段分组通过按钮添加：放在当前视口中心，研究负责人再拖动调整范围。
  function addFrame() {
    const bounds = flowRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const index = (draft.frames?.length ?? 0) + 1;
    const frame: WorkflowFrame = {
      id: `stage-${index}`,
      title: `阶段 ${index}`,
      x: (bounds?.x ?? 0) - 240,
      y: (bounds?.y ?? 0) - 180,
      width: 480,
      height: 360,
    };
    let unique = frame;
    while ((draft.frames ?? []).some((entry) => entry.id === unique.id)) {
      unique = { ...unique, id: `${frame.id}-${Date.now()}` };
    }
    onChange(addWorkflowFrame(draft, unique));
    setSelected(`${FRAME_PREFIX}${unique.id}`);
  }

  // 窄于 xl 时三栏纵向堆叠并整页滚动；xl 起恢复三栏各自滚动，避免两栏被画布挤成细条。
  return <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 overflow-y-auto xl:auto-rows-auto xl:grid-cols-[240px_minmax(0,1fr)_300px] xl:overflow-hidden">
    <aside className="max-h-80 min-w-0 overflow-y-auto border-b border-border p-3 xl:max-h-none xl:min-h-0 xl:border-b-0 xl:border-e">
      <h2 className="m-0 mb-1 text-base font-normal">节点库</h2>
      <p className="mt-0 text-sm leading-5 text-subtext">把专家和系统环节拖进画布组合任务；点击条目查看说明。</p>
      <section aria-label="阶段分组" className="mb-4">
        <h3 className="mb-1 text-sm font-normal text-subtext">阶段分组</h3>
        <button type="button" title="画布放不下时，用分组框把节点圈成几个阶段，只作展示，不影响执行" className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-surface" onClick={addFrame}><Frame size={15} className="shrink-0 text-subtext" />添加阶段分组<Plus size={14} className="ms-auto shrink-0 text-subtext" /></button>
      </section>
      <section aria-label="流程控制" className="mb-4">
        <h3 className="mb-1 text-sm font-normal text-subtext">流程控制</h3>
        {[{ id: systemNodeIds.scope, title: "G1 · 研究范围确认" }, { id: systemNodeIds.delivery, title: "G4 · 交付确认" }].map(({ id, title }) => <button key={id} type="button" draggable title={`拖拽「${title}」到画布放置；点击查看说明`} onDragStart={dragSystem(id)} aria-pressed={selected === id} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-surface" onClick={() => selectSystem(id)}><ShieldCheck size={15} className="shrink-0 text-subtext" />{title}</button>)}
        <button type="button" disabled={!selectedTask || !!selectedTask.requiresApproval} title="先选择专家任务，再为它设置人工确认" className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-surface disabled:opacity-50" onClick={addApproval}><ShieldCheck size={15} className="shrink-0 text-subtext" />任务后人工确认<Plus size={14} className="ms-auto shrink-0 text-subtext" /></button>
        <Tooltip content="按上游结论或失败情况走其中一条分支；连出两条线，第一条标「成立」，第二条标「不成立」" interactive className="w-full">
          <div draggable onDragStart={(event) => { event.dataTransfer.setData(ROUTE_MIME, "route"); event.dataTransfer.effectAllowed = "copy"; }} className="flex min-h-11 w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 text-start hover:border-border hover:bg-surface active:cursor-grabbing">
            <Split size={15} className="shrink-0 text-subtext" aria-hidden="true" />
            <strong className="min-w-0 flex-1 truncate text-sm font-normal text-text">条件分流</strong>
          </div>
        </Tooltip>
        <Tooltip content="按清单一项一项执行，全部完成后流程继续" interactive className="w-full">
          <div draggable onDragStart={(event) => { event.dataTransfer.setData(FOREACH_MIME, "foreach"); event.dataTransfer.effectAllowed = "copy"; }} className="flex min-h-11 w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 text-start hover:border-border hover:bg-surface active:cursor-grabbing">
            <ListOrdered size={15} className="shrink-0 text-subtext" aria-hidden="true" />
            <strong className="min-w-0 flex-1 truncate text-sm font-normal text-text">逐项处理</strong>
          </div>
        </Tooltip>
        <Tooltip content="等研究目录下某个文件出现，再继续往下走" interactive className="w-full">
          <div draggable onDragStart={(event) => { event.dataTransfer.setData(WAIT_MIME, "wait"); event.dataTransfer.effectAllowed = "copy"; }} className="flex min-h-11 w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 text-start hover:border-border hover:bg-surface active:cursor-grabbing">
            <Hourglass size={15} className="shrink-0 text-subtext" aria-hidden="true" />
            <strong className="min-w-0 flex-1 truncate text-sm font-normal text-text">事件等待</strong>
          </div>
        </Tooltip>
      </section>
      <section aria-label="实验" className="mb-4">
        <h3 className="mb-1 text-sm font-normal text-subtext">实验</h3>
        <Tooltip content="系统直接跑实验，不用专家；开跑前先请你在聊天里确认，同意后自动运行，跑完检查产物文件是否齐全" interactive className="w-full">
          <div draggable onDragStart={(event) => { event.dataTransfer.setData(EXPERIMENT_MIME, "experiment"); event.dataTransfer.effectAllowed = "copy"; }} className="flex min-h-11 w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 text-start hover:border-border hover:bg-surface active:cursor-grabbing">
            <FlaskConical size={15} className="shrink-0 text-subtext" aria-hidden="true" />
            <strong className="min-w-0 flex-1 truncate text-sm font-normal text-text">实验节点</strong>
          </div>
        </Tooltip>
      </section>
      <section aria-label="人工任务" className="mb-4">
        <h3 className="mb-1 text-sm font-normal text-subtext">人工任务</h3>
        <Tooltip content="运行到这一步会停下来等你；在研究面板亲自提交文字产出后，流程继续" interactive className="w-full">
          <div draggable onDragStart={(event) => { event.dataTransfer.setData(HUMAN_MIME, "human"); event.dataTransfer.effectAllowed = "copy"; }} className="flex min-h-11 w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 text-start hover:border-border hover:bg-surface active:cursor-grabbing">
            <UserRound size={15} className="shrink-0 text-subtext" aria-hidden="true" />
            <strong className="min-w-0 flex-1 truncate text-sm font-normal text-text">等你完成的一项</strong>
          </div>
        </Tooltip>
      </section>
      <section aria-label="专家任务">
      <h3 className="mb-1 text-sm font-normal text-subtext">专家任务</h3>
      <div className="flex flex-col gap-1">
        {agents.map((agent) => <Tooltip key={agent.id} content={agent.description || (agent.builtIn ? "内置专家" : `自定义 v${agent.version}`)} interactive className="w-full">
          <div draggable onDragStart={(event) => { event.dataTransfer.setData(AGENT_MIME, agent.id); event.dataTransfer.effectAllowed = "copy"; }} className="flex min-h-11 w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 text-start hover:border-border hover:bg-surface active:cursor-grabbing">
            <GripVertical size={15} className="shrink-0 text-subtext" aria-hidden="true" />
            <strong className="min-w-0 flex-1 truncate text-sm font-normal text-text">{agent.name}</strong>
          </div>
        </Tooltip>)}
      </div>
      </section>
    </aside>
    <div ref={canvasRef} className="workflow-canvas relative min-h-120 min-w-0 border-b border-border xl:min-h-0 xl:border-b-0" aria-label="W1 工作流编辑画布" onDragOver={onDragOverCanvas} onDragLeave={onDragLeaveCanvas} onDrop={onDropCanvas}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(flow) => { flowRef.current = flow; }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeContextMenu={onEdgeContextMenu}
        onConnect={connect}
        onReconnect={reconnect}
        reconnectRadius={16}
        defaultViewport={draft.viewport ?? { x: 0, y: 0, zoom: 1 }}
        fitView={!draft.viewport}
        // 首次打开时自适应，但不为一个长流程把节点缩到看不清：低于这个缩放就保持
        // 可读大小、从起点开始显示，后面的平移查看。手动缩放的范围仍由 minZoom 决定。
        fitViewOptions={{ minZoom: 0.55, padding: 0.1 }}
        minZoom={0.2}
        maxZoom={1.5}
        connectionRadius={30}
        nodesDraggable={!preview}
        nodesConnectable={!preview}
        elementsSelectable={!preview}
        deleteKeyCode={preview ? null : ["Backspace", "Delete"]}
        onMoveStart={(event) => { if (event) viewportDirty.current = true; setEdgeMenu(null); }}
        // 松手兜底：多选拖动或收尾事件没到齐时，把本地剩余坐标补写进草稿再清空。
        onNodeDragStop={() => {
          const remaining = dragPositionsRef.current;
          if (!Object.keys(remaining).length) return;
          let next = draft;
          for (const [id, position] of Object.entries(remaining)) {
            next = id.startsWith(FRAME_PREFIX)
              ? updateWorkflowFrame(next, id.slice(FRAME_PREFIX.length), position)
              : { ...next, positions: { ...next.positions, [id]: position } };
          }
          updateDragPositions(() => ({}));
          if (next !== draft) onChange(next);
        }}
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
      {edgeMenu && (() => {
        const dependency = graph.edges.find((edge) => edge.id === edgeMenu.id)?.dependency;
        return <div data-edge-menu role="menu" aria-label="连线操作" className="absolute z-30 min-w-40 rounded-md border border-border bg-background p-1 text-sm shadow-control-subtle" style={{ left: edgeMenu.x, top: edgeMenu.y }}>
          {dependency
            ? <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-accent-red hover:bg-surface" onClick={() => { onEdgesChange([{ id: edgeMenu.id, type: "remove" }]); setEdgeMenu(null); }}><Trash2 size={14} />删除连线</button>
            : <p className="m-0 px-2 py-1.5 text-subtext">系统约束线，不可删除</p>}
        </div>;
      })()}
      {!draft.tasks.length && <div className="pointer-events-none absolute inset-x-3 top-14 text-center text-sm text-subtext">从左侧把专家拖到画布上，加入第一个专家；也可以点上方「AI 排流程」，用一句话生成整条流程。</div>}
      {error && <div role="alert" className="absolute inset-x-3 bottom-3 rounded-md border border-accent-red bg-background px-3 py-2 text-sm text-accent-red">{error}</div>}
    </div>
    <aside className="p-4 xl:min-h-0 xl:overflow-y-auto xl:border-s xl:border-border">
      {selectedFrame ? <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-start justify-between gap-2"><h2 className="m-0 text-base font-normal">阶段分组</h2><Button size="small" variant="danger" aria-label="删除阶段分组" onClick={() => { onChange(removeWorkflowFrame(draft, selectedFrame.id)); setSelected(null); }}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">名称<input className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedFrame.title} maxLength={60} onChange={(event) => onChange(updateWorkflowFrame(draft, selectedFrame.id, { title: event.target.value }))} /></label>
        <p className="m-0 text-xs leading-5 text-subtext">分组框只是画布上的展示辅助，把节点圈成阶段；不进入执行计划，也不影响任何确认。</p>
      </div> : selectedSystem ? <div className="flex flex-col gap-3 text-sm">
        <h2 className="m-0 text-base font-normal">{selectedSystem.data.title}</h2>
        <span className="text-xs text-subtext">{selectedSystem.data.taskId ? "任务检查点 · 随任务配置生成" : "系统环节 · 运行时执行"}</span>
        <p className="m-0 leading-5 text-subtext">{selectedSystem.data.description}</p>
        {selectedSystem.data.gate && <p className="m-0 leading-5 text-subtext">在聊天里的确认卡片上批准或拒绝，可以写原因；批准只对当前这版计划或产物有效。</p>}
        {approvalTask && <><Button onClick={() => setSelected(approvalTask.id)}>查看任务 {approvalTask.id}</Button><Button onClick={() => { updateTask(approvalTask.id, { requiresApproval: false }); setSelected(approvalTask.id); }}>取消该任务的人工确认</Button></>}
        {!selectedSystem.data.taskId && <p className="m-0 text-xs leading-4 text-subtext">系统环节的连线由系统自动维护，不用手动拖线。</p>}
        {!selectedSystem.data.taskId && draft.positions[selectedSystem.id] !== undefined && <Button variant="danger" onClick={() => removeSystemNode(selectedSystem.id)}><Trash2 size={14} />从画布移除</Button>}
        <p className="m-0 text-xs leading-5 text-subtext">{selectedSystem.data.label}。此处是草稿设计，不表示已批准或已交付。</p>
      </div> : selectedTask?.kind === "route" ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><div><h2 className="m-0 text-base font-normal">{selectedTask.brief || "条件分流"}</h2><p className="mb-0 mt-1 text-sm text-subtext">运行到此处时自动判定，只放行其中一条分支</p></div><Button size="small" variant="danger" aria-label="删除分流节点" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">名称<input className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.brief} maxLength={120} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">判断依据<select title="读前置任务的结论：按「通过 / 有问题」二选一；或者只看前置是否执行失败——失败走「成立」，全部正常走「不成立」。" className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.route?.on ?? "verdict"} onChange={(event) => updateTask(selectedTask.id, { route: { on: event.target.value as "verdict" | "failure", source: "", verdictIs: "pass" } })}>
          <option value="verdict">上游任务的结论（通过 / 有问题）</option>
          <option value="failure">上游任务执行失败</option>
        </select></label>
        {selectedTask.route?.on === "verdict" && <>
          <label className="flex flex-col gap-1.5 text-sm">读取哪个结论<select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.route?.source ?? ""} onChange={(event) => updateTask(selectedTask.id, { route: { ...selectedTask.route!, source: event.target.value } })}>
            <option value="">先选择前置任务的结论产物</option>
            {gatedDepOutputs.map((output) => <option key={output} value={output}>{output}</option>)}
          </select></label>
          {!gatedDepOutputs.length && <p className="m-0 text-xs leading-4 text-subtext">还没有可选的结论：先连线一个开启了「结论把关」的任务。</p>}
          <label className="flex flex-col gap-1.5 text-sm">结论为什么时走「成立」分支<select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.route?.verdictIs ?? "pass"} onChange={(event) => updateTask(selectedTask.id, { route: { ...selectedTask.route!, verdictIs: event.target.value as "pass" | "blocked" } })}>
            <option value="pass">结论为「通过」</option>
            <option value="blocked">结论为「有问题」</option>
          </select></label>
          <label className="flex flex-col gap-1.5 text-sm">上游拿不到结论时走哪条<select title="上游失败或被跳过时拿不到结论：不选就停在这里等你，选了就按所选分支继续。" className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.route?.defaultBranch ?? ""} onChange={(event) => updateTask(selectedTask.id, { route: { ...selectedTask.route!, defaultBranch: (event.target.value || undefined) as "then" | "else" | undefined } })}>
            <option value="">停在分流节点等你处理</option>
            <option value="then">直接走「成立」分支</option>
            <option value="else">直接走「不成立」分支</option>
          </select></label>
        </>}
        <div className="flex flex-col gap-1.5 text-sm">
          <span title="每个后续任务标一条分支，两条都要有任务；运行时没走的那条显示「已跳过」，不算失败。">分支走向</span>
          {routeChildren.length ? <div className="flex flex-col gap-1.5">
            {routeChildren.map((child) => <div key={child.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{(agentNames.get(child.role) ?? child.brief) || child.id}</span>
              <span className="flex shrink-0 gap-1">
                {[["then", "成立"], ["else", "不成立"]].map(([value, name]) => <button key={value} type="button" aria-pressed={(child.routeBranch ?? "") === value} className={`rounded-md border px-2 py-0.5 text-xs ${(child.routeBranch ?? "") === value ? "border-primary bg-primary/10 text-primary" : "border-border text-subtext hover:bg-surface"}`} onClick={() => onChange({ ...draft, tasks: draft.tasks.map((task) => task.id === child.id ? { ...task, routeBranch: value as "then" | "else" } : task) })}>{name}</button>)}
              </span>
            </div>)}
          </div> : <span className="text-subtext">还没有后续任务：从分流节点向下连出两条线。</span>}
        </div>
      </div> : selectedTask?.kind === "foreach" ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><div><h2 className="m-0 text-base font-normal">{selectedTask.brief || "逐项处理"}</h2><p className="mb-0 mt-1 text-sm text-subtext" title="一项完成并验收后才开始下一项；成功项的产物会汇总给下游。">按清单一项一项执行，全部完成后继续</p></div><Button size="small" variant="danger" aria-label="删除逐项任务" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">名称<input className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.brief} maxLength={120} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm"><FieldLabel hint={`清单来自直接前置任务的产物，上游会同时生成配套的 ${selectedTask.forEach?.source ? `${selectedTask.forEach.source}.items.json` : ".items.json"}；这个要求会自动带给上游专家。`}>列表来源</FieldLabel><select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.forEach?.source ?? ""} onChange={(event) => updateTask(selectedTask.id, { forEach: { ...selectedTask.forEach!, source: event.target.value } })}>
          <option value="">先连线，再选择要逐项处理的清单</option>
          {depOutputs.map((output) => <option key={output} value={output}>{output}</option>)}
        </select></label>
        <label className="flex flex-col gap-1.5 text-sm"><FieldLabel hint="用 {item} 占位，比如 readings/{item}.md；每一项按它生成一个文件。">逐项产物模板</FieldLabel><input className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm text-text" value={selectedTask.forEach?.itemOutput ?? ""} maxLength={200} onChange={(event) => updateTask(selectedTask.id, { forEach: { ...selectedTask.forEach!, itemOutput: event.target.value } })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">逐项简报<textarea title="{item} 会替换为这一项的标题。" className="min-h-28 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={selectedTask.forEach?.itemBrief ?? ""} maxLength={24000} onChange={(event) => updateTask(selectedTask.id, { forEach: { ...selectedTask.forEach!, itemBrief: event.target.value } })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">某项失败时<select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.forEach?.onFailure ?? "pause"} onChange={(event) => updateTask(selectedTask.id, { forEach: { ...selectedTask.forEach!, onFailure: event.target.value === "skip" ? "skip" : "pause" } })}>
          <option value="pause">暂停任务，等你处理</option>
          <option value="skip">跳过这项，继续剩余项</option>
        </select></label>
      </div> : selectedTask?.kind === "experiment" ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><div><h2 className="m-0 text-base font-normal">{selectedTask.brief || "实验节点"}</h2><p className="mb-0 mt-1 text-sm text-subtext">不用专家，系统直接运行实验</p></div><Button size="small" variant="danger" aria-label="删除实验节点" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">名称<input className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.brief} maxLength={120} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">声明产物<textarea title="每行一个相对路径；跑完后逐个检查，文件缺失或为空都算这一步失败。" className="min-h-20 resize-y rounded-md border border-border bg-background p-2.5 font-mono text-sm text-text outline-none focus:border-text" value={selectedTask.outputs.join("\n")} maxLength={2000} onChange={(event) => updateTask(selectedTask.id, { outputs: event.target.value.split("\n") })} /></label>
        <p className="m-0 text-xs leading-5 text-subtext">开跑前你在聊天里确认要运行的代码、命令和算力；跑完缺文件或为空，后面的任务不会开始。</p>
      </div> : selectedTask?.kind === "wait" ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><div><h2 className="m-0 text-base font-normal">{selectedTask.brief || "事件等待"}</h2><p className="mb-0 mt-1 text-sm text-subtext">等文件出现再继续，超时转失败等你处理</p></div><Button size="small" variant="danger" aria-label="删除等待节点" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">名称<input className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.brief} maxLength={120} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm"><FieldLabel hint="填研究目录里的相对路径，比如 handoff/ready.md。">等待出现的文件</FieldLabel><input className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm text-text" value={selectedTask.waitStep?.source ?? ""} maxLength={200} onChange={(event) => updateTask(selectedTask.id, { waitStep: { source: event.target.value, timeoutMinutes: selectedTask.waitStep?.timeoutMinutes ?? 240 } })} /></label>
        <label className="flex flex-col gap-1.5 text-sm"><FieldLabel hint="单位分钟；0 表示一直等。">超时</FieldLabel><input className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" type="number" min={0} max={1440} value={selectedTask.waitStep?.timeoutMinutes ?? 0} onChange={(event) => updateTask(selectedTask.id, { waitStep: { source: selectedTask.waitStep?.source ?? "", timeoutMinutes: Number(event.target.value) || 0 } })} /></label>
        <p className="m-0 text-xs leading-5 text-subtext">文件出现就继续；超时转失败并通知你。</p>
      </div> : selectedTask?.kind === "human" ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><div><h2 className="m-0 text-base font-normal">{selectedTask.brief || "人工任务"}</h2><p className="mb-0 mt-1 text-sm text-subtext">运行到这一步会停下来等你提交</p></div><Button size="small" variant="danger" aria-label="删除人工任务" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">任务说明<textarea title="运行到这一步时，这段说明会显示在研究面板里。" className="min-h-32 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={selectedTask.brief} maxLength={24000} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">产出文件<input title="研究目录里的相对路径；你提交的文字会写进这个文件。" className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm text-text" value={selectedTask.outputs[0] ?? ""} maxLength={200} onChange={(event) => updateTask(selectedTask.id, { outputs: [event.target.value] })} /></label>
        <p className="m-0 text-xs leading-5 text-subtext">轮到你时，在研究面板提交文字；写进上面的文件后流程继续。</p>
      </div> : selectedTask ? <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2"><h2 className="m-0 text-base font-normal" title={`任务 ID：${selectedTask.id}`}>{agentNames.get(selectedTask.role) || selectedTask.role || selectedTask.id}</h2><Button size="small" variant="danger" aria-label="删除任务" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={14} /></Button></div>
        <label className="flex flex-col gap-1.5 text-sm">Agent<select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.role} onChange={(event) => updateTask(selectedTask.id, { role: event.target.value })}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="flex flex-col gap-1.5 text-sm">任务简报<textarea className="min-h-40 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={selectedTask.brief} maxLength={24000} onChange={(event) => updateTask(selectedTask.id, { brief: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">声明产物<textarea title="每行一个相对路径；文件要写在研究目录里，不能和其他任务重复。" className="min-h-24 resize-y rounded-md border border-border bg-background p-2.5 font-mono text-sm text-text outline-none focus:border-text" value={selectedTask.outputs.join("\n")} onChange={(event) => updateTask(selectedTask.id, { outputs: event.target.value.split("\n") })} /></label>
        <div className="flex flex-col gap-1.5 text-sm">
          <span title="勾选后，任务开始时自动带上这些文件。">输入产物</span>
          {depOutputs.length ? <div className="flex flex-col gap-0.5">
            {depOutputs.map((output) => <label key={output} className="flex min-h-8 items-center gap-2 rounded-md px-1 text-subtext hover:bg-surface">
              <input type="checkbox" className="accent-primary" checked={(selectedTask.inputs ?? []).includes(output)} onChange={(event) => {
                const current = selectedTask.inputs ?? [];
                updateTask(selectedTask.id, { inputs: event.target.checked ? [...current, output] : current.filter((path) => path !== output) });
              }} />
              <span title={output} className="min-w-0 truncate font-mono text-xs">{output}</span>
            </label>)}
          </div> : <span className="text-subtext">还没有直接前置任务：先连线，再从这里勾选要读取的上游产物。</span>}
        </div>
        {routeParent && <div className="flex flex-col gap-1.5 text-sm">
          <span>分支走向（挂在「{routeParent.brief || "条件分流"}」之下）</span>
          <span className="flex gap-1">
            {[["then", "成立"], ["else", "不成立"]].map(([value, name]) => <button key={value} type="button" aria-pressed={(selectedTask.routeBranch ?? "") === value} className={`rounded-md border px-2 py-0.5 text-xs ${(selectedTask.routeBranch ?? "") === value ? "border-primary bg-primary/10 text-primary" : "border-border text-subtext hover:bg-surface"}`} onClick={() => updateTask(selectedTask.id, { routeBranch: value as "then" | "else" })}>{name}</button>)}
          </span>
        </div>}
        {selectedTask.dependsOn.length >= 2 && <label className="flex items-center justify-between gap-2 text-sm text-subtext">
          汇合方式
          <select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.waitFor ?? "all"} onChange={(event) => updateTask(selectedTask.id, { waitFor: event.target.value === "any" ? "any" : undefined })}>
            <option value="all">等全部前置完成</option>
            <option value="any">任一前置完成即继续</option>
          </select>
        </label>}
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <span className="text-sm text-text">流程控制</span>
          <button type="button" role="switch" aria-checked={!!selectedTask.requiresApproval} title="任务完成后先暂停，研究负责人批准后，下游任务才会开始" className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-start text-sm text-subtext hover:bg-surface" onClick={() => updateTask(selectedTask.id, { requiresApproval: !selectedTask.requiresApproval })}>
            完成后需研究负责人确认
            <SwitchIndicator checked={!!selectedTask.requiresApproval} />
          </button>
          <button type="button" role="switch" aria-checked={!!selectedTask.gateDownstream} title="结论把关：任务完成时给出结论（通过 / 有问题）；有问题时暂停下游并通知你" className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-start text-sm text-subtext hover:bg-surface" onClick={() => updateTask(selectedTask.id, { gateDownstream: !selectedTask.gateDownstream, maxRework: selectedTask.gateDownstream ? 0 : selectedTask.maxRework })}>
            结论有问题时暂停下游
            <SwitchIndicator checked={!!selectedTask.gateDownstream} />
          </button>
          {selectedTask.gateDownstream && <label className="flex items-center justify-between gap-2 px-1 text-sm text-subtext">
            <FieldLabel hint="系统带着问题说明重跑前置和下游任务，每轮单独记录；轮数上限会写进你确认的计划。">结论有问题时自动返工</FieldLabel>
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-text" value={selectedTask.maxRework ?? 0} onChange={(event) => updateTask(selectedTask.id, { maxRework: Number(event.target.value) })}>
              {Array.from({ length: MAX_REWORK + 1 }, (_, rounds) => <option key={rounds} value={rounds}>{rounds === 0 ? "不自动返工" : `最多 ${rounds} 轮`}</option>)}
            </select>
          </label>}
        </div>
        {selectedTask.dependsOn.length > 0 && <p className="m-0 border-t border-border pt-3 text-xs leading-5 text-subtext">前置任务：{selectedTask.dependsOn.map((id) => draft.tasks.find((task) => task.id === id)).map((task) => task ? agentNames.get(task.role) ?? task.role : "").join("、")}</p>}
      </div> : null}
    </aside>
  </div>;
}
