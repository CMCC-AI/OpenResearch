import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Blocks, Bot, Plug, MessagesSquare, Trash2, Workflow } from "lucide-react";
import { createWorkflow, deleteWorkflow, getWorkflow, listMcpServers, listWorkflowAgents, listWorkflowSkills, listWorkflows, saveWorkflow } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { listProjectsQuery } from "../queries/projects";
import { Button, showAlert, Spinner } from "../components/ui";
import { AgentLibrary } from "./AgentLibrary";
import { SkillsLibrary } from "./SkillsLibrary";
import { McpLibrary } from "./McpLibrary";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { createAutosave } from "./autosave";
import { stagePendingWorkflowUse } from "./pendingUse";
import { createBlankDraft, DEFAULT_WORKFLOW_NAME, migrateDraftLayout, validateWorkflowDraft, type WorkflowDraft, type WorkflowDraftInput } from "./model";
import { stageWorkflowConversation } from "./conversation";

function draftInput(draft: WorkflowDraft): WorkflowDraftInput {
  return {
    name: draft.name,
    objective: "",
    summary: "",
    // 画布草稿一律按自定义编排提交；literature 只是旧数据的兼容取值。
    workflow: "custom",
    tasks: draft.tasks,
    positions: draft.positions,
    viewport: draft.viewport,
    // 阶段分组只占画布空间；旧草稿没有 frames 字段，按空数组处理。
    frames: draft.frames ?? [],
  };
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function WorkflowStudio({ projectId, sessionId = null, onOpenSession, onOpenChats }: { projectId?: string; sessionId?: string | null; onOpenSession: (sessionId: string, projectId: string) => void; onOpenChats?: () => void }) {
  // undefined=工作流库总览，null=新建，字符串=编辑库里这条；项目与全局共用同一个库。
  const [draftId, setDraftId] = useState<string | null | undefined>(undefined);
  if (draftId === undefined) return <WorkflowLibrary onEdit={(draftId) => setDraftId(draftId)} />;
  return <WorkflowEditor key={draftId ?? "new"} projectId={projectId} sessionId={sessionId} draftId={draftId} onOpenSession={onOpenSession} onOpenChats={onOpenChats} onBack={() => setDraftId(undefined)} />;
}

function WorkflowEditor({ projectId, sessionId = null, draftId: initialDraftId, onOpenSession, onOpenChats, onBack }: {
  projectId?: string;
  sessionId?: string | null;
  draftId: string | null;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onOpenChats?: () => void;
  onBack?: () => void;
}) {
  const [tab, setTab] = useState<"workflow" | "agents" | "skills" | "tools">("workflow");
  const [id, setId] = useState<string | null>(initialDraftId);
  const agentsQuery = useQuery({ queryKey: workspaceKey("workflowAgents"), queryFn: ({ signal }) => listWorkflowAgents(signal) });
  const toolsQuery = useQuery({ queryKey: workspaceKey("mcpServers"), queryFn: ({ signal }) => listMcpServers(signal) });
  const skillsQuery = useQuery({ queryKey: workspaceKey("workflowSkills"), queryFn: ({ signal }) => listWorkflowSkills(signal) });
  const draftQuery = useQuery({
    queryKey: workspaceKey("workflowDraft", id ?? "new"),
    queryFn: ({ signal }) => getWorkflow(id as string, signal),
    enabled: id !== null,
  });
  const libraryQuery = useQuery({ queryKey: workspaceKey("workflowList"), queryFn: ({ signal }) => listWorkflows(signal) });
  // 项目列表常开：技能生效范围的绑定勾选在项目工作区内也要可用。
  const projectsQuery = useQuery({ ...listProjectsQuery() });
  const [draft, setDraft] = useState<WorkflowDraftInput>(createBlankDraft);
  const [hydrated, setHydrated] = useState(id === null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const agents = agentsQuery.data ?? [];
  const tools = toolsQuery.data ?? [];
  const skills = skillsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];

  // 自动保存按最新渲染状态取值：定时器闭包里只留 ref，避免拿到旧草稿。
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const saverRef = useRef<ReturnType<typeof createAutosave> | null>(null);
  const persistRef = useRef<(() => Promise<WorkflowDraft>) | undefined>(undefined);

  useEffect(() => {
    if (hydrated || draftQuery.isPending) return;
    const saved = draftQuery.data;
    if (!saved) return;
    setDraft(migrateDraftLayout(draftInput(saved)));
    setDirty(false);
    setHydrated(true);
  }, [draftQuery.data, draftQuery.isPending, hydrated]);

  function invalidateLibrary() {
    void queryClient.invalidateQueries({ queryKey: workspaceKey("workflowList") });
    void queryClient.invalidateQueries({ queryKey: workspaceKey("workflowDraft") });
  }

  function change(next: WorkflowDraftInput) {
    setDraft(next);
    setDirty(true);
    setErrors([]);
    ensureSaver().schedule();
  }

  async function persist(): Promise<WorkflowDraft> {
    // 自动保存不卡命名：空名兜底为默认名；内容校验仍由「在对话中使用」提交时把关。
    const input = draft.name.trim() ? draft : { ...draft, name: DEFAULT_WORKFLOW_NAME };
    const saved = id ? await saveWorkflow(id, input) : await createWorkflow(input, projectId ?? "");
    setId(saved.id);
    setDraft(draftInput(saved));
    setDirty(false);
    invalidateLibrary();
    return saved;
  }
  persistRef.current = persist;

  // 卸载会清空 saverRef（StrictMode 也会走一遍），所以按需重建而不是只在渲染期初始化。
  function ensureSaver() {
    if (!saverRef.current) {
      saverRef.current = createAutosave(async () => {
        if (!dirtyRef.current) return;
        setSaveState("saving");
        try {
          await persistRef.current?.();
          setSaveState("saved");
        } catch {
          setSaveState("error");
        }
      });
    }
    return saverRef.current;
  }

  // 卸载或关闭页面前，把还没落盘的改动补发一次；fetch 不随组件卸载中断。
  useEffect(() => {
    const current = ensureSaver();
    const onHide = () => { void current.dispose().catch(() => {}); };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void current.dispose().catch(() => {});
      saverRef.current = null;
    };
  }, []);

  async function remove() {
    if (!window.confirm(`删除工作流「${draft.name}」？已登记的研究计划不受影响。`)) return;
    // 先停掉防抖定时器：否则删除落库后自动保存会把这条草稿重新写回来。
    saverRef.current?.cancel();
    setBusy(true);
    try {
      await deleteWorkflow(id as string);
      invalidateLibrary();
      showAlert("工作流已删除", "success");
      onBack?.();
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function back() {
    setBusy(true);
    try {
      await saverRef.current?.flush();
      if (saveStateRef.current === "error") {
        showAlert("自动保存失败，请检查网络后重试", "error");
        return;
      }
      onBack?.();
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const validation = validateWorkflowDraft(draft, agents);
    if (validation.length) {
      setErrors(validation);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      saverRef.current?.cancel();
      const saved = await persist();
      if (projectId && sessionId) {
        // 已有会话沿用文本预填；换绑由服务端的绑定锁定规则约束。
        stageWorkflowConversation(projectId, sessionId, saved);
        onOpenSession(sessionId, projectId);
      } else if (projectId) {
        // 新会话在对话页以工作流模式开始：记待用标记，首条消息发送时绑定并锁定。
        stagePendingWorkflowUse(saved);
        onOpenSession("new", projectId);
      } else {
        // 全局工作流：还不知道用哪个项目，先记待用标记，回主对话页选择。
        stagePendingWorkflowUse(saved);
        onOpenChats?.();
      }
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-1" role="group" aria-label="工作流资源">
          {onBack && <Button variant="ghost" disabled={busy} onClick={() => void back()}><ArrowLeft size={15} />返回工作流库</Button>}
          <Button variant="ghost" active={tab === "agents"} aria-pressed={tab === "agents"} onClick={() => setTab("agents")}><Bot size={15} />Agents <span className="text-xs text-subtext">{agents.length}</span></Button>
          <Button variant="ghost" active={tab === "skills"} aria-pressed={tab === "skills"} onClick={() => setTab("skills")}><Blocks size={15} />Skills <span className="text-xs text-subtext">{skills.length}</span></Button>
          <Button variant="ghost" active={tab === "tools"} aria-pressed={tab === "tools"} onClick={() => setTab("tools")}><Plug size={15} />MCP <span className="text-xs text-subtext">{tools.length}</span></Button>
          <Button variant="ghost" active={tab === "workflow"} aria-pressed={tab === "workflow"} onClick={() => setTab("workflow")}><Workflow size={15} />工作流</Button>
        </div>
        {tab === "workflow" && <>
          <input aria-label="工作流名称" value={draft.name} maxLength={200} placeholder={DEFAULT_WORKFLOW_NAME} onChange={(event) => change({ ...draft, name: event.target.value })} className="h-8 min-w-0 w-44 rounded-md border border-transparent bg-transparent px-2 text-sm font-medium text-text transition-colors hover:border-border focus:border-border focus:bg-background focus:outline-none" />
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {id && <Button disabled={busy} onClick={() => void remove()}><Trash2 size={14} />删除</Button>}
            <span role="status" className="text-xs text-subtext">{saveState === "saving" ? "保存中…" : saveState === "error" ? "保存失败" : saveState === "saved" ? "已自动保存" : ""}</span>
            {saveState === "error" && <Button variant="ghost" onClick={() => void saverRef.current?.flush()}>重试</Button>}
            <Button variant="primary" disabled={busy || agentsQuery.isPending} onClick={() => void submit()}>{busy ? <Spinner /> : <MessagesSquare size={14} />}在对话中使用</Button>
          </div>
        </>}
      </header>
      {agentsQuery.isPending || toolsQuery.isPending || skillsQuery.isPending || !hydrated ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-subtext"><Spinner />正在加载工作流资源…</div> : agentsQuery.error || toolsQuery.error || skillsQuery.error || draftQuery.error ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-accent-red"><p>{(agentsQuery.error ?? toolsQuery.error ?? skillsQuery.error ?? draftQuery.error) instanceof Error ? String((agentsQuery.error ?? toolsQuery.error ?? skillsQuery.error ?? draftQuery.error) as Error) : "资源读取失败"}</p><Button onClick={() => { void agentsQuery.refetch(); void toolsQuery.refetch(); void skillsQuery.refetch(); void draftQuery.refetch(); void libraryQuery.refetch(); }}>重试</Button></div> : tab === "agents" ? <AgentLibrary agents={agents} mcpServers={tools} userSkills={skills.filter((skill) => skill.source === "user")} onChanged={() => agentsQuery.refetch()} /> : tab === "skills" ? <SkillsLibrary skills={skills} agents={agents} projects={projects} projectId={projectId} sessionId={sessionId} onOpenSession={onOpenSession} onOpenChats={onOpenChats} onChanged={() => skillsQuery.refetch()} /> : tab === "tools" ? <McpLibrary /> : <div className="flex min-h-0 flex-1 flex-col">
        {errors.length > 0 && <div role="alert" className="shrink-0 border-b border-accent-red bg-background px-4 py-2 text-sm text-accent-red"><strong>使用前需要处理：</strong><ul className="mb-0 mt-1 ps-5">{errors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}</ul>{errors.length > 8 && <p className="mb-0 mt-1">另有 {errors.length - 8} 项问题。</p>}</div>}
        <WorkflowCanvas draft={draft} agents={agents} onChange={change} />
      </div>}
    </div>
  </>;
}
