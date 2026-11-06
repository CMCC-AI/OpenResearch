import { getTaskWorkspace, type Pane, type ProjectWorkspace } from "./workspaceState";

type Source = {
  context: () => string;
  cached: (projectId: string) => ProjectWorkspace | undefined;
  read: (projectId: string, signal: AbortSignal) => Promise<ProjectWorkspace | null>;
  remember: (projectId: string, workspace: ProjectWorkspace | null) => void;
  loading: (active: boolean) => void;
  failed: (error: unknown) => void;
};

/** A navigation intent owns its read; a later intent or scope change cannot be
 * overwritten by its response, even when an old server ignores cancellation. */
export function createSessionNavigation(source: Source) {
  let revision = 0;
  let pending: AbortController | undefined;
  const cancel = () => {
    revision++;
    pending?.abort();
    pending = undefined;
    source.loading(false);
  };
  const open = (projectId: string, sessionId: string | null, commit: (pane: Pane | null | undefined) => void, fallback?: Pane | null) => {
    cancel();
    const pane = (workspace: ProjectWorkspace | null | undefined) => {
      const task = getTaskWorkspace(workspace, sessionId ?? "new");
      return task ? task.active : fallback;
    };
    const cached = source.cached(projectId);
    if (cached !== undefined) { commit(pane(cached)); return; }
    const request = new AbortController();
    pending = request;
    const visit = revision;
    const context = source.context();
    const current = () => !request.signal.aborted && visit === revision && source.context() === context;
    source.loading(true);
    void Promise.resolve().then(() => current() ? source.read(projectId, request.signal) : null).then((workspace) => {
      if (!current()) return;
      source.remember(projectId, workspace);
      commit(pane(workspace));
    }).catch((error: unknown) => {
      if (current()) source.failed(error);
    }).finally(() => {
      if (visit === revision) { pending = undefined; source.loading(false); }
    });
  };
  return { open, cancel };
}
