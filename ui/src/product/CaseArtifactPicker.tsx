import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Folder, FileText } from "lucide-react";
import type { ArtifactEntry } from "../api";
import { fmtBytes } from "../api";
import { listCaseArtifacts, type CaseArtifacts } from "./caseArtifacts";

export function CaseArtifactPicker({ queryScope, projectId, sessionId, listing, paths, onChange, disabled }: { queryScope: string; projectId: string; sessionId: string; listing: CaseArtifacts; paths: string[]; onChange: (paths: string[]) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className="min-w-0 rounded-lg border border-border p-3"><legend className="px-1 text-sm font-medium">选择公开的成果目录或文件</legend><p className="mt-0 text-xs text-subtext">仅复制勾选内容。建议选择论文、图表、报告等成果；批量特征、缓存和其他中间数据保持不勾选。</p>
    {!listing.entries.length && <p className="text-sm text-subtext">这个对话尚无登记的研究成果目录，可以仅发布对话记录。</p>}
    <div className="max-h-80 overflow-auto">{listing.entries.map(entry => <ArtifactRow key={entry.path} entry={entry} queryScope={queryScope} rootTitle={listing.roots.find(root => root.path === entry.path)?.title} projectId={projectId} sessionId={sessionId} paths={paths} onChange={onChange} />)}</div>
  </fieldset>;
}
function ArtifactRow({ entry, rootTitle, queryScope, projectId, sessionId, paths, onChange, inherited = false }: { entry: ArtifactEntry; rootTitle?: string; queryScope: string; projectId: string; sessionId: string; paths: string[]; onChange: (paths: string[]) => void; inherited?: boolean }) {
  const [expanded, setExpanded] = useState(Boolean(rootTitle));
  const children = useQuery({ queryKey: ["case-artifact-children", queryScope, projectId, sessionId, entry.path], queryFn: () => listCaseArtifacts(projectId, sessionId, entry.path), enabled: expanded && entry.isDir && !rootTitle });
  const checked = inherited || paths.includes(entry.path);
  const rows = rootTitle ? entry.children ?? [] : children.data?.entries.find(row => row.path === entry.path)?.children ?? [];
  return <div className="min-w-0"><div className="flex min-w-0 items-center gap-2 py-1 text-sm">
    {entry.isDir ? <button type="button" aria-label={`${expanded ? "收起" : "展开"}成果目录 ${entry.name}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="inline-flex shrink-0 p-1">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="w-5 shrink-0" />}
    {!rootTitle && <input type="checkbox" aria-label={`公开 ${entry.path}`} checked={checked} disabled={inherited} onChange={event => onChange(event.target.checked ? [...paths.filter(path => !path.startsWith(`${entry.path}/`)), entry.path] : paths.filter(path => path !== entry.path))} />}
    {entry.isDir ? <Folder size={15} className="shrink-0 text-subtext" /> : <FileText size={15} className="shrink-0 text-subtext" />}<span className="truncate" title={entry.path}>{rootTitle || entry.name}</span>{!entry.isDir && <span className="shrink-0 text-xs text-subtext">{fmtBytes(entry.size)}</span>}
  </div>{expanded && entry.isDir && <div className="ml-4 border-l border-border pl-2">{!rootTitle && children.isPending && <p role="status" className="text-xs text-subtext">正在读取目录…</p>}{children.error && <p role="alert" className="text-xs text-accent-red">{children.error.message}</p>}{rows.map(child => <ArtifactRow key={child.path} entry={child} queryScope={queryScope} projectId={projectId} sessionId={sessionId} paths={paths} onChange={onChange} inherited={checked} />)}</div>}</div>;
}
