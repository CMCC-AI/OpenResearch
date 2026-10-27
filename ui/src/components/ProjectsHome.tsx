import { useQuery } from "@tanstack/react-query";

import { listProjectActivityQuery } from "../queries/projects";
import { m } from "../paraglide/messages.js";
import { ArrowRight, ChevronRight, Folder, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  timeAgo,
  type Project,
  type AgentSelection,
} from "../api";

import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { NewProjectForm } from "./NewProjectForm";
import { Button, showAlert } from "./ui";
import { getComposerStashStore, type ComposerStash } from "../composerStash";
import { getWorkspaceGeneration } from "../queries/client";
import { useNavigate } from "@tanstack/react-router";
import { ResearchStartPanel, ResearchCases } from "../product/ResearchStartPanel";

export function NewProjectDialog({
  onClose,
  onCreated,
  preferredAgent,
  initialName,
}: {
  onClose: () => void;
  onCreated: (project: Project, githubPublicationError: string | null, draft?: ComposerStash) => void;
  preferredAgent: AgentSelection | null;
  initialName?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
    (dialog.querySelector<HTMLElement>("[data-initial-focus]") ?? focusable()[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop fixed inset-0 bg-modal-backdrop flex items-start justify-center p-5 [--new-project-modal-top:clamp(4rem,20vh,24rem)] pt-[var(--new-project-modal-top)] overflow-y-auto z-100"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal w-120 max-w-full max-h-[calc(100vh_-_var(--new-project-modal-top)_-_1.25rem)] overflow-y-auto bg-background border border-border rounded-xl shadow-modal p-6 [&_h2]:mt-0 [&_h2]:mx-0 [&_h2]:mb-3.5 [&_h2]:text-xl [&_h2]:font-medium"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-dialog-title"
        tabIndex={-1}
      >
        <h2 id="new-project-dialog-title">{m.projects_home_new_project()}</h2>
        <NewProjectForm onCancel={onClose} onCreated={onCreated} preferredAgent={preferredAgent} initialName={initialName} />
      </div>
    </div>
  );
}

function LiveDot() {
  return (
    <span className="activity-pulse h-2 w-2 shrink-0 rounded-full bg-accent-teal animate-[or-pulse_1.2s_ease-in-out_infinite]" />
  );
}

export function ProjectsHome({
  projects,
  onOpen,
  onCreated,
  onDeleted,
  preferredAgent,
  initialDialogOpen = false,
  initialProjectId,
  onResume,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
  onCreated: (project: Project, githubPublicationError: string | null, draft?: ComposerStash) => void;
  onDeleted: (id: string) => void;
  preferredAgent: AgentSelection | null;
  initialDialogOpen?: boolean;
  initialProjectId?: string;
  onResume: (project: Project, draft: ComposerStash) => void;
}) {
  const navigate = useNavigate();
  const existingProject = projects.find((project) => project.id === initialProjectId);
  const [modalOpen, setModalOpen] = useState(initialDialogOpen);
  const homeStashes = getComposerStashStore(getWorkspaceGeneration());
  const [draft, setDraft] = useState(() => homeStashes.get("research-home")?.draft ?? "");
  const [workMode, setWorkMode] = useState<NonNullable<ComposerStash["workMode"]>>(() => homeStashes.get("research-home")?.workMode ?? "normal");
  const [attachments, setAttachments] = useState<ComposerStash["attachments"]>(() => homeStashes.get("research-home")?.attachments ?? []);
  useEffect(() => { homeStashes.set("research-home", { draft, attachments, annotations: [], workMode }); }, [homeStashes, draft, attachments, workMode]);
  useEffect(() => { if (initialDialogOpen) setModalOpen(true); }, [initialDialogOpen]);
  const [projectPendingDelete, setProjectPendingDelete] = useState<Project | null>(null);
  useEffect(() => {
    if (!initialProjectId) return;
    const saved = getComposerStashStore(getWorkspaceGeneration()).get(`${initialProjectId}:new`);
    if (saved) { setDraft(saved.draft); setAttachments(saved.attachments); setWorkMode(saved.workMode ?? "normal"); }
  }, [initialProjectId]);
  const activity = useQuery(listProjectActivityQuery());
  const activityByProject = Object.fromEntries((activity.data ?? []).map((summary) => [summary.projectId, summary]));

  return (
    <div className="home research-home flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable_both-edges] bg-canvas">
      <div className="home-inner research-home-inner max-w-294 my-0 mx-auto pt-10 px-7 pb-16 [@media((max-width:_960px))]:px-5 max-sm:px-4">
        {existingProject && <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background p-3 text-sm"><span>继续研究：{existingProject.name}</span><Button size="small" onClick={() => void navigate({ to: "/projects", search: {} })}>切换为新建项目</Button></div>}
        <ResearchStartPanel preferredAgent={preferredAgent} projects={projects} activity={activity.data ?? []} project={existingProject} onSelectProject={(id) => void navigate({ to: "/projects", search: id ? { project: id } : {} })} workMode={workMode} onWorkModeChange={setWorkMode} draft={draft} onDraftChange={setDraft} attachments={attachments} onAttachmentsChange={setAttachments} onStart={() => existingProject ? onResume(existingProject, { draft, attachments, annotations: [], workMode }) : setModalOpen(true)} onError={(message) => showAlert(message, "error")} />
        <div className="research-home-sections grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.8fr)] gap-8 [@media((max-width:_1200px))]:grid-cols-1">
          <section aria-labelledby="continue-research-title" className="min-w-0">
            <h2 id="continue-research-title" className="product-page-section-title mt-0 mb-5 flex items-center gap-2">继续研究<ChevronRight size={20} className="text-muted" /></h2>
            <div className="research-recent-list flex flex-col gap-1">
              {projects.length === 0 ? <p className="p-4 text-base text-muted">尚无研究项目，从上方创建第一个项目。</p> : [...projects].sort((a, b) => (activityByProject[b.id]?.lastMessageAt ?? b.updatedAt) - (activityByProject[a.id]?.lastMessageAt ?? a.updatedAt)).map((p) => <div key={p.id} className="research-recent-item group flex items-center gap-2 rounded-xl border border-transparent p-2.5">
                <span className="research-project-icon grid size-10 shrink-0 place-items-center rounded-lg"><Folder size={20} className="text-primary" /></span>
                <button onClick={() => onOpen(p.id)} className="flex min-w-0 flex-1 flex-col gap-1 text-start"><span className="w-full truncate text-base font-normal">{p.name}</span><span className="text-sm text-muted">更新于 {timeAgo(activityByProject[p.id]?.lastMessageAt ?? p.updatedAt)} · {activityByProject[p.id]?.totalAgents ?? 0} 个研究会话</span></button>
                {activityByProject[p.id]?.activeAgents > 0 && <LiveDot />}
                <button onClick={() => onOpen(p.id)} aria-label={`继续研究 ${p.name}`} className="research-recent-action shrink-0 text-primary"><ArrowRight size={16} /></button>
                <button onClick={() => { setProjectPendingDelete(p); }} aria-label={`删除项目 ${p.name}`} className="research-recent-action shrink-0 text-muted hover:text-accent-red"><Trash2 size={14} /></button>
              </div>)}
            </div>
          </section>
          <ResearchCases />
        </div>
      </div>

      {modalOpen && (
        <NewProjectDialog
          preferredAgent={preferredAgent}
          initialName={draft.trim().split(/[。\n]/)[0].slice(0, 24)}
          onClose={() => setModalOpen(false)}
          onCreated={(project, githubPublicationError) => {
            setModalOpen(false);
            homeStashes.delete("research-home");
            onCreated(project, githubPublicationError, { draft, attachments, annotations: [], workMode });
          }}
        />
      )}
      {projectPendingDelete && (
        <DeleteProjectDialog
          project={projectPendingDelete}
          onClose={() => setProjectPendingDelete(null)}
          onRemoved={() => { setProjectPendingDelete(null); onDeleted(projectPendingDelete.id); }}
        />
      )}
    </div>
  );
}
