import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Download, FileText, Folder, FolderOpen, PanelLeft, Search, X } from "lucide-react";
import { projectAssetUrl, projectRequest, getReadOnlyApi } from "../readOnlyApi";
import { materialKind, materialLines, materialLink, materialMime, materialStatus, materialTree, materialUrl, type MaterialFile, type MaterialNode, type MaterialPackage } from "../materialReader";
import { loadMaterialPreview } from "../materialPreview";
import { fmtBytes } from "../api";
import { MediaPreview } from "./MediaPreview";
import { MediaToolbarSlot } from "./mediaToolbar";
import { Md } from "./Md";
import { Button, IconButton, IconButtonLink, Input, Spinner } from "./ui";
import { useDialogFocus } from "./useDialogFocus";

export default function MaterialReader({ id, onClose }: { id: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [material, setMaterial] = useState<MaterialPackage | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useDialogFocus(ref, onClose);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setMaterial(null); setError("");
    void (async () => {
      const response = await projectRequest(`/api/materials/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!response.ok) throw new Error("无法读取材料清单，请稍后重试。");
      const value: MaterialPackage = await response.json();
      if (value.id !== id || value.ready === false) throw new Error("材料尚未完成导入，暂时无法浏览。");
      materialTree(value.files);
      if (!disposed) setMaterial(value);
    })().catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; controller.abort(); };
  }, [id, attempt]);
  return createPortal(<div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="flex h-full w-full max-w-6xl flex-col border-l border-border bg-background text-text shadow-elevated" onClick={event => event.stopPropagation()}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0"><h2 id={titleId} className="m-0 flex items-center gap-2 font-semibold"><FolderOpen size={19} className="text-primary" />研究材料{material ? <span className="text-sm font-normal text-subtext">{material.files.length} 个文件</span> : null}</h2><p className="mb-0 mt-1 text-xs text-subtext">浏览原件不代表 AI 已阅读；引用以本次导入版本为准。</p></div>
        <IconButton aria-label="关闭材料阅读器" onClick={onClose}><X size={18} /></IconButton>
      </header>
      {material ? <ReaderContent key={material.id} material={material} /> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5">
        {error ? <><p role="alert" className="text-sm text-accent-red">{error}</p><Button data-initial-focus onClick={() => setAttempt(value => value + 1)}>重新加载</Button></> : <><Spinner /><p role="status" className="text-sm text-subtext">正在加载材料目录…</p></>}
      </div>}
    </div>
  </div>, document.body);
}

function ReaderContent({ material }: { material: MaterialPackage }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<MaterialFile | null>(null);
  const [directory, setDirectory] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set(materialTree(material.files).filter(node => node.kind === "folder").map(node => node.path)));
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const filtered = useMemo(() => material.files.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (filter === "all" || materialKind(file) === filter)), [material.files, query, filter]);
  const tree = useMemo(() => materialTree(filtered), [filtered]);
  function openFile(file: MaterialFile) {
    setSelected(file); setDirectory(false);
    setExpanded(previous => {
      const next = new Set(previous);
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index++) next.add(parts.slice(0, index).join("/"));
      return next;
    });
  }
  function toggle(path: string) { setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; }); }
  const download = selected ? projectAssetUrl(materialUrl(material.id, selected.id, "download")) : null;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-subtext">
      <Button size="small" className="sm:hidden" onClick={() => setDirectory(value => !value)}><PanelLeft size={14} />{directory ? "查看正文" : "目录"}</Button>
      <span>导入时间：{material.createdAt ? new Date(material.createdAt).toLocaleString("zh-CN") : "未记录"}</span>
      <span className="truncate">版本 {material.id.slice(0, 8)}</span>
    </div>
    <div className="flex min-h-0 flex-1">
      <aside aria-label="材料目录" className={`${directory ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-border sm:flex sm:w-64`}>
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <label className="relative"><Search size={15} className="pointer-events-none absolute left-2 top-2.5 text-subtext" /><Input data-initial-focus type="search" aria-label="搜索材料文件" placeholder="搜索文件名或路径" className="w-full pl-7" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <select aria-label="筛选材料类型" className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">全部类型</option><option value="pdf">PDF</option><option value="markdown">Markdown</option><option value="text">文本与代码</option><option value="image">图片</option><option value="unsupported">其他格式</option>
          </select>
        </div>
        <nav className="min-h-0 flex-1 overflow-auto p-2" aria-label="上传文件夹">
          {tree.length ? <Directory nodes={tree} selected={selected?.id} expanded={expanded} searching={Boolean(query || filter !== "all")} onToggle={toggle} onSelect={openFile} /> : <p role="status" className="p-3 text-sm text-subtext">没有匹配的文件。</p>}
        </nav>
        <p className="border-t border-border px-3 py-2 text-xs text-subtext">{filtered.length} / {material.files.length} 个文件</p>
      </aside>
      <section aria-label="材料预览" className={`${directory ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col sm:flex`}>
        {selected ? <>
          <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0"><h3 className="m-0 break-words text-sm font-medium">{selected.path}</h3><p className="mb-0 mt-1 text-xs text-subtext">{materialStatus(selected)} · {fmtBytes(selected.size)}</p></div>
            <div className="flex shrink-0 items-center gap-1">{download && <IconButtonLink href={download} download={selected.path.split("/").at(-1)} aria-label="下载材料原件" data-tip="下载原件"><Download size={16} /></IconButtonLink>}</div>
          </div>
          <details className="shrink-0 border-b border-border px-4 py-2 text-xs text-subtext"><summary className="cursor-pointer">来源与版本</summary><dl className="mt-2 space-y-1"><div>来源：{selected.id}</div><div className="break-all">材料包：{material.id}</div><div className="break-all">SHA-256：{selected.sha256}</div>{selected.note && <div>{selected.note}</div>}</dl></details>
          <div ref={setToolbar} className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2 empty:hidden" />
          <MediaToolbarSlot value={toolbar}><MaterialPreview key={selected.id} material={material} file={selected} onOpen={openFile} /></MediaToolbarSlot>
        </> : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-subtext"><FolderOpen size={32} /><p className="text-sm">从目录选择文件，在这里阅读原件。</p><p className="text-xs">支持 PDF、文本、Markdown 和图片；其他格式可下载阅读。</p></div>}
      </section>
    </div>
  </div>;
}

function Directory({ nodes, selected, expanded, searching, onToggle, onSelect }: { nodes: MaterialNode[]; selected?: string; expanded: Set<string>; searching: boolean; onToggle: (path: string) => void; onSelect: (file: MaterialFile) => void }) {
  return <ul className="m-0 list-none space-y-0.5 p-0">{nodes.map(node => node.kind === "folder" ? <li key={`folder:${node.path}`}>
    <button type="button" aria-expanded={searching || expanded.has(node.path)} className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm hover:bg-surface" onClick={() => onToggle(node.path)}>{searching || expanded.has(node.path) ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}<Folder size={15} className="shrink-0 text-subtext" /><span className="truncate" title={node.path}>{node.name}</span></button>
    {(searching || expanded.has(node.path)) && <div className="pl-3"><Directory nodes={node.children} selected={selected} expanded={expanded} searching={searching} onToggle={onToggle} onSelect={onSelect} /></div>}
  </li> : <li key={node.file.id}><button type="button" aria-current={selected === node.file.id ? "true" : undefined} className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${selected === node.file.id ? "bg-surface text-primary" : "hover:bg-surface"}`} onClick={() => onSelect(node.file)}><FileText size={15} className="shrink-0 text-subtext" /><span className="truncate" title={node.path}>{node.name}</span></button></li>)}</ul>;
}

type PreviewState = { content: string; url?: undefined } | { url: string; content?: undefined };
function MaterialPreview({ material, file, onOpen }: { material: MaterialPackage; file: MaterialFile; onOpen: (file: MaterialFile) => void }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [source, setSource] = useState(false);
  const [page, setPage] = useState(0);
  const textContainer = useRef<HTMLDivElement>(null);
  const kind = materialKind(file);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let objectUrl: string | undefined;
    setPreview(null); setError("");
    void loadMaterialPreview(material.id, file, controller.signal).then(value => {
      if (disposed) return;
      if (value.bytes) {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(value.bytes).buffer], { type: materialMime(file) }));
        setPreview({ url: objectUrl });
      } else setPreview({ content: value.content ?? "" });
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [material.id, file, retry]);
  const content = preview?.content ?? "";
  const lines = useMemo(() => materialLines(content), [content]);
  useEffect(() => { textContainer.current?.scrollTo(0, 0); }, [page, source]);
  if (error) return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center"><p role="alert" className="max-w-lg text-sm text-subtext">{error}</p>{kind !== "unsupported" && <Button onClick={() => setRetry(value => value + 1)}>重试预览</Button>}</div>;
  if (!preview) return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-subtext" role="status"><Spinner />正在读取原件…</div>;
  if (preview.url && (kind === "pdf" || kind === "image")) return <div className="min-h-0 flex-1"><MediaPreview kind={kind} url={preview.url} name={file.path.split("/").at(-1)!} download={false} /></div>;
  const renderedMarkdown = kind === "markdown" && content.length <= 64 * 1024 && lines.length <= 2000;
  const first = page * 200;
  function interceptLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      event.preventDefault();
      let id = href.slice(1); try { id = decodeURIComponent(id); } catch { return; }
      [...(textContainer.current?.querySelectorAll("[id]") ?? [])].find(element => element.id === id)?.scrollIntoView();
    } else if (!/^(https?:|mailto:)/i.test(href)) event.preventDefault();
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-subtext">
      {renderedMarkdown ? <Button size="small" onClick={() => setSource(value => !value)}>{source ? "阅读视图" : "查看原文"}</Button> : <span>{kind === "markdown" ? "文档较长，以分页原文展示" : "只读文本"}</span>}
      {(!renderedMarkdown || source) && <div className="flex items-center gap-2"><span>{lines.length ? `${first + 1}–${Math.min(first + 200, lines.length)} / ${lines.length} 行` : "空文件"}</span><IconButton size="small" aria-label="上一段文本" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ChevronRight size={14} className="rotate-180" /></IconButton><IconButton size="small" aria-label="下一段文本" disabled={first + 200 >= lines.length} onClick={() => setPage(value => value + 1)}><ChevronRight size={14} /></IconButton></div>}
    </div>
    <div ref={textContainer} className="min-h-0 flex-1 overflow-auto p-4" onClickCapture={interceptLink}>
      {renderedMarkdown && !source ? <Md text={content} resolveFilePath={path => materialLink(material.files, file, path)?.path ?? null} onOpenFile={path => { const target = material.files.find(entry => entry.path === path); if (target) onOpen(target); }} resolveImageSrc={src => {
        const image = materialLink(material.files, file, src);
        if (!image || materialKind(image) !== "image") return [];
        return [{ url: projectAssetUrl(materialUrl(material.id, image.id, getReadOnlyApi() ? "download" : "preview")), resolveAsset: () => null }];
      }} /> : <div className="space-y-0.5 font-mono text-sm">{lines.slice(first, first + 200).map((line, index) => <div key={first + index} className="flex gap-3"><span aria-hidden="true" className="w-10 shrink-0 select-none text-right text-subtext">{first + index + 1}</span><code className="min-w-0 whitespace-pre-wrap break-words">{line || " "}</code></div>)}{!lines.length && <p className="text-subtext">此文本文件为空。</p>}</div>}
    </div>
  </div>;
}
