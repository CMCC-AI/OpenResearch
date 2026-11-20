import type { ChatSession, Project } from "./api";

const SNAPSHOT_PREFIX = "orx:sidebar-snapshot:v1:";
const QUICK_CHAT_PROJECT_ID = "quick-chat";
const MAX_PROJECTS = 50;
const MAX_SESSIONS_PER_PROJECT = 20;

interface SidebarSnapshotPayload {
  projects: Project[];
  sessions: Record<string, ChatSession[]>;
}

const lastSerialized = new Map<string, string>();

function storageKey(userId: string): string {
  return `${SNAPSHOT_PREFIX}${userId}`;
}

function readSnapshot(userId?: string): SidebarSnapshotPayload | null {
  if (!userId || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.projects)) return null;
    const projects = record.projects.filter(
      (item): item is Project =>
        Boolean(item) && typeof item === "object" && typeof (item as Project).id === "string" && typeof (item as Project).name === "string"
        && (item as Project).id !== QUICK_CHAT_PROJECT_ID && !(item as Project).isQuickChat,
    );
    const sessions: Record<string, ChatSession[]> = {};
    if (record.sessions && typeof record.sessions === "object" && !Array.isArray(record.sessions)) {
      for (const [projectId, list] of Object.entries(record.sessions as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        sessions[projectId] = list.filter(
          (item): item is ChatSession =>
            Boolean(item) && typeof item === "object" && typeof (item as ChatSession).id === "string" && typeof (item as ChatSession).projectId === "string",
        );
      }
    }
    return { projects, sessions };
  } catch {
    return null;
  }
}

function writeSnapshot(userId: string, payload: SidebarSnapshotPayload): void {
  if (typeof localStorage === "undefined") return;
  try {
    const key = storageKey(userId);
    const serialized = JSON.stringify(payload);
    if (lastSerialized.get(key) === serialized) return;
    localStorage.setItem(key, serialized);
    lastSerialized.set(key, serialized);
  } catch {
    /* Local cache persistence is best-effort. */
  }
}

export function readSidebarProjectsSnapshot(userId?: string): Project[] | undefined {
  const snapshot = readSnapshot(userId);
  return snapshot?.projects.length ? snapshot.projects : undefined;
}

export function readSidebarSessionsSnapshot(userId: string | undefined, projectId: string): ChatSession[] | undefined {
  const snapshot = readSnapshot(userId);
  const rows = snapshot?.sessions[projectId];
  return rows?.length ? rows : undefined;
}

export function writeSidebarProjectsSnapshot(userId: string | undefined, projects: readonly Project[]): void {
  if (!userId || typeof localStorage === "undefined") return;
  const current = readSnapshot(userId);
  const trimmed = projects
    .filter((project) => project.id !== QUICK_CHAT_PROJECT_ID && !project.isQuickChat)
    .slice(0, MAX_PROJECTS);
  const activeIds = new Set(trimmed.map((project) => project.id));
  const sessions: Record<string, ChatSession[]> = {};
  if (current) {
    for (const [projectId, rows] of Object.entries(current.sessions)) {
      if (activeIds.has(projectId) || projectId === QUICK_CHAT_PROJECT_ID) sessions[projectId] = rows;
    }
  }
  writeSnapshot(userId, { projects: trimmed, sessions });
}

export function writeSidebarSessionsSnapshot(
  userId: string | undefined,
  projectId: string,
  sessions: readonly ChatSession[],
): void {
  if (!userId || typeof localStorage === "undefined") return;
  const current = readSnapshot(userId) ?? { projects: [], sessions: {} };
  const nextSessions = {
    ...current.sessions,
    [projectId]: sessions.slice(0, MAX_SESSIONS_PER_PROJECT).map((session) => ({ ...session, busy: false })),
  };
  writeSnapshot(userId, { projects: current.projects, sessions: nextSessions });
}

export function clearSidebarSnapshots(userId?: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (userId) {
      const key = storageKey(userId);
      localStorage.removeItem(key);
      lastSerialized.delete(key);
      return;
    }
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(SNAPSHOT_PREFIX)) {
        localStorage.removeItem(key);
        lastSerialized.delete(key);
      }
    }
  } catch {
    /* Local cache cleanup is best-effort. */
  }
}
