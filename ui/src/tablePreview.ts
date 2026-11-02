export interface PreviewRow { index: number; cells: string[] }
export interface TableSort { column: number; descending: boolean }
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Keep source row identities and text while sorting only the bounded preview. */
export function visibleTableRows(rows: string[][], query: string, sort: TableSort | null, header: boolean): PreviewRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const selected = rows.flatMap((cells, index) =>
    (header && index === 0) || (needle && !cells.some((cell) => cell.toLocaleLowerCase().includes(needle)))
      ? [] : [{ index, cells }]);
  if (!sort) return selected;
  const column = sort.column;
  const values = rows.slice(header ? 1 : 0).map((row) => row[column]?.trim() ?? "").filter(Boolean);
  const numeric = values.length > 0 && values.every((value) => NUMBER.test(value) && Number.isFinite(Number(value)));
  return selected.sort((a, b) => {
    const left = a.cells[column]?.trim() ?? "", right = b.cells[column]?.trim() ?? "";
    // Missing cells stay last in both directions; equal values keep source order.
    if (!left || !right) return left ? -1 : right ? 1 : a.index - b.index;
    const result = numeric ? Number(left) - Number(right) : left.localeCompare(right, undefined, { numeric: true });
    return (sort.descending ? -result : result) || a.index - b.index;
  });
}
