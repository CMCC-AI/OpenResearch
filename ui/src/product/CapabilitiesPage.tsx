import { Link } from "@tanstack/react-router";
import { ArrowRight, FileText, ShieldCheck, Users } from "lucide-react";
import { capabilityStages } from "./researchCapabilities";
import { PlatformFrame } from "./ProductNav";

export function CapabilitiesPage() {
  return <PlatformFrame title="科研能力中心">
    <main className="min-h-0 flex-1 overflow-y-auto px-7 py-10">
      <div className="mx-auto max-w-330">
        <header className="mb-8 flex items-end justify-between gap-8 [@media((max-width:_720px))]:items-start [@media((max-width:_720px))]:flex-col">
          <div><h1 className="m-0 text-5xl tracking-[-0.045em]">科研能力全景</h1><p className="mt-3 mb-0 text-lg text-subtext">从研究问题到可信成果，一张图看清完整科研能力。</p></div>
          <div className="text-end text-sm [@media((max-width:_720px))]:text-start"><Link to="/projects" search={{ new: true }} className="inline-flex items-center gap-2 font-medium text-primary no-underline">点击任一能力，开始科研项目 <ArrowRight size={16} /></Link><p className="mt-2 mb-0 text-subtext">可从任一环节开始，按研究目标自由组合</p></div>
        </header>

        <section className="rounded-2xl border border-border bg-background p-5 shadow-hairline">
          <div className="mb-5 flex items-center justify-center gap-3 text-sm text-subtext"><span className="h-px flex-1 bg-border-variant" /><strong className="text-text">研究全流程 · 从问题到成果 · 持续迭代</strong><span className="h-px flex-1 bg-border-variant" /></div>
          <div className="grid grid-cols-5 gap-3 [@media((max-width:_1180px))]:grid-cols-2 [@media((max-width:_640px))]:grid-cols-1">
            {capabilityStages.map((stage) => <article key={stage.number} className="min-w-0 rounded-xl border border-border-variant bg-canvas p-3">
              <div className="mb-3 flex items-center gap-3 border-b border-border-variant px-1 pb-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-primary bg-background text-sm font-semibold text-primary">{stage.number}</span><div><h2 className="m-0 text-lg">{stage.title}</h2><p className="m-0 text-xs text-muted">{stage.subtitle}</p></div></div>
              <div className="flex flex-col gap-1">{stage.items.map(({ title, description, icon: Icon, prompt }) => <Link key={title} to="/projects" search={{ new: true }} title={prompt} className="group flex items-start gap-3 rounded-lg px-2 py-2.5 text-text no-underline hover:bg-background">
                <Icon size={17} className="mt-0.5 shrink-0 text-primary" /><span className="min-w-0"><strong className="block text-sm font-medium">{title}</strong><small className="mt-0.5 block leading-snug text-muted">{description}</small></span><ArrowRight size={14} className="ms-auto mt-1 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>)}</div>
            </article>)}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-6 rounded-xl bg-primary-subtle px-5 py-4 text-sm"><strong>全程支撑</strong><span className="inline-flex items-center gap-2"><FileText size={16} />研究上下文</span><span className="inline-flex items-center gap-2"><ShieldCheck size={16} />证据与溯源</span><span className="inline-flex items-center gap-2"><Users size={16} />人工确认</span><span className="inline-flex items-center gap-2">算力接入</span></div>
        </section>
      </div>
    </main>
  </PlatformFrame>;
}
