import { Check, ChevronDown, FolderOpen, MessageCircle, Plus } from "lucide-react";
import { QUICK_CHAT_PROJECT_NAME, type Project, type ProjectActivity } from "../api";
import { m } from "../paraglide/messages.js";
import { usePopover } from "./ModelPicker";
import { Button, MenuItem } from "./ui";

export function ComposerProjectPicker({ projects, activity, projectId, projectName, onSelect, onNewProject }: {
  projects: Project[];
  activity: ProjectActivity[];
  projectId: string;
  projectName: string;
  onSelect: (id: string) => void;
  onNewProject: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const isQuickChat = !projectId;
  const lastActivity = new Map(activity.map((row) => [row.projectId, row.lastActivityAt]));
  const recent = [...projects].sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId) || Math.max(lastActivity.get(b.id) ?? 0, b.updatedAt) - Math.max(lastActivity.get(a.id) ?? 0, a.updatedAt));
  return <div ref={ref} className="relative mb-2 w-fit max-w-full">
    <Button className="max-w-full gap-2 rounded-lg px-3 text-sm font-normal text-text" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {isQuickChat ? <MessageCircle size={15} className="shrink-0" /> : <FolderOpen size={15} className="shrink-0" />}
      <span className="truncate">{isQuickChat ? QUICK_CHAT_PROJECT_NAME : projectName}</span>
      <ChevronDown size={12} className="shrink-0 text-subtext" />
    </Button>
    {open && <div role="menu" aria-label={m.projects_home_projects()} className="absolute bottom-full start-0 z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-background p-1.5 shadow-menu">
      <MenuItem role="menuitemradio" aria-checked={isQuickChat} size="compact" className="text-sm" onClick={() => { setOpen(false); onSelect(""); }}>
        <span className="flex min-w-0 items-center gap-2"><MessageCircle size={14} className="shrink-0 text-subtext" /><span className="truncate">{QUICK_CHAT_PROJECT_NAME}</span></span>
        {isQuickChat && <Check size={13} className="shrink-0" />}
      </MenuItem>
      {recent.length > 0 && <>
        <div className="my-1 border-t border-border" />
        <div className="px-2 py-1 text-sm text-subtext">{m.chat_recents()}</div>
        <div className="max-h-64 overflow-y-auto pb-1.5">
          {recent.map((project) => <MenuItem key={project.id} role="menuitemradio" aria-checked={project.id === projectId} size="compact" className="text-sm" onClick={() => { setOpen(false); onSelect(project.id); }}>
            <span className="truncate">{project.name}</span>{project.id === projectId && <Check size={13} className="shrink-0" />}
          </MenuItem>)}
        </div>
      </>}
      <div className="my-1 border-t border-border" />
      <MenuItem role="menuitem" size="compact" className="text-sm" onClick={() => { setOpen(false); onNewProject(); }}><span className="flex items-center gap-2"><Plus size={14} />{m.projects_home_new_project()}</span></MenuItem>
    </div>}
  </div>;
}
