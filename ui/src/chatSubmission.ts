export interface SubmissionReceipt {
  sessionId: string;
  clientTurnId: string;
  submission: { kind: string; id: string } | null;
}

/** A busy session and an absent receipt cannot establish ownership of a send. */
export async function reconcileSubmission({ sessionId, clientTurnId, isCurrent, lookup, rejected, timeoutMs = 3000 }: {
  sessionId: string;
  clientTurnId: string;
  isCurrent: () => boolean;
  lookup: (signal: AbortSignal) => Promise<SubmissionReceipt>;
  rejected: boolean;
  timeoutMs?: number;
}): Promise<"accepted" | "rejected" | "unknown" | "retired"> {
  if (!isCurrent()) return "retired";
  if (rejected) return "rejected";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Receipt lookup timed out")); }, timeoutMs);
    });
    const receipt = await Promise.race([lookup(controller.signal), deadline]);
    if (!isCurrent()) return "retired";
    return receipt?.sessionId === sessionId && receipt?.clientTurnId === clientTurnId
      && (receipt.submission?.kind === "turn" || receipt.submission?.kind === "queued")
      && typeof receipt.submission.id === "string" && receipt.submission.id.length > 0
      ? "accepted" : "unknown";
  } catch {
    return isCurrent() ? "unknown" : "retired";
  } finally {
    clearTimeout(timer);
  }
}
