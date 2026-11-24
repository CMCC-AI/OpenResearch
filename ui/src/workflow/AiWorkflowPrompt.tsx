// AI 排流程：把一句话交给编排页的生成编排。进度、节点预览和落盘都由画布负责，
// 这里只收集句子，并在真正开始后收起弹层——生成慢也没关系，画布上能看到过程。
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "../components/ui";

export function AiWorkflowPrompt({ disabled = false, onGenerate }: {
  /** 画布内容还没就绪时先不开口，避免生成稿和随后加载到的草稿互相覆盖。 */
  disabled?: boolean;
  /** 开始生成；返回 false 表示没被采用（如用户拒绝替换），弹层保持打开。 */
  onGenerate: (intent: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState("");
  const request = intent.trim();

  function generate() {
    if (!request) return;
    if (onGenerate(request)) setOpen(false);
  }

  return <div className="relative" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <Button variant="ghost" disabled={disabled} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}><Sparkles size={14} />AI 排流程</Button>
    {open && <div role="dialog" aria-label="AI 排流程" className="absolute end-0 top-full z-50 mt-2 flex w-80 flex-col gap-2 rounded-md border border-border bg-background p-3 shadow-dropdown">
      <strong className="text-sm font-normal">用一句话描述这条流程</strong>
      <p className="m-0 text-xs text-subtext">比如：先检索文献，再筛选和精读，最后综合成一份综述报告。生成后会落到画布上，你可以随意调整。</p>
      <textarea className="min-h-20 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={intent} placeholder="这条流程要完成什么？" onChange={(event) => setIntent(event.target.value)} />
      <div className="flex items-center justify-between gap-2">
        <Button size="small" variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
        <Button size="small" variant="primary" disabled={!request} onClick={generate}>生成流程</Button>
      </div>
    </div>}
  </div>;
}
