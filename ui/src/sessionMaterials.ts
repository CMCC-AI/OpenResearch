/** Only registered materials in the active ancestry belong to this conversation. */
export function sessionMaterialIds(messages: { id: string; parentId?: string | null; parts: { type: string; text?: string | null }[] }[], leaf: string | null | undefined): string[] {
  const byId = new Map(messages.map(message => [message.id, message]));
  const visited = new Set<string>();
  const ids = new Set<string>();
  let message = leaf ? byId.get(leaf) : undefined;
  while (message && !visited.has(message.id)) {
    visited.add(message.id);
    for (const part of message.parts) if (part.type === "material" && part.text) ids.add(part.text);
    message = message.parentId ? byId.get(message.parentId) : undefined;
  }
  return [...ids];
}
