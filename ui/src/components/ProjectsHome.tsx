import { useQuery } from "@tanstack/react-query";

import { listProjectActivityQuery } from "../queries/projects";
import { m } from "../paraglide/messages.js";
import { autoDir } from "../i18n";
import { ArrowRight, Folder, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  deleteProject,
  timeAgo,
  type Project,
} from "../api";

import { NewProjectForm } from "./NewProjectForm";
import { Button, showAlert } from "./ui";
import { getComposerStashStore, type ComposerStash } from "../composerStash";
import { getWorkspaceGeneration } from "../queries/client";
import { useNavigate } from "@tanstack/react-router";
import { ResearchStartPanel, ResearchCases } from "../product/ResearchStartPanel";

export function NewProjectDialog({
  onClose,
  onCreated,
  remote = false,
  initialPaperId,
  initialName,
}: {
  onClose: () => void;
  onCreated: (project: Project, githubPublicationError: string | null, draft?: ComposerStash) => void;
  remote?: boolean;
  initialPaperId?: string;
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
        <NewProjectForm onCancel={onClose} onCreated={onCreated} remote={remote} initialPaperId={initialPaperId} initialName={initialName} />
      </div>
    </div>
  );
}

function DeleteProjectDialog({
  project,
  deleting,
  error,
  onClose,
  onConfirm,
}: {
  project: Project;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const deletingRef = useRef(deleting);
  onCloseRef.current = onClose;
  deletingRef.current = deleting;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    (focusable()[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!deletingRef.current) onCloseRef.current();
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

  const hasSyncedRepository = Boolean(
    project.githubEnabled && (project.githubUrl || (project.githubOwner && project.githubRepo)),
  );

  return (
    <div
      className="modal-backdrop fixed inset-0 bg-modal-backdrop flex items-center justify-center p-5 overflow-y-auto z-100"
      onClick={(event) => {
        if (!deleting && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal w-110 max-w-full bg-background border border-border rounded-xl shadow-modal p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-project-dialog-title"
        aria-describedby="delete-project-dialog-description"
        tabIndex={-1}
      >
        <h2 id="delete-project-dialog-title" className="mt-0 mb-3 text-xl">{m.projects_home_delete_project()}</h2>
        <div id="delete-project-dialog-description" className="flex flex-col gap-2 text-sm leading-normal text-subtext">
          <p className="m-0">
            {m.projects_delete_from_app({ name: autoDir(project.name) })}
          </p>
          <p className="m-0">
            {hasSyncedRepository ? m.projects_home_local_and_github_kept() : m.projects_home_local_folder_kept()}
          </p>
          {error && <p className="m-0 text-accent-red" role="alert">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={deleting} onClick={onClose}>{m.projects_home_cancel()}</Button>
          <Button variant="danger" disabled={deleting} onClick={onConfirm}>
            {deleting ? m.projects_home_deleting() : m.projects_home_delete_project_action()}
          </Button>
        </div>
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
  remote = false,
  initialDialogOpen = false,
  initialPaperId,
  initialProjectId,
  onResume,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
  onCreated: (project: Project, githubPublicationError: string | null, draft?: ComposerStash) => void;
  onDeleted: (id: string) => void;
  remote?: boolean;
  initialDialogOpen?: boolean;
  initialPaperId?: string;
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
  useEffect(() => { if (initialDialogOpen) setModalOpen(true); }, [initialDialogOpen, initialPaperId]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [projectPendingDelete, setProjectPendingDelete] = useState<Project | null>(null);
  useEffect(() => {
    if (!initialProjectId) return;
    const saved = getComposerStashStore(getWorkspaceGeneration()).get(`${initialProjectId}:new`);
    if (saved) { setDraft(saved.draft); setAttachments(saved.attachments); setWorkMode(saved.workMode ?? "normal"); }
  }, [initialProjectId]);
  const activity = useQuery(listProjectActivityQuery());
  const activityByProject = Object.fromEntries((activity.data ?? []).map((summary) => [summary.projectId, summary]));

  async function onDelete(p: Project) {
    setDeleting(p.id);
    setDeleteError(null);
    try {
      await deleteProject(p.id);
      setDeleteError(null);
      setProjectPendingDelete(null);
      onDeleted(p.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="home flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable_both-edges] bg-canvas">
      <div className="home-inner max-w-290 my-0 mx-auto pt-12 px-6 pb-16 [@media((max-width:_960px))]:pt-6 [@media((max-width:_960px))]:px-4">
        {existingProject && <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background p-3 text-sm"><span>继续研究：{existingProject.name}</span><Button size="small" onClick={() => void navigate({ to: "/projects", search: {} })}>切换为新建项目</Button></div>}
        <ResearchStartPanel workMode={workMode} onWorkModeChange={setWorkMode} draft={draft} onDraftChange={setDraft} attachments={attachments} onAttachmentsChange={setAttachments} onStart={() => existingProject ? onResume(existingProject, { draft, attachments, annotations: [], workMode }) : setModalOpen(true)} onError={(message) => showAlert(message, "error")} />
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6 [@media((max-width:_960px))]:grid-cols-1">
          <section aria-labelledby="continue-research-title" className="min-w-0">
            <h2 id="continue-research-title" className="mt-0 mb-4 text-xl font-semibold">继续研究</h2>
            <div className="overflow-hidden rounded-xl border border-border bg-background">
              {projects.length === 0 ? <p className="p-4 text-sm text-muted">尚无研究项目，从上方创建第一个项目。</p> : [...projects].sort((a, b) => (activityByProject[b.id]?.lastMessageAt ?? b.updatedAt) - (activityByProject[a.id]?.lastMessageAt ?? a.updatedAt)).map((p) => <div key={p.id} className="flex items-center gap-3 border-b border-border-variant p-4 last:border-b-0">
                <Folder size={22} className="shrink-0 text-primary" />
                <button onClick={() => onOpen(p.id)} className="flex min-w-0 flex-1 flex-col gap-1 text-start"><span className="w-full truncate font-medium">{p.name}</span><span className="text-xs text-muted">更新于 {timeAgo(activityByProject[p.id]?.lastMessageAt ?? p.updatedAt)} · {activityByProject[p.id]?.totalAgents ?? 0} 个研究会话</span></button>
                {activityByProject[p.id]?.activeAgents > 0 && <LiveDot />}
                <button onClick={() => onOpen(p.id)} aria-label={`继续研究 ${p.name}`} className="shrink-0 text-primary"><ArrowRight size={16} /></button>
                <button onClick={() => { setDeleteError(null); setProjectPendingDelete(p); }} disabled={deleting === p.id} aria-label={`删除项目 ${p.name}`} className="shrink-0 text-muted hover:text-accent-red"><Trash2 size={14} /></button>
              </div>)}
            </div>
          </section>
          <ResearchCases onSelect={(prompt) => { setDraft(prompt); document.getElementById("research-objective")?.focus(); }} />
        </div>
      </div>

      {modalOpen && (
        <NewProjectDialog
          remote={remote}
          initialPaperId={initialPaperId}
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
          deleting={deleting === projectPendingDelete.id}
          error={deleteError}
          onClose={() => {
            setDeleteError(null);
            setProjectPendingDelete(null);
          }}
          onConfirm={() => void onDelete(projectPendingDelete)}
        />
      )}
    </div>
  );
}
