import type { ChatMessage } from "./api";

type Path = (string | number)[];
type Change = { op: "set"; path: Path; value: unknown } | { op: "append"; path: Path; text: string } | { op: "remove"; path: Path };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function isChatMessage(value: unknown): value is ChatMessage {
  return object(value) && typeof value.id === "string" && typeof value.role === "string" && Array.isArray(value.parts) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    && value.parts.every(part => object(part) && typeof part.id === "string" && typeof part.type === "string");
}
function update(value: unknown, change: Change, depth = 0): unknown {
  if (depth === change.path.length) {
    if (change.op === "set") return change.value;
    if (change.op === "append" && typeof value === "string" && typeof change.text === "string") return value + change.text;
    throw Error("Invalid message delta operation");
  }
  const key = change.path[depth];
  if (typeof key === "string" && ["__proto__", "constructor", "prototype"].includes(key)) throw Error("Unsafe message path");
  if (Array.isArray(value)) {
    if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key >= value.length) throw Error("Invalid array path");
    const copy = value.slice();
    copy[key] = update(value[key], change, depth + 1);
    return copy;
  }
  if (!object(value) || typeof key !== "string") throw Error("Invalid object path");
  const copy = { ...value };
  if (depth === change.path.length - 1 && change.op === "remove") {
    if (!Object.hasOwn(value, key)) throw Error("Missing delta path");
    delete copy[key];
  } else {
    if (!Object.hasOwn(value, key) && !(change.op === "set" && depth === change.path.length - 1)) throw Error("Missing delta path");
    copy[key] = update(value[key], change, depth + 1);
  }
  return copy;
}

/** Connection-local baselines; a missing/reordered delta requires snapshot repair. */
export class ChatMessageStream {
  private messages = new Map<string, { revision: number; message: ChatMessage }>();
  clear() { this.messages.clear(); }
  full(data: unknown): { sessionId: string; message: ChatMessage } | null {
    if (!object(data) || typeof data.sessionId !== "string" || !isChatMessage(data.message)) return null;
    if (Number.isSafeInteger(data.streamRevision) && Number(data.streamRevision) > 0) {
      const key = JSON.stringify([data.sessionId, data.message.id]);
      if (!this.messages.has(key) && this.messages.size >= 128) this.clear();
      this.messages.set(key, { revision: Number(data.streamRevision), message: data.message });
    }
    return { sessionId: data.sessionId, message: data.message };
  }
  delta(data: unknown): { sessionId: string; message: ChatMessage } | null {
    try {
      if (!object(data) || typeof data.sessionId !== "string" || typeof data.messageId !== "string" || !Array.isArray(data.changes) || data.changes.length > 4096) return null;
      const key = JSON.stringify([data.sessionId, data.messageId]);
      const old = this.messages.get(key);
      if (!old || old.revision !== data.baseRevision || data.revision !== old.revision + 1) return null;
      let message: unknown = old.message;
      for (const operation of data.changes) {
        if (!object(operation) || !["set", "append", "remove"].includes(String(operation.op)) || !Array.isArray(operation.path) || operation.path.length > 64) return null;
        message = update(message, operation as Change);
      }
      if (!isChatMessage(message) || message.id !== data.messageId) return null;
      this.messages.set(key, { revision: Number(data.revision), message });
      return { sessionId: data.sessionId, message };
    } catch { return null; }
  }
}
