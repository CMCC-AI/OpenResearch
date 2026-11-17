import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, FileText, Trophy } from "lucide-react";
import { artifactUrl, fmtBytes, getArtifactFileText, listResearchDeliveries } from "../api";
import { deliverableReportPath, researchModes, type ResearchMode } from "../research";
import { workspaceKey } from "../queries/client";
import { Button, Spinner } from "./ui";
import { Md } from "./Md";
import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import type { ImageCandidate } from "../markdownTarget";
import type { ResearchDeliveryEntry } from "../research";

// 过程产物的通俗定位：多数场景下读者只需要报告正文，其余文件按需查证。
const artifactNote = (path: string, reportPath: string | null) => {
  if (path === reportPath) return "报告正文 · 最终成果";
  const notes: [RegExp, string][] = [
    [/^strategy\//, "检索策略 · 怎么找到这些文献的"],
    [/^discovery\//, "文献发现 · 入选文献清单与出处"],
    [/^evidence\//, "证据集 · 每篇文献的摘录与定位"],
    [/^synthesis\//, "主题综合 · 写正文前的归纳笔记"],
    [/^outline\//, "写作大纲 · 正文的章节骨架"],
    [/^review\//, "独立评审 · 评审专家的意见与结论"],
    [/^audit\//, "引用审计 · 引用真实性与定位核验记录"],
    [/^package\//, "归档清单 · 全部文件指纹，排查与交接用"],
  ];
  const matched = notes.find(([pattern]) => pattern.test(path));
  if (matched) return matched[1];
  if (path.endsWith(".csv")) return "原始结果数据";
  if (/\.(png|jpe?g|svg|webp)$/i.test(path)) return "论文图与配套数据";
  if (path.endsWith(".log")) return "实验运行日志";
  return "过程产物 · 供查证";
};

// 复制当前预览的全文；点击后短暂显示「已复制」。
function CopyPreviewButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <Button size="small" variant="ghost" onClick={() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }}>
    {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}
  </Button>;
}

export function ResearchDeliverables({ projectId, onOpenWorkflow }: { projectId: string; onOpenWorkflow?: () => void }) {
  const readOnly = useReadOnlyWorkspace();
  const query = useQuery({
    queryKey: workspaceKey("researchDeliveries", projectId),
    queryFn: ({ signal }) => listResearchDeliveries(projectId, signal),
    staleTime: 30_000,
  });
  const [viewing, setViewing] = useState<{ studyId: string; path: string } | null>(null);
  const autoOpened = useRef(false);
  const deliveries = query.data ?? [];
  // 进入成果页默认展开主报告，免去先找「查看报告」再点开的一步。
  useEffect(() => {
    if (autoOpened.current || !deliveries.length) return;
    autoOpened.current = true;
    const reportPath = deliverableReportPath(deliveries[0]);
    if (reportPath) setViewing({ studyId: deliveries[0].studyId, path: reportPath });
  }, [deliveries]);
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
      <p className="mt-1 text-sm text-subtext">经交付确认（G4）的研究成果：报告正文与产物按确认版本留存，过程执行见专家团面板。</p>
    </header>
    {query.isPending ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-subtext"><Spinner />正在读取研究成果…</div>
      : query.error ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-accent-red"><p>{query.error.message}</p><Button onClick={() => void query.refetch()}>重试</Button></div>
      : readOnly ? <div className="flex flex-1 items-center justify-center p-8 text-sm text-subtext">精选案例视图不包含研究成果数据，请在实时工作区查看。</div>
      : !deliveries.length ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Trophy size={28} className="text-subtext" />
        <p className="max-w-md text-sm text-subtext">还没有研究成果。在「使用工作流」提交研究，专家完成任务并通过 G4 交付确认后，报告与产物会出现在这里。</p>
        {onOpenWorkflow && <Button onClick={onOpenWorkflow}>去提交研究</Button>}
      </div>
      : <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4"><div className="mx-auto flex max-w-3xl flex-col gap-4">
        {deliveries.map((delivery) => <DeliveryCard key={delivery.studyId} projectId={projectId} delivery={delivery} viewing={viewing} setViewing={setViewing} readOnly={Boolean(readOnly)} resolveImageSrc={resolveImageSrc} modeName={modeName} />)}
      </div></div>}
  </div>;
}

function DeliveryCard({ projectId, delivery, viewing, setViewing, readOnly, resolveImageSrc, modeName }: {
  projectId: string;
  delivery: ResearchDeliveryEntry;
  viewing: { studyId: string; path: string } | null;
  setViewing: (value: { studyId: string; path: string } | null) => void;
  readOnly: boolean;
  resolveImageSrc: (studyId: string, paths: Set<string>) => (src: string) => ImageCandidate[];
  modeName: (mode: string) => string;
}) {
  const reportPath = deliverableReportPath(delivery);
  const paths = new Set(delivery.artifacts.map((artifact) => artifact.path));
  const viewingThis = viewing?.studyId === delivery.studyId;
  const viewingReport = viewingThis && viewing.path === reportPath;
  const processArtifacts = delivery.artifacts.filter((artifact) => artifact.path !== reportPath);
  const viewer = useQuery({
    queryKey: workspaceKey("researchDeliveryDoc", projectId, viewing?.studyId, viewing?.path),
    queryFn: ({ signal }) => getArtifactFileText(projectId, `research/${viewing!.studyId}/${viewing!.path}`, signal),
    enabled: viewingThis,
    staleTime: 30_000,
  });
  const renderPreview = (path: string) => <div className="mt-3 rounded-lg border border-border bg-surface">
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-subtext"><span className="min-w-0 truncate">{path}</span><span className="flex shrink-0 items-center gap-1">{!viewer.isPending && !viewer.error && viewer.data && <CopyPreviewButton text={viewer.data.content} />}<Button size="small" variant="ghost" onClick={() => setViewing(null)}>关闭</Button></span></div>
    {viewer.isPending ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-subtext"><Spinner />正在加载文档…</p>
      : viewer.error ? <p role="alert" className="p-4 text-sm text-accent-red">文档读取失败：{viewer.error.message}</p>
      : !viewer.data ? <p className="p-4 text-sm text-subtext">产物文件不存在，可能已被移动或删除。</p>
      : <div className="file-view-md max-h-[70vh] overflow-y-auto p-4"><Md text={viewer.data.content} inert={readOnly} resolveImageSrc={resolveImageSrc(delivery.studyId, paths)} /></div>}
    {viewer.data?.truncated && <p className="border-t border-border px-3 py-1.5 text-xs text-subtext">文档过长，仅显示前 512 KB，可从列表下载该产物文件。</p>}
  </div>;
  const artifactRow = (artifact: { path: string; bytes: number }) => {
    const active = viewingThis && viewing.path === artifact.path;
    return <li key={artifact.path} className="flex items-start gap-2 px-3 py-1.5 text-sm">
      <FileText size={14} className="mt-1 shrink-0 text-subtext" />
      <div className="min-w-0 flex-1">
        <button type="button" className={`block max-w-full truncate text-start ${active ? "text-primary" : "hover:text-primary"}`} onClick={() => setViewing(active ? null : { studyId: delivery.studyId, path: artifact.path })}>{artifact.path}</button>
        <p className="mt-0.5 truncate text-xs text-subtext">{artifactNote(artifact.path, reportPath)}</p>
      </div>
      <span className="mt-1 shrink-0 text-xs tabular-nums text-subtext">{fmtBytes(artifact.bytes)}</span>
      <a className="mt-1 shrink-0 text-xs text-primary" href={artifactUrl(projectId, `research/${delivery.studyId}/${artifact.path}`)} download>下载</a>
    </li>;
  };
  return <section className="rounded-xl border border-border bg-background p-4" aria-label={`研究成果 · ${delivery.objective}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-text">{delivery.objective}</h3>
        <p className="mt-1 text-xs text-subtext">{modeName(delivery.mode)} · 计划 v{delivery.planVersion} · {delivery.decidedAt ? `确认于 ${new Date(delivery.decidedAt).toLocaleString()}` : "已确认"} · {delivery.artifacts.length} 个产物</p>
      </div>
      <div className="flex shrink-0 gap-2">
        {reportPath && <Button size="small" variant={viewingReport ? "primary" : undefined} onClick={() => setViewing(viewingReport ? null : { studyId: delivery.studyId, path: reportPath })}><FileText size={14} />{viewingReport ? "收起报告" : "查看报告"}</Button>}
      </div>
    </div>
    {viewingReport && renderPreview(reportPath!)}
    {processArtifacts.length > 0 && <details className="mt-3 rounded-lg border border-border/60">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm text-subtext">过程与验证（{processArtifacts.length} 份 · 供查证，不必逐篇读）</summary>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {processArtifacts.map(artifactRow)}
      </ul>
      <p className="px-3 py-2 text-xs text-subtext">点击文件名可在线预览，右侧「下载」保存原文件。</p>
      {viewingThis && !viewingReport && renderPreview(viewing.path)}
    </details>}
    {delivery.summary && <details className="mt-3 text-sm text-subtext"><summary className="cursor-pointer select-none">计划说明（专家团自动生成）</summary><p className="mt-1 whitespace-pre-wrap">{delivery.summary}</p></details>}
  </section>;
}
