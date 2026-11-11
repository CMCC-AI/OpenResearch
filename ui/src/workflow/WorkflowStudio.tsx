import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Save, Send, Workflow } from "lucide-react";
import { createChatSession, getGlobalWorkflowDraft, getWorkflowDraft, listWorkflowAgents, saveGlobalWorkflowDraft, saveWorkflowDraft, submitWorkflowDraft } from "../api";
import { workspaceKey } from "../queries/client";
import { listProjectsQuery } from "../queries/projects";
import { Button, Input, showAlert, Spinner } from "../components/ui";
import { NewProjectDialog } from "../components/ProjectsHome";
import { AgentLibrary } from "./AgentLibrary";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { createLiteratureDraft, migrateDraftLayout, validateWorkflowDraft, type WorkflowDraft, type WorkflowDraftInput } from "./model";

function draftInput(draft: WorkflowDraft): WorkflowDraftInput {
  return {
    name: draft.name,
    objective: "",
    summary: "",
    workflow: "literature",
    tasks: draft.tasks,
    positions: draft.positions,
    viewport: draft.viewport,
  };
}

// 研究目标属于"一次运行"而非草稿：随作用域（全局/项目）保存在本地，
// 刷新后仍在，但保存工作流草稿不会携带它。
const objectiveStorageKey = (scope: string) => `mobilesci.workflowObjective.${scope}`;

function loadStoredObjective(scope: string): string {
  try {
    return localStorage.getItem(objectiveStorageKey(scope)) ?? "";
  } catch {
    return "";
  }
}

function storeObjective(scope: string, value: string) {
  try {
    localStorage.setItem(objectiveStorageKey(scope), value);
  } catch {
    // 本地存储不可用时目标仅在本次会话内保留。
  }
}

export function WorkflowStudio({ projectId, onOpenSession }: { projectId?: string; onOpenSession: (sessionId: string, projectId: string) => void }) {
  const scope = projectId ?? "global";
  const [tab, setTab] = useState<"workflow" | "agents">("workflow");
  const agentsQuery = useQuery({ queryKey: workspaceKey("workflowAgents"), queryFn: ({ signal }) => listWorkflowAgents(signal) });
  const draftQuery = useQuery({
    queryKey: workspaceKey("workflowDraft", scope),
    queryFn: ({ signal }) => projectId ? getWorkflowDraft(projectId, signal) : getGlobalWorkflowDraft(signal),
  });
  const projectsQuery = useQuery({ ...listProjectsQuery(), enabled: !projectId });
  const [draft, setDraft] = useState<WorkflowDraftInput>(createLiteratureDraft);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [objective, setObjective] = useState(() => loadStoredObjective(scope));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pendingSession, setPendingSession] = useState<{ id: string; objective: string; projectId: string } | null>(null);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const agents = agentsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];

  useEffect(() => {
    if (hydratedScope === scope || draftQuery.isPending) return;
    const saved = draftQuery.data;
    setDraft(saved ? migrateDraftLayout(draftInput(saved)) : createLiteratureDraft());
    setDraftId(saved?.id ?? null);
    setObjective(loadStoredObjective(scope));
    setHydratedScope(scope);
    setDirty(false);
  }, [scope, draftQuery.data, draftQuery.isPending, hydratedScope]);

  function changeObjective(value: string) {
    setObjective(value);
    storeObjective(scope, value);
    setErrors([]);
  }

  function change(next: WorkflowDraftInput) {
    setDraft(next);
    setDirty(true);
    setErrors([]);
  }

  async function persist(): Promise<WorkflowDraft> {
    const saved = projectId ? await saveWorkflowDraft(projectId, draft) : await saveGlobalWorkflowDraft(draft);
    setDraftId(saved.id);
    setDraft(draftInput(saved));
    setDirty(false);
    return saved;
  }

  async function save() {
    setBusy(true);
    try {
      await persist();
      showAlert(projectId ? "工作流草稿已保存" : "全局工作流草稿已保存", "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const runObjective = objective.trim();
    if (!runObjective) {
      showAlert("请填写研究目标", "error");
      return;
    }
    const validation = validateWorkflowDraft(draft, agents);
    if (validation.length) {
      setErrors(validation);
      return;
    }
    const target = projectId ?? targetProjectId;
    if (!target) {
      showAlert("请选择要提交到的项目，或先新建项目", "error");
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const saved = await persist();
      const reusable = pendingSession?.objective === runObjective && pendingSession.projectId === target ? pendingSession : null;
      const sessionId = reusable?.id ?? (await createChatSession(target, undefined, {
        research: { mode: "team", objective: runObjective },
      })).id;
      setPendingSession({ id: sessionId, objective: runObjective, projectId: target });
      const result = await submitWorkflowDraft(sessionId, saved.id, runObjective);
      setPendingSession(null);
      showAlert(result.deduplicated ? "该计划已登记，已打开原研究" : `研究计划 v${result.version} 已登记，请确认 G1`, "success");
      onOpenSession(result.sessionId, target);
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
          <Button variant="ghost" active={tab === "agents"} aria-pressed={tab === "agents"} onClick={() => setTab("agents")}><Bot size={15} />Agents <span className="text-xs text-subtext">{agents.length}</span></Button>
          <Button variant="ghost" active={tab === "workflow"} aria-pressed={tab === "workflow"} onClick={() => setTab("workflow")}><Workflow size={15} />工作流</Button>
        </div>
        {tab === "workflow" && <div className="flex flex-wrap items-center gap-2">
          {!projectId && <>
            <select aria-label="提交到项目" value={targetProjectId} disabled={busy || projectsQuery.isPending} onChange={(event) => setTargetProjectId(event.target.value)} className="h-8 max-w-56 rounded-md border border-border bg-background px-2 text-sm text-text">
              <option value="">{projectsQuery.isPending ? "正在读取项目…" : projectsQuery.error ? "项目读取失败，可新建项目" : projects.length ? "选择提交项目" : "暂无项目，请新建"}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <Button disabled={busy} onClick={() => setCreatingProject(true)}>新建项目</Button>
          </>}
          <span role="status" className="text-xs text-subtext">{dirty ? "有未保存修改" : draftId ? "草稿已保存" : "尚未保存"}</span>
          <Button disabled={busy} onClick={() => void save()}><Save size={14} />保存草稿</Button>
          <Button variant="primary" disabled={busy || agentsQuery.isPending || !objective.trim()} title={objective.trim() ? undefined : "请先填写研究目标"} onClick={() => void submit()}>{busy ? <Spinner /> : <Send size={14} />}提交研究</Button>
        </div>}
      </header>
      {agentsQuery.isPending || hydratedScope !== scope ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-subtext"><Spinner />正在加载工作流资源…</div> : agentsQuery.error || draftQuery.error ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-accent-red"><p>{(agentsQuery.error ?? draftQuery.error) instanceof Error ? String((agentsQuery.error ?? draftQuery.error) as Error) : "资源读取失败"}</p><Button onClick={() => { void agentsQuery.refetch(); void draftQuery.refetch(); }}>重试</Button></div> : tab === "agents" ? <AgentLibrary agents={agents} onChanged={() => agentsQuery.refetch()} /> : <div className="flex min-h-0 flex-1 flex-col">
        <section className="grid shrink-0 gap-3 border-b border-border p-4 lg:grid-cols-[minmax(180px,0.6fr)_minmax(260px,1.4fr)]" aria-label="运行配置">
          <label className="flex flex-col gap-1.5 text-sm">工作流名称<Input value={draft.name} maxLength={200} onChange={(event) => change({ ...draft, name: event.target.value })} /></label>
          <label className="flex flex-col gap-1.5 text-sm">研究目标<span className="-mt-1 text-xs text-subtext">提交运行时使用，保存草稿不携带</span><Input value={objective} maxLength={24000} placeholder="例如：系统综述近五年图神经网络在药物发现中的应用" onChange={(event) => changeObjective(event.target.value)} /></label>
        </section>
        {errors.length > 0 && <div role="alert" className="shrink-0 border-b border-accent-red bg-background px-4 py-2 text-sm text-accent-red"><strong>提交前需要处理：</strong><ul className="mb-0 mt-1 ps-5">{errors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}</ul>{errors.length > 8 && <p className="mb-0 mt-1">另有 {errors.length - 8} 项问题。</p>}</div>}
        <WorkflowCanvas draft={draft} agents={agents} onChange={change} />
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-subtext"><span>当前模板：W1 系统文献综述 —— 画布编辑通用流程，提交时登记计划摘要，专家按连线顺序执行</span><span>{projectId ? "保存不会调用模型；提交后沿用现有 G1/G4 与研究包。" : "全局草稿无需项目；提交时选择项目、填写研究目标，沿用 G1/G4。"}</span></footer>
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
