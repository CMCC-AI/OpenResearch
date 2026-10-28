import { isExternalMarkdownTarget, resolveMarkdownTarget } from "./markdownTarget.ts";

export interface MaterialFile { id: string; path: string; size: number; sha256: string; format: string; status: string; note?: string }
export interface MaterialPackage { id: string; projectId: string; createdAt?: number; ready?: boolean; files: MaterialFile[] }
export type MaterialKind = "pdf" | "image" | "markdown" | "text" | "unsupported";
export type MaterialNode = { kind: "folder"; path: string; name: string; children: MaterialNode[] }
  | { kind: "file"; path: string; name: string; file: MaterialFile };
export const MATERIAL_TEXT_LIMIT = 1024 * 1024;
export const MATERIAL_FILE_LIMIT = 32 * 1024 * 1024;
export function materialKind(file: MaterialFile): MaterialKind {
  if (file.format === "pdf" || file.format === "image") return file.format;
  if (file.format !== "text") return "unsupported";
  return /\.(md|markdown|mdown)$/i.test(file.path) ? "markdown" : "text";
}
export function materialStatus(file: MaterialFile): string {
  const statuses: Record<string, string> = { ready: "可读取", "on-demand": "按页读取", "needs-vision": "需视觉读取", unsupported: "需专用工具", failed: "解析失败", stored: "原件已保存" };
  return statuses[file.status] ?? file.status;
}
export function materialUrl(id: string, source: string, action: "preview" | "download") {
  return `/api/materials/${encodeURIComponent(id)}/${encodeURIComponent(source)}/${action}`;
}
export function materialMime(file: MaterialFile): string {
  if (materialKind(file) === "pdf") return "application/pdf";
  const ext = file.path.split(".").at(-1)?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" } as Record<string, string>)[ext ?? ""] ?? "text/plain;charset=utf-8";
}
export function materialTree(files: MaterialFile[]): MaterialNode[] {
  const root: MaterialNode[] = [];
  const folders = new Map<string, Extract<MaterialNode, { kind: "folder" }>>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.some(part => !part || part === "." || part === "..") || file.path.includes("\\")) throw new Error("材料目录包含无效路径");
    let children = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join("/");
      let folder = folders.get(path);
      if (!folder) { folder = { kind: "folder", path, name: parts[index], children: [] }; folders.set(path, folder); children.push(folder); }
      children = folder.children;
    }
    children.push({ kind: "file", path: file.path, name: parts.at(-1)!, file });
  }
  const collator = new Intl.Collator("zh-CN", { numeric: true });
  function sort(nodes: MaterialNode[]) {
    nodes.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || collator.compare(a.name, b.name));
    for (const node of nodes) if (node.kind === "folder") sort(node.children);
  }
  sort(root); return root;
}
/** Links resolve exclusively to this immutable package, never the host filesystem. */
export function materialLink(files: MaterialFile[], current: MaterialFile, target: string): MaterialFile | null {
  if (isExternalMarkdownTarget(target) || target.startsWith("/") || target.startsWith("#")) return null;
  const resolved = resolveMarkdownTarget(current.path.split("/").slice(0, -1).join("/"), target);
  return files.find(file => file.path === resolved?.path) ?? null;
}
export function materialLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
