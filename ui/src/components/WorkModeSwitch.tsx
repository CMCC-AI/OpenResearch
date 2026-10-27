import { ResearchModulePreview } from "./ResearchModulePreview";
import { usePopover } from "./ModelPicker";
import { Users, GitBranch, ChevronDown, Check } from "lucide-react";
import { presetWorkflowModes, researchModes, type ResearchMode, type PresetWorkflowMode } from "../research";
export type WorkMode = "normal" | ResearchMode;
export const workModeLabels = { normal: "工作模式", team: "专家团模式" };

type WorkModeSwitchProps = {
  value: WorkMode; onChange: (mode: WorkMode) => void; readOnly?: boolean; activeWorkflow?: PresetWorkflowMode | null; compact?: boolean;
};

function CompactWorkModeSwitch(props: WorkModeSwitchProps) {
  const { open, setOpen, ref } = usePopover();
  const category = props.value === "normal" ? "normal" : "team";
  const Icon = category === "normal" ? GitBranch : Users;
  return <div ref={ref} className="relative min-w-0">
    <button type="button" aria-label="选择工作模式" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-surface px-3 text-sm text-text hover:bg-hover-subtle">
      <Icon size={15} className="shrink-0" /><span className="truncate">{workModeLabels[category]}</span><ChevronDown size={12} className="shrink-0 text-subtext" />
    </button>
    {open && <div role="menu" aria-label="工作模式" className="absolute bottom-full end-0 @max-lg:start-0 @max-lg:end-auto z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] max-h-80 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-menu" onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      {(["normal", "team", ...presetWorkflowModes] as const).map((mode, index) => {
        const selected = props.value === mode || (mode === "team" && category === "team" && !presetWorkflowModes.includes(props.value as PresetWorkflowMode));
        const ModeIcon = mode === "normal" ? GitBranch : Users;
        return <div key={mode}>
          {index === 2 && <div className="my-1 border-t border-border-variant pt-2 px-2 pb-1 text-xs text-subtext">专家团预设流程</div>}
          <button type="button" role="menuitemradio" aria-checked={selected} autoFocus={selected} onClick={() => { props.onChange(mode); setOpen(false); }} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-start text-sm text-text hover:bg-surface focus-visible:bg-surface focus-visible:outline-2 focus-visible:outline-primary">
            <span className="flex min-w-0 items-center gap-2"><ModeIcon size={15} className="shrink-0" />{mode === "normal" || mode === "team" ? workModeLabels[mode] : researchModes[mode]}</span>
            {selected && <Check size={14} className="shrink-0 text-primary" />}
          </button>
        </div>;
      })}
    </div>}
  </div>;
}

export function WorkModeSwitch({ value, onChange, readOnly = false, activeWorkflow, compact = false }: WorkModeSwitchProps) {
  if (compact && !readOnly) return <CompactWorkModeSwitch value={value} onChange={onChange} activeWorkflow={activeWorkflow} />;
  const category = value === "normal" ? "normal" : "team";
  const workflow = presetWorkflowModes.includes(value as PresetWorkflowMode) ? value as PresetWorkflowMode : null;
  const Icon = category === "normal" ? GitBranch : Users;
  return <div className="min-w-0" aria-label={readOnly ? "当前工作模式" : "工作模式切换"}>
    {readOnly ? <div className="flex flex-wrap items-center gap-2 text-sm"><span className="inline-flex items-center gap-2 text-primary"><Icon size={15} />{workModeLabels[category]}</span>{category === "team" && <span className="text-subtext">{workflow ? `指定流程：${researchModes[workflow]}` : value === "team" ? `自动判断${activeWorkflow ? ` · 当前流程：${researchModes[activeWorkflow]}` : ""}` : "历史研究流程"}</span>}</div> : <div className="flex flex-wrap items-center gap-3">
      <label className="inline-flex max-w-full items-center gap-2 text-sm text-primary"><Icon size={15} className="shrink-0" /><select aria-label="工作模式大类" value={category} onChange={(event) => onChange(event.target.value === "normal" ? "normal" : workflow ?? "team")} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text">
        <option value="normal">{workModeLabels.normal}</option>
        <option value="team">{workModeLabels.team}</option>
      </select></label>
      {category === "team" && <label className="inline-flex max-w-full items-center gap-2 text-sm text-subtext"><span className="shrink-0">执行流程</span><select aria-label="科研专家团预设子模式" value={workflow ?? (value === "team" ? "team" : "")} onChange={(event) => onChange(event.target.value as ResearchMode)} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text">
        {!workflow && value !== "team" && <option value="" disabled>请选择执行流程</option>}
        <option value="team">自动判断（推荐）</option>
        {presetWorkflowModes.map((mode) => <option key={mode} value={mode}>{researchModes[mode]}</option>)}
      </select></label>}
    </div>}
    {!readOnly && workflow && <details className="mt-2"><summary className="cursor-pointer text-xs text-primary">了解所选流程与交付</summary><div className="mt-2"><ResearchModulePreview mode={workflow} /></div></details>}
  </div>;
}
