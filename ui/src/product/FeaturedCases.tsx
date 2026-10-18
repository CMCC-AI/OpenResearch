import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, FileText, Download } from "lucide-react";
import { useAuthSession } from "./AuthSession";
import { isCloudWorkspace } from "./CloudWorkspace";
import { PlatformFrame } from "./ProductNav";
import { Button } from "../components/ui";
import { caseRequest, caseFileBlob, type CaseFile, type FeaturedCase, type FeaturedCaseDetail } from "./featuredCasesApi";

export function useCasesBase() {
  const { accountUrl } = useAuthSession();
  return isCloudWorkspace() ? location.origin : accountUrl;
}

export function ResearchCases({ fullPage = false }: { fullPage?: boolean }) {
  const base = useCasesBase();
  const { user } = useAuthSession();
  const query = useQuery({ queryKey: ["featured-cases", base, user?.id], queryFn: () => caseRequest<{ cases: FeaturedCase[] }>(base, "cases"), enabled: Boolean(base && user), staleTime: 10000, refetchInterval: 30000 });
  const rows = fullPage ? query.data?.cases : query.data?.cases.slice(0, 6);
  return <section aria-labelledby="research-cases-title" className="min-w-0">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 id="research-cases-title" className="m-0 text-xl font-semibold">精选案例</h2><div className="flex gap-4 text-sm">{!fullPage && <Link to="/cases" className="text-primary">查看全部</Link>}{user?.isAdmin && <Link to="/admin/cases" className="text-primary">管理精选案例</Link>}</div></div>
    <p className="mb-5 text-sm text-subtext">查看真实项目的完整研究对话与成果文件，了解研究如何一步步推进。</p>
    {query.isPending && <p className="text-sm text-muted">正在读取案例…</p>}
    {query.error && <p role="alert" className="text-sm text-accent-red">{query.error.message} <Button size="small" onClick={() => void query.refetch()}>重试</Button></p>}
    {query.data && !rows?.length && <div className="rounded-xl border border-border bg-background p-6 text-sm text-subtext">暂时没有已发布的精选案例。管理员发布后，会显示在这里。</div>}
    <div className="grid grid-cols-3 gap-4 [@media((max-width:_1100px))]:grid-cols-1">{rows?.map((item) => <Link key={item.id} to="/cases/$caseId" params={{ caseId: item.id }} className="min-w-0 rounded-xl border border-border bg-background p-4 text-text no-underline hover:border-primary"><div className="mb-4 flex h-28 items-center justify-center rounded-lg bg-primary-subtle text-primary"><FileText size={42} /></div><strong className="mb-2 block">{item.title}</strong><span className="mb-4 block whitespace-pre-wrap text-sm leading-relaxed text-subtext">{item.summary}</span><span className="flex items-center justify-between text-xs text-primary"><span>{item.category} · 真实研究记录</span><ArrowRight size={15} /></span></Link>)}</div>
  </section>;
}

export function CasesPage() {
  return <PlatformFrame title="公共研究案例"><main className="min-h-0 flex-1 overflow-y-auto px-6 py-10"><div className="mx-auto max-w-290"><ResearchCases fullPage /></div></main></PlatformFrame>;
}

function FileDownload({ base, detail, file, admin }: { base: string; detail: FeaturedCaseDetail; file: CaseFile; admin: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  async function read(previewOnly: boolean) {
    setBusy(true); setError("");
    try {
      const blob = await caseFileBlob(base, detail.id, file.id, admin);
      if (previewOnly) setPreview((await blob.slice(0, 64000).text()) + (blob.size > 64000 ? "\n\n（预览前 64 KB，下载可查看完整文件。）" : ""));
      else {
        const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
        anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <li className="rounded-lg border border-border bg-background p-4"><div className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1 break-all font-medium">{file.name}</span><span className="text-xs text-muted">{(file.size / 1024).toFixed(1)} KB</span>{/\.(txt|md|csv|json|yaml|yml|tex|py|js|ts|r|log)$/i.test(file.name) && <Button size="small" disabled={busy} onClick={() => void read(true)}>预览</Button>}<Button size="small" disabled={busy} onClick={() => void read(false)}><Download size={14} /> 下载完整文件</Button></div><p className="mb-0 break-all text-xs text-muted">SHA-256：{file.sha256}</p>{error && <p role="alert" className="text-sm text-accent-red">{error}</p>}{preview !== null && <div className="mt-4"><Button size="small" onClick={() => setPreview(null)}>关闭预览</Button><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{preview}</pre></div>}</li>;
}

export function CaseTranscript({ detail, admin = false }: { detail: FeaturedCaseDetail; admin?: boolean }) {
  const base = useCasesBase();
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, detail.snapshot.sessions.length - 1));
  const session = detail.snapshot.sessions[index];
  return <div className="flex flex-col gap-8">
    <header><div className="mb-2 text-sm text-primary">{detail.category} · {admin && detail.status === "draft" ? "待审核快照" : "只读研究档案"}</div><h1 className="m-0 text-3xl font-semibold">{detail.title}</h1><p className="whitespace-pre-wrap text-subtext">{detail.summary}</p><p className="text-xs text-muted">{detail.snapshot.sessions.length} 个研究会话 · {detail.snapshot.sessions.reduce((sum, row) => sum + row.messages.length, 0)} 条记录 · {detail.files.length} 个成果文件</p><p className="text-xs text-subtext">以下为已保存的完整对话，包含工具与分支记录；原项目更新不会自动改变这份快照。</p></header>
    <section aria-label="研究对话"><label className="mb-4 flex flex-wrap items-center gap-3 text-sm">研究会话<select value={index} onChange={(event) => setSelected(Number(event.target.value))} className="max-w-full rounded-lg border border-border bg-background p-2">{detail.snapshot.sessions.map((row, i) => <option key={i} value={i}>{i + 1}. {row.title}（{row.messages.length} 条）</option>)}</select></label><ol className="m-0 flex list-none flex-col gap-4 p-0">{session?.messages.map((message, i) => <li key={message.id} className="rounded-xl border border-border bg-background p-5"><div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-subtext"><strong className="text-text">{message.role === "user" ? "研究者" : "科研智能体"}</strong><span>#{i + 1}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time>{message.parentId && message.parentId !== session.messages[i - 1]?.id && <span>分支 · 回复 #{session.messages.findIndex((item) => item.id === message.parentId) + 1}</span>}</div><pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{message.content || "（空消息）"}</pre></li>)}</ol></section>
    <section aria-label="研究成果"><h2 className="text-xl font-semibold">成果文件</h2>{!detail.files.length && <p className="text-sm text-subtext">管理员未附加成果文件。</p>}<ul className="m-0 flex list-none flex-col gap-3 p-0">{detail.files.map((file) => <FileDownload key={file.id} base={base} detail={detail} file={file} admin={admin} />)}</ul></section>
  </div>;
}

export function CaseDetailPage({ caseId }: { caseId: string }) {
  const base = useCasesBase(); const { user } = useAuthSession();
  const detail = useQuery({ queryKey: ["featured-case",base,user?.id,caseId], queryFn: () => caseRequest<FeaturedCaseDetail>(base,`cases/${encodeURIComponent(caseId)}`), enabled: Boolean(base && user), retry: false, refetchInterval: 30000 });
  return <PlatformFrame title="研究过程"><main className="min-h-0 flex-1 overflow-y-auto px-6 py-8"><div className="mx-auto max-w-290"><Link to="/cases" className="mb-6 inline-block text-sm text-primary">← 返回精选案例</Link>{detail.isPending && <p>正在读取研究记录…</p>}{detail.error && <p role="alert" className="text-accent-red">{detail.error.message}</p>}{detail.data && !detail.error && <CaseTranscript detail={detail.data} />}</div></main></PlatformFrame>;
}
