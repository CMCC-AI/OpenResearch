import { ResearchModulePreview } from "./ResearchModulePreview";
import { Users, GitBranch } from "lucide-react";
import { presetWorkflowModes, researchModes, type ResearchMode, type PresetWorkflowMode } from "../research";
export type WorkMode = "normal" | ResearchMode;
export const workModeLabels = { normal: "工作模式", team: "科研专家团模式" };
export const workModeComparison = "工作模式：单个智能体自主探索与实验；科研专家团模式：主理人判断研究路径，也可手动指定预设流程。";

export function WorkModeSwitch({ value, onChange, readOnly = false, activeWorkflow }: {
  value: WorkMode; onChange: (mode: WorkMode) => void; readOnly?: boolean; activeWorkflow?: PresetWorkflowMode | null;
}) {
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
    {!readOnly && category === "team" && !workflow && <p className="mt-2 text-xs text-subtext">主理人根据目标和材料判断是否触发预设流程；综合任务按需组织专家，不必先选择流程。</p>}
    {!readOnly && workflow && <details className="mt-2"><summary className="cursor-pointer text-xs text-primary">了解所选流程与交付</summary><div className="mt-2"><ResearchModulePreview mode={workflow} /></div></details>}
    <p className="mt-1.5 mb-0 text-xs leading-relaxed text-subtext">{workModeComparison}</p>
  </div>;
}
