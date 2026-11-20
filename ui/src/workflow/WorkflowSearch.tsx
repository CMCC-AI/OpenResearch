import { Search, X } from "lucide-react";

/** 工作流挑选界面共用的搜索框；匹配逻辑在 model.searchWorkflows，各入口保持同一套行为。 */
export function WorkflowSearchBox({ value, onChange, matched, total, onKeyDown, autoFocus = false }: {
  value: string;
  onChange: (keyword: string) => void;
  /** 当前匹配数与总数；两个都给才显示计数。 */
  matched?: number;
  total?: number;
  /** 表单里的搜索框用它拦住回车提交。 */
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}) {
  return <div role="search" className="flex items-center gap-2 rounded-lg border border-border bg-background px-3">
    <Search size={15} className="shrink-0 text-muted" />
    <input aria-label="搜索工作流" value={value} maxLength={200} autoFocus={autoFocus} placeholder="搜索名称或任务内容" onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm text-text outline-none placeholder:text-muted" />
    {value && <button type="button" aria-label="清空搜索" title="清空搜索" onClick={() => onChange("")} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text"><X size={14} /></button>}
    {typeof matched === "number" && typeof total === "number" && <span className="shrink-0 text-xs text-muted">{matched === total ? `共 ${total} 条` : `${matched} / ${total} 条`}</span>}
  </div>;
}
