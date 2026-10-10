import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Users, X } from "lucide-react";
import { researchModes } from "../research";
import { ResearchJourneyIntro } from "./ResearchJourneyIntro";
import { ResearchModulePreview } from "./ResearchModulePreview";
import { useDialogFocus } from "./useDialogFocus";
import { Button, IconButton } from "./ui";

export function ResearchOverviewDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose);
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-background text-text shadow-elevated" onClick={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-4"><h2 id={titleId} className="flex items-center gap-2 font-semibold"><Users size={20} className="text-primary" />科研专家团 · 流程导览</h2><IconButton data-initial-focus aria-label="关闭专家团导览" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-5">
        <p className="text-sm text-subtext">当前会话尚未关联专家团研究。这里展示完整流程和单项会诊能力；新建会话时选择科研专家团，或从当前对话发起单项会诊，登记计划后即可查看真实分工、任务 DAG 与执行成果。</p>
        <ResearchJourneyIntro />
        <section aria-label="单项会诊模块"><h3 className="mb-2 text-sm font-medium">也可以独立使用以下模块</h3><div className="flex flex-col gap-2">{(["design", "diagnosis", "review"] as const).map((mode) => <details key={mode} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium text-primary">{researchModes[mode]} · 查看子流程与专家</summary><div className="mt-3"><ResearchModulePreview mode={mode} /></div></details>)}</div></section>
      </div>
    </div>
  </div>, document.body);
}


export function ResearchStateErrorDialog({ error, onRetry, onClose, loading = false }: { loading?: boolean; error: string; onRetry: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose);
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="w-full max-w-lg rounded-xl border border-border bg-background p-4 text-text shadow-elevated" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between"><h2 id={titleId} className="font-semibold">{loading ? "正在读取专家团状态…" : "科研专家团状态读取失败"}</h2><IconButton data-initial-focus aria-label="关闭研究状态提示" onClick={onClose}><X size={18} /></IconButton></div><p role={loading ? "status" : "alert"} className={`my-3 break-words text-sm ${loading ? "text-subtext" : "text-accent-red"}`}>{loading ? "正在加载真实计划和执行状态，请稍候。" : error}</p><Button disabled={loading} onClick={onRetry}>重试</Button></div></div>, document.body);
}
