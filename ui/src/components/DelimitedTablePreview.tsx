import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { visibleTableRows, type TableSort } from "../tablePreview";

/** Sorting and filtering never change the source file or expand parser limits. */
export function DelimitedTablePreview({ rows }: { rows: string[][] }) {
  const [query, setQuery] = useState("");
  const [header, setHeader] = useState(true);
  const [sort, setSort] = useState<TableSort | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => visibleTableRows(rows, query, sort, header), [rows, query, sort, header]);
  const columns = rows.reduce((count, row) => Math.max(count, row.length), 0);
  const virtual = useVirtualizer({ count: visible.length, getScrollElement: () => scroll.current, estimateSize: () => 36, overscan: 8, getItemKey: (index) => visible[index].index });
  const items = virtual.getVirtualItems();
  const sortBy = (column: number) => {
    setSort((current) => current?.column === column ? current.descending ? null : { column, descending: true } : { column, descending: false });
    scroll.current?.scrollTo({ top: 0 });
  };
  return <div className="min-w-0">
    <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-subtext">
      <input aria-label="筛选表格预览" placeholder="筛选单元格…" value={query} onChange={(event) => { setQuery(event.target.value); scroll.current?.scrollTo({ top: 0 }); }} className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-text" />
      <label className="flex items-center gap-1"><input type="checkbox" checked={header} onChange={(event) => { setHeader(event.target.checked); setSort(null); }} />首行为标题</label>
      <span role="status">预览中匹配 {visible.length} / {Math.max(0, rows.length - (header ? 1 : 0))} 行 · {columns} 列</span>
    </div>
    <div ref={scroll} className="h-96 overflow-auto rounded-lg border border-border" role="region" aria-label="表格数据预览" tabIndex={0}>
      <table className="w-full border-collapse text-start text-xs" aria-rowcount={visible.length + 1}>
        <thead className="sticky top-0 z-10 bg-surface"><tr><th className="border-b border-border p-2 text-start">原始行</th>{Array.from({ length: columns }, (_, column) => <th key={column} aria-sort={sort?.column === column ? sort.descending ? "descending" : "ascending" : "none"} className="min-w-24 border-b border-s border-border text-start"><button type="button" onClick={() => sortBy(column)} className="w-full px-3 py-2 text-start" title="点击依次升序、降序、恢复原顺序">{header ? rows[0]?.[column] || `#${column + 1}` : `#${column + 1}`}{sort?.column === column ? sort.descending ? " ↓" : " ↑" : ""}</button></th>)}</tr></thead>
        <tbody>
          {items.length > 0 && items[0].start > 0 && <tr aria-hidden="true"><td colSpan={columns + 1} style={{ height: items[0].start, padding: 0 }} /></tr>}
          {items.map((item) => { const row = visible[item.index]; return <tr key={row.index} data-index={item.index} ref={virtual.measureElement} aria-rowindex={item.index + 2}><th className="border-b border-border bg-surface p-2 text-start font-normal text-subtext">{row.index + 1}</th>{Array.from({ length: columns }, (_, column) => <td key={column} className="max-w-96 whitespace-pre-wrap break-words border-b border-s border-border p-2 align-top">{row.cells[column] ?? ""}</td>)}</tr>; })}
          {items.length > 0 && <tr aria-hidden="true"><td colSpan={columns + 1} style={{ height: Math.max(0, virtual.getTotalSize() - items[items.length - 1].end), padding: 0 }} /></tr>}
        </tbody>
      </table>
      {visible.length === 0 && <p className="p-4 text-sm text-subtext">没有匹配的预览行。</p>}
    </div>
    <p className="mt-2 mb-0 text-xs text-subtext">排序和筛选仅作用于已加载的预览内容，完整数据请下载原文件。</p>
  </div>;
}
