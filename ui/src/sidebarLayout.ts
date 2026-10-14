import type { ChatSession, Project } from "./api";

// Keep the product home and chat workspace navigation aligned.
export const sidebarClasses = {
  heading: "rail-section-head flex items-center justify-between shrink-0 pt-3.5 pe-2.5 pb-0 ps-4.5",
  label: "rail-section-label m-0 p-0 text-sm font-medium text-subtext",
  actions: "rail-section-actions flex items-center gap-0.5",
  project: "group h-9 flex items-end gap-1 rounded-md px-2.5 text-text",
  indent: "ms-5.5",
  status: "flex h-8.5 items-center px-2.5 text-sm text-subtext",
};

export type SidebarRow =
  | { kind: "project"; project: Project; collapsed: boolean; busy: boolean }
  | { kind: "chat"; project: Project; session: ChatSession }
  | { kind: "more"; project: Project }
  | { kind: "status"; project: Project; pending: boolean; error: boolean; retry: () => void };

export const sidebarRowHeight = (row: SidebarRow) => row.kind === "project" ? 36 : 34;

export function fitSidebarRows(rows: SidebarRow[], height: number, activeId: string | null): SidebarRow[] {
  const selected = rows.find((row) => row.kind === "chat" && row.session.id === activeId);
  const header = selected && rows.find((row) => row.kind === "project" && row.project.id === selected.project.id);
  const fit = (candidates: SidebarRow[], available: number) => {
    const result: SidebarRow[] = [];
    let used = 0;
    for (const row of candidates) {
      if (used + sidebarRowHeight(row) > available) break;
      result.push(row);
      used += sidebarRowHeight(row);
    }
    const last = result.at(-1);
    if (last?.kind === "project" && !last.collapsed) result.pop();
    return result;
  };
  const visible = fit(rows, height);
  if (!selected || visible.includes(selected)) return visible;
  if (!header) return height < 34 ? visible : [...fit(rows.filter((row) => row !== selected), height - 34), selected];
  if (height < 70) return visible;
  return [
    ...fit(rows.filter((row) => row.project.id !== selected.project.id), height - 70),
    header,
    selected,
  ];
}
