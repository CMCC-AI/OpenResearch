import { GitBranch, Users, ArrowRight } from "lucide-react";
import { researchModes, type ResearchMode } from "../research";
import { ResearchModulePreview } from "./ResearchModulePreview";
import { ResearchJourneyIntro, researchTopicExample } from "./ResearchJourneyIntro";

const modeDescriptions = {
  normal: "原来的流程：一个主 Agent 围绕实验树自主迭代，适合快速验证。",
  team: "你提出课题，系统安排合适的专家；研究范围、实验和最终交付由你确认。",
};
export function ResearchModePicker({ value, onChange, onUseExample, hasDraft }: { value: ResearchMode | "normal"; onChange: (mode: ResearchMode | "normal") => void; onUseExample: (topic: string) => void; hasDraft: boolean }) {
  return <section className="mb-3 max-h-96 overflow-y-auto rounded-lg border border-border bg-background p-3 text-sm" aria-label="选择研究流程">
    <p className="mb-1 font-medium text-text">先说你想研究什么</p>
    <p className="mb-3 mt-0 text-xs leading-relaxed text-subtext">直接在下方输入问题即可。可以补充已有材料、期望结果、时间或预算限制；不清楚的部分，主理人会与你澄清。</p>
    <p className="mb-2 text-xs text-subtext">选择协作方式</p>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="主要研究模式">
      {(["normal", "team"] as const).map((mode) => {
        const Icon = mode === "team" ? Users : GitBranch;
        return <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)} className={`flex items-start gap-2 rounded-lg border p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-primary ${value === mode ? "border-primary bg-primary-subtle" : "border-border hover:bg-surface"}`}>
          <Icon size={18} className={value === mode ? "shrink-0 text-primary" : "shrink-0 text-subtext"} />
          <span><strong className="block text-text">{mode === "team" ? "科研专家团" : "原生自主探索"}</strong><span className="mt-1 block text-xs leading-relaxed text-subtext">{modeDescriptions[mode]}</span></span>
        </button>;
      })}
    </div>
    <p className="mt-2 flex items-center gap-1 text-xs text-subtext"><ArrowRight size={12} className="shrink-0" />{value === "normal" ? "提出问题 → 创建实验 → 运行验证 → 分析迭代" : value === "team" ? "提出问题 → 确认范围 → 形成方案 → 验证分析 → 独立审查 → 确认交付" : `${researchModes[value]}：围绕指定材料开展独立专家任务`}</p>
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2">
      <span className="text-xs text-subtext">只需要一项专家能力？</span>
      {(["design", "diagnosis", "review"] as const).map((mode) => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)} className={`rounded-md border px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-primary ${value === mode ? "border-primary bg-primary-subtle text-primary" : "border-border text-subtext hover:bg-surface hover:text-text"}`}>{researchModes[mode]}</button>)}
    </div>
    {value !== "normal" && value !== "team" && <div className="mt-3"><ResearchModulePreview mode={value} /></div>}
    <details key={value === "team" ? "team" : "other"} open={value === "team"} className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">了解专家团完整流程 · 我需要做什么？</summary>
      <div className="mt-2"><ResearchJourneyIntro compact /></div>
    </details>
    {(value === "normal" || value === "team") && <div className="mt-3 rounded-lg bg-surface p-3">
      <p className="mb-1 mt-0 text-xs font-medium text-text">普通用户可以这样提交</p>
      <p className="m-0 text-xs leading-relaxed text-subtext">{researchTopicExample}</p>
      <button type="button" disabled={hasDraft} onClick={() => { onChange("team"); onUseExample(researchTopicExample); }} className="mt-2 text-xs font-medium text-primary underline underline-offset-2 disabled:text-muted disabled:no-underline">{hasDraft ? "下方已有你的课题，可直接编辑后提交" : "填入这个课题试一试（可编辑，不会自动提交）"}</button>
    </div>}
  </section>;
}
