// AI 排流程：把一句话变成画布草稿。挂在编排页，生成结果由调用方决定怎么落到画布。
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { generateWorkflowDraft } from "../api";
import { Button, showAlert, Spinner } from "../components/ui";
import { useLocale } from "../locale";
import { generatedToDraftInput, type WorkflowDraftInput } from "./model";

export function AiWorkflowPrompt({ disabled = false, onGenerated }: {
  /** 画布内容还没就绪时先不开口，避免生成稿和随后加载到的草稿互相覆盖。 */
  disabled?: boolean;
  /** 生成成功：把草稿交给画布；返回 false 表示没被采用（如用户拒绝替换），弹层保持打开。 */
  onGenerated: (draft: WorkflowDraftInput) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState("");
  const [generating, setGenerating] = useState(false);
  const locale = useLocale();

  async function generate() {
    const request = intent.trim();
    if (!request || generating) return;
    setGenerating(true);
    try {
      const generated = await generateWorkflowDraft({ intent: request, locale });
      // 画布没采用（例如用户拒绝替换）就保持弹层，一句话还在，可以直接重试。
      if (onGenerated(generatedToDraftInput(generated))) setOpen(false);
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setGenerating(false);
    }
  }

  return <div className="relative" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <Button variant="ghost" disabled={disabled} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}><Sparkles size={14} />AI 排流程</Button>
    {open && <div role="dialog" aria-label="AI 排流程" className="absolute end-0 top-full z-50 mt-2 flex w-80 flex-col gap-2 rounded-md border border-border bg-background p-3 shadow-dropdown">
      <strong className="text-sm font-normal">用一句话描述这条流程</strong>
      <p className="m-0 text-xs text-subtext">比如：先检索文献，再筛选和精读，最后综合成一份综述报告。生成后会落到画布上，你可以随意调整。</p>
      <textarea className="min-h-20 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={intent} placeholder="这条流程要完成什么？" onChange={(event) => setIntent(event.target.value)} />
      <div className="flex items-center justify-between gap-2">
        <Button size="small" variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
        <Button size="small" variant="primary" disabled={!intent.trim() || generating} onClick={() => void generate()}>
          {generating ? <span className="flex items-center gap-2"><Spinner />正在排版…</span> : "生成流程"}
        </Button>
      </div>
    </div>}
  </div>;
}
