import type { ComposerAttachment } from "./composerStash";
import type { ChatImageAttachment } from "./api";
import { projectRequest } from "./readOnlyApi";

export const MAX_MATERIAL_FILE = 32 * 1024 * 1024;
export const MAX_MATERIAL_TOTAL = 512 * 1024 * 1024;
export function validateMaterialFiles(files: { name: string; size: number }[], existing: { size: number }[] = []) {
  if (files.length + existing.length > 2000) throw new Error("每次最多上传 2000 个文件。");
  for (const file of files) if (file.size > MAX_MATERIAL_FILE) throw new Error(`${file.name} 超过 32 MiB。`);
  if ([...files, ...existing].reduce((n, f) => n + f.size, 0) > MAX_MATERIAL_TOTAL) throw new Error("材料总大小不能超过 512 MiB。");
}
const ignoredMaterialPath = (path: string) => path.split("/").some(part =>
  [".git", "node_modules", "__pycache__", ".DS_Store", "__MACOSX", "Thumbs.db"].includes(part));

export function pendingMaterials(files: File[], paths?: string[]): ComposerAttachment[] {
  const entries = files.map((file, i) => ({
    file, dataUrl: "", mediaType: file.type || "application/octet-stream",
    name: paths?.[i] || file.webkitRelativePath || file.name, size: file.size,
  })).filter(entry => !ignoredMaterialPath(entry.name));
  validateMaterialFiles(entries);
  return entries;
}

/** Read every batch of directory entries; Chromium may return only 100 per batch. */
export async function droppedMaterials(transfer: DataTransfer): Promise<ComposerAttachment[]> {
  const items = Array.from(transfer.items).filter(i => i.kind === "file");
  if (!items.length) return pendingMaterials(Array.from(transfer.files));
  // Capture browser-owned items before awaiting; the drop data store expires after the event.
  const captured = items.map(item => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile?.() }));
  if (captured.some(item => !item.entry && !item.file)) {
    throw new Error("浏览器无法读取拖入的材料，请使用文件或文件夹选择按钮。");
  }
  const result: ComposerAttachment[] = [];
  const visit = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = prefix + entry.name;
    if (ignoredMaterialPath(path)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      validateMaterialFiles([file], result);
      result.push(...pendingMaterials([file], [path]));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) await visit(child, `${path}/`);
      }
    }
  };
  for (const { entry, file } of captured) {
    if (entry) await visit(entry, "");
    else if (file) {
      const pending = pendingMaterials([file]);
      validateMaterialFiles(pending.map(a => ({ name: a.name || file.name, size: a.size })), result);
      result.push(...pending);
    }
  }
  return result;
}

type Snapshot = { id: string; projectId: string; ready: boolean; files: { id: string; path: string; status: string; note?: string }[] };
// Same draft retry reuses its upload; no repeated copies after a message/network failure.
const uploads = new WeakMap<ComposerAttachment[], Map<string, { id?: string; promise?: Promise<ChatImageAttachment[]>; complete?: ChatImageAttachment[] }>>();
async function response<T>(result: Response): Promise<T> {
  if (!result.ok) throw new Error(`材料上传失败：${await result.text()}`);
  return result.json() as Promise<T>;
}
export async function prepareMaterialAttachments(projectId: string, attachments: ComposerAttachment[]): Promise<ChatImageAttachment[]> {
  if (!attachments.some(a => a.file)) return attachments.map(a => ({ mediaType: a.mediaType, dataBase64: a.dataUrl.slice(a.dataUrl.indexOf(",") + 1), name: a.name }));
  let projects = uploads.get(attachments);
  if (!projects) { projects = new Map(); uploads.set(attachments, projects); }
  let state = projects.get(projectId);
  if (!state) { state = {}; projects.set(projectId, state); }
  if (state.complete) return state.complete;
  if (state.promise) return state.promise;
  const current = state;
  current.promise = (async () => {
    const base = `/api/projects/${encodeURIComponent(projectId)}/materials`;
    if (!current.id) current.id = (await response<Snapshot>(await projectRequest(base, { method: "POST" }))).id;
    const previous = await response<Snapshot>(await projectRequest(`${base}/${current.id}`));
    if (!previous.ready) for (const attachment of attachments.filter(a => a.file)) {
      await response<Snapshot>(await projectRequest(`${base}/${current.id}/files?path=${encodeURIComponent(attachment.name || attachment.file!.name)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: attachment.file }));
    }
    const snapshot = await response<Snapshot>(await projectRequest(`${base}/${current.id}/finalize`, { method: "POST" }));
    const legacy = attachments.filter(a => !a.file).map(a => ({ mediaType: a.mediaType, dataBase64: a.dataUrl.slice(a.dataUrl.indexOf(",") + 1), name: a.name }));
    current.complete = [...legacy, { mediaType: "application/vnd.orx.materials", dataBase64: "", materialId: snapshot.id, name: `研究材料 · ${snapshot.files.length} 个文件` }];
    return current.complete;
  })();
  try { return await current.promise; } finally { current.promise = undefined; }
}
