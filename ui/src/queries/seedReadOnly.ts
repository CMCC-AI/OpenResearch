import type { QueryClient } from "@tanstack/react-query";
import type { ChatMessage, ChatSession, Experiment, Harness, Project, ProjectArtifacts, QueuedMessage, Run, UiState } from "../api";
import type { NativeProjectSnapshot } from "../product/nativeProjectSnapshot";
import { canonicalRequest } from "../readOnlyApi";
import type { ProjectWorkspace } from "../workspaceState";

function readResponse<T>(responses: Record<string, unknown>, rawPath: string, encodedPath?: string): T | undefined {
  const raw = responses[canonicalRequest(rawPath)];
  if (raw !== undefined) return raw as T;
  if (encodedPath) {
    const encoded = responses[canonicalRequest(encodedPath)];
    if (encoded !== undefined) return encoded as T;
  }
  return undefined;
}

/** Populate TanStack Query caches from the in-memory case snapshot before App mounts so the first frame renders without waterfalls or blank loading screens. */
export function seedReadOnlyWorkspace(client: QueryClient, caseId: string, workspace: NativeProjectSnapshot): ProjectWorkspace | null {
  const { responses, projectId, sessionId } = workspace;
  const scope = ["workspace", caseId] as const;
  const encodedProject = encodeURIComponent(projectId);

  const projects = readResponse<{ projects?: Project[] }>(responses, "/api/projects")?.projects;
  if (projects) client.setQueryData([...scope, "listProjects"], projects);

  const uiState = readResponse<UiState>(responses, "/api/settings/ui-state");
  if (uiState) client.setQueryData([...scope, "getUiState"], uiState);

  const sessions = readResponse<{ sessions?: ChatSession[] }>(
    responses,
    `/api/chat/sessions?projectId=${projectId}`,
    `/api/chat/sessions?projectId=${encodedProject}`,
  )?.sessions;
  if (sessions) client.setQueryData([...scope, "listChatSessions", projectId], sessions);

  const projectUiState = readResponse<ProjectWorkspace | null>(
    responses,
    `/api/projects/${projectId}/ui-state`,
    `/api/projects/${encodedProject}/ui-state`,
  );
  if (projectUiState !== undefined) client.setQueryData([...scope, "getProjectUiState", projectId], projectUiState);

  const experiments = readResponse<{ experiments?: Experiment[] }>(
    responses,
    `/api/projects/${projectId}/experiments`,
    `/api/projects/${encodedProject}/experiments`,
  )?.experiments;
  if (experiments) client.setQueryData([...scope, "listExperiments", projectId], experiments);

  const runs = readResponse<{ runs?: Run[] }>(
    responses,
    `/api/projects/${projectId}/runs`,
    `/api/projects/${encodedProject}/runs`,
  )?.runs;
  if (runs) client.setQueryData([...scope, "listRuns", projectId], runs);

  const artifacts = readResponse<ProjectArtifacts>(
    responses,
    `/api/projects/${projectId}/files`,
    `/api/projects/${encodedProject}/files`,
  );
  if (artifacts) client.setQueryData([...scope, "getArtifacts", projectId], artifacts);

  const harnesses = readResponse<{ harnesses?: Harness[] }>(responses, "/api/harnesses")?.harnesses;
  if (harnesses) client.setQueryData([...scope, "getHarnesses"], harnesses);

  const sessionIds = new Set<string>();
  if (sessionId) sessionIds.add(sessionId);
  for (const session of sessions ?? []) sessionIds.add(session.id);

  for (const sid of sessionIds) {
    const encodedSession = encodeURIComponent(sid);
    const messages = readResponse<{ messages?: ChatMessage[]; queued?: QueuedMessage[]; activeLeafId?: string | null }>(
      responses,
      `/api/chat/sessions/${sid}/messages`,
      `/api/chat/sessions/${encodedSession}/messages`,
    );
    if (messages?.messages) {
      client.setQueryData([...scope, "getChatMessages", sid], {
        messages: messages.messages,
        queued: messages.queued ?? [],
        activeLeafId: messages.activeLeafId ?? null,
      });
    }
    const research = readResponse<unknown>(
      responses,
      `/api/research/sessions/${sid}`,
      `/api/research/sessions/${encodedSession}`,
    );
    if (research !== undefined) client.setQueryData([...scope, "researchStudy", sid], research);
  }

  return projectUiState ?? null;
}
