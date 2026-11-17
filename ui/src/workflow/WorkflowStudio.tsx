import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, Copy, Save, MessagesSquare, Trash2, Workflow } from "lucide-react";
import { copyWorkflow, createWorkflow, deleteWorkflow, getWorkflow, listWorkflowAgents, listWorkflows, saveWorkflow } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { listProjectsQuery } from "../queries/projects";
import { Button, Input, showAlert, Spinner } from "../components/ui";
import { NewProjectDialog } from "../components/ProjectsHome";
import { AgentLibrary } from "./AgentLibrary";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowPicker } from "./WorkflowPicker";
import { createBlankDraft, migrateDraftLayout, validateWorkflowDraft, type WorkflowDraft, type WorkflowDraftInput } from "./model";
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

export function WorkflowStudio({ projectId, sessionId = null, onOpenSession }: { projectId?: string; sessionId?: string | null; onOpenSession: (sessionId: string, projectId: string) => void }) {
  // 项目作用域：undefined=选择工作流，null=新建，字符串=编辑库里这条。
  const [editingDraftId, setEditingDraftId] = useState<string | null | undefined>(undefined);
  // 全局作用域没有选择页，编辑器内用下拉切换库里的工作流。
  const [globalDraftId, setGlobalDraftId] = useState<string | null>(null);
  if (projectId) {
    if (editingDraftId === undefined) return <WorkflowPicker key={projectId} projectId={projectId} sessionId={sessionId} onEdit={(draftId) => setEditingDraftId(draftId)} onOpenSession={onOpenSession} />;
    return <WorkflowEditor key={editingDraftId ?? "new"} projectId={projectId} sessionId={sessionId} draftId={editingDraftId} onOpenSession={onOpenSession} onBack={() => setEditingDraftId(undefined)} />;
  }
  return <WorkflowEditor key={globalDraftId ?? "new"} draftId={globalDraftId} onOpenSession={onOpenSession} onSwitchDraft={(draftId) => setGlobalDraftId(draftId)} onDeleted={() => setGlobalDraftId(null)} />;
}

function WorkflowEditor({ projectId, sessionId = null, draftId: initialDraftId, onOpenSession, onBack, onSwitchDraft, onDeleted }: {
  projectId?: string;
  sessionId?: string | null;
  draftId: string | null;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onBack?: () => void;
  onSwitchDraft?: (draftId: string | null) => void;
  onDeleted?: () => void;
}) {
  const [tab, setTab] = useState<"workflow" | "agents">("workflow");
  const [id, setId] = useState<string | null>(initialDraftId);
  const agentsQuery = useQuery({ queryKey: workspaceKey("workflowAgents"), queryFn: ({ signal }) => listWorkflowAgents(signal) });
  const draftQuery = useQuery({
    queryKey: workspaceKey("workflowDraft", id ?? "new"),
    queryFn: ({ signal }) => getWorkflow(id as string, signal),
    enabled: id !== null,
  });
  const libraryQuery = useQuery({ queryKey: workspaceKey("workflowList"), queryFn: ({ signal }) => listWorkflows(signal) });
  const projectsQuery = useQuery({ ...listProjectsQuery(), enabled: !projectId });
  const [draft, setDraft] = useState<WorkflowDraftInput>(createBlankDraft);
  const [hydrated, setHydrated] = useState(id === null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [switchNonce, setSwitchNonce] = useState(0);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const agents = agentsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];

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
  }

  async function persist(): Promise<WorkflowDraft> {
    // 空白草稿不再预填模板名称，保存前先在这里拦截，避免退回库列表时把无名草稿落库。
    if (!draft.name.trim()) throw new Error("请先填写工作流名称");
    const saved = id ? await saveWorkflow(id, draft) : await createWorkflow(draft, projectId ?? "");
    setId(saved.id);
    setDraft(draftInput(saved));
    setDirty(false);
    invalidateLibrary();
    return saved;
  }

  async function save() {
    setBusy(true);
    try {
      await persist();
      showAlert("工作流已保存入库", "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setBusy(true);
    try {
      const copied = await copyWorkflow(id as string);
      invalidateLibrary();
      showAlert(`已创建副本「${copied.name}」，可在工作流列表中打开`, "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`删除工作流「${draft.name}」？已登记的研究计划不受影响。`)) return;
    setBusy(true);
    try {
      await deleteWorkflow(id as string);
      invalidateLibrary();
      showAlert("工作流已删除", "success");
      (onDeleted ?? onBack)?.();
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function back() {
    setBusy(true);
    try {
      if (dirty) await persist();
      onBack?.();
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  function switchDraft(next: string | null) {
    if (next === id) return;
    if (dirty && !window.confirm("当前有未保存的修改，切换工作流将丢弃这些修改。")) {
      setSwitchNonce((nonce) => nonce + 1);
      return;
    }
    onSwitchDraft?.(next);
  }

  async function submit() {
    const validation = validateWorkflowDraft(draft, agents);
    if (validation.length) {
      setErrors(validation);
      return;
    }
    const target = projectId ?? targetProjectId;
    if (!target) {
      showAlert("请选择使用此方法的项目，或先新建项目", "error");
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const saved = await persist();
      const targetSession = projectId ? sessionId : null;
      stageWorkflowConversation(target, targetSession, saved);
      onOpenSession(targetSession ?? "new", target);
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1" role="group" aria-label="工作流资源">
          {onBack && <Button variant="ghost" disabled={busy} onClick={() => void back()}><ArrowLeft size={15} />{dirty ? "保存并选择工作流" : "选择工作流"}</Button>}
          <Button variant="ghost" active={tab === "agents"} aria-pressed={tab === "agents"} onClick={() => setTab("agents")}><Bot size={15} />Agents <span className="text-xs text-subtext">{agents.length}</span></Button>
          <Button variant="ghost" active={tab === "workflow"} aria-pressed={tab === "workflow"} onClick={() => setTab("workflow")}><Workflow size={15} />工作流</Button>
        </div>
        {tab === "workflow" && <div className="flex flex-wrap items-center gap-2">
          {!projectId && <select key={switchNonce} aria-label="切换工作流" value={id ?? ""} disabled={busy || libraryQuery.isPending} onChange={(event) => switchDraft(event.target.value || null)} className="h-8 max-w-56 rounded-md border border-border bg-background px-2 text-sm text-text">
            <option value="">{libraryQuery.isPending ? "正在读取工作流库…" : "＋ 新建工作流"}</option>
            {(libraryQuery.data ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>}
          {!projectId && <>
            <select aria-label="使用工作流的项目" value={targetProjectId} disabled={busy || projectsQuery.isPending} onChange={(event) => setTargetProjectId(event.target.value)} className="h-8 max-w-56 rounded-md border border-border bg-background px-2 text-sm text-text">
              <option value="">{projectsQuery.isPending ? "正在读取项目…" : projectsQuery.error ? "项目读取失败，可新建项目" : projects.length ? "选择使用项目" : "暂无项目，请新建"}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <Button disabled={busy} onClick={() => setCreatingProject(true)}>新建项目</Button>
          </>}
          {id && <>
            <Button disabled={busy} title="以已保存的版本创建一条副本" onClick={() => void copy()}><Copy size={14} />另存为副本</Button>
            <Button disabled={busy} onClick={() => void remove()}><Trash2 size={14} />删除</Button>
          </>}
          <span role="status" className="text-xs text-subtext">{dirty ? "有未保存修改" : id ? "已保存入库" : "尚未保存"}</span>
          <Button disabled={busy} onClick={() => void save()}><Save size={14} />保存草稿</Button>
          <Button variant="primary" disabled={busy || agentsQuery.isPending} onClick={() => void submit()}>{busy ? <Spinner /> : <MessagesSquare size={14} />}在对话中使用</Button>
        </div>}
      </header>
      {agentsQuery.isPending || !hydrated ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-subtext"><Spinner />正在加载工作流资源…</div> : agentsQuery.error || draftQuery.error ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-accent-red"><p>{(agentsQuery.error ?? draftQuery.error) instanceof Error ? String((agentsQuery.error ?? draftQuery.error) as Error) : "资源读取失败"}</p><Button onClick={() => { void agentsQuery.refetch(); void draftQuery.refetch(); void libraryQuery.refetch(); }}>重试</Button></div> : tab === "agents" ? <AgentLibrary agents={agents} onChanged={() => agentsQuery.refetch()} /> : <div className="flex min-h-0 flex-1 flex-col">
        <section className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border p-4" aria-label="工作流方法">
          <label className="flex flex-col gap-1.5 text-sm">工作流名称<Input value={draft.name} maxLength={200} placeholder="输入工作流名称" onChange={(event) => change({ ...draft, name: event.target.value })} /></label>
          <p className="m-0 text-sm text-subtext">自由组合专家与依赖；具体目标、材料与约束在聊天中提供。</p>
        </section>
        {errors.length > 0 && <div role="alert" className="shrink-0 border-b border-accent-red bg-background px-4 py-2 text-sm text-accent-red"><strong>使用前需要处理：</strong><ul className="mb-0 mt-1 ps-5">{errors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}</ul>{errors.length > 8 && <p className="mb-0 mt-1">另有 {errors.length - 8} 项问题。</p>}</div>}
        <WorkflowCanvas draft={draft} agents={agents} onChange={change} />
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-subtext"><span>专家与依赖自由组合，提交后按专家团模式执行。保存方法不会调用模型。</span><span>在聊天中提出需求，AI 按流程执行；进展、确认和产物在当前对话展示。</span></footer>
      </div>}
    </div>
    {creatingProject && <NewProjectDialog preferredAgent={null} onClose={() => setCreatingProject(false)} onCreated={(project, publicationError) => {
      setTargetProjectId(project.id);
      setCreatingProject(false);
      void projectsQuery.refetch();
      if (publicationError) showAlert(publicationError, "error");
    }} />}
  </>;
}
