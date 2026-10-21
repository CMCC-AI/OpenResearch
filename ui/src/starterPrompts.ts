import type { StarterPrompt } from "./api";

/** Keep the new-chat entry points available independently of model generation. */
export function resolveStarterPrompts(
  data: { blank: boolean; prompts: StarterPrompt[] | null } | undefined,
  defaults: StarterPrompt[],
): StarterPrompt[] {
  return !data?.blank && data?.prompts?.length ? data.prompts : defaults;
}
