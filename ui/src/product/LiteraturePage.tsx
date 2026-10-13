import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpenCheck, ExternalLink, Eye, FileText, Heart, MessageCircle, Search } from "lucide-react";
import { getDeepLiteraturePapers, getDeepLiteratureStatus, type DeepLiteraturePaper } from "../api";
import { PlatformFrame } from "./ProductNav";

export function deepLiteratureUrl(webUrl: string, destination: string) {
  return new URL(destination, `${webUrl.replace(/\/$/, "")}/`).href;
}

function paperUrl(webUrl: string, id: string) {
  return deepLiteratureUrl(webUrl, `/abs/${encodeURIComponent(id)}`);
}

function PaperCard({ paper, webUrl }: { paper: DeepLiteraturePaper; webUrl: string }) {
  return <article className="flex flex-col rounded-xl border border-border-variant bg-background p-5 transition-shadow hover:shadow-card">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {paper.hasBlog && <span className="rounded-full bg-primary-subtle px-2.5 py-1 text-xs font-medium text-primary">已有深度解读</span>}
      {paper.categories.slice(0, 3).map((category) => <span key={category} className="rounded-full bg-canvas px-2.5 py-1 text-xs text-subtext">{category}</span>)}
      <span className="ms-auto text-xs text-muted">{paper.date || paper.id}</span>
    </div>
    <h2 className="m-0 text-lg leading-snug">{paper.title}</h2>
    <p className="mt-2 mb-0 text-xs text-muted">{paper.authors.slice(0, 4).join("、")}{paper.authors.length > 4 ? " 等" : ""}</p>
    {paper.abstract && <p className="mt-3 mb-0 line-clamp-3 text-sm leading-relaxed text-subtext">{paper.abstract}</p>}
    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
      <span className="inline-flex items-center gap-1"><Eye size={13} />{paper.views}</span>
      <span className="inline-flex items-center gap-1"><Heart size={13} />{paper.likes}</span>
      <span className="inline-flex items-center gap-1"><MessageCircle size={13} />{paper.commentCount}</span>
      {paper.githubStars != null && <span>GitHub ★ {paper.githubStars}</span>}
    </div>
    <footer className="mt-auto flex flex-wrap items-center gap-3 border-t border-border-variant pt-4">
      <a href={paperUrl(webUrl, paper.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary no-underline">进入 DeepXiv 精读 <ExternalLink size={14} /></a>
      <Link to="/projects" search={{ paper: `arxiv:${paper.id}` }} className="ms-auto inline-flex items-center gap-1.5 text-sm font-medium text-text no-underline">从此论文创建项目 <ArrowRight size={14} /></Link>
    </footer>
  </article>;
}

export function LiteraturePage() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"hot" | "new">("hot");
  const [offset, setOffset] = useState(0);
  const status = useQuery({ queryKey: ["deep-literature", "status"], queryFn: ({ signal }) => getDeepLiteratureStatus(signal), retry: false, staleTime: 30_000 });
  const feed = useQuery({ queryKey: ["deep-literature", "papers", query, tab, offset], queryFn: ({ signal }) => getDeepLiteraturePapers(query, tab, signal, offset), enabled: status.data?.connected === true, retry: false, staleTime: 60_000 });
  const submit = (event: FormEvent) => { event.preventDefault(); setQuery(input.trim()); setOffset(0); };

  return <PlatformFrame title="论文精读">
    <main className="min-h-0 flex-1 overflow-y-auto px-7 py-10">
      <div className="mx-auto max-w-280">
        <header className="grid grid-cols-[1fr_auto] gap-6 [@media((max-width:_760px))]:grid-cols-1">
          <div><span className="inline-flex items-center gap-2 text-sm font-medium text-primary"><BookOpenCheck size={16} />DeepXiv 文献理解层</span><h1 className="mt-3 mb-2 text-5xl tracking-[-0.045em]">从发现论文，到读懂论文</h1><p className="m-0 max-w-190 text-lg leading-relaxed text-subtext">在 DeepXiv 完成精读、解读、问答与笔记，再把论文带入 SONA 建立项目、运行实验并沉淀结果。</p></div>
          <div className="flex h-fit flex-col items-end gap-3 [@media((max-width:_760px))]:items-start">
            <div className={`rounded-full border px-3 py-1.5 text-xs ${status.data?.connected ? "border-accent-green bg-accent-green-subtle text-accent-green" : "border-border bg-background text-muted"}`}>{status.isLoading ? "正在检测连接" : status.data?.connected ? "DeepXiv 已连接" : "DeepXiv 未连接"}</div>
            {status.data?.connected && status.data.webUrl && <a href={deepLiteratureUrl(status.data.webUrl, "/library")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-background no-underline">登录并打开我的文库 <ExternalLink size={14} /></a>}
          </div>
        </header>

        <section className="mt-8 grid grid-cols-3 gap-3 [@media((max-width:_760px))]:grid-cols-1">
          {[['1', '发现与筛选', '浏览热门与最新论文，按主题快速检索'], ['2', '理解与沉淀', '阅读 PDF、查看深度解读、问答并记录笔记'], ['3', '研究与验证', '从论文创建项目，再选择 Agent 设计和运行实验']].map(([step, title, copy]) => <article key={step} className="rounded-xl border border-border-variant bg-background p-4"><span className="text-xs font-semibold text-primary">0{step}</span><h2 className="mt-2 mb-1 text-base">{title}</h2><p className="m-0 text-sm leading-relaxed text-subtext">{copy}</p></article>)}
        </section>

        {(status.error || (status.data && !status.data.connected)) && <section role="alert" className="mt-8 rounded-xl border border-accent-amber bg-accent-amber-subtle p-5"><h2 className="m-0 text-base">文献服务暂不可用</h2><p className="mt-2 text-sm text-subtext">请稍后重新连接，或继续通过论文发现寻找研究材料。</p><button disabled={status.isFetching} onClick={() => void status.refetch()} className="rounded-lg border border-border px-3 py-2 text-sm">重新连接</button></section>}

        {status.data?.connected && <>
          <form onSubmit={submit} className="mt-8 flex items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-hairline"><Search className="ms-2 text-muted" size={20} /><input aria-label="搜索论文精读" maxLength={500} value={input} onChange={(event) => setInput(event.target.value)} className="min-w-0 flex-1 border-0 bg-transparent px-0 py-2 focus:border-0" placeholder="搜索标题、摘要、作者或研究主题…" /><button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-background">搜索</button></form>
          <div className="mt-6 flex items-center justify-between"><div className="flex gap-2">{([['hot', '热门论文'], ['new', '最新论文']] as const).map(([value, label]) => <button key={value} onClick={() => { setTab(value); setOffset(0); }} className={`rounded-full border px-3 py-1.5 text-xs ${tab === value ? "border-primary bg-primary-subtle text-primary" : "border-border text-subtext"}`}>{label}</button>)}</div><span className="text-xs text-muted">{feed.data ? `共 ${feed.data.total} 篇 · 第 ${offset / 18 + 1} 页` : ""}</span></div>
          {feed.isFetching && <div className="py-16 text-center text-sm text-subtext">正在读取 DeepXiv…</div>}
          {feed.error && <div role="alert" className="mt-6 rounded-lg border border-accent-red bg-accent-red-subtle p-4 text-sm text-accent-red">暂时无法读取论文。<button disabled={feed.isFetching} onClick={() => void feed.refetch()} className="ms-3 underline">重试</button></div>}
          {feed.data && <div className="mt-4 grid grid-cols-2 gap-3 [@media((max-width:_880px))]:grid-cols-1">{feed.data.papers.map((paper) => <PaperCard key={paper.id} paper={paper} webUrl={feed.data.webUrl} />)}</div>}
          {feed.data?.papers.length === 0 && <div className="py-16 text-center text-subtext"><FileText className="mx-auto mb-3" />没有找到相关论文。</div>}
          <nav aria-label="文献分页" className="mt-6 flex justify-between gap-3"><button disabled={offset === 0 || feed.isFetching} onClick={() => setOffset(Math.max(0, offset - 18))} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-40">上一页</button><button disabled={!feed.data?.hasMore || feed.isFetching || feed.isError} onClick={() => setOffset(offset + 18)} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-40">下一页</button></nav>
        </>}
      </div>
    </main>
  </PlatformFrame>;
}
