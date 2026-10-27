import { useEffect, useState } from "react";
import { readPreviewResponse } from "../previewText";
import { parseStructuredFile, STRUCTURED_PREVIEW_LIMIT, type StructuredDocument } from "../structuredPreview";
import { Spinner } from "./ui";

function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

export default function StructuredPreview({ url, name }: { url: string; name: string }) {
  const [document, setDocument] = useState<StructuredDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(0);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(url, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error(`读取文件失败（HTTP ${response.status}）`);
      if (Number(response.headers.get("content-length")) > STRUCTURED_PREVIEW_LIMIT) { await response.body?.cancel(); throw new Error("文件超过 16 MiB，请下载查看。"); }
      const { bytes, truncated } = await readPreviewResponse(response, STRUCTURED_PREVIEW_LIMIT);
      controller.signal.throwIfAborted();
      if (truncated) throw new Error("文件超过 16 MiB，请下载查看。");
      const result = parseStructuredFile(bytes, name);
      controller.signal.throwIfAborted();
      setDocument(result);
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [url, name]);
  if (error) return <div className="p-4 text-sm text-subtext" role="alert">{error} <a href={url} download={name} className="text-primary">下载原文件</a></div>;
  if (!document) return <div className="flex items-center gap-2 p-4 text-sm text-subtext"><Spinner />正在生成预览…</div>;
  const table = document.tables?.[sheet];
  const columns = table ? Math.max(0, ...table.rows.map((row) => row.length)) : 0;
  return <div className="flex min-h-0 flex-col gap-4 p-4 text-sm text-text">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0 text-xs text-subtext">{document.notes.map((note) => <p className="m-0 mb-1" key={note}>{note}</p>)}</div><a href={url} download={name} className="shrink-0 text-primary">下载原文件</a></div>
    {document.tables && <>
      <div role="tablist" aria-label="工作表" className="flex flex-wrap gap-1">{document.tables.map((item, index) => <button key={index} type="button" role="tab" aria-selected={sheet === index} onClick={() => { setSheet(index); setPage(0); }} className={`rounded-md border px-3 py-1.5 ${sheet === index ? "border-primary bg-primary-subtle text-primary" : "border-border text-subtext"}`}>{item.name}</button>)}</div>
      {table && table.rows.length > 100 && <div className="flex items-center gap-3 text-xs text-subtext"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded border border-border px-2 py-1 disabled:opacity-45">上一页</button><span>第 {page + 1} / {Math.ceil(table.rows.length / 100)} 页 · {table.rows.length} 行</span><button type="button" disabled={(page + 1) * 100 >= table.rows.length} onClick={() => setPage(page + 1)} className="rounded border border-border px-2 py-1 disabled:opacity-45">下一页</button></div>}
      {table && <div className="max-h-160 overflow-auto rounded-lg border border-border" role="tabpanel" aria-label={table.name}><table className="w-full border-collapse text-start text-xs"><thead className="sticky top-0 bg-surface"><tr><th className="border-b border-border p-2 text-start">行</th>{Array.from({ length: columns }, (_, index) => <th key={index} className="min-w-24 border-b border-s border-border p-2 text-start">{columnName(index)}</th>)}</tr></thead><tbody>{table.rows.slice(page * 100, (page + 1) * 100).map((row, index) => <tr key={index}><th className="border-b border-border bg-surface p-2 text-start font-normal text-subtext">{page * 100 + index + 1}</th>{Array.from({ length: columns }, (_, column) => <td key={column} className="max-w-96 whitespace-pre-wrap break-words border-b border-s border-border p-2 align-top">{row[column] ?? ""}</td>)}</tr>)}</tbody></table></div>}
    </>}
    {document.sections?.map((section, index) => <section key={index} className="min-w-0 rounded-lg border border-border p-4"><h3 className="mt-0 mb-3 text-sm font-medium">{section.title}</h3><pre className={`m-0 whitespace-pre-wrap break-words text-sm leading-relaxed ${section.code ? "font-mono" : "font-sans"}`}>{section.text || "（无可提取文本）"}</pre></section>)}
    {document.entries && <div className="overflow-auto rounded-lg border border-border"><table className="w-full border-collapse text-start text-sm"><thead className="bg-surface"><tr><th className="p-2 text-start">文件路径</th><th className="p-2 text-end">原始大小</th></tr></thead><tbody>{document.entries.map((entry, index) => <tr key={index}><td className="break-all border-t border-border p-2">{entry.name}{entry.encrypted ? "（已加密）" : ""}</td><td className="whitespace-nowrap border-t border-border p-2 text-end text-subtext">{entry.size.toLocaleString()} B</td></tr>)}</tbody></table></div>}
  </div>;
}
