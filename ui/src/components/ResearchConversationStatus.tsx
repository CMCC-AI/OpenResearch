import { CheckCircle2, ChevronRight, CircleDot, CircleHelp } from "lucide-react";
import type { ResearchConversationStatus as Status } from "../researchConversationStatus";

export function ResearchConversationStatus({ status, onOpen }: { status: Status; onOpen?: () => void }) {
  const tone = status.kind === "confirmation" || status.kind === "attention" ? "text-accent-amber"
    : status.kind === "complete" ? "text-accent-green"
    : status.kind === "idle" ? "text-subtext" : "text-primary";
  const Icon = status.kind === "complete" ? CheckCircle2
    : status.kind === "confirmation" || status.kind === "attention" ? CircleHelp : CircleDot;
  const content = <><Icon size={13} className="shrink-0" aria-hidden="true" /><span>{status.label}</span>{onOpen && <ChevronRight size={12} className="shrink-0" aria-hidden="true" />}</>;
  return <div role="status" className={`min-w-0 text-xs ${tone}`}>
    {onOpen ? <button type="button" onClick={onOpen} title="查看专家团进度与人工确认" className="flex min-w-0 items-center gap-1.5 rounded text-start hover:underline focus-visible:outline-2 focus-visible:outline-primary">{content}</button>
      : <span className="flex min-w-0 items-center gap-1.5">{content}</span>}
  </div>;
}
