import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getChatMessagesQuery } from "../queries/chat";
import { sessionMaterialIds } from "../sessionMaterials";
import { MaterialReaderPane } from "./MaterialReader";
import { Button, Spinner } from "./ui";

export default function MaterialWorkspace({ sessionId, requestedId }: { sessionId: string | null; requestedId?: string }) {
  const query = useQuery({ ...getChatMessagesQuery(sessionId ?? ""), enabled: Boolean(sessionId) });
  const [selection, setSelection] = useState<{ requested?: string; id: string } | null>(null);
  const ids = sessionMaterialIds(query.data?.messages ?? [], query.data?.activeLeafId);
  const preferred = selection?.requested === requestedId ? selection?.id : requestedId;
  const id = preferred && ids.includes(preferred) ? preferred : requestedId && ids.includes(requestedId) ? requestedId : ids[0];
  if (!sessionId) return <EmptyMaterials />;
  if (!query.data && query.isPending) return <div role="status" className="flex flex-1 items-center justify-center gap-2 p-4 text-sm text-subtext"><Spinner />正在读取会话材料…</div>;
  if (query.isError) return <div role="alert" className="p-4 text-sm text-accent-red">无法读取会话材料。<Button onClick={() => void query.refetch()}>重试</Button></div>;
  if (!id) return <EmptyMaterials />;
  return <div className="flex h-full min-h-0 flex-col">
    {ids.length > 1 && <label className="flex shrink-0 items-center gap-2 border-b border-border p-3 text-sm">导入批次<select aria-label="选择材料导入批次" className="min-w-0 flex-1 rounded-md border border-border bg-background p-1.5" value={id} onChange={event => setSelection({ requested: requestedId, id: event.target.value })}>{ids.map((value, index) => <option key={value} value={value}>批次 {ids.length - index} · {value.slice(0, 8)}</option>)}</select></label>}
    <div className="min-h-0 flex-1"><MaterialReaderPane key={id} id={id} /></div>
  </div>;
}

function EmptyMaterials() {
  return <div role="status" className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-subtext"><p>当前对话暂无上传材料。</p><p>通过输入框上传文件、文件夹或 ZIP 并发送后，可在这里浏览原件。</p></div>;
}
