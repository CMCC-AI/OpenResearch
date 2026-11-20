/** 编辑器点了「在对话中使用」但还没有目标会话时，先把工作流记成待用标记；
 * 新对话页读到后预选工作流模式，首条消息发送时才真正绑定并锁定。 */

export interface PendingWorkflowUse {
  draftId: string;
  name: string;
}

const KEY = "mobilesci.pendingWorkflowUse";

export function stagePendingWorkflowUse(workflow: { id: string; name: string }) {
  try { localStorage.setItem(KEY, JSON.stringify({ draftId: workflow.id, name: workflow.name })); } catch { /* 隐私模式等场景忽略 */ }
}

/** 读出并清除标记；只在新会话（还没有会话 id）里调用，避免旧对话被误绑定。 */
export function takePendingWorkflowUse(): PendingWorkflowUse | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const { draftId, name } = parsed as Record<string, unknown>;
      if (typeof draftId === "string" && typeof name === "string") return { draftId, name };
    }
  } catch { /* 坏数据按没有标记处理 */ }
  return null;
}

export function clearPendingWorkflowUse() {
  try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
}
