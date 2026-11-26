import type { WorkflowDraft } from "./model.ts";

export const workflowConversationRequest = (workflow: Pick<WorkflowDraft, "name">) => `请使用工作流「${workflow.name}」，根据下面的需求开展研究：\n`;
/** 技能库 → 对话的交接文案：先把“做什么 / 什么时候用 / 产出什么”问清楚，
 *  建好后用 orx skills add 登记，回到技能库就能看到。 */
export const skillConversationRequest = () =>
  "请帮我创建一个可复用技能：\n- 做什么：\n- 什么时候用（触发场景）：\n- 产出什么：\n\n写好后用 `orx skills add` 登记，并告诉我技能名。\n";
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
