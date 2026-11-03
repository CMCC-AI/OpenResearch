import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { projectRequest } from "./readOnlyApi";
import { readPreviewResponse } from "./previewText";

export interface MaterialCitation {
  readEventId: string; packageId: string; source: string; path: string; sha256: string;
  format: "text" | "notebook" | "pdf"; page: number | null;
  offset: number; lineCount: number; contentBytes: number; contentSha256: string;
  readerSessionId: string | null; readerStudyId: string | null; readerPlanVersion: number | null;
}
const identityFields = ["readEventId", "packageId", "source", "path", "sha256", "format", "page", "offset", "lineCount", "contentBytes", "contentSha256", "readerSessionId", "readerStudyId", "readerPlanVersion"] as const;
export const citationUrl = (citation: MaterialCitation) => `/api/materials/${encodeURIComponent(citation.packageId)}/${encodeURIComponent(citation.source)}/citations/${encodeURIComponent(citation.readEventId)}`;
export const citationRange = (citation: MaterialCitation) => `${citation.page == null ? citation.format === "notebook" ? "Notebook 只读视图 · " : "" : `第 ${citation.page} 页 · `}第 ${citation.offset}–${citation.offset + citation.lineCount - 1} 行`;

export async function loadMaterialCitation(citation: MaterialCitation, signal: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(citation.offset) || citation.offset < 1 || !Number.isSafeInteger(citation.lineCount) || citation.lineCount < 1 || citation.lineCount > 1000
    || !Number.isSafeInteger(citation.offset + citation.lineCount) || !Number.isSafeInteger(citation.contentBytes) || citation.contentBytes < 1 || citation.contentBytes > 64 * 1024
    || !/^[a-f0-9]{64}$/.test(citation.sha256) || !/^[a-f0-9]{64}$/.test(citation.contentSha256)
    || !["text", "notebook", "pdf"].includes(citation.format)
    || (citation.format === "pdf" ? !Number.isSafeInteger(citation.page) || citation.page! < 1 : citation.page !== null)) throw new Error("引用来源信息不完整，无法核验原文选区。");
  const response = await projectRequest(citationUrl(citation), { signal, cache: "no-store" });
  // JSON escaping can expand the bounded 64 KiB text sixfold. Still cap the
  // response even if a stale backend returns a full file or the SPA shell.
  const { bytes, truncated } = await readPreviewResponse(response, 512 * 1024);
  signal.throwIfAborted();
  if (truncated) throw new Error("引用原文响应超过允许范围，无法显示。");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("无法读取引用原文，请检查后端版本并重试。"); }
  if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error.slice(0, 2048) : `引用原文读取失败（HTTP ${response.status}）`);
  if (!value || typeof value.content !== "string" || !value.citation || identityFields.some(field => value.citation[field] !== citation[field])) throw new Error("返回的来源与声明引用不一致，无法显示。");
  const content = new TextEncoder().encode(value.content);
  if (content.length !== citation.contentBytes || bytesToHex(sha256(content)) !== citation.contentSha256) throw new Error("返回正文与声明选区哈希不一致，无法显示。");
  return value.content;
}
