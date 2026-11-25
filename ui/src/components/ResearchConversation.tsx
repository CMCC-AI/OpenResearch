import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Circle, CircleDot, CircleStop, FileText, ShieldCheck } from "lucide-react";
import { artifactUrl, deliveryArtifactUrl, getArtifactFileText, getDeliveryArtifactFileText, interruptChat, reopenHumanTask, type ChatMessage } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { useChatState } from "../queries/chatStore";
import { activePath } from "../transcriptTree";
import { currentDecisions, expertRoles, researchArtifactLabel, researchAttention, researchDeliveryArchive, researchDuration, researchFileSize, researchOutcome, researchPackageUrl, researchProcessSummary, researchProgress, researchReviewSummary, researchTaskStatus, researchWorkflowMode, resolveArtifactLinkPath, workflowTone, type ResearchMetrics, type ResearchStudy, type ResearchTask, type WorkflowState } from "../research";
import { sha256Hex } from "../product/sha256";
import type { TabOpenIntent } from "../tabPreview";
import { Button, Spinner } from "./ui";
import { Md } from "./Md";
import { ResearchPanel } from "./ResearchPanel";
import { HumanSubmitForm } from "./ResearchWorkflow";
import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";

type ExpertRenderer = (message: ChatMessage, sessionId: string, running: boolean) => ReactNode;
/** 已确认交付的读取源；有值时所有产物字节都从封存归档取，不读工作区。 */
type DeliverySource = { studyId: string; archive: string } | null;

function StateIcon({ state }: { state: WorkflowState }) {
  const Icon = state === "completed" ? CheckCircle2 : state === "running" ? CircleDot : state === "blocked" ? ShieldCheck : Circle;
  return <Icon size={16} className={`shrink-0 ${state === "running" ? "animate-pulse motion-reduce:animate-none" : ""}`} aria-hidden="true" />;
}

/** Reads original, persisted child messages; SSE updates the existing query cache.
 * `live` marks a task the plan still calls running, so its last call keeps its
 * in-progress treatment even when the child session's busy flag lags behind. */
function ExpertTranscript({ projectId, sessionId, renderMessage, live = false }: { projectId: string; sessionId: string; renderMessage: ExpertRenderer; live?: boolean }) {
  const [state, , history] = useChatState(projectId, sessionId);
  const messages = activePath(state.messagesBySession[sessionId] ?? [], state.activeLeafBySession[sessionId]).filter(message => message.role === "assistant");
  if (history.isPending) return <p role="status" className="flex items-center gap-2 text-sm text-subtext"><Spinner />正在读取专家记录…</p>;
  if (history.error) return <div role="alert" className="text-sm text-accent-red">专家记录读取失败<Button size="small" onClick={() => void history.refetch()}>重试</Button></div>;
  return <div className="flex flex-col gap-4">{messages.length ? messages.map(message => <div key={message.id} data-expert-message-id={message.id}>{renderMessage(message, sessionId, (live || state.busySessions.has(sessionId)) && message === messages.at(-1))}</div>) : <p role="status" className="m-0 text-sm text-subtext">等待专家上报进展。</p>}</div>;
}

/** 产物文件按需读取，打开折叠时才请求，并校验内容与验收哈希一致。 */
function useArtifactText(projectId: string, studyId: string, artifact: ResearchTask["artifacts"][number], enabled: boolean, delivery?: DeliverySource) {
  return useQuery({
    queryKey: workspaceKey("getArtifactFileText", delivery ? "delivered" : "live", projectId, studyId, artifact.path, artifact.sha256, delivery?.archive ?? ""),
    enabled,
    queryFn: async ({ signal }) => {
      const file = delivery
        ? await getDeliveryArtifactFileText(delivery.studyId, artifact.path, delivery.archive, signal)
        : await getArtifactFileText(projectId, `research/${studyId}/${artifact.path}`, signal);
      if (!file) throw new Error(delivery ? "已确认交付中找不到该文件。" : "产物文件不存在，请检查执行记录。");
      if (!file.binary && !file.truncated && await sha256Hex(new TextEncoder().encode(file.content)) !== artifact.sha256) throw new Error("产物内容已变化，与本次验收版本不一致。");
      return file;
    },
    staleTime: Infinity,
  });
}

/** 报告内图片只解析到本次验收登记过的产物路径，外链原样放行。 */
function artifactImageResolver(projectId: string, studyId: string, artifact: ResearchTask["artifacts"][number], paths: Set<string>, delivery?: DeliverySource) {
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
    return paths.has(candidate) ? [{ url: delivery ? deliveryArtifactUrl(delivery.studyId, candidate, delivery.archive) : artifactUrl(projectId, `research/${studyId}/${candidate}`), resolveAsset: () => null }] : [];
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

function ArtifactBody({ projectId, studyId, artifact, paths, query, contentClassName, onOpenArtifactFile, delivery }: { projectId: string; studyId: string; artifact: ResearchTask["artifacts"][number]; paths: Set<string>; query: ReturnType<typeof useArtifactText>; contentClassName?: string; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void; delivery?: DeliverySource }) {
  const readOnly = useReadOnlyWorkspace();
  if (query.isPending) return <p role="status" className="text-sm text-subtext">正在读取产物…</p>;
  if (query.error) return <div role="alert" className="text-sm text-accent-red">{query.error.message}<Button size="small" onClick={() => void query.refetch()}>重试</Button></div>;
  if (query.data?.binary) return <p className="text-sm text-subtext">此格式通过文件查看。</p>;
  return <>
    <div className={`file-view-md min-w-0${contentClassName ? ` ${contentClassName}` : ""}`}><Md text={query.data?.content ?? ""} inert={Boolean(readOnly)} resolveImageSrc={artifactImageResolver(projectId, studyId, artifact, paths, delivery)} onOpenFile={!delivery && onOpenArtifactFile ? (path, _line, _exp, _ref, intent) => onOpenArtifactFile(path, intent) : undefined} resolveFilePath={!delivery && onOpenArtifactFile ? artifactLinkResolver(studyId, artifact.path, paths) : undefined} /></div>
    {query.data?.truncated && <p className="m-0 text-xs text-subtext">仅显示部分内容，可下载源文件查看完整内容。</p>}
  </>;
}

function taskDisplayName(task: ResearchTask): string {
  if (task.agent?.name) return task.agent.name;
  if (task.role && expertRoles[task.role]) return expertRoles[task.role];
  if (task.kind === "route") return "条件分流";
  if (task.kind === "foreach") return "逐项处理";
  if (task.kind === "human") return "人工任务";
  if (task.kind === "experiment") return "实验执行";
  if (task.kind === "wait") return "等待事件";
  return task.role || task.id;
}

/** 产物卡片：以研究里的角色命名文件，路径和指纹放在次要位置，默认不打扰阅读。 */
function ResearchArtifact({ projectId, studyId, artifact, paths, onOpenArtifactFile, defaultOpen = false, label, deliverable = true, delivery }: { projectId: string; studyId: string; artifact: ResearchTask["artifacts"][number]; paths: Set<string>; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void; defaultOpen?: boolean; label?: string; deliverable?: boolean; delivery?: DeliverySource }) {
  const [open, setOpen] = useState(defaultOpen);
  const readOnly = useReadOnlyWorkspace();
  const path = `research/${studyId}/${artifact.path}`;
  const query = useArtifactText(projectId, studyId, artifact, open, delivery);
  const verified = Boolean(query.data && !query.data.binary && !query.data.truncated);
  const meta = [artifact.path, researchFileSize(artifact.bytes)].filter(Boolean).join(" · ");
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} data-artifact-path={artifact.path} className="min-w-0 rounded-md border border-border bg-background">
    <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
      <FileText size={14} className="shrink-0 self-center text-subtext" aria-hidden="true" />
      <span className="text-sm text-text">{label ?? researchArtifactLabel(artifact.path)}</span>
      {!deliverable && <span className="rounded bg-surface px-1.5 py-0.5 text-xs text-subtext">过程记录</span>}
      <span className="min-w-0 break-all text-xs text-subtext">{meta}</span>
      <ChevronDown size={14} className={`ms-auto shrink-0 self-center text-subtext transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
    </summary>
    <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
      <ArtifactBody projectId={projectId} studyId={studyId} artifact={artifact} paths={paths} query={query} contentClassName="max-h-96 overflow-y-auto" onOpenArtifactFile={onOpenArtifactFile} delivery={delivery} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {onOpenArtifactFile && !delivery && <button type="button" className="text-primary" onClick={() => onOpenArtifactFile(`artifacts/${path}`, "preview")}>在文件中打开</button>}
        {!readOnly && <a className="text-primary" href={delivery ? deliveryArtifactUrl(delivery.studyId, artifact.path, delivery.archive) : artifactUrl(projectId, path)} download>下载{delivery ? "已确认版本" : "源文件"}</a>}
        <details className="min-w-0">
          <summary className="cursor-pointer text-subtext">文件指纹</summary>
          <p className="mt-1 text-xs text-subtext">{delivery ? "用来确认读取的文件与已确认交付完全一致。" : "用来确认打开的文件与验收版本完全一致，日常阅读无需关注。"}</p>
          <code className="mt-1 block break-all font-mono text-xs text-subtext">{artifact.sha256}</code>
          {verified && <p className="mt-1 text-xs text-accent-green">已核对：内容与验收版本一致。</p>}
        </details>
      </div>
    </div>
  </details>;
}

/** 结论正文默认只露开头，长报告可展开；读取时仍会校验内容与验收版本一致。 */
function ConclusionCard({ projectId, study, file, paths, onOpenArtifactFile, delivery }: { projectId: string; study: ResearchStudy; file: NonNullable<ReturnType<typeof researchOutcome>["conclusion"]>; paths: Set<string>; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void; delivery?: DeliverySource }) {
  const [expanded, setExpanded] = useState(false);
  const readOnly = useReadOnlyWorkspace();
  const path = `research/${study.id}/${file.artifact.path}`;
  const query = useArtifactText(projectId, study.id, file.artifact, true, delivery);
  const content = query.data?.content ?? "";
  const long = !query.data?.binary && (content.length > 600 || content.split("\n").length > 12);
  const clipped = long && !expanded;
  return <div className="flex min-w-0 flex-col gap-2" data-outcome-conclusion>
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <strong className="text-base text-text">{file.label}</strong>
      <span className="text-xs text-subtext">{taskDisplayName(file.task)}{researchFileSize(file.artifact.bytes) ? ` · ${researchFileSize(file.artifact.bytes)}` : ""}</span>
      <span className="ms-auto flex items-center gap-3 text-xs">
        {onOpenArtifactFile && !delivery && <button type="button" className="text-primary" onClick={() => onOpenArtifactFile(`artifacts/research/${study.id}/${file.artifact.path}`, "preview")}>打开文件</button>}
        {!readOnly && <a className="text-primary" href={delivery ? deliveryArtifactUrl(delivery.studyId, file.artifact.path, delivery.archive) : artifactUrl(projectId, path)} download>下载{delivery ? "已确认版本" : ""}</a>}
      </span>
    </div>
    <div className={clipped ? "relative max-h-60 overflow-hidden" : ""}>
      <ArtifactBody projectId={projectId} studyId={study.id} artifact={file.artifact} paths={paths} query={query} onOpenArtifactFile={onOpenArtifactFile} delivery={delivery} />
      {clipped && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-background to-transparent" aria-hidden="true" />}
    </div>
    {long && <button type="button" className="self-start text-xs text-primary" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开全文"}</button>}
  </div>;
}

/** 已登记的证据声明就是研究结论本身，附上支撑类型和来源，避免让用户去读内部报告。 */
function ClaimsConclusion({ study }: { study: ResearchStudy }) {
  const [showAll, setShowAll] = useState(false);
  const claims = showAll ? study.claims : study.claims.slice(0, 3);
  const support = (claim: ResearchStudy["claims"][number]) => claim.support === "experiment" ? "有实验证据" : claim.support === "paper" ? "有论文原文依据" : "推测性结论";
  return <div className="flex flex-col gap-2">
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-outcome-claims>
      {claims.map((claim) => <li key={claim.id} className="min-w-0">
        <p className="m-0 text-sm text-text">{claim.text}</p>
        <p className="m-0 break-words text-xs text-subtext">{support(claim)} · {claim.source}{claim.location ? ` · ${claim.location}` : ""}</p>
      </li>)}
    </ul>
    {study.claims.length > 3 && <button type="button" className="self-start text-xs text-primary" onClick={() => setShowAll(value => !value)}>{showAll ? "收起" : `查看全部 ${study.claims.length} 条结论`}</button>}
  </div>;
}

/** 交付确认后的研究结果：先结论，再过程可信度，最后才是文件和原始摘要。 */
function ResearchOutcome({ projectId, study, metrics, onOpenArtifactFile }: { projectId: string; study: ResearchStudy; metrics?: ResearchMetrics | null; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void }) {
  const [filesOpen, setFilesOpen] = useState(false);
  const outcome = researchOutcome(study);
  const archive = researchDeliveryArchive(study);
  const delivery: DeliverySource = archive ? { studyId: study.id, archive } : null;
  const summaries = outcome.tasks.filter((task) => task.state === "completed" && task.summary);
  const leaves = outcome.tasks.filter((task) => task.state === "completed" && (task.summary || task.artifacts.length) && !outcome.tasks.some((candidate) => candidate.dependsOn.includes(task.id)));
  const conclusionTask = leaves[0] ?? summaries[0] ?? null;
  const paths = new Set(outcome.tasks.flatMap((task) => task.artifacts.map((artifact) => artifact.path)));
  const otherFiles = outcome.files.filter((file) => file !== outcome.conclusion);
  const otherDeliverables = outcome.deliverables.filter((file) => file !== outcome.conclusion);
  const counts = outcome.counts;
  const facts = [
    metrics?.activeDurationMs != null ? researchDuration(metrics) : null,
    `${counts.completed} 个步骤完成`,
    counts.skipped ? `${counts.skipped} 步未走` : null,
    counts.experts ? `${counts.experts} 位专家` : null,
    counts.reworkRounds ? `${counts.reworkRounds} 轮返工` : null,
    `${counts.files} 份文件`,
  ].filter(Boolean).join(" · ");
  const process = researchProcessSummary(study);
  const review = researchReviewSummary(study);
  const title = researchWorkflowMode(study) === "proposal" ? "实验方案 · 已确认" : "研究成果 · 已确认";
  if (!study.claims.length && !outcome.conclusion && !conclusionTask?.summary) return null;
  return <section aria-label="研究成果" className="flex min-w-0 flex-col gap-3 rounded-lg border border-accent-green bg-accent-green-subtle p-3">
    <div className="flex flex-wrap items-center gap-2">
      <CheckCircle2 size={16} className="shrink-0 text-accent-green" aria-hidden="true" />
      <strong className="text-sm">{title}</strong>
      <span className="ms-auto text-xs text-subtext">{facts}</span>
    </div>
    <div className="flex min-w-0 flex-col gap-4 rounded-md border border-border bg-background p-3">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="m-0 text-xs font-medium text-subtext">研究结论</h3>
        {study.claims.length ? <ClaimsConclusion study={study} />
          : outcome.conclusion ? <ConclusionCard projectId={projectId} study={study} file={outcome.conclusion} paths={paths} onOpenArtifactFile={onOpenArtifactFile} delivery={delivery} />
            : <div className="flex min-w-0 flex-col gap-1"><strong className="text-sm">{taskDisplayName(conclusionTask!)}</strong><div className="min-w-0 text-sm text-text"><Md text={conclusionTask!.summary ?? ""} /></div></div>}
      </div>
      {(process || review) && <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-3">
        <h3 className="m-0 text-xs font-medium text-subtext">研究过程</h3>
        {process && <p className="m-0 break-words text-sm text-text">{process}</p>}
        {review && <p className="m-0 text-xs text-subtext">{review}</p>}
      </div>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-xs">
        {otherFiles.length > 0 && <button type="button" className="text-primary" aria-expanded={filesOpen} onClick={() => setFilesOpen(value => !value)}>其他文件（{otherFiles.length}）</button>}
        {summaries.length > 0 && <details className="min-w-0">
          <summary className="cursor-pointer text-primary">专家工作摘要（{summaries.length}）</summary>
          <div className="mt-2 flex flex-col gap-2">
            {summaries.map((task) => <div key={task.id} className="min-w-0 rounded border border-border p-2">
              <strong className="text-xs">{taskDisplayName(task)}</strong>
              <div className="mt-1 text-sm text-text"><Md text={task.summary ?? ""} /></div>
            </div>)}
          </div>
        </details>}
        {outcome.tasks.length > 0 && <button type="button" className="ms-auto text-subtext" onClick={() => document.querySelector("[data-research-task-list]")?.scrollIntoView({ block: "start", behavior: "smooth" })}>查看完整执行过程 ↓</button>}
      </div>
      {filesOpen && <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-3">
        {otherDeliverables.length > 0 && <div className="flex min-w-0 flex-col gap-2">
          <h4 className="m-0 text-xs font-medium text-subtext">交付文件</h4>
          {otherDeliverables.map((file) => <ResearchArtifact key={`${file.task.id}:${file.artifact.path}:${file.artifact.sha256}`} projectId={projectId} studyId={study.id} artifact={file.artifact} label={file.label} paths={paths} onOpenArtifactFile={onOpenArtifactFile} delivery={delivery} />)}
        </div>}
        {outcome.reviews.length > 0 && <div className="flex min-w-0 flex-col gap-2">
          <h4 className="m-0 text-xs font-medium text-subtext">复核与过程记录</h4>
          {outcome.reviews.map((file) => <ResearchArtifact key={`${file.task.id}:${file.artifact.path}:${file.artifact.sha256}`} projectId={projectId} studyId={study.id} artifact={file.artifact} label={file.label} deliverable={false} paths={paths} onOpenArtifactFile={onOpenArtifactFile} delivery={delivery} />)}
        </div>}
      </div>}
    </div>
  </section>;
}

function historicalStatus(task: ResearchTask): { state: WorkflowState; label: string } {
  return { state: task.state === "completed" ? "completed" : "stopped", label: `历史版本 · ${task.state === "completed" ? "已验收" : task.state === "running" ? "执行记录" : "未完成"}` };
}

/** One checklist row per expert task; running rows expand to the live transcript, finished ones stay collapsed. */
function TaskRow({ projectId, study, task, version, renderMessage, onOpenArtifactFile, delivery }: { projectId: string; study: ResearchStudy; task: ResearchTask; version: number; renderMessage: ExpertRenderer; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void; delivery?: DeliverySource }) {
  const readOnly = useReadOnlyWorkspace();
  const current = version === study.plans.at(-1)?.version;
  // 等待用户的人工任务直接在对话里展开提交框；历史计划或已结束的研究不再开放提交。
  const humanAwaiting = current && task.kind === "human" && task.state === "awaiting" && study.status !== "stopped";
  const canReopen = current && !readOnly && task.kind === "human" && task.state === "completed" && study.status === "active" && !delivery;
  const [expanded, setExpanded] = useState(current && (task.state === "running" || Boolean(humanAwaiting)));
  const [processOpen, setProcessOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  async function actReopen() {
    setReopening(true); setReopenError(null);
    try {
      await reopenHumanTask(study.id, task.id);
      setConfirmReopen(false);
      await queryClient.invalidateQueries({ queryKey: workspaceKey("researchStudy", study.sessionId) });
    } catch (error) {
      setReopenError(error instanceof Error ? error.message : String(error));
    } finally {
      setReopening(false);
    }
  }
  const status = current ? researchTaskStatus(study, task) : historicalStatus(task);
  const name = taskDisplayName(task);
  const canExpand = Boolean(humanAwaiting || task.sessionId || task.summary || task.verdict?.status === "blocked" || task.artifacts.length);
  const open = expanded && canExpand;
  const runningLive = current && task.state === "running";
  const paths = new Set(study.plans.find(plan => plan.version === version)?.tasks.flatMap(item => item.artifacts.map(file => file.path)) ?? []);
  const counters = `${(task.reworkCount ?? 0) > 0 ? ` · 触发返工 ${task.reworkCount} 轮` : ""}${(task.attempts ?? 0) > 0 ? ` · 重试 ${task.attempts} 次` : ""}`;
  const header = <>
    <StateIcon state={status.state} />
    <strong className="min-w-0 truncate text-sm font-medium">{name}</strong>
    <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs" role="status">{status.label}{counters}<ChevronDown size={14} className={`transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" /></span>
  </>;
  return <li data-research-task-id={task.id} aria-label={`专家任务 · ${name}`} className={`min-w-0 rounded-lg border ${workflowTone[status.state]}`}>
    {canExpand ? <button type="button" aria-expanded={open} onClick={() => setExpanded(value => !value)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start focus-visible:outline-2 focus-visible:outline-primary">{header}</button> : <div className="flex w-full items-center gap-2 px-3 py-2">{header}</div>}
    {open && <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap text-sm text-subtext">{task.brief}</p>
        {runningLive && task.sessionId && !readOnly && <Button size="small" variant="ghost" disabled={cancelling} className="shrink-0" onClick={() => {
          setCancelling(true); setCancelError(null);
          void interruptChat(task.sessionId!).catch(error => { setCancelError(error instanceof Error ? error.message : String(error)); }).finally(() => { setCancelling(false); void queryClient.invalidateQueries({ queryKey: workspaceKey("researchStudy", study.sessionId) }); });
        }}><CircleStop size={13} aria-hidden="true" />{cancelling ? "正在停止…" : "停止该专家"}</Button>}
      </div>
      {humanAwaiting && !readOnly && <HumanSubmitForm study={study} task={task} />}
      {cancelError && <p role="alert" className="m-0 text-sm text-accent-red">停止失败：{cancelError}</p>}
      {task.verdict?.status === "blocked" && <p role="status" className="m-0 text-sm text-accent-amber">需处理：{task.verdict.reasons.join("；")}</p>}
      {task.summary && <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-3"><span className="text-xs text-subtext">专家工作摘要</span><div className="min-w-0 text-sm text-text"><Md text={task.summary} /></div></div>}
      {current && task.kind === "human" && task.state === "completed" && delivery && study.status === "active" && <p className="m-0 text-xs text-subtext">交付已确认；如需修改这一步，请在主对话让研究负责人按受影响任务修订计划（forceRerun）。</p>}
      {canReopen && <div className="flex flex-col gap-2">
        {confirmReopen ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-amber bg-surface p-2 text-xs">
          <span className="min-w-0 flex-1">修改后，这一步的下游任务和当前交付确认都会失效，需要重新提交并确认。</span>
          <Button size="small" disabled={reopening} onClick={() => void actReopen()}>{reopening ? "撤回中…" : "确认修改"}</Button>
          <Button size="small" variant="ghost" disabled={reopening} onClick={() => setConfirmReopen(false)}>取消</Button>
        </div> : <Button size="small" variant="ghost" className="self-start" onClick={() => setConfirmReopen(true)}>修改这一步</Button>}
        {reopenError && <p role="alert" className="m-0 text-xs text-accent-red">撤回失败：{reopenError}</p>}
      </div>}
      {task.artifacts.map(artifact => <ResearchArtifact key={artifact.sha256 + artifact.path} projectId={projectId} studyId={study.id} artifact={artifact} label={researchArtifactLabel(artifact.path)} paths={paths} onOpenArtifactFile={onOpenArtifactFile} delivery={delivery} />)}
      {task.sessionId && (runningLive ? <ExpertTranscript projectId={projectId} sessionId={task.sessionId} renderMessage={renderMessage} live /> : <details open={processOpen} onToggle={event => setProcessOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-subtext">执行记录</summary>{processOpen && <div className="mt-2"><ExpertTranscript projectId={projectId} sessionId={task.sessionId} renderMessage={renderMessage} /></div>}</details>)}
    </div>}
  </li>;
}

export function ResearchConversation({ projectId, study, metrics, renderMessage, onInspect, onOpenArtifactFile }: { projectId: string; study: ResearchStudy; metrics?: ResearchMetrics | null; renderMessage: ExpertRenderer; onInspect?: () => void; onOpenArtifactFile?: (path: string, intent: TabOpenIntent) => void }) {
  const plan = study.plans.at(-1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const tasks = plan?.tasks ?? [];
  const progress = researchProgress(study);
  const delivered = Boolean(researchPackageUrl(study)) && !study.evidenceReviewRequired;
  const archive = researchDeliveryArchive(study);
  const delivery: DeliverySource = delivered && archive ? { studyId: study.id, archive } : null;
  // 计划还没开始时，每个任务都显示同一条「等待确认」：折成一行摘要，展开才看名单。
  const notStarted = tasks.length > 0 && tasks.every(task => task.state === "pending" && !task.sessionId && !(task.reworkCount ?? 0));
  const sharedStatus = notStarted ? [...new Set(tasks.map((task) => researchTaskStatus(study, task).label))] : [];
  const taskList = <ol className="flex flex-col gap-2" data-research-task-list>{tasks.map(task => <TaskRow key={`${plan!.version}:${task.id}:${task.sessionId ?? "pending"}`} projectId={projectId} study={study} task={task} version={plan!.version} renderMessage={renderMessage} onOpenArtifactFile={onOpenArtifactFile} delivery={delivery} />)}</ol>;
  return <section aria-label="对话中的工作流" className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4" onClickCapture={event => { if (event.target instanceof Element && event.target.closest("summary")) onInspect?.(); }}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{plan?.workflowSource?.name ?? "科研工作流"}{plan ? ` · 计划 v${plan.version}` : ""}</strong><span role="status" className="text-xs text-subtext">{researchAttention(study)}</span></div>
    {progress.total > 0 && !notStarted && <div className="flex items-center gap-3"><div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="研究步骤完成情况" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}><div className="h-full rounded-full bg-primary" style={{ width: `${progress.completed / progress.total * 100}%` }} /></div><span className="shrink-0 text-xs text-subtext">{progress.completed}/{progress.total} 个步骤已结束</span></div>}
    {delivered && <ResearchOutcome projectId={projectId} study={study} metrics={metrics} onOpenArtifactFile={onOpenArtifactFile} />}
    <ResearchPanel placement="conversation" sessionId={study.sessionId} disabled={false} />
    {tasks.length ? (notStarted
      ? <details className="group min-w-0 rounded-lg border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm text-subtext [&::-webkit-details-marker]:hidden">
          <Circle size={16} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{tasks.length} 个步骤{sharedStatus.length === 1 ? ` · ${sharedStatus[0]}` : " · 尚未开始"}</span>
          <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-border p-3">{taskList}</div>
      </details>
      : taskList) : plan && <p role="status" className="m-0 text-sm text-subtext">{currentDecisions(study).some(decision => decision.gate === "G1" && decision.status === "approved") ? "范围已确认，等待就绪专家开始。" : "请先确认本次研究范围，专家随后按依赖执行。"}</p>}
    {study.plans.length > 1 && <details open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm text-subtext">历史计划（{study.plans.length - 1}）</summary>{historyOpen && <div className="mt-3 flex flex-col gap-3">{study.plans.slice(0, -1).map(previous => <details key={previous.version}><summary className="cursor-pointer text-xs text-subtext">计划 v{previous.version}</summary><ol className="mt-2 flex flex-col gap-2">{previous.tasks.map(task => <TaskRow key={`${previous.version}:${task.id}:${task.sessionId ?? "pending"}`} projectId={projectId} study={study} task={task} version={previous.version} renderMessage={renderMessage} onOpenArtifactFile={onOpenArtifactFile} delivery={null} />)}</ol></details>)}</div>}</details>}
  </section>;
}
