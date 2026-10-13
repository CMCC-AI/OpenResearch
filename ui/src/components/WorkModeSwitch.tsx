import { Repeat2, Users, GitBranch } from "lucide-react";
export type WorkMode = "normal" | "team";
export const workModeLabels: Record<WorkMode, string> = { normal: "工作模式", team: "科创专家团工作模式" };
export const workModeComparison = "工作模式：单个智能体自主验证，适合快速探索；专家团模式：多专家分工、分阶段确认，形成审查报告与研究包。";

export function WorkModeSwitch({ value, onChange, readOnly = false }: {
  value: WorkMode; onChange: (mode: WorkMode) => void; readOnly?: boolean;
}) {
  const Icon = value === "team" ? Users : GitBranch;
  return <div className="min-w-0" aria-label={readOnly ? "当前工作模式" : "工作模式切换"}>
    {readOnly ? <span className="inline-flex items-center gap-2 text-sm text-primary"><Icon size={15} />{workModeLabels[value]}</span> : <button type="button" aria-label={`当前${workModeLabels[value]}，切换至${workModeLabels[value === "normal" ? "team" : "normal"]}`} aria-pressed={value === "team"} onClick={() => onChange(value === "normal" ? "team" : "normal")} title="选择新项目的工作模式" className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary hover:bg-primary-subtle"><Icon size={15} className="shrink-0" /><span>{workModeLabels[value]}</span><Repeat2 size={14} className="shrink-0" /></button>}
    <p className="mt-1.5 mb-0 text-xs leading-relaxed text-subtext">{workModeComparison}</p>
  </div>;
}
