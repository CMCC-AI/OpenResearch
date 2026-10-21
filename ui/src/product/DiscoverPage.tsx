import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, Calendar, Database, ExternalLink, Quote, Search, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { discoverPapers, type LiteratureHit, type LiteratureSource } from "../api";
import { LitSourceLogo, LIT_SOURCE_NAME } from "../components/LitSourceLogo";
import { literatureSources, externalLiteratureSources } from "../literatureSources";
import { PlatformFrame } from "./ProductNav";

const sources: { id: LiteratureSource | "all"; label: string }[] = [
  { id: "all", label: "全部渠道" },
  ...literatureSources.map(({ id, name }) => ({ id, label: name })),
];

function DatabaseIntroductions() {
  return <section aria-labelledby="database-introduction-title" className="mt-8">
    <h2 id="database-introduction-title" className="product-page-section-title m-0">学术数据源</h2>
    <div className="mt-4 grid grid-cols-3 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
      {literatureSources.map(({ id, name, description, url }) => <article key={id} aria-label={`${name} 数据源介绍`} className="min-w-0 rounded-xl border border-border-variant bg-background p-5">
        <LitSourceLogo source={id} size={28} />
        <h3 className="product-page-card-title mt-4 mb-2">{name}</h3>
        <p className="product-page-copy m-0 text-subtext">{description}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm text-primary no-underline">访问官网<ExternalLink size={13} /></a>
      </article>)}
      {externalLiteratureSources.map(({ id, name, description, url }) => <article key={id} aria-label={`${name} 数据源介绍`} className="min-w-0 rounded-xl border border-border-variant bg-background p-5">
        <Database size={28} className="text-primary" aria-hidden="true" />
        <h3 className="product-page-card-title mt-4 mb-2">{name}</h3>
        <p className="product-page-copy m-0 text-subtext">{description}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm text-primary no-underline">官网检索<ExternalLink size={13} /></a>
      </article>)}
    </div>
  </section>;
}

function PaperCard({ paper }: { paper: LiteratureHit }) {
  return <article className="rounded-xl border border-border-variant bg-background p-5 transition-shadow hover:shadow-card">
    <div className="mb-3 flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2 text-xs font-medium text-subtext"><LitSourceLogo source={paper.source} decorative />{LIT_SOURCE_NAME[paper.source]}</span><span className="text-xs text-muted">{paper.id}</span></div>
    <h3 className="product-page-card-title m-0">{paper.title}</h3>
    {paper.abstract && <p className="product-page-copy mt-3 mb-0 line-clamp-3 text-subtext">{paper.abstract}</p>}
    <footer className="mt-5 flex flex-wrap items-center gap-4 border-t border-border-variant pt-4 text-xs text-muted">
      {paper.publicationDate && <span className="inline-flex items-center gap-1"><Calendar size={13} />{paper.publicationDate}</span>}
      {paper.citations !== undefined && <span className="inline-flex items-center gap-1"><Quote size={13} />{paper.citations} 次引用</span>}
      {paper.votes !== undefined && <span>{paper.votes} 社区评价</span>}
      {paper.source === "alphaxiv" ? <Link to="/projects" search={{ paper: `arxiv:${paper.id}` }} className="ms-auto inline-flex items-center gap-1 font-medium text-primary no-underline">从此论文创建项目 <ArrowRight size={14} /></Link> : <Link to="/projects" search={{ new: true }} className="ms-auto inline-flex items-center gap-1 font-medium text-primary no-underline">进入工作台 <ArrowRight size={14} /></Link>}
    </footer>
  </article>;
}

export function DiscoverPage() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<LiteratureSource | "all">("all");
  const results = useQuery({
    queryKey: ["product", "discover", query, source],
    queryFn: ({ signal }) => discoverPapers(query, source, signal),
    enabled: query.length >= 2,
    staleTime: 300_000,
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setQuery(input.trim()); };

  return <PlatformFrame title="论文发现">
    <main className="min-h-0 flex-1 overflow-y-auto px-7 py-10 [@media((max-width:_960px))]:px-5 max-sm:px-4">
      <div className="mx-auto max-w-280">
        <header className="mb-8"><span className="inline-flex items-center gap-2 text-sm font-medium text-primary"><Sparkles size={15} />多来源学术发现</span><h1 className="product-page-title mt-3 mb-2">寻找下一项研究的起点</h1><p className="product-page-description m-0">检索社区解读、生命科学预印本、跨学科学术图谱与生物医学文献。</p></header>
        <form onSubmit={submit} className="rounded-2xl border border-border bg-background p-4 shadow-hairline">
          <div className="flex items-center gap-3"><Search className="text-muted" size={22} /><input autoFocus value={input} onChange={(event) => setInput(event.target.value)} className="min-w-0 flex-1 border-0 bg-transparent px-0 py-3 text-lg focus:border-0" placeholder="输入研究问题、主题、方法或论文标题…" /><button className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-background" type="submit">搜索论文</button></div>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border-variant pt-3">{sources.map((item) => <button key={item.id} type="button" onClick={() => setSource(item.id)} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${source === item.id ? "border-primary bg-primary-subtle text-primary" : "border-border text-subtext"}`}>{item.id !== "all" && <LitSourceLogo source={item.id} size={14} decorative />}{item.label}</button>)}</div>
        </form>

        <DatabaseIntroductions />

        {results.isFetching && <div className="mt-10 flex items-center justify-center gap-3 text-subtext"><span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />正在检索多个论文渠道…</div>}
        {results.error && <div role="alert" className="mt-8 rounded-lg border border-accent-red bg-accent-red-subtle p-4 text-sm text-accent-red">{results.error.message}</div>}
        {results.data && <section className="mt-8"><div className="mb-4 flex items-center justify-between"><h2 className="product-page-section-title m-0">检索结果</h2><span className="text-sm text-muted">{results.data.papers.length} 篇论文</span></div>{results.data.sourceErrors.length > 0 && <p className="rounded-lg bg-accent-amber-subtle p-3 text-sm text-subtext">部分渠道暂不可用：{results.data.sourceErrors.map((item) => item.source).join("、")}</p>}<div className="grid gap-3">{results.data.papers.map((paper) => <PaperCard key={`${paper.source}-${paper.id}`} paper={paper} />)}</div>{results.data.papers.length === 0 && <div className="py-14 text-center text-subtext"><BookOpen className="mx-auto mb-3" />没有找到论文，请尝试更具体的关键词。</div>}</section>}
      </div>
    </main>
  </PlatformFrame>;
}
