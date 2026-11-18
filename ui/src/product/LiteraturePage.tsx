import { useRef, useState, type FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BookOpenCheck, ExternalLink, Eye, FileText, Heart, MessageCircle, Search, X } from "lucide-react";
import { getDeepLiteraturePapers, getDeepLiteratureStatus, type DeepLiteraturePaper } from "../api";
import { useOptionalAuthSession } from "./AuthSession";
import { PlatformFrame } from "./ProductNav";

const PAGE_SIZE = 18;

/**
 * Build a DeepXiv destination URL. When unified SSO is active (`ssoLogin`),
 * route through DeepXiv's OpenResearch SSO start endpoint so signed-in users
 * land directly in their reading workspace without an extra login click.
 */
export function deepLiteratureUrl(webUrl: string, destination: string, ssoLogin = false) {
  const base = `${webUrl.replace(/\/$/, "")}/`;
  const target = destination.startsWith("/") ? destination : `/${destination}`;
  if (!ssoLogin) {
    return new URL(target.replace(/^\/+/, ""), base).href;
  }
  const start = new URL("api/auth/openresearch/start", base);
  start.searchParams.set("returnTo", target);
  return start.href;
}

function paperUrl(webUrl: string, id: string, ssoLogin = false) {
  return deepLiteratureUrl(webUrl, `/abs/${encodeURIComponent(id)}`, ssoLogin);
}

function PaperSkeletonGrid() {
  return <div aria-label="正在加载论文列表" className="mt-4 grid grid-cols-2 gap-3 [@media((max-width:_880px))]:grid-cols-1">
    {Array.from({ length: 6 }, (_, index) => (
      <div key={index} className="flex flex-col rounded-xl border border-border-variant bg-background p-5 animate-pulse">
        <div className="mb-3 flex gap-2">
          <div className="h-5 w-20 rounded-full bg-canvas" />
          <div className="h-5 w-14 rounded-full bg-canvas" />
        </div>
        <div className="h-6 w-4/5 rounded bg-canvas" />
        <div className="mt-2 h-4 w-1/2 rounded bg-canvas" />
        <div className="mt-3 h-4 w-full rounded bg-canvas" />
        <div className="mt-2 h-4 w-11/12 rounded bg-canvas" />
        <div className="mt-6 border-t border-border-variant pt-4">
          <div className="h-4 w-28 rounded bg-canvas" />
        </div>
      </div>
    ))}
  </div>;
}

function PaperCard({ paper, webUrl, ssoLogin }: { paper: DeepLiteraturePaper; webUrl: string; ssoLogin: boolean }) {
  const targetUrl = paperUrl(webUrl, paper.id, ssoLogin);
  return <article className="flex flex-col rounded-xl border border-border-variant bg-background p-5 transition-shadow hover:shadow-card">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {paper.hasBlog && <span className="rounded-full bg-primary-subtle px-2.5 py-1 text-xs font-medium text-primary">已有深度解读</span>}
      {paper.categories.slice(0, 3).map((category) => <span key={category} className="rounded-full bg-canvas px-2.5 py-1 text-xs text-subtext">{category}</span>)}
      <span className="ms-auto text-xs text-muted">{paper.date || paper.id}</span>
    </div>
    <h2 className="product-page-card-title m-0">
      <a href={targetUrl} target="_blank" rel="noreferrer" className="text-inherit no-underline transition-colors hover:text-primary">{paper.title}</a>
    </h2>
    <p className="mt-2 mb-0 text-sm text-muted">{paper.authors.slice(0, 4).join("、")}{paper.authors.length > 4 ? " 等" : ""}</p>
    {paper.abstract && <p className="product-page-copy mt-3 mb-0 line-clamp-3 text-subtext">{paper.abstract}</p>}
    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
      <span className="inline-flex items-center gap-1"><Eye size={13} />{paper.views}</span>
      <span className="inline-flex items-center gap-1"><Heart size={13} />{paper.likes}</span>
      <span className="inline-flex items-center gap-1"><MessageCircle size={13} />{paper.commentCount}</span>
      {paper.githubStars != null && <span>GitHub ★ {paper.githubStars}</span>}
    </div>
    <footer className="mt-auto pt-4">
      <div className="border-t border-border-variant pt-4">
        <a href={targetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary no-underline hover:underline">进入 DeepXiv 精读 <ExternalLink size={14} /></a>
      </div>
    </footer>
  </article>;
}

export function LiteraturePage() {
  const auth = useOptionalAuthSession();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"hot" | "new">("hot");
  const [offset, setOffset] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const status = useQuery({
    queryKey: ["deep-literature", "status"],
    queryFn: ({ signal }) => getDeepLiteratureStatus(signal),
    retry: false,
    staleTime: 120_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const feed = useQuery({
    queryKey: ["deep-literature", "papers", query, tab, offset],
    queryFn: ({ signal }) => getDeepLiteraturePapers(query, tab, signal, offset),
    enabled: status.data?.connected !== false,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const unavailable = Boolean(status.error || (status.data && !status.data.connected));
  const connected = status.data?.connected === true || (!unavailable && feed.isSuccess);
  const ssoLogin = Boolean(auth?.user && auth?.deepLiteratureUrl);
  const webUrl = auth?.deepLiteratureUrl || feed.data?.webUrl || status.data?.webUrl || "";
  const totalPages = feed.data ? Math.max(1, Math.ceil(feed.data.total / PAGE_SIZE)) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setQuery(input.trim());
    setOffset(0);
  };

  const clearSearch = () => {
    setInput("");
    setQuery("");
    setOffset(0);
    inputRef.current?.focus();
  };

  const changePage = (nextOffset: number) => {
    setOffset(nextOffset);
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const retryConnection = () => {
    void status.refetch();
    void feed.refetch();
  };

  return <PlatformFrame title="论文精读">
    <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto px-7 py-10 [@media((max-width:_960px))]:px-5 max-sm:px-4">
      <div className="mx-auto max-w-280">
        <header className="grid grid-cols-[1fr_auto] gap-6 [@media((max-width:_760px))]:grid-cols-1">
          <div><span className="inline-flex items-center gap-2 text-sm font-medium text-primary"><BookOpenCheck size={16} />DeepXiv 文献理解层</span><h1 className="product-page-title mt-3 mb-2">从发现论文，到读懂论文</h1><p className="product-page-description m-0 max-w-190">在 DeepXiv 完成精读、解读、问答与笔记，再把论文带入 MobileSci 建立项目、运行实验并沉淀结果。</p></div>
          <div className="flex h-fit flex-col items-end gap-3 [@media((max-width:_760px))]:items-start">
            <div className={`rounded-full border px-3 py-1.5 text-xs ${connected ? "border-accent-green bg-accent-green-subtle text-accent-green" : "border-border bg-background text-muted"}`}>{!connected && (status.isLoading || feed.isLoading) ? "正在检测连接" : connected ? "DeepXiv 已连接" : "DeepXiv 未连接"}</div>
            {connected && webUrl && <a href={deepLiteratureUrl(webUrl, "/library", ssoLogin)} target="_blank" rel="noreferrer" title={ssoLogin ? "使用当前 MobileSci 账户直接登录并打开文库" : undefined} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-background no-underline hover:opacity-90">打开我的文库 <ExternalLink size={14} /></a>}
          </div>
        </header>

        <section className="mt-8 grid grid-cols-3 gap-3 [@media((max-width:_760px))]:grid-cols-1">
          {[['1', '发现与筛选', '浏览热门与最新论文，按主题快速检索'], ['2', '理解与沉淀', '阅读 PDF、查看深度解读、问答并记录笔记'], ['3', '研究与验证', '创建空白项目，选择 Agent 设计和运行实验']].map(([step, title, copy]) => <article key={step} className="rounded-xl border border-border-variant bg-background p-4"><span className="text-xs font-semibold text-primary">0{step}</span><h2 className="product-page-section-title mt-2 mb-1">{title}</h2><p className="product-page-copy m-0 text-subtext">{copy}</p></article>)}
        </section>

        {unavailable && <section role="alert" className="mt-8 rounded-xl border border-accent-amber bg-accent-amber-subtle p-5"><h2 className="product-page-section-title m-0">文献服务暂不可用</h2><p className="mt-2 text-base text-subtext">请稍后重新连接，或继续通过论文发现寻找研究材料。</p><button disabled={status.isFetching} onClick={retryConnection} className="rounded-lg border border-border px-3 py-2 text-sm">重新连接</button></section>}

        {!unavailable && <>
          <form onSubmit={submit} className="mt-8 flex items-center gap-2 rounded-xl border border-border bg-background p-3 shadow-hairline">
            <Search className="ms-2 shrink-0 text-muted" size={20} />
            <input ref={inputRef} aria-label="搜索论文精读" maxLength={500} value={input} onChange={(event) => setInput(event.target.value)} className="min-w-0 flex-1 border-0 bg-transparent px-0 py-2 focus:border-0" placeholder="搜索标题、摘要、作者或研究主题…" />
            {(input || query) && <button type="button" onClick={clearSearch} aria-label="清空搜索" title="清空搜索" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text"><X size={16} /></button>}
            <button type="submit" className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-background hover:opacity-90">搜索</button>
          </form>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              {([['hot', '热门论文'], ['new', '最新论文']] as const).map(([value, label]) => <button key={value} onClick={() => { setTab(value); setOffset(0); }} className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${tab === value ? "border-primary bg-primary-subtle text-primary" : "border-border text-subtext hover:text-text"}`}>{label}</button>)}
            </div>
            <span className="text-xs text-muted">
              {feed.isPlaceholderData && feed.isFetching ? "正在加载… · " : ""}
              {feed.data ? `${query ? `「${query}」· ` : ""}共 ${feed.data.total} 篇 · 第 ${currentPage} / ${totalPages} 页` : ""}
            </span>
          </div>
          {!feed.data && (feed.isFetching || status.isLoading) && <PaperSkeletonGrid />}
          {feed.error && !feed.data && !status.isLoading && <div role="alert" className="mt-6 rounded-lg border border-accent-red bg-accent-red-subtle p-4 text-sm text-accent-red">暂时无法读取论文。<button disabled={feed.isFetching} onClick={() => void feed.refetch()} className="ms-3 underline">重试</button></div>}
          {feed.data && <div className="mt-4 grid grid-cols-2 gap-3 [@media((max-width:_880px))]:grid-cols-1">{feed.data.papers.map((paper) => <PaperCard key={paper.id} paper={paper} webUrl={webUrl || feed.data.webUrl} ssoLogin={ssoLogin} />)}</div>}
          {feed.data?.papers.length === 0 && !feed.isFetching && <div className="py-16 text-center text-subtext"><FileText className="mx-auto mb-3" />没有找到相关论文。{query && <button type="button" onClick={clearSearch} className="ms-2 text-primary underline">查看全部论文</button>}</div>}
          {feed.data && feed.data.papers.length > 0 && <nav aria-label="文献分页" className="mt-6 flex justify-between gap-3"><button disabled={offset === 0 || feed.isFetching} onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-40">上一页</button><button disabled={!feed.data.hasMore || feed.isFetching || feed.isError} onClick={() => changePage(offset + PAGE_SIZE)} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-40">下一页</button></nav>}
        </>}
      </div>
    </main>
  </PlatformFrame>;
}
