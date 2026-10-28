import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { FolderOpen } from "lucide-react";
import { getWorkspaceGeneration, subscribeWorkspace } from "../queries/client";

const MaterialReader = lazy(() => import("./MaterialReader"));

export function MaterialChip({ id }: { id: string }) {
  const scope = useSyncExternalStore(subscribeWorkspace, getWorkspaceGeneration);
  const [open, setOpen] = useState<number | null>(null);
  return <div className="mt-2 max-w-full text-sm">
    <button type="button" className="flex max-w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-primary hover:bg-surface" aria-haspopup="dialog" onClick={() => setOpen(scope)}><FolderOpen size={16} className="shrink-0" />浏览研究材料</button>
    {open === scope && <Suspense fallback={<span role="status" className="ml-2 text-subtext">正在打开材料…</span>}>
      <MaterialReader key={`${scope}:${id}`} id={id} onClose={() => setOpen(null)} />
    </Suspense>}
  </div>;
}
