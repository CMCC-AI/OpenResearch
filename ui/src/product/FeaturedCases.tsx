import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isCancelledError, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, BookOpen, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { ReadOnlyProject } from "./ReadOnlyProject";
import { useAuthSession } from "./AuthSession";
import { isCloudWorkspace } from "./CloudWorkspace";
import { PlatformFrame } from "./ProductNav";
import { Button, Spinner } from "../components/ui";
import { ProgressBar } from "../components/ProgressBar";
import { queryClient } from "../queries/client";
import { pickAutoCaseCover, resolveCaseCoverSrc } from "./caseCovers";
import {
  caseDetailMeta,
  caseDetailRequest,
  caseRequest,
  getCaseLoadProgress,
  subscribeCaseLoadProgress,
  type CaseLoadProgress,
  type FeaturedCase,
  type FeaturedCaseDetail,
} from "./featuredCasesApi";

export function useCasesBase() {
  const { accountUrl } = useAuthSession();
  return isCloudWorkspace() ? location.origin : accountUrl;
}

function caseProgressKey(base: string, caseId: string, admin: boolean) {
  return `${base}:${admin ? "admin" : "public"}:${caseId}`;
}

function formatProgressBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function caseDetailQuery(base: string, userId: string | undefined, caseId: string, admin: boolean) {
  const path = `${admin ? "admin/cases" : "cases"}/${encodeURIComponent(caseId)}`;
  const progressKey = caseProgressKey(base, caseId, admin);
  return {
    queryKey: ["featured-case", base, userId, caseId, admin] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      caseDetailRequest
        ? caseDetailRequest(base, path, { signal, progressKey })
        : caseRequest<FeaturedCaseDetail>(base, path, { signal }),
    enabled: Boolean(base && userId),
    staleTime: 5 * 60_000,
    retry: false as const,
  };
}

function CaseLoadingSkeleton() {
  return (
    <div aria-hidden="true" className="mt-6 grid grid-cols-[minmax(0,1fr)_18rem] gap-4 max-md:grid-cols-1 motion-safe:animate-pulse">
      <div className="flex flex-col gap-4 rounded-xl border border-border-variant bg-background p-5">
        <div className="ms-auto h-10 w-2/5 rounded-lg bg-panel" />
        <div className="flex flex-col gap-2.5">
          <div className="h-3 w-4/5 rounded bg-panel" />
          <div className="h-3 w-full rounded bg-panel" />
          <div className="h-3 w-3/4 rounded bg-panel" />
        </div>
        <div className="ms-auto h-8 w-1/3 rounded-lg bg-panel" />
        <div className="flex flex-col gap-2.5">
          <div className="h-3 w-5/6 rounded bg-panel" />
          <div className="h-3 w-2/3 rounded bg-panel" />
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border-variant bg-background p-4 max-md:hidden">
        <div className="h-4 w-1/2 rounded bg-panel" />
        <div className="h-14 rounded-lg bg-panel" />
        <div className="h-14 rounded-lg bg-panel" />
        <div className="h-14 rounded-lg bg-panel" />
      </div>
    </div>
  );
}

function CaseLoadingProgress({ progress, compact = false }: { progress: CaseLoadProgress | null; compact?: boolean }) {
  const phase = progress?.phase ?? "connecting";
  const loaded = progress?.loadedBytes ?? 0;
  const total = progress?.totalBytes ?? null;
  const stageLabel = phase === "parsing"
    ? "正在解析对话与工作区内容…"
    : phase === "downloading"
      ? "正在下载研究记录与成果快照…"
      : "正在连接并获取案例详情…";
  const compactLabel = phase === "parsing"
    ? "正在解析内容…"
    : phase === "downloading"
      ? "正在下载案例…"
      : "正在打开案例…";

  if (compact) {
    const determinate = phase === "parsing" || (total !== null && total > 0);
    const max = phase === "parsing" ? Math.max(loaded, 1) : (total ?? 1);
    const value = phase === "parsing" ? max : Math.min(loaded, max);
    const pct = determinate ? Math.min(100, Math.round((value / max) * 100)) : null;
    const byteCaption = phase === "parsing"
      ? formatProgressBytes(loaded || max)
      : total !== null && total > 0
        ? `${formatProgressBytes(loaded)} / ${formatProgressBytes(total)}`
        : loaded > 0
          ? formatProgressBytes(loaded)
          : "";
    return (
      <span role="status" aria-live="polite" className="mt-1 block w-full max-sm:col-start-2">
        <span className="flex items-center justify-between gap-2 text-xs text-primary">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Spinner />
            <span className="truncate">{compactLabel}</span>
          </span>
          <span className="shrink-0 tabular-nums text-muted">
            {pct !== null ? `${pct}%` : ""}{pct !== null && byteCaption ? " · " : ""}{byteCaption}
          </span>
        </span>
        <span
          className="progress-track mt-1.5 block h-1.5 w-full overflow-hidden rounded-full border border-border bg-panel"
          role="progressbar"
          aria-label={compactLabel}
          aria-valuenow={pct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {determinate
            ? <span className="progress-fill block h-full rounded-full bg-accent transition-[width] duration-200 ease-standard" style={{ width: `${pct}%` }} />
            : <span className="progress-fill-indeterminate block h-full rounded-full bg-accent" />}
        </span>
      </span>
    );
  }

  if (phase === "parsing" || (total !== null && total > 0)) {
    const max = phase === "parsing" ? Math.max(loaded, 1) : total!;
    const value = phase === "parsing" ? max : Math.min(loaded, max);
    const pct = Math.min(100, Math.round((value / max) * 100));
    return (
      <div className="mt-4">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <Spinner />
          <span>{stageLabel}</span>
        </div>
        <ProgressBar
          value={value}
          max={max}
          label={`${pct}%`}
          caption={<span>{phase === "parsing" ? formatProgressBytes(loaded || max) : `${formatProgressBytes(loaded)} / ${formatProgressBytes(total!)}`}</span>}
        />
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 text-sm font-medium text-text">
        <Spinner />
        <span>{stageLabel}</span>
      </div>
      <div className="progress mt-3 mx-0 mb-1" role="progressbar" aria-label={stageLabel} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-track h-2 rounded-full bg-panel border border-border overflow-hidden">
          <div className="progress-fill-indeterminate h-full bg-accent rounded-full" />
        </div>
        {loaded > 0 && (
          <div className="progress-caption flex justify-between mt-1.5 text-sm text-muted">
            <span>已接收数据</span>
            <span>{formatProgressBytes(loaded)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function useCaseProgress(base: string, caseId: string | null, admin: boolean) {
  const progressKey = caseId ? caseProgressKey(base, caseId, admin) : undefined;
  const readProgress = () => (getCaseLoadProgress ? getCaseLoadProgress(progressKey) : null);
  return useSyncExternalStore(
    (listener) => (subscribeCaseLoadProgress ? subscribeCaseLoadProgress(progressKey, listener) : () => {}),
    readProgress,
    readProgress,
  );
}

function categoryBadgeClass(category: string) {
  if (/综述|文献|survey|review/i.test(category)) return "research-case-badge-purple";
  if (/实验|数据|预测|分析|实证|experiment|benchmark/i.test(category)) return "research-case-badge-teal";
  if (/复现|模型|系统|架构|reproduction/i.test(category)) return "research-case-badge-blue";
  return "";
}

function displayCaseSummary(item: FeaturedCase) {
  const summary = item.summary?.trim() ?? "";
  const title = item.title?.trim() ?? "";
  if (!summary || summary === title) return "查看完整研究对话、推理过程与公开成果文件";
  return summary;
}

function formatCaseDate(item: FeaturedCase) {
  const raw = item.published_at || item.updated_at || item.created_at;
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function CasesGridSkeleton({ fullPage }: { fullPage: boolean }) {
  return (
    <div
      aria-label="正在读取案例…"
      role="status"
      className={`research-case-grid grid ${fullPage ? "grid-cols-3 gap-6 max-lg:grid-cols-2 max-sm:grid-cols-1" : "grid-cols-3 gap-5 max-md:grid-cols-1"} motion-safe:animate-pulse`}
    >
      {[0, 1, 2].map((item) => (
        <div key={item} aria-hidden="true" className="flex flex-col overflow-hidden rounded-2xl border border-border-variant bg-background">
          <div className="research-case-cover-img w-full bg-panel" />
          <div className={`flex flex-1 flex-col gap-2.5 ${fullPage ? "p-5" : "p-4"}`}>
            <div className="h-5 w-4/5 rounded bg-panel" />
            <div className="h-3.5 w-full rounded bg-panel" />
            <div className="h-3.5 w-2/3 rounded bg-panel" />
          </div>
          <div className={`border-t border-divider-faint ${fullPage ? "px-5 py-3.5" : "px-4 py-3"}`}>
            <div className="h-3.5 w-1/3 rounded bg-panel" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ResearchCases({ fullPage = false }: { fullPage?: boolean }) {
  const base = useCasesBase();
  const { user } = useAuthSession();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["featured-cases", base, user?.id], queryFn: () => caseRequest<{ cases: FeaturedCase[] }>(base, "cases"), enabled: Boolean(base && user), staleTime: 10000, refetchInterval: 30000 });
  const [selectedCategory, setSelectedCategory] = useState("全部");
  const [searchQuery, setSearchQuery] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);
  const attemptRef = useRef(0);
  const openingIdRef = useRef<string | null>(null);
  const activeProgress = useCaseProgress(base, openingId, false);

  const allCases = query.data?.cases ?? [];
  const categoryCounts = new Map<string, number>();
  for (const item of allCases) {
    const category = item.category?.trim() || "科研实践";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const categories = Array.from(categoryCounts.entries());
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const activeCategory = selectedCategory !== "全部" && categoryCounts.has(selectedCategory) ? selectedCategory : "全部";
  const rows = fullPage
    ? allCases.filter((item) => {
        const category = item.category?.trim() || "科研实践";
        if (activeCategory !== "全部" && category !== activeCategory) return false;
        if (!normalizedQuery) return true;
        return (
          item.title.toLowerCase().includes(normalizedQuery) ||
          item.summary.toLowerCase().includes(normalizedQuery) ||
          category.toLowerCase().includes(normalizedQuery)
        );
      })
    : allCases.slice(0, 3);

  useEffect(() => () => {
    attemptRef.current += 1;
    if (openingIdRef.current && base && user) {
      void queryClient.cancelQueries({ queryKey: caseDetailQuery(base, user.id, openingIdRef.current, false).queryKey });
    }
  }, [base, user]);

  const prefetchCase = (caseId: string) => {
    if (!base || !user) return;
    void queryClient.prefetchQuery(caseDetailQuery(base, user.id, caseId, false));
  };

  const openCase = async (caseId: string) => {
    if (!base || !user) return;
    if (openingIdRef.current === caseId) return;
    const previousId = openingIdRef.current;
    if (previousId && previousId !== caseId) {
      void queryClient.cancelQueries({ queryKey: caseDetailQuery(base, user.id, previousId, false).queryKey });
    }
    const attempt = ++attemptRef.current;
    openingIdRef.current = caseId;
    setOpeningId(caseId);
    setCardError((current) => (current?.id === caseId ? null : current));
    const options = caseDetailQuery(base, user.id, caseId, false);
    try {
      await queryClient.fetchQuery(options);
      if (attemptRef.current !== attempt) return;
      openingIdRef.current = null;
      setOpeningId(null);
      void navigate({ to: "/cases/$caseId", params: { caseId } });
    } catch (error) {
      if (attemptRef.current !== attempt || isCancelledError(error)) return;
      openingIdRef.current = null;
      setOpeningId(null);
      setCardError({ id: caseId, message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section aria-labelledby="research-cases-title" className={`research-cases min-w-0 ${fullPage ? "research-cases-full" : ""}`}>
      {fullPage ? (
        <header className="mb-7 flex flex-col gap-4 border-b border-border-variant pb-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 id="research-cases-title" className="product-page-title m-0">精选案例</h1>
                {query.data && (
                  <span className="inline-flex items-center rounded-full border border-border-variant bg-surface px-2.5 py-0.5 text-xs font-medium text-subtext tabular-nums">
                    共 {allCases.length} 个公开案例
                  </span>
                )}
              </div>
              <p className="product-page-description mt-2 mb-0 max-w-2xl">
                查看真实项目的完整研究对话与成果文件，了解研究如何一步步推进。
              </p>
            </div>
            {user?.isAdmin && (
              <Link
                to="/admin/cases"
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-text no-underline shadow-hairline transition-colors hover:border-primary hover:bg-primary-subtle hover:text-primary"
              >
                <SlidersHorizontal size={15} aria-hidden="true" />
                <span>管理精选案例</span>
              </Link>
            )}
          </div>
          {allCases.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div role="group" aria-label="按分类筛选案例" className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-pressed={activeCategory === "全部"}
                  onClick={() => setSelectedCategory("全部")}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    activeCategory === "全部"
                      ? "border-primary bg-primary-subtle text-primary"
                      : "border-border-variant bg-background text-subtext hover:border-border hover:text-text"
                  }`}
                >
                  <span>全部</span>
                  <span className="tabular-nums opacity-75">{allCases.length}</span>
                </button>
                {categories.map(([category, count]) => (
                  <button
                    key={category}
                    type="button"
                    aria-pressed={activeCategory === category}
                    onClick={() => setSelectedCategory(category)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      activeCategory === category
                        ? "border-primary bg-primary-subtle text-primary"
                        : "border-border-variant bg-background text-subtext hover:border-border hover:text-text"
                    }`}
                  >
                    <span>{category}</span>
                    <span className="tabular-nums opacity-75">{count}</span>
                  </button>
                ))}
              </div>
              <div className="relative w-64 max-sm:w-full">
                <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索案例标题、分类或简介…"
                  aria-label="搜索精选案例"
                  className="h-9 w-full rounded-lg border border-border bg-background pr-8 pl-8 text-sm text-text placeholder:text-muted focus:border-primary focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="清除搜索"
                    onClick={() => setSearchQuery("")}
                    className="absolute top-1/2 right-2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-text"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}
        </header>
      ) : (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 id="research-cases-title" className="product-page-section-title m-0 flex items-center gap-2">
            精选案例
            <Link to="/cases" aria-label="查看全部精选案例" className="inline-flex items-center gap-0.5 text-sm font-normal text-muted no-underline hover:text-primary">
              <span>全部</span>
              <ChevronRight size={18} aria-hidden="true" />
            </Link>
          </h2>
          <div className="flex items-center gap-3 text-sm">
            {user?.isAdmin && (
              <Link
                to="/admin/cases"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-variant bg-background px-2.5 py-1 text-xs font-medium text-primary no-underline transition-colors hover:border-primary hover:bg-primary-subtle"
              >
                <SlidersHorizontal size={13} aria-hidden="true" />
                <span>管理精选案例</span>
              </Link>
            )}
          </div>
        </div>
      )}

      {query.isPending && <CasesGridSkeleton fullPage={fullPage} />}
      {query.error && (
        <p role="alert" className="rounded-xl border border-danger-notice-border bg-accent-red-subtle px-4 py-3 text-sm text-accent-red">
          {query.error.message} <Button size="small" onClick={() => void query.refetch()}>重试</Button>
        </p>
      )}
      {query.data && !allCases.length && (
        <div className="research-cases-empty flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-background/60 px-6 py-14 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-muted">
            <BookOpen size={20} aria-hidden="true" />
          </div>
          <p className="m-0 text-base text-subtext">暂时没有已发布的精选案例。管理员发布后，会显示在这里。</p>
        </div>
      )}
      {query.data && allCases.length > 0 && !rows.length && (
        <div className="research-cases-empty flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-background/60 px-6 py-12 text-center">
          <p className="m-0 text-sm text-subtext">没有找到符合当前筛选条件的精选案例。</p>
          <Button
            size="small"
            onClick={() => {
              setSelectedCategory("全部");
              setSearchQuery("");
            }}
          >
            重置筛选
          </Button>
        </div>
      )}

      {rows.length > 0 && (
        <div className={`research-case-grid grid ${fullPage ? "grid-cols-3 gap-6 max-lg:grid-cols-2 max-sm:grid-cols-1" : "grid-cols-3 gap-5 max-md:grid-cols-1"}`}>
          {rows.map((item, index) => {
            const loadingCard = openingId === item.id;
            const errorForCard = cardError?.id === item.id ? cardError.message : null;
            const category = item.category?.trim() || "科研实践";
            const summaryText = displayCaseSummary(item);
            const dateText = formatCaseDate(item);
            return (
              <div key={item.id} className="min-w-0 flex flex-col">
                <Link
                  to="/cases/$caseId"
                  params={{ caseId: item.id }}
                  aria-busy={loadingCard || undefined}
                  onPointerDown={() => prefetchCase(item.id)}
                  onFocus={() => prefetchCase(item.id)}
                  onClick={(event) => {
                    if (!base || !user || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                    const options = caseDetailQuery(base, user.id, item.id, false);
                    const state = queryClient.getQueryState(options.queryKey);
                    if (state?.data && !state.isInvalidated && Date.now() - state.dataUpdatedAt < options.staleTime) return;
                    event.preventDefault();
                    void openCase(item.id);
                  }}
                  className="research-case-link flex min-w-0 flex-1 flex-col rounded-2xl text-text no-underline focus-visible:outline-none"
                >
                  <article className="research-case-card flex h-full flex-1 flex-col overflow-hidden rounded-2xl border border-border-variant bg-background shadow-hairline">
                    <div className="research-case-cover relative overflow-hidden bg-surface">
                      <img
                        src={resolveCaseCoverSrc(base, item, index)}
                        alt=""
                        className="research-case-cover-img block w-full object-cover"
                        loading="lazy"
                        onError={(event) => {
                          const fallback = pickAutoCaseCover(item, index);
                          if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
                        }}
                      />
                      <span className={`research-case-badge ${categoryBadgeClass(category)}`}>
                        {category}
                      </span>
                    </div>
                    <div className={`research-case-body flex flex-1 flex-col ${fullPage ? "p-5" : "p-4"}`}>
                      <strong className="research-case-title block text-base font-semibold leading-snug text-text line-clamp-2">
                        {item.title}
                      </strong>
                      <p className={`mt-2 mb-0 text-sm leading-relaxed text-subtext ${fullPage ? "line-clamp-3" : "line-clamp-2"}`}>
                        {summaryText}
                      </p>
                    </div>
                    <footer className={`research-case-footer mt-auto border-t border-divider-faint ${fullPage ? "px-5 py-3.5" : "px-4 py-3"}`}>
                      {loadingCard ? (
                        <CaseLoadingProgress progress={activeProgress} compact />
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs text-muted tabular-nums">
                            {dateText ? `发布于 ${dateText}` : "真实研究记录"}
                          </span>
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                            <span>查看详情</span>
                            <ArrowRight size={14} aria-hidden="true" className="research-case-arrow" />
                          </span>
                        </div>
                      )}
                    </footer>
                  </article>
                </Link>
                {errorForCard && !loadingCard && (
                  <div role="alert" className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-border-variant bg-background px-3 py-2 text-xs">
                    <span className="min-w-0 truncate text-accent-red">{errorForCard}</span>
                    <Button size="small" onClick={() => void openCase(item.id)}>重试</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function CasesPage() {
  return <PlatformFrame title="公共研究案例"><main className="min-h-0 flex-1 overflow-y-auto px-7 py-10 [@media((max-width:_960px))]:px-5 max-sm:px-4"><div className="mx-auto max-w-280"><ResearchCases fullPage /></div></main></PlatformFrame>;
}

export function CaseTranscript({ detail, admin = false, fullPage = false }: { detail: FeaturedCaseDetail; admin?: boolean; fullPage?: boolean }) {
  const base = useCasesBase();
  const { user } = useAuthSession();
  if (detail.snapshot.workspace) return <div className={admin && !fullPage ? "case-content-enter h-192 overflow-hidden rounded-xl border border-border" : "case-content-enter h-full min-h-0"}><ReadOnlyProject key={detail.id} id={detail.id} base={base} admin={admin} workspace={detail.snapshot.workspace} /></div>;
  return <main className="case-content-enter flex h-full flex-col items-start justify-center gap-4 p-8"><h1 className="m-0 text-xl font-semibold">{detail.title}</h1><p className="text-sm text-subtext">这个案例保存的是旧版文本记录。可以在案例管理中选择主对话及需要公开的成果，生成新的对话案例。</p>{user?.isAdmin && <Link to="/admin/cases" search={{ project: detail.source_project_id || undefined }} className="text-sm text-primary">选择对话和公开成果</Link>}</main>;
}

export function CaseDetailPage({ caseId, adminPreview = false }: { caseId: string; adminPreview?: boolean }) {
  const base = useCasesBase();
  const { user } = useAuthSession();
  const admin = Boolean(adminPreview && user?.isAdmin);
  const progress = useCaseProgress(base, caseId, admin);
  const cachedCases = queryClient.getQueryData<{ cases: FeaturedCase[] }>(["featured-cases", base, user?.id])?.cases;
  const previewCase = cachedCases?.find((item) => item.id === caseId);
  const detail = useQuery(caseDetailQuery(base, user?.id, caseId, admin));
  const statusQuery = useQuery({
    queryKey: ["featured-case-status", base, user?.id, caseId, admin],
    queryFn: ({ signal }) => caseDetailMeta
      ? caseDetailMeta(base, caseId, admin, signal)
      : caseRequest<FeaturedCase>(base, `${admin ? "admin/cases" : "cases"}/${encodeURIComponent(caseId)}`, { signal }),
    enabled: Boolean(base && user && detail.data),
    retry: false,
    refetchInterval: 30000,
  });
  useEffect(() => {
    if (statusQuery.data && detail.data && statusQuery.data.revision !== detail.data.revision && !detail.isFetching) {
      void detail.refetch();
    }
  }, [statusQuery.data?.revision, detail.data?.revision, detail.isFetching, detail.refetch]);

  const activeError = detail.error ?? (detail.data ? statusQuery.error : null);
  if (detail.data && !activeError) return <CaseTranscript detail={detail.data} admin={admin} fullPage />;

  const retrying = Boolean(detail.isFetching || statusQuery.isFetching);
  const retry = () => {
    if (detail.error || !detail.data) void detail.refetch();
    else if (statusQuery.error) void statusQuery.refetch();
  };

  return (
    <PlatformFrame title={previewCase?.title || "研究过程"}>
      <main className="min-h-0 flex-1 overflow-y-auto px-7 py-8 [@media((max-width:_960px))]:px-5 max-sm:px-4">
        <div className="mx-auto max-w-280">
          <Link to="/cases" className="mb-6 inline-block text-sm text-primary no-underline hover:underline">← 返回精选案例</Link>
          {activeError ? (
            <section role="alert" className="rounded-xl border border-border-variant bg-background p-6">
              {previewCase && <p className="m-0 mb-1 text-xs text-subtext">{previewCase.category} · {previewCase.title}</p>}
              <h1 className="m-0 text-lg font-medium text-text">案例加载失败</h1>
              <p className="mt-2 mb-0 text-sm text-accent-red">{activeError.message}</p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button variant="primary" disabled={retrying} onClick={retry}>
                  {retrying ? <><Spinner /> 正在重试…</> : "重试"}
                </Button>
                <Link to="/cases" className="text-sm text-subtext no-underline hover:text-primary">返回精选案例</Link>
              </div>
            </section>
          ) : (
            <>
              <section role="status" aria-live="polite" className="rounded-xl border border-border-variant bg-background p-6">
                {previewCase ? (
                  <>
                    <p className="m-0 text-xs text-subtext">{previewCase.category} · 真实研究记录</p>
                    <h1 className="product-page-card-title mt-1.5 mb-0 text-text">{previewCase.title}</h1>
                    {previewCase.summary && <p className="mt-2 mb-0 text-sm text-subtext line-clamp-2">{previewCase.summary}</p>}
                  </>
                ) : (
                  <h1 className="product-page-card-title m-0 text-text">正在打开精选案例</h1>
                )}
                <CaseLoadingProgress progress={progress} />
              </section>
              <CaseLoadingSkeleton />
            </>
          )}
        </div>
      </main>
    </PlatformFrame>
  );
}
