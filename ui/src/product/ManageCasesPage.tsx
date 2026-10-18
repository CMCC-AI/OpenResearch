import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { listProjects, getArtifacts, getCodeTree, listChatSessions, artifactUrl, projectFileUrl, type ArtifactEntry } from "../api";
import { Button } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { CaseTranscript, useCasesBase } from "./FeaturedCases";
import { caseRequest, caseWrite, captureProject, sourceFile, type FeaturedCase, type FeaturedCaseDetail } from "./featuredCasesApi";

interface SourceFile { key: string; path: string; url: string; name: string }
function artifactFiles(entries: ArtifactEntry[], projectId: string): SourceFile[] {
  return entries.flatMap((entry) => entry.isDir ? artifactFiles(entry.children ?? [], projectId) : [{ key: `artifacts:${entry.path}`, path: entry.path, name: entry.name, url: artifactUrl(projectId, entry.path) }]);
}

export function ManageCasesPage({ initialProject = "" }: { initialProject?: string }) {
  const base = useCasesBase(); const { user, canAccessResearch } = useAuthSession();
  const client = useQueryClient();
  const [projectId, setProjectId] = useState(initialProject);
  const [source, setSource] = useState("artifacts");
  const [filter, setFilter] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Record<string, SourceFile>>({});
  const [title, setTitle] = useState(""); const [summary, setSummary] = useState(""); const [category, setCategory] = useState("科研实践");
  const [selectedCase, setSelectedCase] = useState("");
  const [reviewed, setReviewed] = useState(false); const [order, setOrder] = useState(0);
  const [progress, setProgress] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const admin = Boolean(user?.isAdmin);
  const projects = useQuery({ queryKey: ["case-source-projects",base,user?.id], queryFn: () => listProjects(), enabled: admin && canAccessResearch });
  const sessions = useQuery({ queryKey: ["case-source-sessions",base,user?.id,projectId], queryFn: () => listChatSessions(projectId), enabled: admin && canAccessResearch && Boolean(projectId) });
  const files = useQuery({ queryKey: ["case-source-files",base,user?.id,projectId,source], enabled: admin && canAccessResearch && Boolean(projectId), queryFn: async () => {
    if (source === "artifacts") { const data = await getArtifacts(projectId); return { files: artifactFiles(data.entries,projectId), truncated: data.truncated }; }
    const opts = source === "repository" ? {} : { sessionId: source };
    const data = await getCodeTree(projectId,opts);
    return { files: data.entries.map((path) => ({ key:`${source}:${path}`,path,name:path.split("/").at(-1) || path,url:projectFileUrl(projectId,path,opts) })), truncated: data.truncated };
  }});
  const cases = useQuery({ queryKey: ["case-admin-list",base,user?.id], queryFn: () => caseRequest<{ cases: FeaturedCase[] }>(base,"admin/cases"), enabled: admin && Boolean(base) });
  const detail = useQuery({ queryKey: ["case-admin-detail",base,user?.id,selectedCase], queryFn: () => caseRequest<FeaturedCaseDetail>(base,`admin/cases/${selectedCase}`), enabled: admin && Boolean(base && selectedCase), retry:false });
  useEffect(() => { setSelectedFiles({}); setFilter(""); setSource("artifacts"); },[projectId]);
  useEffect(() => { if (projects.data && projectId && !title) setTitle(projects.data.find((project) => project.id === projectId)?.name ?? ""); },[projects.data,projectId,title]);
  useEffect(() => { setReviewed(false); setOrder(detail.data?.sort_order ?? 0); },[detail.data?.revision,selectedCase,detail.data?.sort_order]);
  async function refresh() {
    await Promise.all([client.invalidateQueries({ queryKey:["case-admin-list",base,user?.id] }),client.invalidateQueries({ queryKey:["case-admin-detail",base,user?.id] }),client.invalidateQueries({ queryKey:["featured-cases",base] }),client.invalidateQueries({ queryKey:["featured-case",base] })]);
  }
  async function action(task: () => Promise<unknown>, message: string) {
    setBusy(true); setError(""); setProgress(message);
    try { await task(); await refresh(); setProgress("操作完成。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setProgress(""); await refresh(); }
    finally { setBusy(false); }
  }
  async function createDraft() {
    if (!projects.data?.some((project) => project.id === projectId)) { setError("请选择你有权访问的项目。"); return; }
    if (!title.trim() || !summary.trim() || !category.trim()) { setError("请填写案例标题、简介和分类。"); return; }
    const selected = Object.values(selectedFiles);
    if (selected.length > 200) { setError("最多选择 200 个成果文件。"); return; }
    if (new Set(selected.map((file) => file.name.trim())).size !== selected.length) { setError("公开文件名重复，请在下方修改为不同名称。"); return; }
    await action(async () => {
      setProgress("正在复制项目的全部研究对话…");
      const snapshot = await captureProject(projectId);
      const request = { sourceProjectId:projectId,title:title.trim(),summary:summary.trim(),category:category.trim(),snapshot,expectedFileCount:selected.length };
      if (new Blob([JSON.stringify(request)]).size > 16 * 1024 * 1024) throw new Error("完整对话超过 16 MB，不能截断发布。请先整理为独立的展示项目。");
      const content: { file:SourceFile; blob:Blob }[] = []; let total = 0;
      for (const file of selected) {
        if (!file.name.trim() || /[\\/\x00-\x1f\x7f]/.test(file.name) || [".",".."].includes(file.name.trim())) throw new Error("公开文件名不能包含目录或控制字符。");
        setProgress(`正在复制成果：${file.name}`);
        const blob = await sourceFile(file.url); total += blob.size;
        if (total > 200 * 1024 * 1024) throw new Error("成果总量超过 200 MB。");
        content.push({ file,blob });
      }
      setProgress("正在核对源研究记录是否保持一致…");
      if (JSON.stringify(await captureProject(projectId)) !== JSON.stringify(snapshot)) throw new Error("复制成果期间研究记录发生变化，请重新生成快照。");
      const saved = await caseWrite<{id:string}>(base,"admin/cases",request); setSelectedCase(saved.id);
      for (const {file,blob} of content) {
        setProgress(`正在保存公开副本：${file.name}`);
        await caseRequest(base,`admin/cases/${saved.id}/files?name=${encodeURIComponent(file.name.trim())}`,{method:"POST",headers:{"content-type":"application/octet-stream"},body:blob});
      }
      setSelectedFiles({});
    },"正在准备案例快照…");
  }
  const current = detail.data;
  if (!admin) return <main className="p-6"><p role="alert">仅系统管理员可以添加、发布和下架精选案例。</p><Link to="/cases">返回公共案例</Link></main>;
  const visibleFiles = files.data?.files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8"><div className="mx-auto flex max-w-290 flex-col gap-8">
    <header><Link to="/cases" className="text-sm text-primary">← 返回公共案例</Link><h1 className="mb-2 text-3xl font-semibold">精选案例管理</h1><p className="text-sm text-subtext">生成完整对话和选定成果文件的独立副本，审核后向所有登录用户发布。原项目的访问权限保持不变。</p></header>
    {error && <p role="alert" className="rounded-lg border border-border bg-background p-4 text-accent-red">{error}</p>}{progress && <p role="status" className="text-sm text-primary">{progress}</p>}
    {!canAccessResearch ? <p className="text-sm text-subtext">当前账号没有这个研究空间的项目访问权限。请从自己有权访问的工作空间进入，再选择项目生成案例。</p> : <form onSubmit={(event) => { event.preventDefault(); void createDraft(); }} className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5">
      <label className="flex flex-col gap-2 text-sm">已有研究项目<select required value={projectId} disabled={busy} onChange={(event) => { setProjectId(event.target.value); setTitle(projects.data?.find((project) => project.id === event.target.value)?.name ?? ""); }} className="rounded-lg border border-border bg-background p-2"><option value="">请选择项目</option>{projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {projects.error && <p role="alert" className="text-accent-red">{projects.error.message}</p>}
      <label className="flex flex-col gap-2 text-sm">案例标题<input required maxLength={200} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} className="rounded-lg border border-border p-2" /></label>
      <label className="flex flex-col gap-2 text-sm">分类<input required maxLength={80} disabled={busy} value={category} onChange={(event) => setCategory(event.target.value)} className="rounded-lg border border-border p-2" /></label>
      <label className="flex flex-col gap-2 text-sm">案例简介<textarea required maxLength={4000} disabled={busy} value={summary} onChange={(event) => setSummary(event.target.value)} className="min-h-24 rounded-lg border border-border p-2" /></label>
      {projectId && <fieldset disabled={busy} className="min-w-0 rounded-lg border border-border p-4"><legend className="text-sm font-medium">选择要公开的成果文件</legend><p className="text-xs text-subtext">默认不公开任何文件。勾选后复制实际文件内容，不公开原目录地址；单文件最多 25 MB，总计 200 MB。</p><label className="mb-3 flex flex-wrap items-center gap-2 text-sm">文件来源<select value={source} onChange={(event) => setSource(event.target.value)} className="max-w-full rounded-lg border border-border bg-background p-2"><option value="artifacts">项目成果目录</option><option value="repository">项目主仓库</option>{sessions.data?.map((session) => <option key={session.id} value={session.id}>会话工作区：{session.title || "未命名会话"}</option>)}</select></label><input aria-label="搜索成果文件" placeholder="搜索文件路径" value={filter} onChange={(event) => setFilter(event.target.value)} className="mb-3 w-full rounded-lg border border-border p-2" />
      {files.isFetching && <p className="text-xs text-muted">正在读取文件列表…</p>}{files.error && <p role="alert" className="text-xs text-accent-red">{files.error.message}</p>}{files.data?.truncated && <p className="text-xs text-subtext">原项目文件列表达到服务端上限，未列出的文件未被选择。</p>}<div className="max-h-64 overflow-auto">{visibleFiles.slice(0,200).map((file) => <label key={file.key} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={Boolean(selectedFiles[file.key])} onChange={(event) => setSelectedFiles((current) => { const next={...current}; if(event.target.checked)next[file.key]=file;else delete next[file.key];return next; })} /><span className="break-all">{file.path}</span></label>)}{visibleFiles.length > 200 && <p className="text-xs text-muted">显示前 200 项，请搜索缩小范围。</p>}</div>
      {Object.values(selectedFiles).length > 0 && <div className="mt-4 border-t border-border pt-3"><p className="text-sm font-medium">已选 {Object.values(selectedFiles).length} 个文件 · 可修改公开文件名</p>{Object.values(selectedFiles).map((file) => <label key={file.key} className="mb-2 flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 flex-1 break-all">{file.path}</span><input aria-label={`公开文件名 ${file.path}`} maxLength={255} value={file.name} onChange={(event) => setSelectedFiles((current) => ({...current,[file.key]:{...file,name:event.target.value}}))} className="rounded border border-border p-2" /><button type="button" onClick={() => setSelectedFiles((current) => {const next={...current};delete next[file.key];return next;})}>移除</button></label>)}</div>}
      </fieldset>}
      <Button type="submit" disabled={busy || !projectId}>生成待审核快照</Button>
    </form>}
    <section><h2 className="text-xl font-semibold">已保存的案例</h2>{cases.isPending && <p>正在读取案例…</p>}{cases.error && <p role="alert" className="text-accent-red">{cases.error.message}</p>}<div className="flex flex-wrap gap-2">{cases.data?.cases.map((item) => <button key={item.id} disabled={busy} onClick={() => setSelectedCase(item.id)} className={`rounded-lg border px-4 py-3 text-sm ${selectedCase===item.id?"border-primary bg-primary-subtle text-primary":"border-border bg-background"}`}>{item.title} · {item.status === "published" ? "已发布" : "草稿"}</button>)}</div>{cases.data && !cases.data.cases.length && <p className="text-sm text-subtext">还没有案例，从上方选择一个已有项目开始。</p>}</section>
    {detail.isFetching && <p role="status">正在读取待审核内容…</p>}{detail.error && <p role="alert" className="text-accent-red">{detail.error.message}</p>}
    {current && !detail.error && <section className="flex flex-col gap-5 border-t border-border pt-6"><div className="rounded-xl border border-border bg-background p-5"><h2 className="mt-0 text-xl font-semibold">{current.status === "published" ? "已发布案例" : "发布前审核"}</h2><p className="text-sm text-subtext">完整对话包含工具输入、输出和分支内容，请逐会话审核。成果文件可下载检查。需要修改对话或替换成果时，先下架，再从整理后的原项目生成新快照。</p>{current.status === "draft" && <><p className="text-sm">成果复制进度：{current.files.length} / {current.expected_file_count ?? 0}</p><label className="mb-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={busy || detail.isFetching} onChange={(event) => setReviewed(event.target.checked)} />我已审核完整对话与全部成果文件，确认可向所有登录用户公开。</label></>}<div className="flex flex-wrap items-center gap-3">{current.status === "draft" ? <><Button disabled={busy || !reviewed || detail.isFetching || current.files.length !== current.expected_file_count} onClick={() => void action(() => caseWrite(base,`admin/cases/${current.id}/publish`,{revision:current.revision,reviewed:true}),"正在发布案例…")}>确认发布</Button><Button disabled={busy} onClick={() => { if(window.confirm("删除此案例草稿及其公开文件副本？原项目不受影响。"))void action(async()=>{await caseRequest(base,`admin/cases/${current.id}`,{method:"DELETE"});setSelectedCase("");},"正在删除草稿…"); }}>删除草稿</Button></> : <><Link to="/cases/$caseId" params={{caseId:current.id}} className="text-sm text-primary">查看公共页面</Link><Button disabled={busy} onClick={() => void action(() => caseWrite(base,`admin/cases/${current.id}/unpublish`,{revision:current.revision}),"正在下架案例…")}>下架案例</Button></>}<label className="flex items-center gap-2 text-sm">排序<input type="number" min={-100000} max={100000} value={order} onChange={(event)=>setOrder(Number(event.target.value))} className="w-24 rounded border border-border p-2" /></label><Button disabled={busy || !Number.isInteger(order)} onClick={() => void action(() => caseWrite(base,`admin/cases/${current.id}/order`,{revision:current.revision,order}),"正在保存排序…")}>保存排序</Button></div></div><CaseTranscript key={current.id} detail={current} admin /></section>}
  </div></main>;
}
