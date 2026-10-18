import { Users } from "lucide-react";
import { presetWorkflowModes, researchModes } from "../research";
import { ResearchModulePreview } from "./ResearchModulePreview";

/** Original SOP routes; actual assignments remain in the persisted study. */
export function ResearchJourneyIntro({ compact = false }: { compact?: boolean }) {
  return <section aria-label="科研专家团流程预览" className="rounded-xl border border-border bg-canvas p-3 sm:p-4">
    <h3 className="m-0 flex items-center gap-2 text-sm font-semibold text-text"><Users size={17} className="text-primary" />科研专家团 · 预设流程</h3>
    <p className="mb-0 mt-2 text-xs leading-relaxed text-subtext">默认由主理人根据目标和材料判断研究路径，也可手动指定以下流程。主理人登记专家分工并推进任务。下方为流程说明，尚未开始研究。</p>
    <div className={`mt-3 grid gap-2 ${compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
      {presetWorkflowModes.map((mode) => <details key={mode} className="rounded-lg border border-border bg-background p-3"><summary className="cursor-pointer text-sm text-primary">{researchModes[mode]}</summary><div className="mt-3"><ResearchModulePreview mode={mode} /></div></details>)}
    </div>
  </section>;
}
