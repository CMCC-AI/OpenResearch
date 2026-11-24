import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Workflow } from "lucide-react";
import { deleteWorkflow, listWorkflows, timeAgo } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { Button, IconButton, showAlert, Spinner } from "../components/ui";
import { CapabilityTile } from "./CapabilityTile";
import { WorkflowSearchBox } from "./WorkflowSearch";
import { searchWorkflows, type WorkflowDraft } from "./model";

export function WorkflowLibrary({ onEdit }: {
  onEdit: (draftId: string | null) => void;
}) {
  const drafts = useQuery({ queryKey: workspaceKey("workflowList"), queryFn: ({ signal }) => listWorkflows(signal) });
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // 库对全部项目共享：projectId 只记录创建来源，这里仅作展示，不限制查看与编辑。
  const all = drafts.data ?? [];
  const matched = searchWorkflows(all, search).map((draft) => ({ draft, source: draft.projectId === "" ? "全局工作流" : "项目工作流", experts: new Set(draft.tasks.map((task) => task.role)).size }));

  function invalidateLibrary() {
    void queryClient.invalidateQueries({ queryKey: workspaceKey("workflowList") });
  }

  async function removeDraft(draft: WorkflowDraft) {
    if (!window.confirm(`删除工作流「${draft.name}」？已登记的研究计划不受影响。`)) return;
    setBusyId(draft.id);
    try {
      await deleteWorkflow(draft.id);
      invalidateLibrary();
      showAlert("工作流已删除", "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyId(null);
    }
  }

  return <div className="h-full min-h-0 overflow-y-auto bg-background">
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 flex items-center gap-2 text-xl font-medium"><Workflow size={22} />我的工作流</h1>
          <p className="mb-0 mt-2 text-sm text-subtext">这里汇集可复用的研究方法：点击卡片查看或编辑，之后在聊天中让 AI 按流程执行。</p>
        </div>
        <Button variant="primary" onClick={() => onEdit(null)}><Plus size={14} />新建工作流</Button>
      </header>
      {drafts.isPending ? <p role="status" className="flex items-center gap-2 text-sm text-subtext"><Spinner />正在读取工作流库…</p> : drafts.error ? <div role="alert" className="flex flex-col items-start gap-3 text-sm text-accent-red">
        <p className="m-0">工作流读取失败：{drafts.error.message}</p>
        <Button onClick={() => void drafts.refetch()}>重试</Button>
      </div> : all.length === 0 ? <section className="flex flex-col items-start gap-3 rounded-lg border border-border p-5">
        <h2 className="m-0 text-base font-medium">工作流库还是空的</h2>
        <p className="m-0 text-sm text-subtext">从空白画布编排一条工作流保存入库，所有项目都能在聊天中按它执行。</p>
        <Button variant="primary" onClick={() => onEdit(null)}>编排一条新工作流</Button>
      </section> : <>
        <WorkflowSearchBox value={search} onChange={setSearch} matched={matched.length} total={all.length} />
        {matched.length === 0 ? <p role="status" className="m-0 text-sm text-subtext">没有匹配「{search.trim()}」的工作流，换个关键词试试。</p> : <div className="grid gap-3 sm:grid-cols-2">
          {matched.map(({ draft, source, experts }) => <div key={draft.id} className="capability-card flex items-start gap-2 rounded-xl border border-border-variant bg-background p-4">
            <button type="button" onClick={() => onEdit(draft.id)} className="m-0 grid min-w-0 flex-1 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-0 bg-transparent p-0 text-start">
              <CapabilityTile kind="workflow" name={draft.name} size="md" />
              <strong className="break-words text-sm font-medium">{draft.name}</strong>
              <span className="col-start-2 text-xs text-subtext">{source} · {draft.tasks.length} 个任务 · {experts} 位专家</span>
              <span className="col-start-2 text-xs text-muted">更新于 {timeAgo(draft.updatedAt)}</span>
            </button>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton size="small" aria-label={`删除 ${draft.name}`} title="删除" disabled={busyId === draft.id} onClick={() => void removeDraft(draft)}><Trash2 size={14} /></IconButton>
            </div>
          </div>)}
        </div>}
      </>}
    </div>
  </div>;
}
