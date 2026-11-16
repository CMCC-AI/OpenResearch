import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Pencil, Plus, Workflow } from "lucide-react";
import { listWorkflowAgents, listWorkflows } from "../api";
import { workspaceKey } from "../queries/client";
import { Button, Spinner } from "../components/ui";
import { stageWorkflowConversation } from "./conversation";

export function WorkflowPicker({ projectId, sessionId = null, onEdit, onOpenSession }: {
  projectId: string;
  sessionId?: string | null;
  // `null` starts an unsaved draft; a string edits that library entry.
  onEdit: (draftId: string | null) => void;
  onOpenSession: (sessionId: string, projectId: string) => void;
}) {
  const drafts = useQuery({ queryKey: workspaceKey("workflowList"), queryFn: ({ signal }) => listWorkflows(signal) });
  const agents = useQuery({ queryKey: workspaceKey("workflowAgents"), queryFn: ({ signal }) => listWorkflowAgents(signal) });
  const [selectedId, setSelectedId] = useState("");
  // The library is shared: `projectId` marks where a workflow was created, not who may run it.
  const choices = (drafts.data ?? []).map((draft) => ({ draft, source: draft.projectId === "" ? "全局工作流" : "项目工作流" }));
  const selected = choices.find(({ draft }) => draft.id === selectedId)?.draft;
  const loading = drafts.isPending || agents.isPending;
  const loadError = drafts.error ?? agents.error;

  function start(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || loading || loadError) return;
    stageWorkflowConversation(projectId, sessionId, selected);
    onOpenSession(sessionId ?? "new", projectId);
  }

  return <div className="h-full min-h-0 overflow-y-auto bg-background">
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 flex items-center gap-2 text-xl font-medium"><Workflow size={22} />使用工作流</h1>
          <p className="mb-0 mt-2 text-sm text-subtext">选择一种方法，回到聊天中描述需求；AI 会在当前对话中执行并展示结果。</p>
        </div>
        <Button onClick={() => onEdit(null)}><Plus size={14} />新建工作流</Button>
      </header>
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-subtext"><Spinner />正在读取工作流库…</p> : loadError ? <div role="alert" className="flex flex-col items-start gap-3 text-sm text-accent-red">
        <p className="m-0">工作流读取失败：{loadError.message}</p>
        <Button onClick={() => { void drafts.refetch(); void agents.refetch(); }}>重试</Button>
      </div> : choices.length === 0 ? <section className="flex flex-col items-start gap-3 rounded-lg border border-border p-5">
        <h2 className="m-0 text-base font-medium">工作流库还是空的</h2>
        <p className="m-0 text-sm text-subtext">从空白画布编排一条工作流保存入库，所有项目都能在这里选用。</p>
        <Button variant="primary" onClick={() => onEdit(null)}>编排一条新工作流</Button>
      </section> : <form className="flex flex-col gap-5" onSubmit={(event) => void start(event)}>
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-3 text-sm font-medium">选择工作流</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {choices.map(({ draft, source }) => <div key={draft.id} className={`flex min-w-0 items-start gap-2 rounded-lg border p-4 ${selectedId === draft.id ? "border-primary bg-surface" : "border-border hover:bg-surface"}`}>
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                <input type="radio" name="workflow" value={draft.id} checked={selectedId === draft.id} onChange={() => setSelectedId(draft.id)} className="mt-1 shrink-0" />
                <span className="flex min-w-0 flex-col gap-1"><strong className="break-words text-sm font-medium">{draft.name}</strong><span className="text-xs text-subtext">{source} · {draft.tasks.length} 个任务</span></span>
              </label>
              <button type="button" onClick={() => onEdit(draft.id)} aria-label={`编辑 ${draft.name}`} className="shrink-0 rounded-md border border-transparent p-1 text-subtext hover:bg-background hover:text-text"><Pencil size={14} /></button>
            </div>)}
          </div>
        </fieldset>
        {selected && <section aria-label="工作流任务预览" className="rounded-lg border border-border p-4">
          <details>
          <summary className="cursor-pointer text-sm font-medium">查看任务与依赖 · {selected.tasks.length} 项</summary>
          <ol className="mb-0 mt-4 flex flex-col gap-3 ps-5 text-sm">
            {selected.tasks.map((task) => <li key={task.id} className="ps-1">
              <span className="font-medium">{agents.data?.find((agent) => agent.id === task.role)?.name ?? task.role}</span>
              <p className="mb-0 mt-1 break-words text-subtext">{task.brief}</p>
              {task.dependsOn.length > 0 && <p className="mb-0 mt-1 break-words text-xs text-subtext">前置任务：{task.dependsOn.map((id) => { const parent = selected.tasks.find((entry) => entry.id === id); return parent ? agents.data?.find((agent) => agent.id === parent.role)?.name ?? parent.role : id; }).join("、")}</p>}
            </li>)}
          </ol>
          </details>
        </section>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={!selected || !selected.tasks.length}><ArrowRight size={15} />在对话中使用</Button>
          <span className="text-xs text-subtext">带回聊天并发送需求后，AI 会生成计划供你确认。</span>
        </div>
      </form>}
    </div>
  </div>;
}
