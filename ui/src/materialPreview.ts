import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getReadOnlyApi, projectAssetUrl, projectRequest } from "./readOnlyApi";
import { readPreviewResponse, decodePreviewText } from "./previewText";
import { materialKind, materialUrl, MATERIAL_TEXT_LIMIT, MATERIAL_FILE_LIMIT, type MaterialFile } from "./materialReader";

export async function loadMaterialPreview(id: string, file: MaterialFile, signal: AbortSignal) {
  const kind = materialKind(file);
  if (kind === "unsupported") throw new Error("此格式暂不支持预览，请下载原件阅读。");
  const text = kind === "text" || kind === "markdown";
  const limit = text ? MATERIAL_TEXT_LIMIT : MATERIAL_FILE_LIMIT;
  if (file.size > limit) throw new Error(text ? "文本超过 1 MiB，请下载原件阅读；分段预览将在后续支持。" : "文件超过预览容量限制，请下载原件。");
  // Published cases read their immutable originals, never the viewer's private executor.
  const response = getReadOnlyApi()
    ? await fetch(projectAssetUrl(materialUrl(id, file.id, "download")), { signal })
    : await projectRequest(materialUrl(id, file.id, "preview"), { signal });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(typeof detail?.error === "string" ? detail.error : `预览读取失败（HTTP ${response.status}）`);
  }
  const { bytes, truncated } = await readPreviewResponse(response, limit);
  signal.throwIfAborted();
  if (truncated || bytes.length !== file.size || bytesToHex(sha256(bytes)) !== file.sha256) throw new Error("原件与本次导入版本不一致，无法预览。请重新导入或检查来源。");
  if (text) {
    const decoded = decodePreviewText(bytes);
    if (decoded.binary) throw new Error("无法将此文件解码为文本，请下载原件阅读。");
    return { kind, content: decoded.content, bytes: null };
  }
  return { kind, content: null, bytes };
}
