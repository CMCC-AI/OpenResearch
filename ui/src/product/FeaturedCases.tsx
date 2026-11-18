import reproductionCover from "../assets/workbench/reproduction.png";
import experimentCover from "../assets/workbench/experiment.png";
import reviewCover from "../assets/workbench/review.png";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isCancelledError, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ChevronRight } from "lucide-react";
import { ReadOnlyProject } from "./ReadOnlyProject";
import { useAuthSession } from "./AuthSession";
import { isCloudWorkspace } from "./CloudWorkspace";
import { PlatformFrame } from "./ProductNav";
import { Button, Spinner } from "../components/ui";
import { ProgressBar } from "../components/ProgressBar";
import { queryClient } from "../queries/client";
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

export function ResearchCases({ fullPage = false }: { fullPage?: boolean }) {
  const base = useCasesBase();
  const { user } = useAuthSession();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["featured-cases", base, user?.id], queryFn: () => caseRequest<{ cases: FeaturedCase[] }>(base, "cases"), enabled: Boolean(base && user), staleTime: 10000, refetchInterval: 30000 });
  const rows = fullPage ? query.data?.cases : query.data?.cases.slice(0, 3);
  const covers = [reproductionCover, experimentCover, reviewCover];
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);
  const attemptRef = useRef(0);
  const openingIdRef = useRef<string | null>(null);
  const activeProgress = useCaseProgress(base, openingId, false);

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
    <div className="research-case-grid grid grid-cols-3 gap-4 max-sm:grid-cols-1">{rows?.map((item, index) => {
      const loadingCard = openingId === item.id;
      const errorForCard = cardError?.id === item.id ? cardError.message : null;
      return <div key={item.id} className="min-w-0 flex flex-col">
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
          className="research-case-card min-w-0 rounded-xl text-text no-underline"
        >
          <div className="research-case-cover mb-3 overflow-hidden rounded-xl border border-border-variant"><img src={covers[index % covers.length]} alt="" className="block h-full w-full object-cover" loading="lazy" /></div>
          <strong className="product-page-card-title mb-1.5 block">{item.title}</strong>
          <span className="product-page-copy mb-2 line-clamp-3 block text-subtext">{item.summary}</span>
          {loadingCard
            ? <CaseLoadingProgress progress={activeProgress} compact />
            : <span className="flex items-center justify-between gap-1 text-sm text-subtext"><span className="truncate">{item.category} · 真实研究记录</span><ArrowRight size={16} className="shrink-0" /></span>}
        </Link>
        {errorForCard && !loadingCard && (
          <div role="alert" className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-border-variant bg-background px-3 py-2 text-xs">
            <span className="min-w-0 truncate text-accent-red">{errorForCard}</span>
            <Button size="small" onClick={() => void openCase(item.id)}>重试</Button>
          </div>
        )}
      </div>;
    })}</div>
  </section>;
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
