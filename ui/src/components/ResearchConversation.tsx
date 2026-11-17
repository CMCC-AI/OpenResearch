import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Circle, CircleDot, FileCheck2, ShieldCheck } from "lucide-react";
import { artifactUrl, getArtifactFileText, interruptChat, type ChatMessage } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { useChatState } from "../queries/chatStore";
import { activePath } from "../transcriptTree";
import { currentDecisions, expertRoles, researchAttention, researchPackageUrl, researchProgress, researchTaskStatus, workflowTone, type ResearchStudy, type ResearchTask, type WorkflowState } from "../research";
import { sha256Hex } from "../product/sha256";
import { Button, Spinner } from "./ui";
import { Md } from "./Md";
import { ResearchPanel } from "./ResearchPanel";
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

function ResearchArtifact({ projectId, studyId, artifact, paths, initiallyOpen = false }: { projectId: string; studyId: string; artifact: ResearchTask["artifacts"][number]; paths: Set<string>; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const readOnly = useReadOnlyWorkspace();
  const path = `research/${studyId}/${artifact.path}`;
  const query = useQuery({
    queryKey: workspaceKey("getArtifactFileText", projectId, studyId, artifact.path, artifact.sha256),
    enabled: open,
    queryFn: async ({ signal }) => {
      const file = await getArtifactFileText(projectId, path, signal);
      if (!file) throw new Error("产物文件不存在，请检查执行记录。");
      if (!file.binary && !file.truncated && await sha256Hex(new TextEncoder().encode(file.content)) !== artifact.sha256) throw new Error("产物内容已变化，与本次验收版本不一致。");
      return file;
    },
    staleTime: Infinity,
  });
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="min-w-0 rounded-md border border-border p-3">
    <summary className="cursor-pointer break-all text-sm text-primary">{artifact.path}</summary>
    <div className="mt-2 flex flex-col gap-2">
      <span className="break-all font-mono text-xs text-subtext">验收 SHA-256：{artifact.sha256}</span>
      {query.isPending ? <p role="status" className="text-sm text-subtext">正在读取产物…</p> : query.error ? <div role="alert" className="text-sm text-accent-red">{query.error.message}<Button size="small" onClick={() => void query.refetch()}>重试</Button></div> : query.data?.binary ? <p className="text-sm text-subtext">此格式通过文件查看。</p> : <div className="file-view-md max-h-96 overflow-y-auto"><Md text={query.data?.content ?? ""} inert={Boolean(readOnly)} resolveImageSrc={src => {
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
      }} /></div>}
      {query.data?.truncated && <p className="m-0 text-xs text-subtext">仅显示部分内容，可下载源文件查看完整内容。</p>}
      {!readOnly && <a className="text-xs text-primary" href={artifactUrl(projectId, path)} download>下载源文件</a>}
    </div>
  </details>;
}

function historicalStatus(task: ResearchTask): { state: WorkflowState; label: string } {
  return { state: task.state === "completed" ? "completed" : "stopped", label: `历史版本 · ${task.state === "completed" ? "已验收" : task.state === "running" ? "执行记录" : "未完成"}` };
}

/** One checklist row per expert task; running rows expand to the live transcript, finished ones stay collapsed. */
function TaskRow({ projectId, study, task, version, renderMessage }: { projectId: string; study: ResearchStudy; task: ResearchTask; version: number; renderMessage: ExpertRenderer }) {
  const readOnly = useReadOnlyWorkspace();
  const current = version === study.plans.at(-1)?.version;
  const [expanded, setExpanded] = useState(current && task.state === "running");
  const [processOpen, setProcessOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const status = current ? researchTaskStatus(study, task) : historicalStatus(task);
  const name = task.agent?.name ?? expertRoles[task.role] ?? task.role;
  const canExpand = Boolean(task.sessionId || task.summary || task.verdict?.status === "blocked" || task.artifacts.length);
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
      {runningLive && task.sessionId && !readOnly && <Button size="small" disabled={cancelling} onClick={() => {
        setCancelling(true); setCancelError(null);
        void interruptChat(task.sessionId!).catch(error => { setCancelError(error instanceof Error ? error.message : String(error)); }).finally(() => { setCancelling(false); void queryClient.invalidateQueries({ queryKey: workspaceKey("researchStudy", study.sessionId) }); });
      }}>{cancelling ? "正在停止…" : "停止该专家"}</Button>}
      {cancelError && <p role="alert" className="m-0 text-sm text-accent-red">停止失败：{cancelError}</p>}
      {task.verdict?.status === "blocked" && <p role="status" className="m-0 text-sm text-accent-amber">需处理：{task.verdict.reasons.join("；")}</p>}
      {task.summary && <div className="min-w-0 rounded-md border border-border bg-background p-3 text-sm text-text"><Md text={task.summary} /></div>}
      {task.artifacts.map(artifact => <ResearchArtifact key={artifact.sha256 + artifact.path} projectId={projectId} studyId={study.id} artifact={artifact} paths={paths} initiallyOpen={runningLive && artifact.path === "writing/review.md"} />)}
      {task.sessionId && (runningLive ? <ExpertTranscript projectId={projectId} sessionId={task.sessionId} renderMessage={renderMessage} /> : <details open={processOpen} onToggle={event => setProcessOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-subtext">专家工作过程</summary>{processOpen && <div className="mt-2"><ExpertTranscript projectId={projectId} sessionId={task.sessionId} renderMessage={renderMessage} /></div>}</details>)}
    </div>}
  </li>;
}

export function ResearchConversation({ projectId, study, renderMessage, onInspect }: { projectId: string; study: ResearchStudy; renderMessage: ExpertRenderer; onInspect?: () => void }) {
  const plan = study.plans.at(-1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const tasks = plan?.tasks ?? [];
  const progress = researchProgress(study);
  // 交付确认通过后，把报告正文直接放进卡片，读者不用再点进具体专家找产物。
  const artifactPaths = plan?.tasks.flatMap(task => task.artifacts.map(artifact => artifact.path)) ?? [];
  const deliveredReport = researchPackageUrl(study)
    ? plan?.tasks.flatMap(task => task.artifacts).find(artifact => artifact.path === "writing/review.md")
      ?? plan?.tasks.flatMap(task => task.artifacts).filter(artifact => artifact.path.endsWith(".md")).sort((a, b) => b.bytes - a.bytes)[0]
    : null;
  return <section aria-label="对话中的工作流" className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4" onClickCapture={event => { if (event.target instanceof Element && event.target.closest("summary")) onInspect?.(); }}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{plan?.workflowSource?.name ?? "科研工作流"}{plan ? ` · 计划 v${plan.version}` : ""}</strong><span role="status" className="text-xs text-subtext">{researchAttention(study)}</span></div>
    {progress.total > 0 && <div className="flex items-center gap-3"><div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="已验收专家任务" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.completed / progress.total * 100}%` }} /></div><span className="shrink-0 text-xs text-subtext">{progress.completed}/{progress.total} 任务已验收</span></div>}
    {study.objective.length > 120 ? <details className="group"><summary className="flex cursor-pointer list-none items-start gap-1.5 text-sm text-subtext [&::-webkit-details-marker]:hidden"><span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap group-open:line-clamp-none">{study.objective}</span><ChevronDown size={14} className="mt-1 shrink-0 transition-transform group-open:-rotate-180" aria-hidden="true" /></summary></details> : <p className="m-0 whitespace-pre-wrap text-sm text-subtext">{study.objective}</p>}
    {deliveredReport && <div className="rounded-lg border border-primary/40 bg-primary-subtle/30 p-3">
      <div className="flex items-center gap-2 text-sm"><FileCheck2 size={15} className="shrink-0 text-primary" aria-hidden="true" /><strong>研究成果</strong><span className="min-w-0 truncate text-xs text-subtext">交付确认已通过 · 报告正文如下，可直接阅读</span></div>
      <div className="mt-2"><ResearchArtifact projectId={projectId} studyId={study.id} artifact={deliveredReport} paths={new Set(artifactPaths)} initiallyOpen /></div>
    </div>}
    <ResearchPanel placement="conversation" sessionId={study.sessionId} disabled={false} />
    {tasks.length ? <ol className="flex flex-col gap-2" data-research-task-list>{tasks.map(task => <TaskRow key={`${plan!.version}:${task.id}:${task.sessionId ?? "pending"}`} projectId={projectId} study={study} task={task} version={plan!.version} renderMessage={renderMessage} />)}</ol> : plan && <p role="status" className="m-0 text-sm text-subtext">{currentDecisions(study).some(decision => decision.gate === "G1" && decision.status === "approved") ? "范围已确认，等待就绪专家开始。" : "请先确认本次研究范围，专家随后按依赖执行。"}</p>}
    {study.plans.length > 1 && <details open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm text-subtext">历史计划（{study.plans.length - 1}）</summary>{historyOpen && <div className="mt-3 flex flex-col gap-3">{study.plans.slice(0, -1).map(previous => <details key={previous.version}><summary className="cursor-pointer text-xs text-subtext">计划 v{previous.version}</summary><ol className="mt-2 flex flex-col gap-2">{previous.tasks.map(task => <TaskRow key={`${previous.version}:${task.id}:${task.sessionId ?? "pending"}`} projectId={projectId} study={study} task={task} version={previous.version} renderMessage={renderMessage} />)}</ol></details>)}</div>}</details>}
  </section>;
}
