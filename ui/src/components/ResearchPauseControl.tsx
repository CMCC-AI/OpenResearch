import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { pauseResearchStudy, resumeResearchStudy } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import type { ResearchStudy } from "../research";
import { IconButton, Spinner } from "./ui";
import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";

/** Composer-side pause/resume beside the send key; reversible, so no confirm dialog. */
export function ResearchPauseControl({ study }: { study: ResearchStudy }) {
  const readOnly = useReadOnlyWorkspace();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (readOnly || (study.status !== "active" && study.status !== "paused")) return null;
  const paused = study.status === "paused";
  const toggle = async () => {
    setWorking(true); setError(null);
    try {
      await (paused ? resumeResearchStudy : pauseResearchStudy)(study.id, study.plans.at(-1)?.version ?? 0);
      void queryClient.invalidateQueries({ queryKey: workspaceKey("researchStudy", study.sessionId) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setWorking(false); }
  };
  const label = paused ? "继续研究" : "暂停研究";
  return <span className="relative inline-flex items-center">
    <IconButton aria-label={label} data-tip={label} disabled={working} onClick={() => void toggle()}>
      {working ? <Spinner aria-hidden="true" /> : paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
    </IconButton>
    {error && <span role="alert" className="absolute end-0 top-full z-20 mt-1 w-56 rounded border border-border bg-background p-2 text-xs text-accent-red shadow-elevated">{error}</span>}
  </span>;
}
