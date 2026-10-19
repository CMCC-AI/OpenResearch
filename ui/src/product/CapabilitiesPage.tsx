import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { capabilityStages } from "./researchCapabilities";
import { PlatformFrame } from "./ProductNav";
import stage1 from "../assets/workbench/capability-stage-1.png";
import stage2 from "../assets/workbench/capability-stage-2.png";
import stage3 from "../assets/workbench/capability-stage-3.png";
import stage4 from "../assets/workbench/capability-stage-4.png";
import stage5 from "../assets/workbench/capability-stage-5.png";
import flowStrip from "../assets/workbench/capability-flow-strip.png";
import supportPhoto from "../assets/workbench/capability-support.png";
import chevron from "../assets/workbench/capability-chevron.svg";
import chevronDown from "../assets/workbench/capability-chevron-down.svg";
import arrow from "../assets/workbench/capability-arrow.svg";
import support1 from "../assets/workbench/capability-support-1.svg";
import support2 from "../assets/workbench/capability-support-2.svg";
import support3 from "../assets/workbench/capability-support-3.svg";
import support4 from "../assets/workbench/capability-support-4.svg";
import support5 from "../assets/workbench/capability-support-5.svg";

const stageIcons: Record<string, { src: string; className: string }> = {
  "01": { src: stage1, className: "object-cover" },
  "02": { src: stage2, className: "object-contain" },
  "03": { src: stage3, className: "object-cover object-[50%_52%]" },
  "04": { src: stage4, className: "object-cover" },
  "05": { src: stage5, className: "object-contain object-bottom" },
};

const supports = [
  { label: "全程支撑", icon: support1, photo: true },
  { label: "研究上下文", icon: support2, photo: true },
  { label: "证据与溯源", icon: support3, photo: true },
  { label: "人工确认", icon: support4, photo: true },
  { label: "算力接入", icon: support5, photo: true },
];

export function CapabilitiesPage() {
  return <PlatformFrame title="科研能力中心">
    <main className="min-h-0 flex-1 overflow-y-auto px-7 py-10 [@media((max-width:_960px))]:px-5 max-sm:px-4">
      <div className="mx-auto max-w-280">
        <header className="mb-8 flex items-end justify-between gap-8 [@media((max-width:_720px))]:items-start [@media((max-width:_720px))]:flex-col">
          <div>
            <h1 className="product-page-title m-0">科研能力全景</h1>
            <p className="product-page-description capabilities-subtitle m-0 mt-2.5">从研究问题到可信成果，一张图看清完整科研能力。</p>
          </div>
          <div className="text-end [@media((max-width:_720px))]:text-start">
            <Link to="/projects" search={{ new: true }} className="capabilities-gradient-text inline-flex items-center gap-0.5 text-base no-underline">点击任一能力，开始科研项目 <img src={arrow} alt="" className="capabilities-arrow h-2 w-3" /></Link>
            <p className="m-0 mt-2 text-xs text-muted">可从任一环节开始，按研究目标自由组合</p>
          </div>
        </header>

        <section className="capabilities-card relative overflow-hidden rounded-2xl pb-3">
          <img src={flowStrip} alt="" className="capabilities-flow-strip absolute inset-x-0 top-0 h-12 w-full" />
          <p className="capabilities-gradient-text relative z-10 m-0 flex h-12 items-center justify-center text-base">研究全流程 · 从问题到成果 · 持续迭代</p>
          <div className="relative z-10 mt-6 flex flex-wrap items-start justify-center [@media((max-width:_640px))]:flex-col [@media((max-width:_640px))]:items-center [@media((max-width:_640px))]:gap-4">
            {capabilityStages.map((stage, index) => (
              <Fragment key={stage.number}>
                <div className="relative flex min-w-28 flex-1 flex-col items-center">
                  <img src={stageIcons[stage.number].src} alt="" className={`h-14 w-15 ${stageIcons[stage.number].className}`} />
                  <h2 className="product-page-section-title m-0 mt-6 text-text">{stage.title}</h2>
                  <p className="m-0 text-base text-muted">{stage.subtitle}</p>
                </div>
                {index < capabilityStages.length - 1 && <img src={chevron} alt="" className="capabilities-chevron mt-5 hidden h-4 w-4 shrink-0 [@media((min-width:_640px))]:block" />}
              </Fragment>
            ))}
          </div>
        </section>

        <div className="mt-1 grid grid-cols-5 [@media((max-width:_1180px))]:hidden">
          {capabilityStages.map((stage) => (
            <div key={stage.number} className="flex justify-center">
              <img src={chevronDown} alt="" className="h-2 w-[9px] rotate-90" />
            </div>
          ))}
        </div>

        <div className="mt-1 grid grid-cols-5 gap-4 [@media((max-width:_1180px))]:grid-cols-2 [@media((max-width:_640px))]:grid-cols-1">
          {capabilityStages.map((stage) => (
            <div key={stage.number} className="capabilities-card flex min-h-70 flex-col justify-between gap-2 rounded-2xl p-4 [@media((max-width:_1180px))]:min-h-0">
              {stage.items.map((item) => (
                <Link key={item.title} to="/projects" search={{ new: true }} title={item.prompt}
                  className="capabilities-chip relative flex h-9 items-center justify-center rounded-md px-3 text-base no-underline">
                  <span>{item.title}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>

        <div className="capabilities-card mt-4 rounded-2xl p-4">
          <div className="flex flex-wrap items-center justify-center gap-4">
            {supports.map(({ label, icon, photo }) => (
              <div key={label} className="capabilities-support-chip relative flex h-14 w-40 items-center overflow-hidden rounded-md">
                <img src={icon} alt="" className={`ms-3.5 shrink-0 ${photo ? "h-[18px] w-[18px]" : "h-4 w-4"}`} />
                <span className="min-w-0 flex-1 text-center text-base font-medium">{label}</span>
                {photo && <img src={supportPhoto} alt="" className="absolute right-0 top-[9px] h-10 w-10 rounded-lg object-cover" />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  </PlatformFrame>;
}
