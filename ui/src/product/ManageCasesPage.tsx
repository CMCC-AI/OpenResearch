import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { listProjects, listChatSessions, fmtBytes, type ArtifactEntry } from "../api";
import { Button } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { useCasesBase } from "./FeaturedCases";
import { CaseArtifactPicker } from "./CaseArtifactPicker";
import { listCaseArtifacts, selectedCaseArtifacts, artifactSelectionSummary } from "./caseArtifacts";
import { addProjectToCases } from "./addProjectToCases";
import { CASE_COVER_PRESETS, resolveCaseCoverSrc } from "./caseCovers";
import { caseRequest, caseWrite, uploadCaseCover, type FeaturedCase } from "./featuredCasesApi";

const CASE_CATEGORY_PRESETS = ["科研实践", "文献综述", "实验复现", "数据分析", "课题构思"];
const IMAGE_ARTIFACT_RE = /\.(png|jpe?g|webp|svg)$/i;

function collectImageArtifacts(entries: ArtifactEntry[] = []): ArtifactEntry[] {
  const result: ArtifactEntry[] = [];
  for (const entry of entries) {
    if (entry.isDir) result.push(...collectImageArtifacts(entry.children));
    else if (IMAGE_ARTIFACT_RE.test(entry.name)) result.push(entry);
  }
  return result;
}

function defaultCaseSummary(title: string) {
  return title ? `围绕「${title}」的完整研究过程与公开成果记录。` : "";
}

export function ManageCasesPage({ initialProject = "" }: { initialProject?: string }) {
  const base = useCasesBase();
  const { user, canAccessResearch } = useAuthSession();
  const client = useQueryClient();
  const [projectId, setProjectId] = useState(initialProject);
  const [sessionId, setSessionId] = useState("");
  const [artifactPaths, setArtifactPaths] = useState<string[]>([]);
  const [caseTitle, setCaseTitle] = useState("");
  const [caseSummary, setCaseSummary] = useState("");
  const [caseCategory, setCaseCategory] = useState("科研实践");
  const [caseCover, setCaseCover] = useState<string | null>(null);
  const [coverArtifactPath, setCoverArtifactPath] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    revision: number;
    title: string;
    summary: string;
    category: string;
    cover: string | null;
    coverFile: File | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ item: FeaturedCase; kind: "publish" | "delete" } | null>(null);
  const admin = Boolean(user?.isAdmin);

  const projects = useQuery({ queryKey: ["case-source-projects", base, user?.id], queryFn: () => listProjects(), enabled: admin && canAccessResearch });
  const sessions = useQuery({ queryKey: ["case-source-sessions", base, user?.id, projectId], queryFn: () => listChatSessions(projectId), enabled: admin && canAccessResearch && Boolean(projectId) });
  const cases = useQuery({ queryKey: ["case-admin-list", base, user?.id], queryFn: () => caseRequest<{ cases: FeaturedCase[] }>(base, "admin/cases"), enabled: admin && Boolean(base) });
  const artifactRoots = useQuery({ queryKey: ["case-source-artifacts", base, user?.id, projectId, sessionId], queryFn: () => listCaseArtifacts(projectId, sessionId), enabled: admin && canAccessResearch && Boolean(projectId && sessionId) });
  const artifactSelection = useQuery({ queryKey: ["case-selected-artifacts", base, user?.id, projectId, sessionId, [...artifactPaths].sort()], queryFn: () => selectedCaseArtifacts(projectId, sessionId, artifactPaths), enabled: admin && canAccessResearch && Boolean(sessionId && artifactPaths.length) });
  const artifactSummary = artifactSelection.data ? artifactSelectionSummary(artifactSelection.data) : { files: 0, bytes: 0 };

  async function action(task: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setProgress("正在处理…");
    try {
      await task();
      setProgress(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setProgress("");
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["case-admin-list", base] }),
        client.invalidateQueries({ queryKey: ["featured-cases", base] }),
        client.invalidateQueries({ queryKey: ["featured-case", base] }),
      ]);
      setBusy(false);
    }
  }

  function add(project: { id: string; name: string }, existingId?: string, sourceSessionId?: string, paths: string[] = artifactPaths) {
    const meta = {
      title: caseTitle.trim(),
      summary: caseSummary.trim(),
      category: caseCategory.trim() || "科研实践",
      ...(coverFile ? {} : coverArtifactPath ? { coverArtifactPath } : { cover: caseCover }),
      ...(coverFile ? { coverFile } : {}),
    };
    return action(() => addProjectToCases(base, project, setProgress, existingId, sourceSessionId, paths, meta), "已加入案例集，用户可以查看所选范围的对话和文件。");
  }

  const imageArtifacts = artifactSelection.data ? collectImageArtifacts(artifactSelection.data.entries) : [];

  const selectedProject = projects.data?.find((row) => row.id === projectId);
  const mainSessions = sessions.data?.filter((session) => !session.parentSessionId && !session.sideParentSessionId);
  const existing =
    cases.data?.cases.find((item) => item.source_project_id === projectId && (item.source_session_id || "") === sessionId && item.status === "published") ??
    cases.data?.cases.find((item) => item.source_project_id === projectId && (item.source_session_id || "") === sessionId);

  const visibleCases = [
    ...(cases.data?.cases
      .reduce((items, item) => {
        const key = JSON.stringify([item.source_project_id || item.id, item.source_session_id || ""]);
        const previous = items.get(key);
        if (!previous || item.status === "published" || (previous.status !== "published" && item.created_at > previous.created_at)) {
          items.set(key, item);
        }
        return items;
      }, new Map<string, FeaturedCase>())
      .values() ?? []),
  ];

  if (!admin) {
    return (
      <main className="p-6">
        <p role="alert">仅系统管理员可以管理精选案例。</p>
        <Link to="/cases">返回案例集</Link>
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-6 py-7 max-md:px-4">
      <div className="mx-auto flex max-w-290 flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-tight text-text">精选案例管理</h1>
          <p className="m-0 text-sm text-subtext">
            选择主对话及需要公开的成果目录。案例保留完整对话与专家流程，仅复制勾选的成果，用户只能浏览。
          </p>
        </header>

        {error && (
          <p role="alert" className="m-0 rounded-xl border border-danger-notice-border bg-accent-red-subtle px-4 py-3 text-sm text-accent-red">
            {error}
          </p>
        )}
        {progress && (
          <p role="status" className="m-0 rounded-xl border border-accent-green/40 bg-accent-green-subtle/60 px-4 py-3 text-sm text-text">
            {progress}
          </p>
        )}

        {canAccessResearch ? (
          <form
            className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5 shadow-xs"
            onSubmit={(event) => {
              event.preventDefault();
              const project = projects.data?.find((row) => row.id === projectId);
              if (project && sessionId && artifactRoots.isSuccess && (!artifactPaths.length || artifactSelection.isSuccess)) {
                void add(project, existing?.id, sessionId);
              }
            }}
          >
            <div className="flex items-center gap-2 border-b border-border-variant pb-3">
              <h2 className="m-0 text-base font-semibold text-text">导入研究对话为精选案例</h2>
            </div>

            <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                选择项目
                <select
                  required
                  value={projectId}
                  disabled={busy}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    setSessionId("");
                    setArtifactPaths([]);
                    setCaseTitle("");
                    setCaseSummary("");
                    setCaseCategory("科研实践");
                    setCaseCover(null);
                    setCoverArtifactPath(null);
                    setCoverFile(null);
                  }}
                  className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-text"
                >
                  <option value="">请选择自己的项目</option>
                  {projects.data?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>

              {selectedProject && (
                <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                  选择主对话
                  <select
                    required
                    value={sessionId}
                    disabled={busy || !sessions.isSuccess}
                    onChange={(event) => {
                      const nextSessionId = event.target.value;
                      setSessionId(nextSessionId);
                      setArtifactPaths([]);
                      const matchedSession = mainSessions?.find((session) => session.id === nextSessionId);
                      const matchedExisting =
                        cases.data?.cases.find((item) => item.source_project_id === projectId && (item.source_session_id || "") === nextSessionId && item.status === "published") ??
                        cases.data?.cases.find((item) => item.source_project_id === projectId && (item.source_session_id || "") === nextSessionId);
                      if (nextSessionId) {
                        const fallbackTitle = matchedSession?.title || selectedProject.name || "";
                        setCaseTitle(matchedExisting?.title || fallbackTitle);
                        setCaseSummary(matchedExisting?.summary || defaultCaseSummary(fallbackTitle));
                        setCaseCategory(matchedExisting?.category || "科研实践");
                        setCaseCover(matchedExisting?.cover ?? null);
                        setCoverArtifactPath(null);
                        setCoverFile(null);
                      } else {
                        setCaseTitle("");
                        setCaseSummary("");
                        setCaseCategory("科研实践");
                        setCaseCover(null);
                        setCoverArtifactPath(null);
                        setCoverFile(null);
                      }
                    }}
                    className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-text"
                  >
                    <option value="">请选择一个主对话</option>
                    {mainSessions?.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.title || "未命名对话"}
                        {session.busy ? "（运行中）" : ""}
                        {session.archived ? "（已归档）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {selectedProject && sessionId && (
              <div className="flex flex-col gap-3 rounded-xl border border-border-variant bg-surface/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text">展示信息（可自定义）</span>
                  <span className="text-xs text-subtext">
                    {existing?.status === "published" ? "该对话已发布，可在下方列表点击「编辑信息」修改展示内容。" : "将直接展示在精选案例卡片上，支持后续随时修改。"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text">
                    案例标题
                    <input
                      type="text"
                      required
                      maxLength={200}
                      value={caseTitle}
                      disabled={busy || existing?.status === "published"}
                      onChange={(event) => setCaseTitle(event.target.value)}
                      placeholder="输入向用户展示的案例标题"
                      className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal text-text focus:border-primary focus:outline-none disabled:opacity-60"
                    />
                  </label>
                  <div className="flex flex-col gap-1.5">
                    <label className="flex flex-col gap-1.5 text-xs font-medium text-text">
                      研究分类
                      <input
                        type="text"
                        required
                        maxLength={80}
                        value={caseCategory}
                        disabled={busy || existing?.status === "published"}
                        onChange={(event) => setCaseCategory(event.target.value)}
                        placeholder="如：科研实践、文献综述、实验复现"
                        className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal text-text focus:border-primary focus:outline-none disabled:opacity-60"
                      />
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {CASE_CATEGORY_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          disabled={busy || existing?.status === "published"}
                          onClick={() => setCaseCategory(preset)}
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            caseCategory.trim() === preset
                              ? "border-primary bg-primary-subtle font-medium text-primary"
                              : "border-border-variant bg-background text-subtext hover:border-border hover:text-text"
                          } disabled:opacity-50`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <label className="flex flex-col gap-1.5 text-xs font-medium text-text">
                  <span className="flex items-center justify-between gap-2">
                    <span>案例简介</span>
                    <span className="font-normal tabular-nums text-muted">{caseSummary.length} / 4000</span>
                  </span>
                  <textarea
                    rows={3}
                    required
                    maxLength={4000}
                    value={caseSummary}
                    disabled={busy || existing?.status === "published"}
                    onChange={(event) => setCaseSummary(event.target.value)}
                    placeholder="简要介绍研究背景、方法路径与主要成果，帮助其他研究者快速了解案例价值"
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm font-normal text-text focus:border-primary focus:outline-none disabled:opacity-60"
                  />
                </label>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text">封面图（可选，默认按分类自动匹配）</span>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-subtle">
                      <span>{coverFile ? `已选：${coverFile.name}` : "上传本地封面"}</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/svg+xml"
                        disabled={busy || existing?.status === "published"}
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          if (file) {
                            setCoverFile(file);
                            setCoverArtifactPath(null);
                            setCaseCover(null);
                          }
                        }}
                        className="sr-only"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || existing?.status === "published"}
                      onClick={() => {
                        setCaseCover(null);
                        setCoverArtifactPath(null);
                        setCoverFile(null);
                      }}
                      className={`flex h-16 w-24 flex-col items-center justify-center rounded-lg border text-xs transition-colors ${
                        caseCover === null && !coverArtifactPath && !coverFile
                          ? "border-primary bg-primary-subtle font-medium text-primary"
                          : "border-border-variant bg-background text-subtext hover:border-border hover:text-text"
                      } disabled:opacity-50`}
                    >
                      <span>自动匹配</span>
                    </button>
                    {CASE_COVER_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={busy || existing?.status === "published"}
                        onClick={() => {
                          setCaseCover(preset.id);
                          setCoverArtifactPath(null);
                          setCoverFile(null);
                        }}
                        className={`group relative h-16 w-24 overflow-hidden rounded-lg border transition-colors ${
                          caseCover === preset.id && !coverArtifactPath && !coverFile
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-border-variant hover:border-border"
                        } disabled:opacity-50`}
                      >
                        <img src={preset.src} alt={preset.label} className="block h-full w-full object-cover" />
                        <span className="absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-center text-xs text-text">
                          {preset.label}
                        </span>
                      </button>
                    ))}
                  </div>
                  {imageArtifacts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-xs text-subtext">从所选成果图片选取：</span>
                      {imageArtifacts.slice(0, 8).map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          disabled={busy || existing?.status === "published"}
                          onClick={() => {
                            setCoverArtifactPath(entry.path);
                            setCoverFile(null);
                            setCaseCover(null);
                          }}
                          className={`max-w-48 truncate rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            coverArtifactPath === entry.path
                              ? "border-primary bg-primary-subtle font-medium text-primary"
                              : "border-border-variant bg-background text-subtext hover:border-border hover:text-text"
                          }`}
                        >
                          {entry.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {selectedProject && sessions.isPending && (
              <p role="status" className="m-0 text-xs text-subtext">
                正在读取项目对话…
              </p>
            )}
            {sessions.error && <p role="alert" className="m-0 text-xs text-accent-red">{sessions.error.message}</p>}
            {projects.error && <p role="alert" className="m-0 text-xs text-accent-red">{projects.error.message}</p>}
            {sessionId && artifactRoots.isPending && (
              <p role="status" className="m-0 text-xs text-subtext">
                正在读取所选对话的成果目录…
              </p>
            )}
            {artifactRoots.error && <p role="alert" className="m-0 text-xs text-accent-red">{artifactRoots.error.message}</p>}

            {sessionId && artifactRoots.data && (
              <CaseArtifactPicker
                key={`${projectId}/${sessionId}`}
                queryScope={JSON.stringify([base, user?.id])}
                projectId={projectId}
                sessionId={sessionId}
                listing={artifactRoots.data}
                paths={artifactPaths}
                onChange={setArtifactPaths}
                disabled={busy}
              />
            )}

            {sessionId && (
              <p role="status" className="m-0 rounded-lg border border-border-variant bg-surface/60 px-3 py-2 text-xs text-subtext">
                {artifactPaths.length
                  ? artifactSelection.isPending
                    ? "正在统计所选成果…"
                    : `将复制 ${artifactSummary.files.toLocaleString()} 个成果文件，合计 ${fmtBytes(artifactSummary.bytes)}（未去重）。`
                  : "尚未勾选成果；发布后仅包含对话和专家流程。"}
              </p>
            )}
            {artifactSelection.error && (
              <p role="alert" className="m-0 text-xs text-accent-red">
                {artifactSelection.error.message}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-variant pt-4">
              <p className="m-0 max-w-2xl text-xs text-subtext">
                所有登录用户都能浏览发布内容。未勾选的成果、中间数据、项目工作区及原始上传件留在原项目；案例保留材料来源和读取记录。
              </p>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy ||
                  !selectedProject ||
                  !sessionId ||
                  !artifactRoots.isSuccess ||
                  (artifactPaths.length > 0 && !artifactSelection.isSuccess) ||
                  (Boolean(sessionId) && (!sessions.isSuccess || !mainSessions?.some((session) => session.id === sessionId))) ||
                  !cases.data ||
                  existing?.status === "published"
                }
              >
                {busy
                  ? "正在加入…"
                  : existing?.status === "published"
                    ? "已在案例集中"
                    : artifactPaths.length
                      ? "加入案例集"
                      : "仅发布对话记录"}
              </Button>
            </div>
            {projects.isSuccess && !projects.data.length && (
              <p role="status" className="m-0 text-xs text-subtext">
                当前工作空间没有可导入的项目。历史案例副本可在下方管理。
              </p>
            )}
          </form>
        ) : (
          <div className="rounded-xl border border-border bg-background p-4 text-sm text-subtext">
            请从自己的研究工作空间进入，选择项目加入案例集。
          </div>
        )}

        {confirmation && (
          <section
            role="alertdialog"
            aria-modal="false"
            aria-labelledby="case-confirm-title"
            className="flex flex-col gap-3 rounded-xl border border-accent-amber/50 bg-accent-amber-subtle/40 p-5 shadow-xs"
          >
            <div className="flex items-center gap-2">
              <h2 id="case-confirm-title" className="m-0 text-base font-semibold text-text">
                {confirmation.kind === "delete" ? "删除案例草稿" : "发布已保存的案例副本"}
              </h2>
            </div>
            <p className="m-0 text-sm text-subtext">
              {confirmation.kind === "delete"
                ? `将永久删除“${confirmation.item.title}”的草稿及案例文件副本，不影响原项目。此操作无法撤销。`
                : `请先查看“${confirmation.item.title}”的案例副本，确认完整对话和文件适合公开。发布后所有登录用户均可查看；不会重新读取原项目，缺失文件的副本会被拒绝发布。`}
            </p>
            <div className="flex flex-wrap gap-2.5">
              <Button
                variant={confirmation.kind === "delete" ? "danger" : "primary"}
                disabled={busy}
                onClick={() => {
                  const { item, kind } = confirmation;
                  void action(async () => {
                    if (kind === "delete") await caseRequest(base, `admin/cases/${item.id}`, { method: "DELETE" });
                    else await caseWrite(base, `admin/cases/${item.id}/publish`, { revision: item.revision, reviewed: true });
                    setConfirmation(null);
                  }, kind === "delete" ? "案例草稿及文件副本已删除，原项目不受影响。" : "已保存的案例副本已加入案例集。");
                }}
              >
                {confirmation.kind === "delete" ? "确认删除草稿" : "已审核，确认发布"}
              </Button>
              <Button disabled={busy} onClick={() => setConfirmation(null)}>
                取消
              </Button>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-base font-semibold text-text">案例集</h2>
            {cases.data && (
              <span className="inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-xs text-subtext">
                {visibleCases.length} 个案例
              </span>
            )}
          </div>

          {cases.isPending && <p className="text-sm text-muted">正在读取案例…</p>}
          {cases.error && <p role="alert" className="text-sm text-accent-red">{cases.error.message}</p>}

          <div className="flex flex-col gap-3">
            {visibleCases.map((item) => {
              const sourceProject = projects.data?.find((row) => row.id === item.source_project_id);
              const isPublished = item.status === "published";
              const isEditing = editing?.id === item.id;
              return (
                <article
                  key={item.id}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-xs transition-colors hover:border-border-strong"
                >
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 text-base font-medium text-text">{item.title}</h3>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-px text-xs ${
                            isPublished
                              ? "border-accent-green bg-accent-green-subtle text-accent-green"
                              : "border-accent-amber bg-accent-amber-subtle text-accent-amber"
                          }`}
                        >
                          {isPublished ? "已加入案例集" : "未发布的案例副本"}
                        </span>
                        {item.category && (
                          <span className="inline-flex items-center rounded-full bg-primary-subtle px-2 py-px text-xs text-primary">
                            {item.category}
                          </span>
                        )}
                        <span className="inline-flex items-center rounded-full bg-surface px-2 py-px text-xs text-subtext">
                          {item.source_session_id ? `单个对话 · ${sourceProject?.name || "原项目"}` : "整个项目"}
                        </span>
                      </div>
                      {item.summary && (
                        <p className="mb-0 mt-1.5 line-clamp-2 text-xs text-subtext">{item.summary}</p>
                      )}
                      {projects.isSuccess && !sourceProject && (
                        <p className="mb-0 mt-1.5 text-xs text-subtext">
                          当前工作空间未找到原项目，可能已删除或位于其他工作空间。已保存的案例副本仍可查看和管理。
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to="/cases/$caseId"
                        params={{ caseId: item.id }}
                        search={item.status === "draft" ? { preview: true } : {}}
                        className="inline-flex h-7 items-center gap-1 rounded-sm border border-border-variant bg-surface/60 px-2.5 text-xs font-medium text-primary no-underline transition-colors hover:bg-primary-subtle"
                      >
                        查看案例副本
                      </Link>

                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          setConfirmation(null);
                          setEditing(
                            isEditing
                              ? null
                              : {
                                  id: item.id,
                                  revision: item.revision,
                                  title: item.title || "",
                                  summary: item.summary || "",
                                  category: item.category || "科研实践",
                                  cover: item.cover ?? null,
                                  coverFile: null,
                                },
                          );
                        }}
                      >
                        {isEditing ? "收起编辑" : "编辑信息"}
                      </Button>

                      {item.status === "draft" && (
                        <>
                          {sourceProject && canAccessResearch && (
                            <Button
                              size="small"
                              disabled={busy}
                              onClick={() => {
                                setProjectId(sourceProject.id);
                                setSessionId(item.source_session_id || "");
                                setArtifactPaths([]);
                                setCaseTitle(item.title || "");
                                setCaseSummary(item.summary || "");
                                setCaseCategory(item.category || "科研实践");
                                setCaseCover(item.cover ?? null);
                                setCoverArtifactPath(null);
                                setCoverFile(null);
                                setProgress("请在上方选择主对话和要公开的成果，再加入案例集。");
                              }}
                            >
                              {item.source_session_id ? "选择成果并更新" : "创建对话案例"}
                            </Button>
                          )}
                          <Button
                            size="small"
                            variant="primary"
                            disabled={busy}
                            onClick={() => {
                              setEditing(null);
                              setConfirmation({ item, kind: "publish" });
                            }}
                          >
                            发布已保存副本
                          </Button>
                          <Button
                            size="small"
                            variant="danger"
                            disabled={busy}
                            onClick={() => {
                              setEditing(null);
                              setConfirmation({ item, kind: "delete" });
                            }}
                          >
                            删除草稿
                          </Button>
                        </>
                      )}

                      {isPublished && (
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() => {
                            setEditing(null);
                            void action(
                              () => caseWrite(base, `admin/cases/${item.id}/unpublish`, { revision: item.revision }),
                              "已从案例集移除，原项目仍保留。",
                            );
                          }}
                        >
                          移出案例集
                        </Button>
                      )}
                    </div>
                  </div>

                  {isEditing && editing && (
                    <div className="flex flex-col gap-3 rounded-lg border border-border-variant bg-surface/50 p-4">
                      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                        <label className="flex flex-col gap-1.5 text-xs font-medium text-text">
                          案例标题
                          <input
                            type="text"
                            maxLength={200}
                            value={editing.title}
                            disabled={busy}
                            onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                            placeholder="输入案例标题"
                            className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal text-text focus:border-primary focus:outline-none"
                          />
                        </label>
                        <div className="flex flex-col gap-1.5">
                          <label className="flex flex-col gap-1.5 text-xs font-medium text-text">
                            研究分类
                            <input
                              type="text"
                              maxLength={80}
                              value={editing.category}
                              disabled={busy}
                              onChange={(event) => setEditing({ ...editing, category: event.target.value })}
                              placeholder="如：科研实践、文献综述"
                              className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal text-text focus:border-primary focus:outline-none"
                            />
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {CASE_CATEGORY_PRESETS.map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                disabled={busy}
                                onClick={() => setEditing({ ...editing, category: preset })}
                                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                                  editing.category.trim() === preset
                                    ? "border-primary bg-primary-subtle font-medium text-primary"
                                    : "border-border-variant bg-background text-subtext hover:border-border hover:text-text"
                                }`}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <label className="flex flex-col gap-1.5 text-xs font-medium text-text">
                        <span className="flex items-center justify-between gap-2">
                          <span>案例简介</span>
                          <span className="font-normal tabular-nums text-muted">{editing.summary.length} / 4000</span>
                        </span>
                        <textarea
                          rows={3}
                          maxLength={4000}
                          value={editing.summary}
                          disabled={busy}
                          onChange={(event) => setEditing({ ...editing, summary: event.target.value })}
                          placeholder="简要介绍研究背景、方法与成果"
                          className="rounded-md border border-border bg-background px-3 py-2 text-sm font-normal text-text focus:border-primary focus:outline-none"
                        />
                      </label>
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-text">
                            封面图
                            {editing.cover?.startsWith("asset:") && !editing.coverFile ? "（当前为自定义/成果图片）" : ""}
                          </span>
                          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-subtle">
                            <span>{editing.coverFile ? `已选：${editing.coverFile.name}` : "上传新封面"}</span>
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/svg+xml"
                              disabled={busy}
                              onChange={(event) => {
                                const file = event.target.files?.[0] ?? null;
                                if (file) setEditing({ ...editing, coverFile: file });
                              }}
                              className="sr-only"
                            />
                          </label>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setEditing({ ...editing, cover: null, coverFile: null })}
                            className={`flex h-14 w-22 items-center justify-center rounded-lg border text-xs transition-colors ${
                              editing.cover === null && !editing.coverFile
                                ? "border-primary bg-primary-subtle font-medium text-primary"
                                : "border-border-variant bg-background text-subtext hover:border-border hover:text-text"
                            }`}
                          >
                            自动匹配
                          </button>
                          {CASE_COVER_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              disabled={busy}
                              onClick={() => setEditing({ ...editing, cover: preset.id, coverFile: null })}
                              className={`relative h-14 w-22 overflow-hidden rounded-lg border transition-colors ${
                                editing.cover === preset.id && !editing.coverFile
                                  ? "border-primary ring-2 ring-primary/30"
                                  : "border-border-variant hover:border-border"
                              }`}
                            >
                              <img src={preset.src} alt={preset.label} className="block h-full w-full object-cover" />
                              <span className="absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-center text-xs text-text">
                                {preset.label}
                              </span>
                            </button>
                          ))}
                          {editing.cover?.startsWith("asset:") && !editing.coverFile && (
                            <div className="relative h-14 w-22 overflow-hidden rounded-lg border border-primary ring-2 ring-primary/30">
                              <img
                                src={resolveCaseCoverSrc(base, { id: editing.id, cover: editing.cover, category: editing.category, title: editing.title }, 0, true)}
                                alt="当前封面"
                                className="block h-full w-full object-cover"
                              />
                              <span className="absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-center text-xs text-primary">
                                当前图片
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button size="small" disabled={busy} onClick={() => setEditing(null)}>
                          取消
                        </Button>
                        <Button
                          size="small"
                          variant="primary"
                          disabled={busy || !editing.title.trim() || !editing.summary.trim() || !editing.category.trim()}
                          onClick={() =>
                            void action(async () => {
                              let nextCover = editing.cover;
                              let nextRevision = editing.revision;
                              if (editing.coverFile) {
                                const uploaded = await uploadCaseCover(base, editing.id, editing.coverFile, nextRevision);
                                nextCover = uploaded.cover;
                                nextRevision += 1;
                              }
                              await caseWrite(base, `admin/cases/${editing.id}/meta`, {
                                revision: nextRevision,
                                title: editing.title.trim(),
                                summary: editing.summary.trim(),
                                category: editing.category.trim() || "科研实践",
                                cover: nextCover,
                              });
                              setEditing(null);
                            }, "已更新案例标题与描述信息。")
                          }
                        >
                          保存修改
                        </Button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          {cases.data && !cases.data.cases.length && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background/60 py-12 text-center">
              <p className="m-0 text-sm text-subtext">案例集还没有内容，从上方选择项目或对话加入。</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
