import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResearchModulePreview } from "./ResearchModulePreview";
import { usePopover } from "./ModelPicker";
import { Users, GitBranch, Workflow, ChevronDown, Check } from "lucide-react";
import { listWorkflows } from "../api";
import { workspaceKey } from "../queries/client";
import { presetWorkflowModes, researchModes, type ResearchMode, type PresetWorkflowMode } from "../research";
import { searchWorkflows, type WorkflowDraft } from "../workflow/model";
import { WorkflowSearchBox } from "../workflow/WorkflowSearch";
export type WorkMode = "normal" | "workflow" | ResearchMode;
export const workModeLabels = { normal: "工作模式", team: "专家团模式", workflow: "工作流模式" };

type WorkModeCategory = "normal" | "team" | "workflow";
const workModeCategory = (mode: WorkMode): WorkModeCategory => mode === "normal" ? "normal" : mode === "workflow" ? "workflow" : "team";
const categoryIcon = (category: WorkModeCategory) => category === "normal" ? GitBranch : category === "workflow" ? Workflow : Users;
/** 紧凑菜单的列表超过这个数量才内置搜索框；少的时候保持菜单轻量，专门的挑选入口始终有搜索。 */
const WORKFLOW_SEARCH_MIN = 6;

type WorkModeSwitchProps = {
  value: WorkMode; onChange: (mode: WorkMode) => void; readOnly?: boolean; activeWorkflow?: PresetWorkflowMode | null;
  /** 新会话预选绑定的保存工作流；发送时随会话创建一起绑定。 */
  workflowDraftId?: string | null;
  /** 会话已绑定的工作流名（取最新计划的 workflow_source），只读展示。 */
  boundWorkflowName?: string | null;
} & (
  // 紧凑模式把工作流列表放进菜单，必须同时提供改选回调，否则点选保存的工作流会静默失效。
  | { compact: true; onWorkflowDraftChange: (draftId: string | null) => void }
  | { compact?: false; onWorkflowDraftChange?: (draftId: string | null) => void }
);

type CompactWorkModeSwitchProps = Pick<WorkModeSwitchProps, "value" | "onChange" | "workflowDraftId" | "onWorkflowDraftChange"> & {
  workflows: WorkflowDraft[]; workflowsPending: boolean; workflowsError: boolean;
};

function WorkflowRadio({ entry, selected, onPick }: { entry: WorkflowDraft; selected: boolean; onPick: (draftId: string) => void }) {
  return <button type="button" role="menuitemradio" aria-checked={selected} onClick={() => onPick(entry.id)} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 ps-4 text-start text-sm text-text hover:bg-surface focus-visible:bg-surface focus-visible:outline-2 focus-visible:outline-primary">
    <span className="min-w-0 truncate">{entry.name}</span>
    {selected && <Check size={14} className="shrink-0 text-primary" />}
  </button>;
}

function CompactWorkModeSwitch(props: CompactWorkModeSwitchProps) {
  const { open, setOpen, ref } = usePopover();
  const [workflowSearch, setWorkflowSearch] = useState("");
  const category = workModeCategory(props.value);
  const Icon = categoryIcon(category);
  const workflows = props.workflows;
  const selectedName = workflows.find((entry) => entry.id === props.workflowDraftId)?.name;
  const workflowsHint = props.workflowsPending ? "正在读取…" : props.workflowsError ? "读取失败" : "还没有保存的工作流";
  const matchedWorkflows = searchWorkflows(workflows, workflowSearch);
  const pickWorkflow = (draftId: string) => { props.onWorkflowDraftChange?.(draftId); props.onChange("workflow"); setOpen(false); };
  return <div ref={ref} className="relative min-w-0">
    <button type="button" aria-label="选择工作模式" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-surface px-3 text-sm text-text hover:bg-hover-subtle">
      <Icon size={15} className="shrink-0" /><span className="truncate">{category === "workflow" && selectedName ? `${workModeLabels.workflow} · ${selectedName}` : workModeLabels[category]}</span><ChevronDown size={12} className="shrink-0 text-subtext" />
    </button>
    {open && <div role="menu" aria-label="工作模式" className="absolute bottom-full end-0 @max-lg:start-0 @max-lg:end-auto z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] max-h-80 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-menu" onKeyDown={(event) => {
      // 搜索框里正常编辑文本，方向键导航只作用于菜单项。
      if (event.target instanceof HTMLInputElement) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      {(["normal", "team", "workflow"] as const).map((mode) => {
        const selected = props.value === mode || (mode === "team" && category === "team" && !presetWorkflowModes.includes(props.value as PresetWorkflowMode));
        const ModeIcon = categoryIcon(mode);
        return <button key={mode} type="button" role="menuitemradio" aria-checked={selected} autoFocus={selected} onClick={() => { props.onChange(mode); if (mode !== "workflow") setOpen(false); }} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-start text-sm text-text hover:bg-surface focus-visible:bg-surface focus-visible:outline-2 focus-visible:outline-primary">
          <span className="flex min-w-0 items-center gap-2"><ModeIcon size={15} className="shrink-0" />{workModeLabels[mode]}</span>
          {selected && <Check size={14} className="shrink-0 text-primary" />}
        </button>;
      })}
      {category !== "workflow" && <>
        <div className="my-1 border-t border-border pt-2 px-2 pb-1 text-xs text-subtext">专家团预设流程</div>
        {presetWorkflowModes.map((mode) => <button key={mode} type="button" role="menuitemradio" aria-checked={props.value === mode} onClick={() => { props.onChange(mode); setOpen(false); }} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 ps-4 text-start text-sm text-text hover:bg-surface focus-visible:bg-surface focus-visible:outline-2 focus-visible:outline-primary">
          <span className="min-w-0 truncate">{researchModes[mode]}</span>
          {props.value === mode && <Check size={14} className="shrink-0 text-primary" />}
        </button>)}
      </>}
      {category === "workflow" && <>
        <div className="my-1 border-t border-border pt-2 px-2 pb-1 text-xs text-subtext">保存的工作流</div>
        {workflows.length === 0 ? <div className="px-2 pb-2 text-xs text-subtext">{workflowsHint}</div>
          : workflows.length < WORKFLOW_SEARCH_MIN ? workflows.map((entry) => <WorkflowRadio key={entry.id} entry={entry} selected={props.workflowDraftId === entry.id} onPick={pickWorkflow} />)
            : <>
              <div className="px-1 pb-1"><WorkflowSearchBox value={workflowSearch} onChange={setWorkflowSearch} matched={matchedWorkflows.length} total={workflows.length} /></div>
              <div className="max-h-56 overflow-y-auto">
                {matchedWorkflows.length === 0 ? <div role="status" className="px-2 pb-2 text-xs text-subtext">没有匹配「{workflowSearch.trim()}」的工作流，换个关键词试试。</div>
                  : matchedWorkflows.map((entry) => <WorkflowRadio key={entry.id} entry={entry} selected={props.workflowDraftId === entry.id} onPick={pickWorkflow} />)}
              </div>
            </>}
      </>}
    </div>}
  </div>;
}

/** 工作流档的选择器：按钮 + 弹出列表（带搜索），工作流多起来也能快速定位。 */
function WorkflowDraftPicker({ workflowDraftId, onWorkflowDraftChange, workflows, pending, error }: {
  workflowDraftId: string | null; onWorkflowDraftChange: (draftId: string | null) => void; workflows: WorkflowDraft[]; pending: boolean; error: boolean;
}) {
  const { open, setOpen, ref } = usePopover();
  const [search, setSearch] = useState("");
  const matched = searchWorkflows(workflows, search);
  const selected = workflows.find((entry) => entry.id === workflowDraftId);
  const label = selected?.name ?? (pending ? "正在读取…" : error ? "读取失败" : workflows.length === 0 ? "还没有保存的工作流" : "请选择工作流");
  return <div ref={ref} className="relative min-w-0">
    <button type="button" aria-label="选择研究工作流" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex min-w-0 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text hover:bg-hover-subtle">
      <span className="truncate">{label}</span><ChevronDown size={12} className="shrink-0 text-subtext" />
    </button>
    {open && <div role="dialog" aria-label="选择研究工作流" className="absolute bottom-full start-0 z-50 mb-2 flex max-h-80 w-72 flex-col gap-2 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-menu" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      {workflows.length === 0 ? <p className="m-0 px-2.5 py-2 text-xs text-subtext">还没有保存的工作流，可先到「我的工作流」中创建。</p> : <>
        <div className="px-1.5 pt-1"><WorkflowSearchBox value={search} onChange={setSearch} matched={matched.length} total={workflows.length} autoFocus onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /></div>
        <div className="min-h-0 overflow-y-auto">
          {matched.length === 0 ? <p role="status" className="m-0 px-2.5 py-2 text-xs text-subtext">没有匹配「{search.trim()}」的工作流，换个关键词试试。</p>
            : matched.map((entry) => <button key={entry.id} type="button" role="menuitemradio" aria-checked={workflowDraftId === entry.id} onClick={() => { onWorkflowDraftChange(entry.id); setOpen(false); }} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-start text-sm text-text hover:bg-surface">
              <span className="min-w-0 truncate">{entry.name}</span>
              {workflowDraftId === entry.id && <Check size={14} className="shrink-0 text-primary" />}
            </button>)}
        </div>
      </>}
    </div>}
  </div>;
}

export function WorkModeSwitch({ value, onChange, readOnly = false, activeWorkflow, compact = false, workflowDraftId = null, onWorkflowDraftChange, boundWorkflowName = null }: WorkModeSwitchProps) {
  const category = workModeCategory(value);
  // 工作流档选择保存的工作流；专家团档不再绑定工作流（工作流是独立模式），列表按需读取。
  const savedWorkflows = useQuery({ queryKey: workspaceKey("workflowList"), queryFn: ({ signal }) => listWorkflows(signal), enabled: !readOnly && category !== "normal" });
  const workflows = savedWorkflows.data ?? [];
  if (compact && !readOnly) return <CompactWorkModeSwitch value={value} onChange={onChange} workflows={workflows} workflowsPending={savedWorkflows.isPending} workflowsError={savedWorkflows.error !== null} workflowDraftId={workflowDraftId} onWorkflowDraftChange={onWorkflowDraftChange} />;
  const workflow = presetWorkflowModes.includes(value as PresetWorkflowMode) ? value as PresetWorkflowMode : null;
  const Icon = categoryIcon(category);
  // 只读行已经说明是哪个模式：把流程/工作流名并进同一行，长名字截断而不是换行铺满输入框上方。
  const readOnlyDetail = category === "workflow" ? boundWorkflowName ?? "保存的工作流"
    : category === "team" ? (workflow ? `指定流程：${researchModes[workflow]}` : value === "team" ? `自动判断${activeWorkflow ? ` · 当前流程：${researchModes[activeWorkflow]}` : ""}` : "历史研究流程")
      : null;
  const readOnlyLabel = `${workModeLabels[category]}${readOnlyDetail ? ` · ${readOnlyDetail}` : ""}`;
  return <div className="min-w-0" aria-label={readOnly ? "当前工作模式" : "工作模式切换"}>
    {readOnly ? <div className="flex min-w-0 items-center gap-2 text-sm"><span className="inline-flex min-w-0 items-center gap-2 text-primary" title={readOnlyLabel}><Icon size={15} className="shrink-0" /><span className="min-w-0 truncate">{readOnlyLabel}</span></span></div> : <div className="flex flex-wrap items-center gap-3">
      <label className="inline-flex max-w-full items-center gap-2 text-sm text-primary"><Icon size={15} className="shrink-0" /><select aria-label="工作模式大类" value={category} onChange={(event) => { const next = event.target.value; onChange(next === "normal" || next === "workflow" ? next : workflow ?? "team"); }} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text">
        <option value="normal">{workModeLabels.normal}</option>
        <option value="team">{workModeLabels.team}</option>
        <option value="workflow">{workModeLabels.workflow}</option>
      </select></label>
      {category === "team" && <label className="inline-flex max-w-full items-center gap-2 text-sm text-subtext"><span className="shrink-0">执行流程</span><select aria-label="科研专家团预设子模式" value={workflow ?? (value === "team" ? "team" : "")} onChange={(event) => onChange(event.target.value as ResearchMode)} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text">
        {!workflow && value !== "team" && <option value="" disabled>请选择执行流程</option>}
        <option value="team">自动判断（推荐）</option>
        {presetWorkflowModes.map((mode) => <option key={mode} value={mode}>{researchModes[mode]}</option>)}
      </select></label>}
      {category === "workflow" && onWorkflowDraftChange && <WorkflowDraftPicker workflowDraftId={workflowDraftId} onWorkflowDraftChange={onWorkflowDraftChange} workflows={workflows} pending={savedWorkflows.isPending} error={savedWorkflows.error !== null} />}
    </div>}
    {!readOnly && workflow && <details className="mt-2"><summary className="cursor-pointer text-xs text-primary">了解所选流程与交付</summary><div className="mt-2"><ResearchModulePreview mode={workflow} /></div></details>}
  </div>;
}
