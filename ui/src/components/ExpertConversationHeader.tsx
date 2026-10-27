import { ArrowLeft, Users } from "lucide-react";

export function ExpertConversationHeader({ name, task, onReturn }: { name: string; task: string | null; onReturn: () => void }) {
  return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-2" aria-label="专家子对话导航">
    <button type="button" onClick={onReturn} className="flex shrink-0 items-center gap-1 rounded text-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"><ArrowLeft size={15} aria-hidden="true" />返回主对话</button>
    <span aria-hidden="true" className="text-muted">/</span>
    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><Users size={15} className="shrink-0 text-subtext" aria-hidden="true" />{name}</span>
    {task && <p className="m-0 w-full truncate text-xs text-subtext" title={task}>当前任务：{task}</p>}
  </div>;
}
