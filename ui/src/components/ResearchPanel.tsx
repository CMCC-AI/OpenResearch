import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getResearchStudy, decideResearchGate, stopResearchStudy, downloadResearchPackage, sendChatMessage } from "../api";
import { workspaceKey } from "../queries/client";
import { currentDecisions, researchProgress, researchModes, presetWorkflowModes, researchWorkflowMode, deliveryGate, researchAttention, researchWorkflow, gateNames, type ResearchDecision, type ResearchMode } from "../research";
import { Button } from "./ui/Button";
import { IconButton, MenuItem } from "./ui";
import { ResearchStateErrorDialog } from "./ResearchOverviewDialog";
import { ResearchOverviewDialog } from "./ResearchOverviewDialog";
import { Users, ArrowRight } from "lucide-react";
import { ResearchJourneyIntro } from "./ResearchJourneyIntro";
import { ResearchModulePreview } from "./ResearchModulePreview";
import { ResearchTeamDagDialog } from "./ResearchTeamDag";
import { ResearchWorkflowDialog } from "./ResearchWorkflow";

export function ResearchPanel({ sessionId, onStartWorkflow, disabled, onOpenSession, placement = "composer", expanded = false, onOpenResearch, active = false }: {
  sessionId: string | null; onStartWorkflow?: (mode: ResearchMode) => Promise<void>; disabled: boolean; onOpenSession?: (sessionId: string) => void; placement?: "composer" | "workspace" | "pane"; expanded?: boolean; onOpenResearch?: () => void; active?: boolean;
}) {
  const readOnly = useReadOnlyWorkspace();
  const query = useQuery({ queryKey: workspaceKey("researchStudy", sessionId), queryFn: ({ signal }) => getResearchStudy(sessionId!, signal), enabled: Boolean(sessionId), refetchInterval: (query) => query.state.data?.study?.status === "active" ? 2500 : false });
  const data = query.data;
  const pending = query.isPending;
  const queryError = query.error;
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [dagOpen, setDagOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const study = data?.study;
  async function act(action: () => Promise<unknown>) {
    setWorking(true); setError(null);
    try { await action(); await query.refetch(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  }
  if (placement === "composer" && pending) return <p className="text-sm text-subtext py-2">正在读取研究模式…</p>;
  if (placement === "composer" && queryError) return <div role="alert" className="text-sm text-accent-red py-2">研究状态读取失败：{queryError.message}<Button onClick={() => void query.refetch()}>重试</Button></div>;
  const plan = study?.plans.at(-1);
  const progress = study ? researchProgress(study) : null;
  const decisions = study ? currentDecisions(study) : [];
  const activeStages = study ? researchWorkflow(study).filter((stage) => ["running", "blocked"].includes(stage.state)) : [];
  const approved = decisions.some((d) => d.gate === deliveryGate(researchWorkflowMode(study!)) && d.status === "approved");
  const actions = study && <>
    <Button size="small" disabled={Boolean(readOnly) || working || study.status === "stopped"} onClick={() => void act(() => sendChatMessage(study.sessionId, "请读取当前研究计划、人工决策和真实运行状态，继续推进已就绪任务。"))}>继续研究</Button>
    <Button size="small" disabled={working} onClick={() => void act(() => downloadResearchPackage(study.id, false))}>下载草稿包</Button>
    {approved && <Button size="small" disabled={working} onClick={() => void act(() => downloadResearchPackage(study.id, true))}>下载已确认交付</Button>}
    <Button size="small" variant="danger" disabled={Boolean(readOnly) || working || study.status === "stopped"} onClick={() => void act(() => stopResearchStudy(study.id))}>停止研究</Button>
  </>;
  const renderDecision = (decision: ResearchDecision) => <GateCard key={decision.id} decision={decision} readOnly={Boolean(readOnly)} disabled={working || study?.status === "stopped"} onDecide={(accepted, reason) => act(async () => {
    if (!study) return;
    const result = await decideResearchGate(study.id, decision.id, decision.scopeHash, accepted, reason);
    if (result.resumeError) throw new Error(`决策已保存，但会话未恢复：${result.resumeError}。可点击“继续研究”。`);
  })} />;
  const decisionCards = study && decisions.length > 0 && <section aria-label="人工确认节点" className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">人工确认节点</h3>
    {decisions.filter((decision) => decision.status !== "approved").map(renderDecision)}
    {decisions.some((decision) => decision.status === "approved") && <details><summary className="cursor-pointer text-xs text-subtext">已确认记录（{decisions.filter((decision) => decision.status === "approved").length}）</summary><div className="mt-2 flex flex-col gap-2">{decisions.filter((decision) => decision.status === "approved").map(renderDecision)}</div></details>}
  </section>;
  const dialog = workflowOpen && (sessionId && (queryError || pending) ? <ResearchStateErrorDialog loading={pending} error={queryError?.message ?? ""} onRetry={() => void query.refetch()} onClose={() => setWorkflowOpen(false)} /> : study ? <ResearchWorkflowDialog embedded={placement === "pane"} study={study} runs={data?.runs ?? []} decisionCards={<>{decisionCards}{error && <p role="alert" className="text-sm text-accent-red">{error}</p>}</>} actions={actions} onClose={() => setWorkflowOpen(false)} onOpenSession={onOpenSession} /> : <ResearchOverviewDialog onClose={() => setWorkflowOpen(false)} />);
  const dagDialog = dagOpen && (sessionId && (queryError || pending) ? <ResearchStateErrorDialog loading={pending} error={queryError?.message ?? ""} onRetry={() => void query.refetch()} onClose={() => setDagOpen(false)} /> : <ResearchTeamDagDialog study={study ?? null} runs={data?.runs ?? []} actions={actions} onClose={() => setDagOpen(false)} onDetails={() => { setDagOpen(false); setWorkflowOpen(true); }} onOpenSession={onOpenSession} />);
  const openResearch = () => onOpenResearch ? onOpenResearch() : setDagOpen(true);
  if (readOnly && !study && placement === "composer") return null;
  if (placement === "pane") return <div className="flex h-full min-h-0 flex-col">{pending && sessionId ? <p className="p-4 text-sm text-subtext">正在读取专家团状态…</p> : queryError ? <div role="alert" className="p-4 text-sm text-accent-red">研究状态读取失败：{queryError.message}<Button onClick={() => void query.refetch()}>重试</Button></div> : workflowOpen ? study ? dialog : <div className="h-full overflow-y-auto p-4"><Button size="small" className="mb-3" onClick={() => setWorkflowOpen(false)}>返回专家团流程图</Button><ResearchJourneyIntro /></div> : <ResearchTeamDagDialog embedded study={study ?? null} runs={data?.runs ?? []} actions={actions} onClose={() => {}} onDetails={() => setWorkflowOpen(true)} onOpenSession={onOpenSession} />}</div>;
  if (placement === "workspace") return <>
    {expanded ? <MenuItem className="min-h-7 py-1" aria-label="科研专家团流程" onClick={openResearch} disabled={Boolean(sessionId) && pending}><span className="flex min-w-0 flex-col gap-0.5"><span className="flex items-center gap-4"><Users size={15} className="shrink-0 text-primary" />科研专家团</span><span className="truncate ps-[31px] text-menu text-subtext">{study ? researchAttention(study) : queryError ? "状态读取失败 · 点击重试" : readOnly ? "已结束 · 未保存流程" : "预设流程与执行"}</span></span></MenuItem> : <IconButton aria-label="科研专家团流程" data-tip="科研专家团 · 流程与执行" aria-pressed={active} active={active} disabled={Boolean(sessionId) && pending} onClick={openResearch}><Users size={15} /></IconButton>}
    {dagDialog}
    {dialog}
  </>;
  return <section className={`mb-2 rounded-lg border text-sm ${study ? "border-primary bg-primary-subtle" : "border-border bg-background"}`} aria-label="当前研究流程">
    {!study ? readOnly ? null : <div className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <details><summary className="cursor-pointer text-xs text-subtext">科研专家团模式</summary><div className="mt-2 flex flex-col gap-2"><p className="text-xs text-subtext">当前对话的工作模式保持不变；在同一项目中新建专家团对话，可自动判断或手动指定流程。</p><Button size="small" disabled={disabled || working} onClick={() => void act(() => onStartWorkflow?.("team") ?? Promise.resolve())}>新建专家团对话 · 自动判断</Button>{presetWorkflowModes.map((mode) => <details key={mode} className="rounded-lg border border-border p-2"><summary className="cursor-pointer text-sm text-primary">{researchModes[mode]} · 了解流程与专家</summary><div className="mt-2"><ResearchModulePreview mode={mode} /><Button size="small" className="mt-2" disabled={disabled || working} onClick={() => void act(() => onStartWorkflow?.(mode) ?? Promise.resolve())}>新建专家团对话 · {researchModes[mode]}</Button></div></details>)}</div></details>
      </div>
    </div> : <div className="p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2"><Users size={16} className="shrink-0 text-primary" /><strong className="text-text">{researchModes[researchWorkflowMode(study)]}</strong></div>
        <Button size="small" onClick={openResearch}>查看流程、分工与执行 <ArrowRight size={14} /></Button>
      </div>
      <p role="status" className="mt-2 text-sm font-medium text-primary">{researchAttention(study)}</p>
      {activeStages.length > 0 && <p className="mt-1 text-xs text-subtext">当前环节：{activeStages.map((stage) => stage.title).join(" · ")}</p>}
      <div className="mt-2 flex items-center gap-3"><div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="已验收专家任务" aria-valuemin={0} aria-valuemax={progress?.total || 1} aria-valuenow={progress?.completed ?? 0}><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress?.total ? progress.completed / progress.total * 100 : 0}%` }} /></div><span className="shrink-0 text-xs text-subtext">{progress?.completed}/{progress?.total} 任务{plan ? ` · v${plan.version}` : " · 规划中"}</span></div>
      {!readOnly && decisions.some((decision) => decision.status === "pending") && <button type="button" onClick={openResearch} className="mt-2 text-xs font-medium text-accent-amber underline underline-offset-2">打开流程查看并确认，研究才能继续</button>}
    </div>}
    {error && <p role="alert" className="px-3 pb-3 text-accent-red">{error}</p>}
    {dialog}
  </section>;
}

function GateCard({ decision, disabled, onDecide, readOnly = false }: { readOnly?: boolean; decision: ResearchDecision; disabled: boolean; onDecide: (approved: boolean, reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  let scope: { summary?: string; command?: string; revision?: string; options?: { backend?: string; flavor?: string; host?: string; timeout?: string }; plan?: { summary?: string } } = {};
  try { const parsed: unknown = JSON.parse(decision.scope); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) scope = parsed; } catch { /* old text scopes remain readable */ }
  const gateName = decision.gate === "G3" && !scope.command ? "实验方案确认" : gateNames[decision.gate];
  return <section className="rounded border border-border p-3" aria-label={`${decision.gate} ${gateName}`}>
    <strong>{decision.gate} · {gateName} · {decision.status === "approved" ? "已批准" : decision.status === "rejected" ? "已拒绝" : "等待确认"}</strong>
    <p className="whitespace-pre-wrap py-1">{scope.summary ?? scope.plan?.summary}</p>
    {scope.command && <><p>执行位置：{scope.options?.backend} {scope.options?.host} {scope.options?.flavor} {scope.options?.timeout}</p><pre className="whitespace-pre-wrap break-all text-xs">{scope.command}</pre><p className="text-xs text-subtext break-all">代码版本：{scope.revision}</p></>}
    {decision.gate === "G3" && !scope.command && <p className="text-subtext">确认实验方案的假设、指标、基线、预算与停止条件；此项确认不授权运行实验。</p>}
    {decision.gate === "G4" && <p className="text-subtext">确认当前研究包的结论、证据与局限。此操作生成批准记录，公开发布需另行操作。</p>}
    <details className="mt-2"><summary className="cursor-pointer text-subtext">查看完整审批范围</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(scope, null, 2)}</pre><p className="text-xs text-subtext break-all">范围校验：{decision.scopeHash}</p></details>
    {decision.status === "pending" && !readOnly ? <div className="flex flex-wrap gap-2 mt-2">
      <input aria-label={`${decision.gate} 决策说明`} placeholder="说明或调整意见（可选）" value={reason} onChange={(e) => setReason(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1" />
      <Button size="small" disabled={disabled} onClick={() => void onDecide(true, reason)}>批准当前版本</Button>
      <Button size="small" disabled={disabled} onClick={() => void onDecide(false, reason)}>拒绝并反馈</Button>
    </div> : decision.reason && <p>{decision.reason}</p>}
  </section>;
}
