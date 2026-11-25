import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getResearchStudy, decideResearchGate } from "../api";
import { workspaceKey } from "../queries/client";
import { claimSupportLabel, currentDecisions, deliveryGate, expertRoles, isTemplatePlanSummary, researchFileSize, researchScopeControls, researchScopeSentence, researchProgress, researchModes, presetWorkflowModes, researchWorkflowMode, researchAttention, researchWorkflow, gateNames, type ResearchDecision, type ResearchMode, type ResearchScopeTask } from "../research";
import { Button } from "./ui/Button";
import { IconButton, MenuItem } from "./ui";
import { ResearchStateErrorDialog } from "./ResearchOverviewDialog";
import { Users, Workflow, ArrowRight, CheckCircle2, ChevronDown, CircleDot, XCircle } from "lucide-react";
import { ResearchModulePreview } from "./ResearchModulePreview";
import { ResearchTeamDagDialog } from "./ResearchTeamDag";
import { EndResearchControl } from "./EndResearchControl";

export function ResearchPanel({ sessionId, onStartWorkflow, disabled, onOpenSession, placement = "composer", expanded = false, onOpenResearch, active = false, onOpenWorkflow, workflowActive = false }: {
  sessionId: string | null; onStartWorkflow?: (mode: ResearchMode) => Promise<void>; disabled: boolean; onOpenSession?: (sessionId: string) => void; placement?: "composer" | "workspace" | "pane" | "conversation"; expanded?: boolean; onOpenResearch?: () => void; active?: boolean; onOpenWorkflow?: () => void; workflowActive?: boolean;
}) {
  const readOnly = useReadOnlyWorkspace();
  const query = useQuery({ queryKey: workspaceKey("researchStudy", sessionId), queryFn: ({ signal }) => getResearchStudy(sessionId!, signal), enabled: Boolean(sessionId), refetchInterval: (query) => ["active", "paused"].includes(query.state.data?.study?.status ?? "") ? 2500 : false });
  const data = query.data;
  const pending = query.isPending;
  const queryError = query.error;
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [dagOpen, setDagOpen] = useState(false);
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
  // 确认卡用任务/专家名代替内部任务号；分流等无角色节点按类型兜底。
  const taskNames = new Map((plan?.tasks ?? []).map((task) => [task.id, task.agent?.name ?? expertRoles[task.role] ?? (task.kind === "human" ? "人工任务" : task.id)]));
  const renderDecision = (decision: ResearchDecision) => <GateCard key={decision.id} decision={decision} taskNames={taskNames} deliveryGateName={study ? deliveryGate(researchWorkflowMode(study)) : "G4"} readOnly={Boolean(readOnly)} disabled={working || study?.status === "stopped"} onDecide={(accepted, reason) => act(async () => {
    if (!study) return;
    const result = await decideResearchGate(study.id, decision.id, decision.scopeHash, accepted, reason);
    if (result.resumeError) throw new Error(`决策已保存，但会话未恢复：${result.resumeError}。请在主对话中发送消息继续推进。`);
  })} />;
  const pendingDecisions = decisions.filter((decision) => decision.status === "pending");
  const decided = decisions.filter((decision) => decision.status !== "pending");
  // 对话卡片只保留确认门；结束动作由管理面板（专家团确认区、工作流侧栏）承载。
  const endResearchBlock = study && (study.status === "active" || study.status === "paused") && !readOnly
    ? <EndResearchControl study={study} version={plan?.version ?? 0} disabled={working || disabled} onDone={() => query.refetch()} />
    : null;
  const decisionCards = <>
    {study?.deliveryError && <div role="alert" className="flex flex-col gap-1">
      <p className="m-0 text-sm text-accent-red">交付确认受阻：{study.deliveryError}</p>
      <p className="m-0 text-xs text-subtext">人工任务可直接在任务卡点「修改这一步」；专家任务请在主对话让研究负责人按受影响任务修订计划（forceRerun）。</p>
    </div>}
    {study?.deliveryNotice && <p role="status" className="text-sm text-accent-amber">{study.deliveryNotice}</p>}
    {study?.status === "stopped" && <p role="status" className="text-sm text-subtext">本轮研究已结束，历史记录继续保留。</p>}
    {pendingDecisions.length > 0 ? pendingDecisions.map(renderDecision) : placement !== "conversation" ? <p className="text-sm text-subtext">{study?.status === "active" && plan?.tasks.length && plan.tasks.every((task) => task.state === "completed") && !decisions.some((decision) => decision.status === "approved" && decision.gate === deliveryGate(researchWorkflowMode(study))) ? "交付确认尚未生成，请先处理交付校验问题；无需重复修订全部任务。" : "暂无待确认事项"}</p> : null}
    {decided.length > 0 && <details><summary className="cursor-pointer text-xs text-subtext">确认记录（{decided.length}）</summary><div className="mt-2 flex flex-col gap-2">{decided.map(renderDecision)}</div></details>}
    {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}
  </>;
  const dagDialog = dagOpen && (sessionId && (queryError || pending) ? <ResearchStateErrorDialog loading={pending} error={queryError?.message ?? ""} onRetry={() => void query.refetch()} onClose={() => setDagOpen(false)} /> : <ResearchTeamDagDialog metrics={data?.metrics} study={study ?? null} runs={data?.runs ?? []} onClose={() => setDagOpen(false)} confirmationContent={<>{decisionCards}{endResearchBlock}</>} onOpenSession={onOpenSession} />);
  const openResearch = () => onOpenResearch ? onOpenResearch() : setDagOpen(true);
  if (placement === "conversation") {
    // 对话里这块只在有确认要处理或有记录可回看时出现；没有待办就不占一行。
    if (queryError) return <section aria-label="研究确认" className="flex flex-col gap-3"><div role="alert" className="text-sm text-accent-red">确认状态读取失败<Button size="small" onClick={() => void query.refetch()}>重试</Button></div></section>;
    const hasContent = Boolean(study && (pendingDecisions.length > 0 || decided.length > 0 || study.deliveryError || study.deliveryNotice || study.status === "stopped"));
    return hasContent ? <section aria-label="研究确认" className="flex flex-col gap-3">{decisionCards}</section> : null;
  }
  if (readOnly && !study && placement === "composer") return null;
  if (placement === "pane") return <div className="flex h-full min-h-0 flex-col">{pending && sessionId ? <p className="p-4 text-sm text-subtext">正在读取专家团状态…</p> : queryError ? <div role="alert" className="p-4 text-sm text-accent-red">研究状态读取失败：{queryError.message}<Button onClick={() => void query.refetch()}>重试</Button></div> : <ResearchTeamDagDialog embedded metrics={data?.metrics} study={study ?? null} runs={data?.runs ?? []} onClose={() => {}} confirmationContent={<>{decisionCards}{endResearchBlock}</>} onOpenSession={onOpenSession} />}</div>;
  if (placement === "workspace") {
    // 工作流对话里这个入口跟随工作流身份：直接打开画布侧栏，不再落回专家团面板。
    const workflowEntry = Boolean(plan?.workflowSource) && Boolean(onOpenWorkflow);
    const Icon = workflowEntry ? Workflow : Users;
    const entryLabel = workflowEntry ? "工作流" : "科研专家团";
    const pressActive = workflowEntry ? workflowActive : active;
    return <>
      {expanded ? <MenuItem className="min-h-7 py-1" aria-label={workflowEntry ? "工作流流程与执行" : "科研专家团流程"} onClick={workflowEntry ? onOpenWorkflow : openResearch} disabled={Boolean(sessionId) && pending}><span className="flex min-w-0 flex-col gap-0.5"><span className="flex items-center gap-4"><Icon size={15} className="shrink-0 text-primary" />{entryLabel}</span><span className="truncate ps-[31px] text-menu text-subtext">{study ? researchAttention(study) : queryError ? "状态读取失败 · 点击重试" : readOnly ? "已结束 · 未保存流程" : "预设流程与执行"}</span></span></MenuItem> : <IconButton aria-label={workflowEntry ? "工作流流程与执行" : "科研专家团流程"} data-tip={workflowEntry ? "工作流 · 流程与执行" : "科研专家团 · 流程与执行"} aria-pressed={pressActive} active={pressActive} disabled={Boolean(sessionId) && pending} onClick={workflowEntry ? onOpenWorkflow : openResearch}><Icon size={15} /></IconButton>}
      {dagDialog}
    </>;
  }
  return <section className={`mb-2 rounded-lg border text-sm ${study ? "border-primary bg-primary-subtle" : "border-border bg-background"}`} aria-label="当前研究流程">
    {!study ? readOnly ? null : <div className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <details><summary className="cursor-pointer text-xs text-subtext">专家团模式</summary><div className="mt-2 flex flex-col gap-2"><Button size="small" disabled={disabled || working} onClick={() => void act(() => onStartWorkflow?.("team") ?? Promise.resolve())}>新建专家团对话 · 自动判断</Button>{presetWorkflowModes.map((mode) => <details key={mode} className="rounded-lg border border-border p-2"><summary className="cursor-pointer text-sm text-primary">{researchModes[mode]}</summary><div className="mt-2"><ResearchModulePreview mode={mode} /><Button size="small" className="mt-2" disabled={disabled || working} onClick={() => void act(() => onStartWorkflow?.(mode) ?? Promise.resolve())}>新建专家团对话 · {researchModes[mode]}</Button></div></details>)}</div></details>
      </div>
    </div> : <div className="p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2"><Users size={16} className="shrink-0 text-primary" /><strong className="text-text">{researchModes[researchWorkflowMode(study)]}</strong></div>
        <Button size="small" onClick={openResearch}>查看流程、分工与执行 <ArrowRight size={14} /></Button>
      </div>
      <p role="status" className="mt-2 text-sm font-medium text-primary">{researchAttention(study)}</p>
      {activeStages.length > 0 && <p className="mt-1 text-xs text-subtext">当前环节：{activeStages.map((stage) => stage.title).join(" · ")}</p>}
      <div className="mt-2 flex items-center gap-3"><div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="已验收专家任务" aria-valuemin={0} aria-valuemax={progress?.total || 1} aria-valuenow={progress?.completed ?? 0}><div className="h-full rounded-full bg-primary" style={{ width: `${progress?.total ? progress.completed / progress.total * 100 : 0}%` }} /></div><span className="shrink-0 text-xs text-subtext">{progress?.completed}/{progress?.total} 任务{plan ? ` · v${plan.version}` : " · 规划中"}</span></div>

    </div>}
    {error && <p role="alert" className="px-3 pb-3 text-accent-red">{error}</p>}
    {dagDialog}
  </section>;
}

function GateCard({ decision, taskNames, deliveryGateName, disabled, onDecide, readOnly = false }: { readOnly?: boolean; decision: ResearchDecision; taskNames: Map<string, string>; deliveryGateName: string; disabled: boolean; onDecide: (approved: boolean, reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const scopeKindNames: Record<string, string> = { human: "人工任务", route: "条件分流", foreach: "逐项处理", experiment: "实验执行", wait: "等待事件" };
  let scope: {
    summary?: string; command?: string; revision?: string;
    options?: { backend?: string; flavor?: string; host?: string; timeout?: string };
    plan?: { summary?: string; materialIds?: string[]; tasks?: ResearchScopeTask[]; version?: number };
    claims?: { id?: string; text?: string; support?: string; source?: string; location?: string }[];
    taskId?: string; artifacts?: { path: string; sha256: string }[];
    objective?: string; materialIds?: string[]; version?: number;
    tasks?: ResearchScopeTask[];
  } = {};
  try { const parsed: unknown = JSON.parse(decision.scope); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) scope = parsed; } catch { /* old text scopes remain readable */ }
  // 界面上只出现中文名：任务确认带专家名，其余门用预定义名称，G 编码留在数据里。
  const taskApproval = decision.gate.startsWith("G5:");
  const taskId = scope.taskId ?? (taskApproval ? decision.gate.slice(3) : null);
  const gateLabel = taskApproval ? `任务确认 · ${taskId ? taskNames.get(taskId) ?? taskId : "任务"}` : decision.gate === "G3" && !scope.command ? "实验方案确认" : gateNames[decision.gate] ?? decision.gate;
  const scopeTasks: ResearchScopeTask[] = Array.isArray(scope.tasks) ? scope.tasks : Array.isArray(scope.plan?.tasks) ? scope.plan.tasks : [];
  const stepNumbers = new Map(scopeTasks.map((task, index) => [task.id, index + 1]));
  const scopeTaskName = (task: ResearchScopeTask) => taskNames.get(task.id) ?? (task.role ? expertRoles[task.role] ?? task.role : scopeKindNames[task.kind ?? ""] ?? task.id);
  const materialIds = Array.isArray(scope.materialIds) ? scope.materialIds : Array.isArray(scope.plan?.materialIds) ? scope.plan.materialIds : null;
  // 没有材料就不写这一行；计划版本是内部簿记，不占用户的注意力。
  const scopeMeta = materialIds?.length ? `${materialIds.length} 份研究材料` : null;
  const planSummary = scope.summary ?? scope.plan?.summary;
  const showPlanSummary = Boolean(planSummary) && !(scopeTasks.length > 0 && isTemplatePlanSummary(planSummary));
  // 交付确认批的是结论与产物；步骤安排是计划阶段的事，执行过程在主对话里回看。
  const deliveryDecision = decision.gate === deliveryGateName && Boolean(scope.plan);
  const scopeClaims = deliveryDecision && Array.isArray(scope.claims) ? scope.claims.filter((claim) => claim.text) : [];
  const planSentence = deliveryDecision ? "" : researchScopeSentence(scopeTasks);
  const planControls = deliveryDecision ? "" : researchScopeControls(scopeTasks);
  const status = decision.status === "approved"
    ? { label: "已批准", icon: CheckCircle2, tone: "bg-accent-green-subtle text-accent-green" }
    : decision.status === "rejected"
      ? { label: "已拒绝", icon: XCircle, tone: "bg-accent-red-subtle text-accent-red" }
      : { label: "等待确认", icon: CircleDot, tone: "bg-accent-amber-subtle text-accent-amber" };
  const StatusIcon = status.icon;
  return <section className={`flex flex-col gap-3 rounded-xl border p-4 ${decision.status === "pending" ? "border-border bg-background" : "border-border-variant bg-surface"}`} aria-label={gateLabel}>
    <div className="flex flex-wrap items-center gap-2">
      <strong className="min-w-0 text-sm font-semibold text-text">{gateLabel}</strong>
      <span className={`ms-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ${status.tone}`}><StatusIcon size={12} aria-hidden="true" />{status.label}</span>
    </div>
    <div className="flex min-w-0 flex-col gap-2">
      {scope.objective && scope.objective !== scope.summary && <p className="m-0 text-xs text-subtext">研究目标：{scope.objective}</p>}
      {showPlanSummary && <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-text">{planSummary}</p>}
      {planSentence && <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-text">{planSentence}</p>}
      {planControls && <p className="m-0 text-xs text-subtext">{planControls}</p>}
      {scopeMeta && <p className="m-0 text-xs text-subtext">{scopeMeta}</p>}
    </div>
    {scopeClaims.length > 0 && <div className="flex min-w-0 flex-col gap-2" data-delivery-claims>
      <h3 className="m-0 text-xs font-medium text-subtext">研究结论（{scopeClaims.length}）</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {scopeClaims.map((claim, index) => <li key={claim.id ?? index} className="min-w-0">
          <p className="m-0 text-sm leading-relaxed text-text">{claim.text}</p>
          <p className="m-0 break-words text-xs text-subtext">{claimSupportLabel(claim.support ?? "")}{claim.source ? ` · ${claim.source}` : ""}{claim.location ? ` · ${claim.location}` : ""}</p>
        </li>)}
      </ul>
    </div>}
    {taskApproval && scope.artifacts?.length ? <p className="m-0 break-all text-xs text-subtext">已验收产物：{scope.artifacts.map((artifact) => artifact.path).join("、")}</p> : null}
    {scope.command && <div className="flex min-w-0 flex-col gap-1 text-xs">
      <p className="m-0 text-subtext">执行位置：{scope.options?.backend} {scope.options?.host} {scope.options?.flavor} {scope.options?.timeout}</p>
      <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-2 font-mono text-xs text-text">{scope.command}</pre>
      <p className="m-0 break-all text-subtext">代码版本：{scope.revision}</p>
    </div>}
    {taskApproval && <p className="m-0 text-xs leading-relaxed text-subtext">该任务已通过产物验收；批准后它的下游任务才会开始。拒绝则下游保持暂停，需修订计划后重新执行。</p>}
    {decision.gate === "G3" && !scope.command && <p className="m-0 text-xs leading-relaxed text-subtext">确认实验方案的假设、指标、基线、预算与停止条件；此项确认不授权运行实验。</p>}
    {decision.gate === "G4" && <p className="m-0 text-xs leading-relaxed text-subtext">确认本次研究成果的结论、证据与局限。此操作生成批准记录，公开发布需另行操作。</p>}
    {!deliveryDecision && scopeTasks.length > 0 && <details className="group rounded-lg bg-surface px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-subtext [&::-webkit-details-marker]:hidden">查看任务安排（{scopeTasks.length}）<ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
      <ol className="m-0 mt-2 flex list-none flex-col divide-y divide-border-variant p-0">
        {scopeTasks.map((task, index) => <li key={task.id} className="min-w-0 py-3 first:pt-2 last:pb-0">
          <p className="m-0 text-sm"><span className="text-subtext">第 {index + 1} 步 · </span><span className="font-medium text-text">{scopeTaskName(task)}</span></p>
          {task.brief && <p className="m-0 mt-1 whitespace-pre-wrap text-sm leading-relaxed text-subtext">{task.brief}</p>}
          {task.outputs?.length ? <p className="m-0 mt-1 break-all text-xs text-subtext">产物：{task.outputs.join("、")}</p> : null}
          {task.dependsOn?.length ? <p className="m-0 mt-1 text-xs text-subtext">接在{task.dependsOn.map((id) => stepNumbers.has(id) ? `第 ${stepNumbers.get(id)} 步` : id).join("、")}之后</p> : null}
        </li>)}
      </ol>
    </details>}
    {(() => {
      const artifacts = scopeTasks.flatMap((task) => task.artifacts ?? []);
      if (!artifacts.length) return null;
      const total = artifacts.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0);
      return <details data-delivery-artifacts className="group rounded-lg bg-surface px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-subtext [&::-webkit-details-marker]:hidden">交付文件（{artifacts.length} 份 · {researchFileSize(total)}）<ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
        <ul className="m-0 mt-2 flex list-none flex-col divide-y divide-border-variant p-0 text-xs">
          {artifacts.map((artifact) => <li key={`${artifact.path}:${artifact.sha256 ?? ""}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2 py-1.5 first:pt-1">
            <span className="min-w-0 break-all text-text">{artifact.path}</span>
            {artifact.bytes != null && <span className="text-subtext">{researchFileSize(artifact.bytes)}</span>}
          </li>)}
        </ul>
      </details>;
    })()}
    {decision.status === "pending" && !readOnly ? <div className="flex flex-wrap items-center gap-2 pt-1">
      <input aria-label={`${gateLabel} 决策说明`} placeholder="说明或调整意见（可选）" value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 min-w-40 flex-1 rounded-lg border border-border-variant bg-background px-3 text-sm" />
      <Button size="small" variant="primary" disabled={disabled} onClick={() => void onDecide(true, reason)}>批准当前版本</Button>
      <Button size="small" variant="ghost" disabled={disabled} onClick={() => void onDecide(false, reason)}>拒绝并反馈</Button>
    </div> : decision.reason && <p className="m-0 text-xs text-subtext">{decision.reason}</p>}
  </section>;
}
