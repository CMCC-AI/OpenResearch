import type { ChatSession, TurnOptions } from "./api";
import type { ComposerStash } from "./composerStash";

/** Commands and materials still use the full composer pipeline. Plain questions
 * must be accepted by the server before navigation can leave the start page. */
export function canStartQuestionDirectly(draft: ComposerStash): boolean {
  return Boolean(draft.draft.trim()) && !/^[\/!]/.test(draft.draft.trim())
    && draft.attachments.length === 0 && draft.annotations.length === 0;
}

export interface HomeQuestionAttempt {
  signature: string;
  session: ChatSession;
  clientTurnId: string;
  options: TurnOptions;
}

export async function submitHomeQuestion(attempt: HomeQuestionAttempt, text: string, {
  send, receipt, isCurrent,
}: {
  send: (sessionId: string, text: string, options: TurnOptions, clientTurnId: string) => Promise<unknown>;
  receipt: (sessionId: string, clientTurnId: string) => Promise<{ sessionId: string; clientTurnId: string; submission: { kind: string; id: string } | null }>;
  isCurrent: () => boolean;
}): Promise<void> {
  if (!isCurrent()) throw new DOMException("Workspace changed", "AbortError");
  try {
    await send(attempt.session.id, text.trim(), attempt.options, attempt.clientTurnId);
  } catch (error) {
    // A lost response may already have started the turn. Never create a new
    // session or a new request identity when retrying that question.
    if (!isCurrent()) throw error;
    const saved = await receipt(attempt.session.id, attempt.clientTurnId).catch(() => null);
    if (!saved || saved.sessionId !== attempt.session.id || saved.clientTurnId !== attempt.clientTurnId
      || !saved.submission?.id || !["turn", "queued", "steer"].includes(saved.submission.kind)) throw error;
  }
  if (!isCurrent()) throw new DOMException("Workspace changed", "AbortError");
}
