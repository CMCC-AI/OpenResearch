import type { WorkflowDraft } from "./model.ts";

export const workflowConversationRequest = (workflow: Pick<WorkflowDraft, "name">) => `请使用工作流「${workflow.name}」，根据下面的需求开展研究：\n`;
export const skillConversationRequest = () => "请帮我把下面的操作步骤整理成一个可复用技能：\n";
const handoffs = new Map<string, string>();
const keyFor = (projectId: string, sessionId: string | null) => `mobilesci.composerHandoff.${JSON.stringify([projectId, sessionId])}`;

/** Selection prepares a draft only. Sending stays a deliberate chat action. */
export function stageComposerHandoff(projectId: string, sessionId: string | null, text: string) {
  const key = keyFor(projectId, sessionId);
  handoffs.set(key, text);
  try { localStorage.setItem(key, text); } catch { /* In-memory handoff remains available. */ }
}

export function stageWorkflowConversation(projectId: string, sessionId: string | null, workflow: Pick<WorkflowDraft, "name">) {
  stageComposerHandoff(projectId, sessionId, workflowConversationRequest(workflow));
}

export function takeComposerHandoff(projectId: string, sessionId: string | null): string | null {
  const key = keyFor(projectId, sessionId);
  let text = handoffs.get(key) ?? null;
  try { text ??= localStorage.getItem(key); localStorage.removeItem(key); } catch { /* Optional storage. */ }
  handoffs.delete(key);
  return text;
}
