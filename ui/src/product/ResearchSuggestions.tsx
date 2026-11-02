import { useQuery } from "@tanstack/react-query";
import type { HarnessId } from "../api";
import { getProjectStarterPromptsQuery } from "../queries/projects";
import { resolveStarterPrompts } from "../starterPrompts";
import { getLocale } from "../paraglide/runtime.js";
import { m } from "../paraglide/messages.js";

/** Suggestions belong to the unified home, with defaults while generation loads or fails. */
export function ResearchSuggestions({ projectId, harness, model, onPick }: {
  projectId?: string; harness?: HarnessId; model: string | null; onPick: (prompt: string) => void;
}) {
  const query = useQuery({
    ...getProjectStarterPromptsQuery(projectId ?? "", harness ?? "claude-code", model, getLocale()),
    enabled: Boolean(projectId && harness),
  });
  const prompts = resolveStarterPrompts(query.data, [
    { title: m.chat_panel_starter_blank_1_title(), prompt: m.chat_panel_starter_blank_1_prompt() },
    { title: m.chat_panel_starter_blank_2_title(), prompt: m.chat_panel_starter_blank_2_prompt() },
    { title: m.chat_panel_starter_blank_3_title(), prompt: m.chat_panel_starter_blank_3_prompt() },
    { title: m.chat_panel_starter_blank_4_title(), prompt: m.chat_panel_starter_blank_4_prompt() },
  ]);
  return <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label={m.chat_panel_starter_prompts()}>
    {prompts.map((item, index) => <button key={index} type="button" onClick={() => onPick(item.prompt)} className="min-w-0 rounded-lg border border-border bg-background p-3 text-start hover:border-primary focus-visible:outline-primary">
      <span className="block text-sm text-primary">{item.title}</span>
      <span className="mt-1 line-clamp-2 text-xs text-subtext">{item.prompt}</span>
    </button>)}
  </div>;
}
