import { Link } from "@tanstack/react-router";
import { ArrowRight, BarChart3, BookOpen, Code2, Database, FileText, Paperclip } from "lucide-react";
import { quickCapabilities } from "./researchCapabilities";

export function ResearchStartPanel({ onStart }: { onStart: () => void }) {
  return <section className="mb-8">
    <div className="mb-7 flex items-start justify-between gap-6 [@media((max-width:_680px))]:flex-col"><div><h1 className="m-0 text-5xl tracking-[-0.045em]">今天，想推进哪一项研究？</h1><p className="mt-3 mb-0 text-lg text-subtext">从一个问题、一篇论文、一组数据或一份草稿开始，科研智能体将按需协作。</p></div><Link to="/capabilities" className="shrink-0 text-sm font-medium text-primary no-underline">查看能力全景 <ArrowRight className="inline" size={15} /></Link></div>
    <button onClick={onStart} className="group block w-full rounded-2xl border border-border bg-background p-5 text-start shadow-hairline transition-shadow hover:shadow-card">
      <span className="block min-h-20 text-lg text-muted">描述你的研究目标，或从论文、代码、数据与草稿开始……</span>
      <span className="flex flex-wrap items-center gap-2 border-t border-border-variant pt-4"><span className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><FileText size={16} />论文</span><span className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Code2 size={16} />代码</span><span className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Database size={16} />数据</span><span className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Paperclip size={16} />草稿</span><span className="ms-auto inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-background">开始研究 <ArrowRight size={16} /></span></span>
    </button>
    <div className="mt-4 grid grid-cols-6 gap-2 [@media((max-width:_1000px))]:grid-cols-3 [@media((max-width:_580px))]:grid-cols-2">{quickCapabilities.map(({ title, icon: Icon }) => <button key={title} onClick={onStart} className="inline-flex items-center justify-center gap-2 rounded-full border border-border-variant bg-background px-3 py-2.5 text-sm text-subtext hover:border-border hover:text-text"><Icon size={16} />{title}</button>)}</div>
    <div className="mt-5 flex flex-wrap items-center gap-5 text-xs text-muted"><span className="inline-flex items-center gap-1"><BookOpen size={14} />三类论文来源</span><span className="inline-flex items-center gap-1"><BarChart3 size={14} />真实运行与结果</span><span>Agent · Experiment · Run · Artifact</span></div>
  </section>;
}
