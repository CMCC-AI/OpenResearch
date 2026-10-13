import { isCancelledError, useQuery } from "@tanstack/react-query";
import { ProjectsHome } from "./components/ProjectsHome";
import { setScopedQueryData } from "./queries/client";
import { listProjectsQuery, getUiStateQuery } from "./queries/projects";
import { isCloudWorkspace } from "./product/CloudWorkspace";
import { useRouteContext, Link, useNavigate, useSearch, type ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useRuntime } from "./RemoteRuntime";

import { globalResumeLocation, projectResumeLocation } from "./routeResume";
import { m } from "./paraglide/messages.js";
import { createChatSession, type Project } from "./api";
import { getHarnessesQuery } from "./queries/settings";
import { defaultSelection } from "./components/ModelPicker";
import { getComposerStashStore, type ComposerStash } from "./composerStash";
import { getWorkspaceGeneration } from "./queries/client";
import { queryClient } from "./queries/client";
import { OfflineBanner } from "./components/OfflineBanner";
import { WorkspaceConnection } from "./components/WorkspaceConnection";
import { UpdateBanner, useUpdateStatus } from "./components/UpdateBanner";
import { Button, showAlert, Spinner } from "./components/ui";
import { PlatformFrame } from "./product/ProductNav";

export function RoutePending() {
  return <div className="flex flex-1 h-full items-center justify-center"><Spinner /></div>;
}

export function RouteNotFound() {
  return (
    <div className="flex flex-1 h-full flex-col items-center justify-center gap-3 text-subtext">
      <p>{m.model_picker_unavailable()}</p>
      <Link to="/projects">{m.app_projects()}</Link>
    </div>
  );
}

export function RouteFailure({ error, reset }: Pick<ErrorComponentProps, "error" | "reset">) {
  return (
    <div className="flex flex-1 h-full flex-col items-center justify-center gap-3 text-subtext">
      <p role="alert">{error.message}</p>
      <Button onClick={reset}>{m.app_retry()}</Button>
      <Link to="/projects">{m.app_projects()}</Link>
    </div>
  );
}

function Resume({ projectId }: { projectId?: string }) {
  const { queryClient: client } = useRouteContext({ from: "__root__" });
  const navigate = useNavigate();
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    void (projectId ? projectResumeLocation(projectId, client) : globalResumeLocation(client))
      .then((href) => { if (current) void navigate({ href, replace: true }); })
      .catch((cause: unknown) => {
        if (!current) return;
        // A shared read can be cancelled by invalidation or the last observer leaving.
        if (isCancelledError(cause)) setAttempt((value) => value + 1);
        else setError(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => { current = false; };
  }, [projectId, attempt, navigate, client]);
  return error ? <RouteFailure error={error} reset={() => setAttempt((value) => value + 1)} /> : <RoutePending />;
}

export function ResumeGlobal() { return <Resume />; }
export function ResumeProject({ projectId }: { projectId: string }) { return <Resume projectId={projectId} />; }

export function ProjectsPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const start = useSearch({ from: "/projects/" });
  const projectsOptions = listProjectsQuery();
  const projectsQuery = useQuery(projectsOptions);
  const stateQuery = useQuery(getUiStateQuery());
  const projects = projectsQuery.data;
  const state = stateQuery.data;
  const error = projectsQuery.error ?? stateQuery.error;
  const retry = () => { void projectsQuery.refetch(); void stateQuery.refetch(); };
  const { status } = useUpdateStatus(runtime.kind === "local" && !isCloudWorkspace());
  useEffect(() => {
    document.title = "SONA";
  }, []);
  const openProject = (projectId: string) => void navigate({ to: "/projects/$projectId", params: { projectId } });

  const [opening, setOpening] = useState(false);
  async function beginResearch(project: Project, draft?: ComposerStash) {
    if (opening) return;
    setOpening(true);
    const stashes = getComposerStashStore(getWorkspaceGeneration());
    if (draft) stashes.set(`${project.id}:new`, draft);
    try {
      const selection = state?.preferredAgent ?? defaultSelection(await queryClient.fetchQuery(getHarnessesQuery()));
      if (!selection) throw new Error("请先在个人菜单的设置中配置科研智能体。项目已保留，可从继续研究重新进入。");
      const session = await createChatSession(project.id, selection.harness, { ...selection, autonomy: state?.preferredAutonomy ?? "agentic", ...(draft?.workMode !== "normal" ? { research: { mode: "team", objective: draft?.draft.trim().slice(0, 6000) || "请先澄清研究目标、已有材料和预期成果。" } } : {}) });
      if (draft) stashes.set(session.id, draft);
      stashes.delete(`${project.id}:new`);
      await navigate({ to: "/projects/$projectId/tasks/$sessionId", params: { projectId: project.id, sessionId: session.id } });
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
      void navigate({ to: "/projects", search: { project: project.id } });
    } finally { setOpening(false); }
  }

  return (
    <PlatformFrame title="新建项目 · AI 原生科研工作台">
    <div className="app flex flex-col flex-1 min-h-0">
      {runtime.kind === "local" && !isCloudWorkspace() && <><OfflineBanner /><UpdateBanner status={status} /></>}
      {error && (!projects || !state) ? <RouteFailure error={error} reset={retry} />
        : !projects || !state ? <RoutePending />
          : (
            <ProjectsHome
              remote={runtime.kind === "ssh"}
              projects={projects}
              initialDialogOpen={Boolean(start.new || start.paper)}
              initialPaperId={start.paper}
              initialProjectId={start.project}
              onResume={(project, draft) => void beginResearch(project, draft)}
              onOpen={openProject}
              onCreated={async (project, publicationError, draft) => {
                if (publicationError) {
                  if (draft) getComposerStashStore(getWorkspaceGeneration()).set(`${project.id}:new`, draft);
                  showAlert(publicationError, "error");
                  void navigate({ to: "/projects/$projectId/settings/$tab", params: { projectId: project.id, tab: "git" } });
                } else await beginResearch(project, draft);
              }}
              onDeleted={(id) => setScopedQueryData(projectsOptions.queryKey, (current) => current?.filter((project) => project.id !== id))}
            />
          )}
      {opening && <div role="status" className="fixed inset-0 z-100 flex items-center justify-center bg-modal-backdrop"><div className="rounded-xl bg-background p-5 text-text">正在准备研究工作区…</div></div>}
      {runtime.kind === "ssh" && <WorkspaceConnection runtime={runtime} corner />}
    </div>
    </PlatformFrame>
  );
}
