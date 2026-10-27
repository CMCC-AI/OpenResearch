import type { ChatSession } from "./api";
import { expertRoles, type ResearchStudy } from "./research.ts";

/** Generated helpers are reached through their parent, never removed from storage. */
export function isSidebarSession(session: Pick<ChatSession, "parentSessionId" | "sideParentSessionId">) {
  return !session.parentSessionId && !session.sideParentSessionId;
}

export function mainSessionId(id: string | null, sessions: readonly Pick<ChatSession, "id" | "parentSessionId" | "sideParentSessionId">[]): string | null {
  const lookup = new Map(sessions.map((session) => [session.id, session]));
  const visited = new Set<string>();
  let current = id;
  while (current && !visited.has(current)) {
    visited.add(current);
    const session = lookup.get(current);
    const parent = session?.parentSessionId ?? session?.sideParentSessionId;
    if (!parent) return current;
    current = parent;
  }
  return id;
}

export function expertSessionContext(session: ChatSession | undefined, study: ResearchStudy | null | undefined) {
  if (!session?.parentSessionId) return null;
  const task = study?.plans.slice().reverse().flatMap((plan) => plan.tasks).find((task) => task.sessionId === session.id);
  return {
    mainSessionId: study?.sessionId ?? session.parentSessionId,
    name: task ? expertRoles[task.role] ?? "专家子对话" : "专家子对话",
    task: task?.brief ?? null,
  };
}
