import { isCancelledError, useQuery } from "@tanstack/react-query";
import { ProjectsHome } from "./components/ProjectsHome";
import { setScopedQueryData } from "./queries/client";
import { listProjectsQuery, getUiStateQuery } from "./queries/projects";
import { isCloudWorkspace } from "./product/CloudWorkspace";
import { useRouteContext, Link, useNavigate, useSearch, type ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useRuntime } from "./RemoteRuntime";

import { globalResumeLocation, projectResumeLocation } from "./routeResume";
import { m } from "./paraglide/messages.js";
import { createChatSession, type Project } from "./api";
import { getHarnessesQuery } from "./queries/settings";
import { listChatSessionsQuery } from "./queries/chat";
import { defaultSelection } from "./components/ModelPicker";
import { researchModes } from "./research";
import { getComposerStashStore, getResearchSubmissionStore, type ComposerStash } from "./composerStash";
import { getWorkspaceGeneration } from "./queries/client";
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
  const { queryClient: client } = useRouteContext({ from: "__root__" });
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
    document.title = "MobileSci";
  }, []);
  const openProject = (projectId: string) => void navigate({ to: "/projects/$projectId", params: { projectId } });
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);

  async function beginResearch(project: Project, draft: ComposerStash) {
    if (startingRef.current) return;
    const generation = getWorkspaceGeneration();
    if (!draft.draft.trim() && !draft.attachments.length && !draft.annotations.length) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const [harnesses] = await Promise.all([
        client.fetchQuery(getHarnessesQuery()),
        client.fetchQuery(listChatSessionsQuery(project.id)),
      ]);
      const selection = defaultSelection(harnesses, state?.preferredAgent ?? null);
      if (!selection || !harnesses.find((harness) => harness.id === selection.harness)?.agentReady) {
        throw new Error(m.chat_selected_harness_unavailable());
      }
      if (generation !== getWorkspaceGeneration()) return;
      const mode = draft.workMode ?? "normal";
      const session = await createChatSession(project.id, selection.harness, {
        ...selection,
        autonomy: state?.preferredAutonomy ?? undefined,
        ...(mode !== "normal" ? { research: { mode, objective: draft.draft.trim() || researchModes[mode] } } : {}),
      });
      if (generation !== getWorkspaceGeneration()) return;
      getComposerStashStore(generation).set(session.id, draft);
      getResearchSubmissionStore(generation).set(session.id, draft);
      setScopedQueryData(listChatSessionsQuery(project.id).queryKey, (rows) => [session, ...(rows ?? []).filter((row) => row.id !== session.id)]);
      getComposerStashStore(generation).delete(`${project.id}:new`);
      await navigate({ to: "/projects/$projectId/tasks/$sessionId", params: { projectId: project.id, sessionId: session.id } });
    } catch (error) {
      if (generation === getWorkspaceGeneration()) {
        getComposerStashStore(generation).set(`${project.id}:new`, draft);
        showAlert(error instanceof Error ? error.message : String(error), "error");
        if (start.project !== project.id) await navigate({ to: "/projects", search: { project: project.id }, replace: true });
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  return (
    <PlatformFrame title="新对话 · AI 原生科研工作台" projectId={projects?.some((project) => project.id === start.project) ? start.project : undefined}>
    <div className="app flex flex-col flex-1 min-h-0">
      {runtime.kind === "local" && !isCloudWorkspace() && <><OfflineBanner /><UpdateBanner status={status} /></>}
      {error && (!projects || !state) ? <RouteFailure error={error} reset={retry} />
        : !projects || !state ? <RoutePending />
          : (
            <ProjectsHome
              key={start.project ?? "research-home"}
              preferredAgent={state.preferredAgent}
              starting={starting}
              projects={projects}
              initialDialogOpen={Boolean(start.new)}
              initialProjectId={start.project}
              onResume={beginResearch}
              onOpen={openProject}
              onCreated={async (project, publicationError, draft) => {
                if (publicationError) {
                  if (draft) getComposerStashStore(getWorkspaceGeneration()).set(`${project.id}:new`, draft);
                  showAlert(publicationError, "error");
                  void navigate({ to: "/projects/$projectId/settings/$tab", params: { projectId: project.id, tab: "git" } });
                } else if (draft && (draft.draft.trim() || draft.attachments.length || draft.annotations.length)) {
                  await beginResearch(project, draft);
                } else openProject(project.id);
              }}
              onDeleted={(id) => setScopedQueryData(projectsOptions.queryKey, (current) => current?.filter((project) => project.id !== id))}
            />
          )}
      {runtime.kind === "ssh" && <WorkspaceConnection runtime={runtime} corner />}
    </div>
    </PlatformFrame>
  );
}
