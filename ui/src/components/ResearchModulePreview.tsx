import { ArrowRight } from "lucide-react";
import { consultationModules, researchPresets, expertRoles, researchModes, type ConsultationMode } from "../research";

export function ResearchModulePreview({ mode }: { mode: ConsultationMode }) {
  const module = consultationModules[mode];
  const preset = mode in researchPresets ? researchPresets[mode as keyof typeof researchPresets] : null;
  return <section aria-label={`${researchModes[mode]}模块预览`} className="rounded-lg border border-border bg-background p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-text">{researchModes[mode]}怎么做？</h3></div>
    <p className="mt-2 text-subtext">{module.purpose}</p>
    <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="font-medium text-text">你可以提供</dt><dd className="mt-1 leading-relaxed text-subtext">{module.inputs}</dd></div><div><dt className="font-medium text-text">你会得到</dt><dd className="mt-1 leading-relaxed text-subtext">{module.deliverables}</dd></div></dl>
    <ol className="mt-3 grid gap-2 sm:grid-cols-2">
      {module.steps.map((step, index) => <li key={step.title} className="rounded-lg border border-border bg-surface p-3">
        <div className="flex items-center gap-2"><span className="text-xs text-primary">{index + 1}</span><strong className="text-sm text-text">{step.title}</strong>{index < module.steps.length - 1 && <ArrowRight size={14} className="ms-auto text-muted" aria-hidden="true" />}</div>
        <p className="mt-1 text-xs leading-relaxed text-subtext">{step.description}</p>
        <ul className="mt-2 flex flex-wrap gap-1">{step.roles.map((role) => <li key={role} className="rounded border border-border bg-background px-2 py-1 text-xs text-subtext">{expertRoles[role]} · {module.requiredRoles.includes(role) ? "必需" : "按需"}</li>)}</ul>
      </li>)}
    </ol>
    <p className="mt-3 text-xs leading-relaxed text-subtext">{preset ? `${preset.rules} 实际分工与执行状态以已登记计划为准，预览不代表已调用专家。` : "此为历史会诊记录；实际分工以已登记计划为准，会诊不运行实验。"}</p>
  </section>;
}
