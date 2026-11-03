import { useEffect, useId, useRef, useState } from "react";
import { citationRange, loadMaterialCitation, type MaterialCitation } from "../materialCitation";
import { Button, Spinner } from "./ui";

export function MaterialCitationSource({ citation }: { citation: MaterialCitation }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="mt-2 min-w-0">
    <Button size="small" aria-expanded={open} aria-controls={id} aria-label={`查看原文选区：${citation.path}`} onClick={() => setOpen(value => !value)}>{open ? "收起原文选区" : "查看原文选区"}</Button>
    {open && <div id={id} role="region" aria-label={`引用原文：${citation.path}`} className="mt-2 min-w-0 rounded-lg border border-border bg-background p-3">
      <CitationSelection key={citation.readEventId} citation={citation} />
    </div>}
  </div>;
}

function CitationSelection({ citation }: { citation: MaterialCitation }) {
  const [result, setResult] = useState<{ key: string; content: string | null; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const focusAfterRetry = useRef(false);
  const contentRef = useRef<HTMLPreElement>(null);
  const retryBoxRef = useRef<HTMLDivElement>(null);
  // Polling returns equivalent new objects. Only a changed source or an explicit
  // retry should re-run extraction, and old responses must not flash on a new source.
  const sourceKey = JSON.stringify(citation);
  const requestKey = `${sourceKey}:${attempt}`;
  const content = result?.key === requestKey ? result.content : null;
  const error = result?.key === requestKey ? result.error : "";
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const expected: MaterialCitation = JSON.parse(sourceKey);
    void loadMaterialCitation(expected, controller.signal).then(value => { if (!disposed) setResult({ key: requestKey, content: value, error: "" }); }).catch(cause => { if (!disposed) setResult({ key: requestKey, content: null, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { disposed = true; controller.abort(); };
  }, [sourceKey, requestKey]);
  useEffect(() => {
    if (!focusAfterRetry.current || (content === null && !error)) return;
    focusAfterRetry.current = false;
    // The retry button disappears while loading. Restore that local keyboard
    // position only if the user has not moved focus elsewhere in the meantime.
    if (document.activeElement !== document.body) return;
    if (error) retryBoxRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else contentRef.current?.focus();
  }, [content, error, requestKey]);
  return <>
    <p className="break-words text-sm font-medium">{citation.path}</p>
    <p className="mt-1 text-xs text-subtext">{citation.source} · {citationRange(citation)}</p>
    <p className="mt-1 text-xs text-subtext">只展示该引用的原文选区；浏览不代表 AI 已阅读或结论已通过审查。</p>
    <details className="mt-2 text-xs text-subtext"><summary className="cursor-pointer">来源与版本</summary><dl className="mt-1 space-y-1">
      <div className="break-all">材料包：{citation.packageId}</div><div className="break-all">原件 SHA-256：{citation.sha256}</div><div className="break-all">选区 SHA-256：{citation.contentSha256}</div><div className="break-all">原读取回执：{citation.readEventId}</div>
      <div className="break-all">读取会话：{citation.readerSessionId ?? "手工终端，未关联 Agent 会话"}</div>
    </dl></details>
    {error ? <div ref={retryBoxRef} className="mt-3 space-y-2"><p role="alert" className="break-words text-sm text-accent-red">{error}</p><Button size="small" onClick={() => { focusAfterRetry.current = true; setAttempt(value => value + 1); }}>重新核验</Button></div>
      : content === null ? <div role="status" className="mt-3 flex items-center gap-2 text-sm text-subtext"><Spinner />正在核验引用原文…</div>
        : <pre ref={contentRef} aria-label="已核验的原文选区" tabIndex={0} className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface p-3 text-xs">{content}</pre>}
  </>;
}
