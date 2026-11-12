import reproductionCover from "../assets/workbench/reproduction.png";
import experimentCover from "../assets/workbench/experiment.png";
import reviewCover from "../assets/workbench/review.png";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronRight } from "lucide-react";
import { ReadOnlyProject } from "./ReadOnlyProject";
import { useAuthSession } from "./AuthSession";
import { isCloudWorkspace } from "./CloudWorkspace";
import { PlatformFrame } from "./ProductNav";
import { Button } from "../components/ui";
import { caseRequest, type FeaturedCase, type FeaturedCaseDetail } from "./featuredCasesApi";

export function useCasesBase() {
  const { accountUrl } = useAuthSession();
  return isCloudWorkspace() ? location.origin : accountUrl;
}

export function ResearchCases({ fullPage = false }: { fullPage?: boolean }) {
  const base = useCasesBase();
  const { user } = useAuthSession();
  const query = useQuery({ queryKey: ["featured-cases", base, user?.id], queryFn: () => caseRequest<{ cases: FeaturedCase[] }>(base, "cases"), enabled: Boolean(base && user), staleTime: 10000, refetchInterval: 30000 });
  const rows = fullPage ? query.data?.cases : query.data?.cases.slice(0, 3);
  const covers = [reproductionCover, experimentCover, reviewCover];
  return <section aria-labelledby="research-cases-title" className={`research-cases min-w-0 ${fullPage ? "research-cases-full" : ""}`}>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">{fullPage
      ? <h1 id="research-cases-title" className="product-page-title m-0">精选案例</h1>
      : <h2 id="research-cases-title" className="product-page-section-title m-0 flex items-center gap-2">精选案例<Link to="/cases" aria-label="查看全部精选案例" className="inline-flex text-muted hover:text-primary"><ChevronRight size={20} /></Link></h2>}
      <div className="flex gap-3 text-sm">{user?.isAdmin && <Link to="/admin/cases" className="text-primary">管理精选案例</Link>}</div>
    </div>
    {fullPage && <p className="product-page-description mb-5">查看真实项目的完整研究对话与成果文件，了解研究如何一步步推进。</p>}
    {query.isPending && <p className="text-base text-muted">正在读取案例…</p>}
    {query.error && <p role="alert" className="text-base text-accent-red">{query.error.message} <Button size="small" onClick={() => void query.refetch()}>重试</Button></p>}
    {query.data && !rows?.length && <div className="research-cases-empty rounded-xl border border-border-variant p-6 text-base text-subtext">暂时没有已发布的精选案例。管理员发布后，会显示在这里。</div>}
    <div className="research-case-grid grid grid-cols-3 gap-4 max-sm:grid-cols-1">{rows?.map((item, index) => <Link key={item.id} to="/cases/$caseId" params={{ caseId: item.id }} className="research-case-card min-w-0 rounded-xl text-text no-underline">
      <div className="research-case-cover mb-3 overflow-hidden rounded-xl border border-border-variant"><img src={covers[index % covers.length]} alt="" className="block h-full w-full object-cover" loading="lazy" /></div>
      <strong className="product-page-card-title mb-1.5 block">{item.title}</strong><span className="product-page-copy mb-2 line-clamp-3 block text-subtext">{item.summary}</span><span className="flex items-center justify-between gap-1 text-sm text-subtext"><span className="truncate">{item.category} · 真实研究记录</span><ArrowRight size={16} className="shrink-0" /></span>
    </Link>)}</div>
  </section>;
}

export function CasesPage() {
  return <PlatformFrame title="公共研究案例"><main className="min-h-0 flex-1 overflow-y-auto px-7 py-10 [@media((max-width:_960px))]:px-5 max-sm:px-4"><div className="mx-auto max-w-280"><ResearchCases fullPage /></div></main></PlatformFrame>;
}

export function CaseTranscript({ detail, admin = false, fullPage = false }: { detail: FeaturedCaseDetail; admin?: boolean; fullPage?: boolean }) {
  const base = useCasesBase();
  const { user } = useAuthSession();
  if (detail.snapshot.workspace) return <div className={admin && !fullPage ? "h-192 overflow-hidden rounded-xl border border-border" : "h-full min-h-0"}><ReadOnlyProject key={detail.id} id={detail.id} base={base} admin={admin} workspace={detail.snapshot.workspace} /></div>;
  return <main className="flex h-full flex-col items-start justify-center gap-4 p-8"><h1 className="m-0 text-xl font-semibold">{detail.title}</h1><p className="text-sm text-subtext">这个案例保存的是旧版文本记录。可以在案例管理中选择主对话及需要公开的成果，生成新的对话案例。</p>{user?.isAdmin && <Link to="/admin/cases" search={{ project: detail.source_project_id || undefined }} className="text-sm text-primary">选择对话和公开成果</Link>}</main>;
}

export function CaseDetailPage({ caseId, adminPreview = false }: { caseId: string; adminPreview?: boolean }) {
  const base = useCasesBase(); const { user } = useAuthSession();
  const admin = Boolean(adminPreview && user?.isAdmin);
  const detail = useQuery({ queryKey: ["featured-case",base,user?.id,caseId,admin], queryFn: () => caseRequest<FeaturedCaseDetail>(base,`${admin ? "admin/cases" : "cases"}/${encodeURIComponent(caseId)}`), enabled: Boolean(base && user), retry: false, refetchInterval: 30000 });
  if (detail.data && !detail.error) return <CaseTranscript detail={detail.data} admin={admin} fullPage />;
  return <PlatformFrame title="研究过程"><main className="min-h-0 flex-1 overflow-y-auto px-6 py-8"><Link to="/cases" className="mb-6 inline-block text-sm text-primary">← 返回精选案例</Link>{detail.isPending && <p>正在读取研究记录…</p>}{detail.error && <p role="alert" className="text-accent-red">{detail.error.message}</p>}</main></PlatformFrame>;
}
