import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Circle, CircleDot, ShieldCheck } from "lucide-react";
import { artifactUrl, getArtifactFileText, interruptChat, type ChatMessage } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { useChatState } from "../queries/chatStore";
import { activePath } from "../transcriptTree";
import { currentDecisions, expertRoles, researchAttention, researchProgress, researchTaskStatus, resolveArtifactLinkPath, workflowTone, type ResearchStudy, type ResearchTask, type WorkflowState } from "../research";
import { sha256Hex } from "../product/sha256";
import type { TabOpenIntent } from "../tabPreview";
import { Button, Spinner } from "./ui";
import { Md } from "./Md";
import { ResearchPanel } from "./ResearchPanel";
import { HumanSubmitForm } from "./ResearchWorkflow";
import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";

type ExpertRenderer = (message: ChatMessage, sessionId: string, running: boolean) => ReactNode;

function StateIcon({ state }: { state: WorkflowState }) {
  const Icon = state === "completed" ? CheckCircle2 : state === "running" ? CircleDot : state === "blocked" ? ShieldCheck : Circle;
  return <Icon size={16} className={`shrink-0 ${state === "running" ? "animate-pulse" : ""}`} aria-hidden="true" />;
}

/** Reads original, persisted child messages; SSE updates the existing query cache. */
function ExpertTranscript({ projectId, sessionId, renderMessage }: { projectId: string; sessionId: string; renderMessage: ExpertRenderer }) {
  const [state, , history] = useChatState(projectId, sessionId);
  const messages = activePath(state.messagesBySession[sessionId] ?? [], state.activeLeafBySession[sessionId]).filter(message => message.role === "assistant");
  if (history.isPending) return <p role="status" className="flex items-center gap-2 text-sm text-subtext"><Spinner />正在读取专家记录…</p>;
  if (history.error) return <div role="alert" className="text-sm text-accent-red">专家记录读取失败<Button size="small" onClick={() => void history.refetch()}>重试</Button></div>;
  return <div className="flex flex-col gap-4">{messages.length ? messages.map(message => <div key={message.id} data-expert-message-id={message.id}>{renderMessage(message, sessionId, state.busySessions.has(sessionId) && message === messages.at(-1))}</div>) : <p role="status" className="m-0 text-sm text-subtext">等待专家上报进展。</p>}</div>;
}

/** 产物文件按需读取，打开折叠时才请求，并校验内容与验收哈希一致。 */
function useArtifactText(projectId: string, studyId: string, artifact: ResearchTask["artifacts"][number], enabled: boolean) {
  return useQuery({
    queryKey: workspaceKey("getArtifactFileText", projectId, studyId, artifact.path, artifact.sha256),
    enabled,
    queryFn: async ({ signal }) => {
      const file = await getArtifactFileText(projectId, `research/${studyId}/${artifact.path}`, signal);
      if (!file) throw new Error("产物文件不存在，请检查执行记录。");
      if (!file.binary && !file.truncated && await sha256Hex(new TextEncoder().encode(file.content)) !== artifact.sha256) throw new Error("产物内容已变化，与本次验收版本不一致。");
      return file;
    },
    staleTime: Infinity,
  });
}

/** 报告内图片只解析到本次验收登记过的产物路径，外链原样放行。 */
function artifactImageResolver(projectId: string, studyId: string, artifact: ResearchTask["artifacts"][number], paths: Set<string>) {
  return (src: string) => {
    if (/^https?:\/\//i.test(src)) return [{ url: src, resolveAsset: () => null }];
    let candidate = src;
    try { candidate = decodeURIComponent(src); } catch { /* Keep literal registered paths. */ }
    if (!paths.has(candidate)) {
      const base = artifact.path.split("/").slice(0, -1);
      for (const segment of candidate.split("/")) {
        if (segment === "..") { if (!base.length) return []; base.pop(); }
        else if (segment && segment !== ".") base.push(segment);
      }
      candidate = base.join("/");
    }
    return paths.has(candidate) ? [{ url: artifactUrl(projectId, `research/${studyId}/${candidate}`), resolveAsset: () => null }] : [];
  };
}

/** 产物正文里的相对链接解析到验收登记过的产物路径；命中时返回 `artifacts/` 前缀的
 * 研究产物路径交给文件面板，未命中的链接保持纯文本。 */
function artifactLinkResolver(studyId: string, currentPath: string, paths: Set<string>) {
  return (href: string): string | null => {
    const resolved = resolveArtifactLinkPath(href, currentPath, paths);
    return resolved ? `artifacts/research/${studyId}/${resolved}` : null;
  };
}

function ArtifactBody({ projectId, studyId, artifact, paths, query, contentClassName, onOpenArtifactFile }: { projectId: string; studyId: string; artifact: ResearchTask["artifacts"][number]; paths: Set<string>; query: ReturnType<typeof useArtifactText>; contentClassName?: string; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void }) {
  const readOnly = useReadOnlyWorkspace();
  if (query.isPending) return <p role="status" className="text-sm text-subtext">正在读取产物…</p>;
  if (query.error) return <div role="alert" className="text-sm text-accent-red">{query.error.message}<Button size="small" onClick={() => void query.refetch()}>重试</Button></div>;
  if (query.data?.binary) return <p className="text-sm text-subtext">此格式通过文件查看。</p>;
  return <>
    <div className={`file-view-md min-w-0${contentClassName ? ` ${contentClassName}` : ""}`}><Md text={query.data?.content ?? ""} inert={Boolean(readOnly)} resolveImageSrc={artifactImageResolver(projectId, studyId, artifact, paths)} onOpenFile={onOpenArtifactFile ? (path, _line, _exp, _ref, intent) => onOpenArtifactFile(path, intent) : undefined} resolveFilePath={onOpenArtifactFile ? artifactLinkResolver(studyId, artifact.path, paths) : undefined} /></div>
    {query.data?.truncated && <p className="m-0 text-xs text-subtext">仅显示部分内容，可下载源文件查看完整内容。</p>}
  </>;
}

function ResearchArtifact({ projectId, studyId, artifact, paths, onOpenArtifactFile }: { projectId: string; studyId: string; artifact: ResearchTask["artifacts"][number]; paths: Set<string>; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void }) {
  const [open, setOpen] = useState(false);
  const readOnly = useReadOnlyWorkspace();
  const path = `research/${studyId}/${artifact.path}`;
  const query = useArtifactText(projectId, studyId, artifact, open);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="min-w-0 rounded-md border border-border p-3">
    <summary className="cursor-pointer break-all text-sm text-primary">{artifact.path}</summary>
    <div className="mt-2 flex flex-col gap-2">
      <span className="break-all font-mono text-xs text-subtext">验收 SHA-256：{artifact.sha256}</span>
      <ArtifactBody projectId={projectId} studyId={studyId} artifact={artifact} paths={paths} query={query} contentClassName="max-h-96 overflow-y-auto" onOpenArtifactFile={onOpenArtifactFile} />
      {!readOnly && <a className="text-xs text-primary" href={artifactUrl(projectId, path)} download>下载源文件</a>}
    </div>
  </details>;
}

function historicalStatus(task: ResearchTask): { state: WorkflowState; label: string } {
  return { state: task.state === "completed" ? "completed" : "stopped", label: `历史版本 · ${task.state === "completed" ? "已验收" : task.state === "running" ? "执行记录" : "未完成"}` };
}

/** One checklist row per expert task; running rows expand to the live transcript, finished ones stay collapsed. */
function TaskRow({ projectId, study, task, version, renderMessage, onOpenArtifactFile }: { projectId: string; study: ResearchStudy; task: ResearchTask; version: number; renderMessage: ExpertRenderer; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void }) {
  const readOnly = useReadOnlyWorkspace();
  const current = version === study.plans.at(-1)?.version;
  // 等待主理人的人工任务直接在对话里展开提交框；历史计划或已结束的研究不再开放提交。
  const humanAwaiting = current && task.kind === "human" && task.state === "awaiting" && study.status !== "stopped";
  const [expanded, setExpanded] = useState(current && (task.state === "running" || Boolean(humanAwaiting)));
  const [processOpen, setProcessOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const status = current ? researchTaskStatus(study, task) : historicalStatus(task);
  const name = task.agent?.name ?? expertRoles[task.role] ?? (task.role || (task.kind === "human" ? "人工任务" : task.id));
  const canExpand = Boolean(humanAwaiting || task.sessionId || task.summary || task.verdict?.status === "blocked" || task.artifacts.length);
  const open = expanded && canExpand;
  const runningLive = current && task.state === "running";
  const paths = new Set(study.plans.find(plan => plan.version === version)?.tasks.flatMap(item => item.artifacts.map(file => file.path)) ?? []);
  const counters = `${(task.reworkCount ?? 0) > 0 ? ` · 返工 ${task.reworkCount} 轮` : ""}${(task.attempts ?? 0) > 0 ? ` · 重试 ${task.attempts} 次` : ""}`;
  const header = <>
    <StateIcon state={status.state} />
    <strong className="min-w-0 truncate text-sm font-medium">{name}</strong>
    <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs" role="status">{status.label}{counters}<ChevronDown size={14} className={`transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" /></span>
  </>;
  return <li data-research-task-id={task.id} aria-label={`专家任务 · ${name}`} className={`min-w-0 rounded-lg border ${workflowTone[status.state]}`}>
    {canExpand ? <button type="button" aria-expanded={open} onClick={() => setExpanded(value => !value)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start focus-visible:outline-2 focus-visible:outline-primary">{header}</button> : <div className="flex w-full items-center gap-2 px-3 py-2">{header}</div>}
    {open && <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
      <p className="m-0 whitespace-pre-wrap text-sm text-subtext">{task.brief}</p>
      {humanAwaiting && !readOnly && <HumanSubmitForm study={study} task={task} />}
      {runningLive && task.sessionId && !readOnly && <Button size="small" disabled={cancelling} onClick={() => {
        setCancelling(true); setCancelError(null);
        void interruptChat(task.sessionId!).catch(error => { setCancelError(error instanceof Error ? error.message : String(error)); }).finally(() => { setCancelling(false); void queryClient.invalidateQueries({ queryKey: workspaceKey("researchStudy", study.sessionId) }); });
      }}>{cancelling ? "正在停止…" : "停止该专家"}</Button>}
      {cancelError && <p role="alert" className="m-0 text-sm text-accent-red">停止失败：{cancelError}</p>}
      {task.verdict?.status === "blocked" && <p role="status" className="m-0 text-sm text-accent-amber">需处理：{task.verdict.reasons.join("；")}</p>}
      {task.summary && <div className="min-w-0 rounded-md border border-border bg-background p-3 text-sm text-text"><Md text={task.summary} /></div>}
      {task.artifacts.map(artifact => <ResearchArtifact key={artifact.sha256 + artifact.path} projectId={projectId} studyId={study.id} artifact={artifact} paths={paths} onOpenArtifactFile={onOpenArtifactFile} />)}
      {task.sessionId && (runningLive ? <ExpertTranscript projectId={projectId} sessionId={task.sessionId} renderMessage={renderMessage} /> : <details open={processOpen} onToggle={event => setProcessOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-subtext">专家工作过程</summary>{processOpen && <div className="mt-2"><ExpertTranscript projectId={projectId} sessionId={task.sessionId} renderMessage={renderMessage} /></div>}</details>)}
    </div>}
  </li>;
}

export function ResearchConversation({ projectId, study, renderMessage, onInspect, onOpenArtifactFile }: { projectId: string; study: ResearchStudy; renderMessage: ExpertRenderer; onInspect?: () => void; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void }) {
  const plan = study.plans.at(-1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const tasks = plan?.tasks ?? [];
  const progress = researchProgress(study);
  return <section aria-label="对话中的工作流" className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4" onClickCapture={event => { if (event.target instanceof Element && event.target.closest("summary")) onInspect?.(); }}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{plan?.workflowSource?.name ?? "科研工作流"}{plan ? ` · 计划 v${plan.version}` : ""}</strong><span role="status" className="text-xs text-subtext">{researchAttention(study)}</span></div>
    {progress.total > 0 && <div className="flex items-center gap-3"><div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="已验收专家任务" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.completed / progress.total * 100}%` }} /></div><span className="shrink-0 text-xs text-subtext">{progress.completed}/{progress.total} 任务已验收</span></div>}
    {study.objective.length > 120 ? <details className="group"><summary className="flex cursor-pointer list-none items-start gap-1.5 text-sm text-subtext [&::-webkit-details-marker]:hidden"><span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap group-open:line-clamp-none">{study.objective}</span><ChevronDown size={14} className="mt-1 shrink-0 transition-transform group-open:-rotate-180" aria-hidden="true" /></summary></details> : <p className="m-0 whitespace-pre-wrap text-sm text-subtext">{study.objective}</p>}
    <ResearchPanel placement="conversation" sessionId={study.sessionId} disabled={false} />
    {tasks.length ? <ol className="flex flex-col gap-2" data-research-task-list>{tasks.map(task => <TaskRow key={`${plan!.version}:${task.id}:${task.sessionId ?? "pending"}`} projectId={projectId} study={study} task={task} version={plan!.version} renderMessage={renderMessage} onOpenArtifactFile={onOpenArtifactFile} />)}</ol> : plan && <p role="status" className="m-0 text-sm text-subtext">{currentDecisions(study).some(decision => decision.gate === "G1" && decision.status === "approved") ? "范围已确认，等待就绪专家开始。" : "请先确认本次研究范围，专家随后按依赖执行。"}</p>}
    {study.plans.length > 1 && <details open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm text-subtext">历史计划（{study.plans.length - 1}）</summary>{historyOpen && <div className="mt-3 flex flex-col gap-3">{study.plans.slice(0, -1).map(previous => <details key={previous.version}><summary className="cursor-pointer text-xs text-subtext">计划 v{previous.version}</summary><ol className="mt-2 flex flex-col gap-2">{previous.tasks.map(task => <TaskRow key={`${previous.version}:${task.id}:${task.sessionId ?? "pending"}`} projectId={projectId} study={study} task={task} version={previous.version} renderMessage={renderMessage} onOpenArtifactFile={onOpenArtifactFile} />)}</ol></details>)}</div>}</details>}
  </section>;
}
