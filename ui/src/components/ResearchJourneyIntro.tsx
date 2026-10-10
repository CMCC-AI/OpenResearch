import { ArrowRight, CheckCircle2, Users } from "lucide-react";

const journey = [
  { title: "说清问题", description: "主理人理解你的目标与已有材料", confirmation: false },
  { title: "确认范围", description: "确认要研究什么、做到什么程度", confirmation: true },
  { title: "形成方案", description: "按需安排专家检索资料、设计方法", confirmation: false },
  { title: "确认实验", description: "需要实验时，由你确认资源与执行方案", confirmation: true },
  { title: "验证与分析", description: "专家执行任务，保留真实结果与证据", confirmation: false },
  { title: "独立审查", description: "另由审查专家检查结论和引用", confirmation: false },
  { title: "确认交付", description: "确认报告、研究局限与研究包", confirmation: true },
];

/** Explain the journey before a Study exists; never present preview as live progress. */
export function ResearchJourneyIntro({ compact = false }: { compact?: boolean }) {
  return <section aria-label="科研专家团流程预览" className="rounded-xl border border-border bg-canvas p-3 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="m-0 flex items-center gap-2 text-sm font-semibold text-text"><Users size={17} className="text-primary" />科研专家团如何推进一个课题？</h3><p className="mb-0 mt-1 text-xs leading-relaxed text-subtext">你提出问题，主理人负责拆解任务、安排专家和汇总结果。无需了解专家名单或编写流程指令。</p></div>
      <span className="rounded-full border border-border px-2 py-1 text-xs text-muted">流程预览 · 尚未开始</span>
    </div>
    <ol className={`mt-3 grid gap-2 ${compact ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"}`}>
      {journey.map((stage, index) => <li key={stage.title} className="rounded-lg border border-border-variant bg-background p-3">
        <div className="flex items-center gap-2"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary-subtle text-xs font-medium text-primary">{index + 1}</span><strong className="text-sm text-text">{stage.title}</strong>{index < journey.length - 1 && <ArrowRight size={14} className="ms-auto shrink-0 text-muted" aria-hidden="true" />}</div>
        <p className="mb-0 mt-2 text-xs leading-relaxed text-subtext">{stage.description}</p>
        {stage.confirmation && <span className="mt-2 inline-flex items-center gap-1 text-xs text-primary"><CheckCircle2 size={12} />你来确认</span>}
      </li>)}
    </ol>
    <p className="mb-0 mt-3 text-xs leading-relaxed text-subtext">会根据课题选择环节；不需要实验的课题会跳过实验。提交后，实际专家分工与实时进度将在研究流程图中显示。</p>
  </section>;
}

export const researchTopicExample = "我想比较固定学习率和逐步降低学习率，对一个简单预测模型的效果有什么影响。我没有现成数据，希望先用模拟数据，在本机做一个小实验，不使用付费算力。最后请给我结果表和通俗解释，并指出这个实验能说明什么、不能说明什么。";
