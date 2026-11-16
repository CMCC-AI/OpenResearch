import { runtimeFetch } from "../runtimeRequest.ts";
import type { ArtifactEntry, ProjectArtifacts } from "../api";

export interface CaseArtifacts extends ProjectArtifacts {
  scope: "conversation-results";
  sessionId: string;
  roots: { path: string; title: string }[];
}
export function selectedArtifactPaths(paths: readonly string[]) {
  const sorted = [...new Set(paths)].sort();
  if (sorted.some(path => !path || path.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".."))) throw new Error("成果路径无效。");
  return sorted.filter(path => !sorted.some(parent => parent !== path && path.startsWith(`${parent}/`)));
}
export async function listCaseArtifacts(projectId: string, sessionId: string, path?: string, recursive = false, request: typeof runtimeFetch = runtimeFetch): Promise<CaseArtifacts> {
  const query = new URLSearchParams({ sessionId, recursive: String(recursive) });
  if (path) query.set("path", path);
  const response = await request(`/api/projects/${encodeURIComponent(projectId)}/case-artifacts?${query}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 404) throw new Error("执行器尚未支持按对话选择成果，请更新执行器后重试。");
    throw new Error(body?.error || `成果目录读取失败（${response.status}）`);
  }
  const listing = await response.json() as CaseArtifacts;
  if (listing.scope !== "conversation-results" || listing.sessionId !== sessionId || listing.truncated || !Array.isArray(listing.roots) || !Array.isArray(listing.entries)) throw new Error("所选对话的成果目录未读取完整，请缩小范围后重试。");
  return listing;
}
export function mergeCaseArtifacts(listings: CaseArtifacts[], paths: readonly string[]): ProjectArtifacts {
  const entries = new Map<string, ArtifactEntry>();
  const selected = selectedArtifactPaths(paths);
  function add(entry: ArtifactEntry) {
    if (!selected.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) throw new Error("成果清单包含未勾选的文件。");
    entries.set(entry.path, { ...entry, children: [] });
    for (const child of entry.children ?? []) add(child);
  }
  for (const listing of listings) {
    if (listing.dir !== listings[0].dir || listing.sessionId !== listings[0].sessionId) throw new Error("成果来源发生变化，请重新选择。");
    for (const entry of listing.entries) add(entry);
  }
  for (const path of [...entries.keys()]) {
    let parent = path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (!entries.has(parent)) entries.set(parent, { name: parent.split("/").at(-1)!, path: parent, isDir: true, size: 0, modifiedAt: 0, children: [] });
    }
  }
  const roots: ArtifactEntry[] = [];
  for (const entry of entries.values()) {
    const parent = entry.path.includes("/") ? entries.get(entry.path.slice(0, entry.path.lastIndexOf("/"))) : null;
    if (parent) parent.children!.push(entry); else roots.push(entry);
  }
  function sort(rows: ArtifactEntry[]) { rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)); for (const row of rows) if (row.children?.length) sort(row.children); }
  sort(roots);
  return { dir: listings[0]?.dir ?? "", entries: roots, truncated: false };
}
export function artifactSelectionSummary(listing: ProjectArtifacts) {
  let files = 0, bytes = 0;
  function visit(rows: ArtifactEntry[]) { for (const row of rows) { if (row.isDir) visit(row.children ?? []); else { files++; bytes += row.size; } } }
  visit(listing.entries);
  return { files, bytes };
}
export async function selectedCaseArtifacts(projectId: string, sessionId: string, paths: readonly string[], request: typeof runtimeFetch = runtimeFetch) {
  const selected = selectedArtifactPaths(paths);
  if (selected.length > 200) throw new Error("一次最多选择 200 个成果路径，请按目录选择。");
  if (!selected.length) { const base = await listCaseArtifacts(projectId, sessionId, undefined, false, request); return { dir: base.dir, entries: [], truncated: false }; }
  const listings: CaseArtifacts[] = [];
  for (const path of selected) listings.push(await listCaseArtifacts(projectId, sessionId, path, true, request));
  const listing = mergeCaseArtifacts(listings, selected);
  const summary = artifactSelectionSummary(listing);
  if (summary.files > 2000 || summary.bytes > 512 * 1024 * 1024) throw new Error(`所选范围包含 ${summary.files.toLocaleString()} 个文件，约 ${(summary.bytes / 1024 / 1024).toFixed(1)} MiB；单个案例最多公开 2,000 个成果文件、512 MiB，请改选较小的成果子目录。`);
  return listing;
}
