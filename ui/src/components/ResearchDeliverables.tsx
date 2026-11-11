import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Trophy } from "lucide-react";
import { artifactUrl, fmtBytes, getArtifactFileText, listResearchDeliveries } from "../api";
import { deliverableReportPath, researchModes, type ResearchMode } from "../research";
import { workspaceKey } from "../queries/client";
import { Button, ButtonLink, Spinner } from "./ui";
import { Md } from "./Md";
import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import type { ImageCandidate } from "../markdownTarget";

export function ResearchDeliverables({ projectId, onOpenWorkflow }: { projectId: string; onOpenWorkflow?: () => void }) {
  const readOnly = useReadOnlyWorkspace();
  const query = useQuery({
    queryKey: workspaceKey("researchDeliveries", projectId),
    queryFn: ({ signal }) => listResearchDeliveries(projectId, signal),
    staleTime: 30_000,
  });
  const [viewing, setViewing] = useState<{ studyId: string; path: string } | null>(null);
  const viewer = useQuery({
    queryKey: workspaceKey("researchDeliveryDoc", projectId, viewing?.studyId, viewing?.path),
    queryFn: ({ signal }) => getArtifactFileText(projectId, `research/${viewing!.studyId}/${viewing!.path}`, signal),
    enabled: Boolean(viewing),
    staleTime: 30_000,
  });
  const deliveries = query.data ?? [];
  const researchArtifactUrl = (studyId: string, path: string) => artifactUrl(projectId, `research/${studyId}/${path}`);
  const resolveImageSrc = (studyId: string, paths: Set<string>) => (src: string): ImageCandidate[] => {
    if (/^(https?:)?\/\//i.test(src)) return [{ url: src, resolveAsset: () => null }];
    const candidates = [src];
    try { candidates.push(decodeURIComponent(src)); } catch { /* 保留原始路径 */ }
    const path = candidates.find((value) => paths.has(value));
    if (!path) return [];
    const url = researchArtifactUrl(studyId, path);
    return [{ url, resolveAsset: (assetSrc) => resolveImageSrc(studyId, paths)(assetSrc)[0]?.url ?? null }];
  };
  const modeName = (mode: string) => researchModes[mode as ResearchMode] ?? mode;

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="shrink-0 border-b border-border px-4 py-3">
      <h2 className="flex items-center gap-2 text-base font-normal"><Trophy size={18} className="text-primary" />研究成果</h2>
      <p className="mt-1 text-sm text-subtext">经交付确认（G4）的研究成果：报告正文、产物清单与研究包按确认版本留存，过程执行见专家团面板。</p>
    </header>
    {query.isPending ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-subtext"><Spinner />正在读取研究成果…</div>
      : query.error ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-accent-red"><p>{query.error.message}</p><Button onClick={() => void query.refetch()}>重试</Button></div>
      : readOnly ? <div className="flex flex-1 items-center justify-center p-8 text-sm text-subtext">精选案例视图不包含研究成果数据，请在实时工作区查看。</div>
      : !deliveries.length ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Trophy size={28} className="text-subtext" />
        <p className="max-w-md text-sm text-subtext">还没有研究成果。在「科研工作流」提交研究，专家完成任务并通过 G4 交付确认后，报告与产物会出现在这里。</p>
        {onOpenWorkflow && <Button onClick={onOpenWorkflow}>去提交研究</Button>}
      </div>
      : <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4"><div className="mx-auto flex max-w-3xl flex-col gap-4">
        {deliveries.map((delivery) => {
          const reportPath = deliverableReportPath(delivery);
          const paths = new Set(delivery.artifacts.map((artifact) => artifact.path));
          const viewingThis = viewing?.studyId === delivery.studyId;
          return <section key={delivery.studyId} className="rounded-xl border border-border bg-background p-4" aria-label={`研究成果 · ${delivery.objective}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-text">{delivery.objective}</h3>
                <p className="mt-1 text-xs text-subtext">{modeName(delivery.mode)} · 计划 v{delivery.planVersion} · {delivery.decidedAt ? `确认于 ${new Date(delivery.decidedAt).toLocaleString()}` : "已确认"} · {delivery.artifacts.length} 个产物</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {reportPath && <Button size="small" variant={viewingThis && viewing.path === reportPath ? "primary" : undefined} onClick={() => setViewing(viewingThis && viewing.path === reportPath ? null : { studyId: delivery.studyId, path: reportPath })}><FileText size={14} />查看报告</Button>}
                <ButtonLink size="small" href={delivery.packageUrl} download><Download size={14} />下载研究包</ButtonLink>
              </div>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-subtext">{delivery.summary}</p>
            {delivery.artifacts.length > 0 && <ul className="mt-3 divide-y divide-border/60 rounded-lg border border-border">
              {delivery.artifacts.map((artifact) => <li key={artifact.path} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <FileText size={14} className="shrink-0 text-subtext" />
                <button type="button" className={`min-w-0 flex-1 truncate text-start ${viewingThis && viewing.path === artifact.path ? "text-primary" : "hover:text-primary"}`} onClick={() => setViewing(viewingThis && viewing.path === artifact.path ? null : { studyId: delivery.studyId, path: artifact.path })}>{artifact.path}</button>
                <span className="shrink-0 text-xs tabular-nums text-subtext">{fmtBytes(artifact.bytes)}</span>
                <a className="shrink-0 text-xs text-primary" href={researchArtifactUrl(delivery.studyId, artifact.path)} download>下载</a>
              </li>)}
            </ul>}
            {viewingThis && <div className="mt-3 rounded-lg border border-border bg-surface">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-subtext"><span className="min-w-0 truncate">{viewing.path}</span><Button size="small" variant="ghost" onClick={() => setViewing(null)}>关闭</Button></div>
              {viewer.isPending ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-subtext"><Spinner />正在加载文档…</p>
                : viewer.error ? <p role="alert" className="p-4 text-sm text-accent-red">文档读取失败：{viewer.error.message}</p>
                : !viewer.data ? <p className="p-4 text-sm text-subtext">产物文件不存在，可能已被移动或删除；完整内容以研究包为准。</p>
                : <div className="file-view-md max-h-96 overflow-y-auto p-4"><Md text={viewer.data.content} inert={Boolean(readOnly)} resolveImageSrc={resolveImageSrc(delivery.studyId, paths)} /></div>}
              {viewer.data?.truncated && <p className="border-t border-border px-3 py-1.5 text-xs text-subtext">文档过长，仅显示前 512 KB；完整内容请下载研究包。</p>}
            </div>}
          </section>;
        })}
      </div></div>}
  </div>;
}
