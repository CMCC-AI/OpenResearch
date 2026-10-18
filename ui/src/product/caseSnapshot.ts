import type { ChatMessage } from "../api";

export interface CaseMessage { id: string; parentId: string | null; role: "user" | "assistant"; createdAt: number; content: string }
export interface CaseSnapshot { sessions: { title: string; messages: CaseMessage[] }[] }

/** Copy every persisted part, including tools, prompts, reasoning and nested agent records.
 * Public readers render this as inert text; private file URLs are never followed. */
export function snapshotMessages(messages: ChatMessage[]): CaseMessage[] {
  const ids = new Map(messages.map((message, index) => [message.id, `message-${index + 1}`]));
  return messages.map((message) => ({
    id: ids.get(message.id)!,
    parentId: message.parentId ? ids.get(message.parentId) ?? null : null,
    role: message.role,
    createdAt: message.createdAt,
    content: message.parts.map((part) => part.type === "text" ? part.text ?? "" : JSON.stringify(part, null, 2)).join("\n\n"),
  }));
}
