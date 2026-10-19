import type { NativeProjectSnapshot } from "./nativeProjectSnapshot";
import type { SavedResearch } from "../components/ReadOnlyWorkspace";
import type { ChatMessage, ChatPart, HarnessId, Experiment, Run } from "../api";

export interface CaseMessage { id: string; parentId: string | null; role: "user" | "assistant"; createdAt: number; content: string; parts?: ChatPart[]; completedAt?: number | null }
export interface CaseSession {
  id?: string; title: string; messages: CaseMessage[]; harness?: HarnessId;
  parentSessionId?: string | null; archived?: boolean; activeLeafId?: string | null;
  research?: SavedResearch;
}
export interface CaseSnapshot { workspace?: NativeProjectSnapshot; projectName?: string; sessions: CaseSession[]; experiments?: Experiment[]; runs?: Run[] }

/** Copy every persisted part, including tools, prompts, reasoning and nested agent records.
 * Public readers use an inert transcript renderer; private file URLs are never followed. */
export function snapshotMessages(messages: ChatMessage[]): CaseMessage[] {
  const ids = new Map(messages.map((message, index) => [message.id, `message-${index + 1}`]));
  return messages.map((message) => ({
    id: ids.get(message.id)!,
    parentId: message.parentId ? ids.get(message.parentId) ?? null : null,
    role: message.role,
    createdAt: message.createdAt,
    ...(message.completedAt != null ? { completedAt: message.completedAt } : {}),
    parts: structuredClone(message.parts),
    content: message.parts.map((part) => part.type === "text" ? part.text ?? "" : JSON.stringify(part, null, 2)).join("\n\n"),
  }));
}
