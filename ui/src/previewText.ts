export interface PreviewText { content: string; binary: boolean; truncated: boolean }
/** BOM-marked UTF-16 is previewable; never guess legacy encodings or decode arbitrary binary lossily. */
export function decodePreviewText(bytes: ArrayBuffer | Uint8Array, truncated = false): PreviewText {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
  if (encoding === "utf-8" && data.includes(0)) return { content: "", binary: true, truncated };
  try {
    const content = new TextDecoder(encoding, { fatal: true }).decode(data, { stream: truncated });
    return { content: content.includes("\0") ? "" : content, binary: content.includes("\0"), truncated };
  } catch { return { content: "", binary: true, truncated }; }
}

/** Enforce the read cap even when an older server ignores Range or omits Content-Length. */
export async function readPreviewResponse(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.length, remaining);
      if (value.length > remaining) { truncated = true; await reader.cancel(); break; }
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, truncated };
}
