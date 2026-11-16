import type { WorkflowDraft } from "./model.ts";

export const workflowConversationRequest = (workflow: Pick<WorkflowDraft, "name">) => `请使用工作流「${workflow.name}」，根据下面的需求开展研究：\n`;
const handoffs = new Map<string, string>();
const keyFor = (projectId: string, sessionId: string | null) => `mobilesci.workflowConversation.${JSON.stringify([projectId, sessionId])}`;

/** Selection prepares a draft only. Sending stays a deliberate chat action. */
export function stageWorkflowConversation(projectId: string, sessionId: string | null, workflow: Pick<WorkflowDraft, "name">) {
  const key = keyFor(projectId, sessionId), text = workflowConversationRequest(workflow);
  handoffs.set(key, text);
  try { localStorage.setItem(key, text); } catch { /* In-memory handoff remains available. */ }
}

export function takeWorkflowConversation(projectId: string, sessionId: string | null): string | null {
  const key = keyFor(projectId, sessionId);
  let text = handoffs.get(key) ?? null;
  try { text ??= localStorage.getItem(key); localStorage.removeItem(key); } catch { /* Optional storage. */ }
  handoffs.delete(key);
  return text;
}
