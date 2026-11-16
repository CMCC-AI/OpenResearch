import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { listWorkflows } from "../api";
import { workspaceKey } from "../queries/client";
import { Button, IconButton, Spinner } from "../components/ui";
import { workflowConversationRequest } from "./conversation";

export function ChatWorkflowChooser({ disabled, onChoose }: { disabled: boolean; onChoose: (request: string) => void }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: workspaceKey("workflowList"), queryFn: ({ signal }) => listWorkflows(signal), enabled: open });
  return <div className="relative shrink-0" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <IconButton type="button" disabled={disabled} aria-label="选择工作流" title="选择工作流" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}><Workflow size={16} /></IconButton>
    {open && <div role="dialog" aria-label="选择已有工作流" className="absolute bottom-full start-0 z-50 mb-2 flex max-h-80 w-64 flex-col gap-2 overflow-y-auto rounded-md border border-border bg-background p-3 shadow-dropdown">
      <div className="flex items-center justify-between gap-2"><strong className="text-sm font-normal">选择工作流</strong><Button size="small" variant="ghost" onClick={() => setOpen(false)}>关闭</Button></div>
      <p className="m-0 text-xs text-subtext">选好后在聊天中描述目标和约束。</p>
      {query.isPending ? <span role="status" className="flex gap-2 text-sm"><Spinner />正在读取…</span> : query.error ? <div role="alert" className="text-sm text-accent-red">读取失败<Button size="small" onClick={() => void query.refetch()}>重试</Button></div> : !query.data?.length ? <p className="m-0 text-sm text-subtext">还没有保存的工作流，可先到工作流编排中创建。</p> : query.data.map(workflow => <button key={workflow.id} type="button" className="min-h-11 rounded-md px-2 py-2 text-start text-sm hover:bg-surface" onClick={() => { onChoose(workflowConversationRequest(workflow)); setOpen(false); }}>{workflow.name}<span className="mt-1 block text-xs text-subtext">{workflow.tasks.length} 个任务</span></button>)}
    </div>}
  </div>;
}
