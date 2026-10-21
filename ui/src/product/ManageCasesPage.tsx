import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { listProjects } from "../api";
import { Button } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { useCasesBase } from "./FeaturedCases";
import { addProjectToCases } from "./addProjectToCases";
import { caseRequest, caseWrite, type FeaturedCase } from "./featuredCasesApi";

export function ManageCasesPage({ initialProject = "" }: { initialProject?: string }) {
  const base = useCasesBase();
  const { user, canAccessResearch } = useAuthSession();
  const client = useQueryClient();
  const [projectId, setProjectId] = useState(initialProject);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ item: FeaturedCase; kind: "publish" | "delete" } | null>(null);
  const admin = Boolean(user?.isAdmin);
  const projects = useQuery({ queryKey: ["case-source-projects", base, user?.id], queryFn: () => listProjects(), enabled: admin && canAccessResearch });
  const cases = useQuery({ queryKey: ["case-admin-list", base, user?.id], queryFn: () => caseRequest<{ cases: FeaturedCase[] }>(base, "admin/cases"), enabled: admin && Boolean(base) });
  async function action(task: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setProgress("正在处理…");
    try { await task(); setProgress(success); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setProgress(""); }
    finally {
      await Promise.all([client.invalidateQueries({ queryKey: ["case-admin-list", base] }), client.invalidateQueries({ queryKey: ["featured-cases", base] }), client.invalidateQueries({ queryKey: ["featured-case", base] })]);
      setBusy(false);
    }
  }
  function add(project: { id: string; name: string }, existingId?: string) {
    return action(() => addProjectToCases(base, project, setProgress, existingId), "已加入案例集，用户可以查看完整项目。");
  }
  const selectedProject = projects.data?.find((row) => row.id === projectId);
  const existing = cases.data?.cases.find((item) => item.source_project_id === projectId && item.status === "published")
    ?? cases.data?.cases.find((item) => item.source_project_id === projectId);
  const visibleCases = [...(cases.data?.cases.reduce((items, item) => {
    const key = item.source_project_id || item.id;
    const previous = items.get(key);
    if (!previous || item.status === "published" || (previous.status !== "published" && item.created_at > previous.created_at)) items.set(key, item);
    return items;
  }, new Map<string, FeaturedCase>()) ?? new Map()).values()];
  if (!admin) return <main className="p-6"><p role="alert">仅系统管理员可以管理精选案例。</p><Link to="/cases">返回案例集</Link></main>;
  return <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8"><div className="mx-auto flex max-w-290 flex-col gap-8">
    <header><h1 className="mb-2 text-3xl font-semibold">精选案例管理</h1><p className="text-sm text-subtext">选择自己的项目加入案例集。用户看到的就是原项目页面，可以查看完整会话、文件和科研专家团流程，不能继续输入或编辑。</p></header>
    {error && <p role="alert" className="rounded-lg border border-border bg-background p-4 text-accent-red">{error}</p>}
    {progress && <p role="status" className="text-sm text-primary">{progress}</p>}
    {canAccessResearch ? <form className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5" onSubmit={(event) => {
      event.preventDefault();
      const project = projects.data?.find((row) => row.id === projectId);
      if (project) void add(project, existing?.id);
    }}>
      <label className="flex flex-col gap-2 text-sm">选择项目<select required value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)} className="rounded-lg border border-border bg-background p-2"><option value="">请选择自己的项目</option>{projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {projects.error && <p role="alert" className="text-sm text-accent-red">{projects.error.message}</p>}
      <p className="m-0 text-xs text-subtext">加入后，所有登录用户都能查看该项目的完整内容。</p>
      {projects.isSuccess && !projects.data.length && <p role="status" className="m-0 text-sm text-subtext">当前工作空间没有可导入的项目。历史案例副本可在下方管理。</p>}
      <Button type="submit" disabled={busy || !selectedProject || !cases.data || existing?.status === "published"}>{busy ? "正在加入…" : existing?.status === "published" ? "已在案例集中" : "加入案例集"}</Button>
    </form> : <p className="text-sm text-subtext">请从自己的研究工作空间进入，选择项目加入案例集。</p>}
    {confirmation && <section role="alertdialog" aria-modal="false" aria-labelledby="case-confirm-title" className="rounded-xl border border-border bg-background p-5">
      <h2 id="case-confirm-title" className="text-lg font-semibold">{confirmation.kind === "delete" ? "删除案例草稿" : "发布已保存的案例副本"}</h2>
      <p className="text-sm text-subtext">{confirmation.kind === "delete" ? `将永久删除“${confirmation.item.title}”的草稿及案例文件副本，不影响原项目。此操作无法撤销。` : `请先查看“${confirmation.item.title}”的案例副本，确认完整对话和文件适合公开。发布后所有登录用户均可查看；不会重新读取原项目，缺失文件的副本会被拒绝发布。`}</p>
      <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => {
        const { item, kind } = confirmation;
        void action(async () => {
          if (kind === "delete") await caseRequest(base, `admin/cases/${item.id}`, { method: "DELETE" });
          else await caseWrite(base, `admin/cases/${item.id}/publish`, { revision: item.revision, reviewed: true });
          setConfirmation(null);
        }, kind === "delete" ? "案例草稿及文件副本已删除，原项目不受影响。" : "已保存的案例副本已加入案例集。");
      }}>{confirmation.kind === "delete" ? "确认删除草稿" : "已审核，确认发布"}</Button><Button disabled={busy} onClick={() => setConfirmation(null)}>取消</Button></div>
    </section>}
    <section><h2 className="text-xl font-semibold">案例集</h2>
      {cases.isPending && <p className="text-sm text-muted">正在读取案例…</p>}
      {cases.error && <p role="alert" className="text-sm text-accent-red">{cases.error.message}</p>}
      <div className="flex flex-col gap-3">{visibleCases.map((item) => {
        const sourceProject = projects.data?.find((row) => row.id === item.source_project_id);
        return <article key={item.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-background p-5">
        <div className="min-w-0"><h3 className="m-0 text-base font-medium">{item.title}</h3><p className="mb-0 mt-1 text-xs text-subtext">{item.status === "published" ? "已加入案例集" : "未发布的案例副本"}</p>
          {projects.isSuccess && !sourceProject && <p className="mb-0 mt-1 text-xs text-subtext">当前工作空间未找到原项目，可能已删除或位于其他工作空间。已保存的案例副本仍可查看和管理。</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/cases/$caseId" params={{ caseId: item.id }} search={item.status === "draft" ? { preview: true } : {}} className="text-sm text-primary">查看案例副本</Link>
          {item.status === "draft" && <>
            {sourceProject && canAccessResearch && <Button disabled={busy} onClick={() => void add(sourceProject, item.id)}>从原项目更新并加入</Button>}
            <Button disabled={busy} onClick={() => setConfirmation({ item, kind: "publish" })}>发布已保存副本</Button>
            <Button disabled={busy} onClick={() => setConfirmation({ item, kind: "delete" })}>删除草稿</Button>
          </>}
          {item.status === "published" && <Button disabled={busy} onClick={() => void action(() => caseWrite(base, `admin/cases/${item.id}/unpublish`, { revision: item.revision }), "已从案例集移除，原项目仍保留。")}>移出案例集</Button>}
        </div>
      </article>;
      })}</div>
      {cases.data && !cases.data.cases.length && <p className="text-sm text-subtext">案例集还没有项目，从上方选择一个加入。</p>}
    </section>
  </div></main>;
}
