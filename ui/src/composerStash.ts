import type { ChatTextAnnotation } from "./api";

/** Per-chat stash for unsent composer content (draft, attachments, annotations). */
export interface ComposerAttachment {
  /** Kept in the draft until transferred to the project material store. */
  file?: File;
  dataUrl: string;
  mediaType: string;
  name?: string;
  size: number;
}

export interface ComposerAnnotation extends ChatTextAnnotation {
  id: string;
  range?: Range;
}

export interface ComposerStash {
  draft: string;
  workMode?: import("./components/WorkModeSwitch").WorkMode;
  attachments: ComposerAttachment[];
  annotations: ComposerAnnotation[];
}

export const EMPTY_COMPOSER_STASH: ComposerStash = {
  draft: "",
  attachments: [],
  annotations: [],
};

/** What a composer scope leaves behind, or null when it holds nothing of the
 * user's — empty, or only the untouched demo prefill, which re-seeds itself.
 * Annotation Ranges reference transcript DOM that won't exist on return. */
export function composerStashContent(
  live: ComposerStash,
  prefillDraft: string | null,
): ComposerStash | null {
  const emptyDraft = live.draft === "" || live.draft === prefillDraft;
  if (emptyDraft && live.attachments.length === 0 && live.annotations.length === 0) {
    return null;
  }
  return {
    ...live,
    annotations: live.annotations.map(({ range: _range, ...annotation }) => annotation),
  };
}

// Route navigation unmounts the chat; keep drafts in memory until the runtime identity changes.
let stashGeneration = -1;
let routeStashes = new Map<string, ComposerStash>();
export function getComposerStashStore(generation: number): Map<string, ComposerStash> {
  if (generation !== stashGeneration) {
    routeStashes = new Map();
    stashGeneration = generation;
  }
  return routeStashes;
}
