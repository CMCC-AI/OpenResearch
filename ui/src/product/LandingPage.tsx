import { Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, BrainCircuit, ChartNoAxesCombined, Code2, FlaskConical, Search, Sparkles } from "lucide-react";
import { ProductWordmark } from "./ProductNav";
import { useAuthSession } from "./AuthSession";

const journey = [
  { icon: Search, title: "发现论文", text: "连接 alphaXiv、bioRxiv 与 OpenAlex，寻找真正相关的研究。" },
  { icon: BrainCircuit, title: "形成假设", text: "让科研 Agent 梳理证据、识别空白并定义可检验问题。" },
  { icon: Code2, title: "执行实验", text: "在 Git 分支和隔离运行中复现、迭代并保留完整日志。" },
  { icon: ChartNoAxesCombined, title: "沉淀成果", text: "分析结果、制作图表、撰写论文并导出可复现研究包。" },
];

export function LandingPage() {
  const { loading, user, login } = useAuthSession();
  return <main className="product-landing h-full overflow-y-auto bg-background text-text">
    <nav className="mx-auto flex max-w-330 items-center justify-between px-7 py-5">
      <ProductWordmark />
      <div className="flex items-center gap-7 text-sm [@media((max-width:_720px))]:hidden">
        <a href="#product" className="text-subtext no-underline hover:text-text">产品</a>
        <a href="#product" className="text-subtext no-underline hover:text-text">产品能力</a>
      </div>
      {user
        ? <Link to="/projects" className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-background no-underline">进入产品主页 <ArrowRight size={16} /></Link>
        : <button type="button" disabled={loading} onClick={login} className="inline-flex items-center gap-2 rounded-full border-0 bg-primary px-5 py-2.5 text-sm font-medium text-background disabled:opacity-60">登录 <ArrowRight size={16} /></button>}
    </nav>

    <section className="relative mx-auto grid min-h-[calc(100vh_-_74px)] max-w-330 grid-cols-[1.05fr_.95fr] items-center gap-12 overflow-hidden px-7 py-14 [@media((max-width:_860px))]:grid-cols-1">
      <div className="relative z-1 max-w-170">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-canvas px-3 py-1.5 text-xs text-subtext"><Sparkles size={14} className="text-primary" />AI 原生科研工作台</span>
        <h1 className="m-0 text-7xl leading-[1.04] tracking-[-0.065em] [@media((max-width:_720px))]:text-5xl">让科研智能体<br />与你共同推进<br /><span className="text-primary">每一次研究</span></h1>
        <p className="mt-7 max-w-150 text-xl leading-relaxed text-subtext">贯通论文发现、研究构思、实验验证、结果分析与科学写作。所有过程都有项目、代码、日志与证据可追溯。</p>
        <div className="mt-9 flex flex-wrap gap-3">
          {user
            ? <Link to="/projects" search={{ new: true }} className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 font-medium text-background no-underline">开始研究 <ArrowRight size={18} /></Link>
            : <button type="button" disabled={loading} onClick={login} className="inline-flex items-center gap-2 rounded-lg border-0 bg-primary px-6 py-3 font-medium text-background disabled:opacity-60">登录后开始研究 <ArrowRight size={18} /></button>}
          <a href="#product" className="inline-flex items-center gap-2 rounded-lg border border-border px-6 py-3 text-text no-underline hover:bg-canvas">了解能力</a>
        </div>
        <div className="mt-12 flex flex-wrap items-center gap-5 text-xs text-muted"><span>论文渠道</span><strong className="text-text">alphaXiv</strong><strong className="text-text">bioRxiv</strong><strong className="text-text">OpenAlex</strong><strong className="text-text">Deep Literature</strong></div>
      </div>

      <div className="relative min-h-145 [@media((max-width:_860px))]:min-h-110" aria-hidden="true">
        <div className="absolute inset-0 rounded-[2.5rem] bg-primary-subtle rotate-3" />
        <div className="absolute inset-8 overflow-hidden rounded-[2rem] border border-border bg-canvas shadow-card">
          <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(var(--dots-strong)_1px,transparent_1px)] [background-size:22px_22px]" />
          <div className="absolute left-[12%] top-[14%] w-[72%] rounded-2xl border border-border bg-background p-5 shadow-elevated">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium"><FlaskConical size={18} className="text-primary" />Research workspace</div>
            <div className="h-2 w-3/4 rounded-full bg-border-variant" /><div className="mt-2 h-2 w-1/2 rounded-full bg-border-variant" />
            <div className="mt-5 grid grid-cols-3 gap-2"><div className="h-20 rounded-lg bg-accent-blue-subtle" /><div className="h-20 rounded-lg bg-accent-green-subtle" /><div className="h-20 rounded-lg bg-accent-purple-subtle" /></div>
          </div>
          <div className="absolute bottom-[12%] left-[7%] flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 shadow-elevated"><BookOpen size={18} className="text-primary" /><span className="text-sm">证据已关联到论文原文</span></div>
          <div className="absolute bottom-[8%] right-[6%] rounded-xl bg-text px-4 py-3 text-sm text-background shadow-elevated">实验运行完成 · 4/4</div>
        </div>
      </div>
    </section>

    <section id="product" className="border-t border-border-variant bg-canvas px-7 py-20">
      <div className="mx-auto max-w-300"><p className="m-0 text-sm font-medium text-primary">完整科研闭环</p><h2 className="mt-3 mb-10 text-4xl tracking-[-0.035em]">从问题到可信成果，持续迭代</h2>
        <div className="grid grid-cols-4 gap-4 [@media((max-width:_860px))]:grid-cols-2 [@media((max-width:_520px))]:grid-cols-1">{journey.map(({ icon: Icon, title, text }, index) => <article key={title} className="rounded-xl border border-border-variant bg-background p-5"><span className="text-xs text-muted">0{index + 1}</span><Icon className="mt-8 text-primary" size={23} /><h3 className="mt-4 mb-2 text-lg">{title}</h3><p className="m-0 text-sm leading-relaxed text-subtext">{text}</p></article>)}</div>
      </div>
    </section>
  </main>;
}
