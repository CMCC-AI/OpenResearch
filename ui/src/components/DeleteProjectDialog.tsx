import { useId, useRef, useState } from "react";
import { deleteProject, type Project } from "../api";
import { m } from "../paraglide/messages.js";
import { Button, showAlert } from "./ui";
import { useDialogFocus } from "./useDialogFocus";

export function DeleteProjectDialog({ project, onClose, onRemoved }: {
  project: Project;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [deleteFolder, setDeleteFolder] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!pending) onClose(); };
  useDialogFocus(ref, close);

  async function remove() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await deleteProject(project.id, deleteFolder);
      if (result.recoveryPath) showAlert(m.projects_delete_recovery_path({ path: result.recoveryPath }), "success", { duration: Infinity });
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return <div className="modal-backdrop fixed inset-0 z-100 flex items-center justify-center overflow-y-auto bg-modal-backdrop p-5" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
      className="modal w-120 max-w-full rounded-xl border border-border bg-background p-6 text-text shadow-modal">
      <h2 id={titleId} className="mt-0 mb-3 text-xl">{m.projects_home_delete_project()}</h2>
      <div id={descriptionId} className="flex flex-col gap-3 text-sm text-subtext">
        <p className="m-0">{m.projects_delete_from_app({ name: project.name })}</p>
        <p className="m-0">{m.projects_delete_folder_location()}</p>
        <div className="break-all rounded-lg border border-border p-3">{project.repoPath}</div>
        <label className="flex items-start gap-2 text-text">
          <input type="checkbox" checked={deleteFolder} disabled={pending} onChange={(event) => setDeleteFolder(event.target.checked)} className="mt-0.5" />
          <span>{m.projects_delete_folder_option()}</span>
        </label>
        <p className="m-0">{deleteFolder ? m.projects_delete_folder_recovery() : m.projects_delete_folder_kept()}</p>
        {project.githubEnabled && <p className="m-0">{m.projects_delete_github_kept()}</p>}
        {error && <p className="m-0 text-accent-red" role="alert">{error}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button data-initial-focus disabled={pending} onClick={close}>{m.projects_home_cancel()}</Button>
        <Button variant="danger" disabled={pending} onClick={() => void remove()}>{pending ? m.projects_home_deleting() : deleteFolder ? m.projects_delete_with_folder() : m.projects_home_delete_project_action()}</Button>
      </div>
    </div>
  </div>;
}
