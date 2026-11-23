import { appHref } from "../appBasePath";
import { listChatSessions, getChatMessages, getResearchStudy, listExperiments, listRuns } from "../api";
import { snapshotMessages, type CaseSnapshot } from "./caseSnapshot";

export interface FeaturedCase {
  id: string; title: string; summary: string; category: string;
  cover?: string | null;
  source_project_id?: string;
  source_session_id?: string | null;
  status: "draft" | "published"; revision: number; sort_order: number;
  created_at: string; updated_at: string; published_at: string | null;
}
export interface CaseFile { id: string; name: string; size: number; sha256: string }
export interface FeaturedCaseDetail extends FeaturedCase { snapshot: CaseSnapshot; files: CaseFile[]; source_project_id?: string; expected_file_count?: number }

export interface CaseLoadProgress {
  phase: "connecting" | "downloading" | "parsing";
  loadedBytes: number;
  totalBytes: number | null;
}

const progressSnapshots = new Map<string, CaseLoadProgress>();
const progressListeners = new Map<string, Set<() => void>>();

function notifyProgress(key: string) {
  const listeners = progressListeners.get(key);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

function setCaseLoadProgress(key: string | undefined, progress: CaseLoadProgress) {
  if (!key) return;
  progressSnapshots.set(key, progress);
  notifyProgress(key);
}

function clearCaseLoadProgress(key: string | undefined) {
  if (!key || !progressSnapshots.has(key)) return;
  progressSnapshots.delete(key);
  notifyProgress(key);
}

export function getCaseLoadProgress(key: string | undefined): CaseLoadProgress | null {
  return key ? progressSnapshots.get(key) ?? null : null;
}

export function subscribeCaseLoadProgress(key: string | undefined, listener: () => void) {
  if (!key) return () => {};
  let set = progressListeners.get(key);
  if (!set) {
    set = new Set();
    progressListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) progressListeners.delete(key);
  };
}

export async function caseRequest<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}/api/platform/${path}`, { ...init, credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(value?.error || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function caseDetailMeta(base: string, caseId: string, admin: boolean, signal?: AbortSignal): Promise<FeaturedCase> {
  return caseRequest<FeaturedCase>(base, `${admin ? "admin/cases" : "cases"}/${encodeURIComponent(caseId)}?meta=1`, { signal });
}

export async function caseDetailRequest(
  base: string,
  path: string,
  options: { signal?: AbortSignal; progressKey?: string } = {},
): Promise<FeaturedCaseDetail> {
  const { signal, progressKey } = options;
  setCaseLoadProgress(progressKey, { phase: "connecting", loadedBytes: 0, totalBytes: null });
  try {
    const response = await fetch(`${base}/api/platform/${path}`, { credentials: "include", cache: "no-store", signal });
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(value?.error || `请求失败（${response.status}）`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      setCaseLoadProgress(progressKey, { phase: "parsing", loadedBytes: 0, totalBytes: null });
      return await response.json() as FeaturedCaseDetail;
    }
    const rawHeader = Number(response.headers.get("x-case-json-bytes"));
    const hasExactRawBytes = Number.isFinite(rawHeader) && rawHeader > 0;
    const contentEncoding = response.headers.get("content-encoding")?.toLowerCase() ?? "";
    const lengthHeader = Number(response.headers.get("content-length"));
    let totalBytes: number | null = hasExactRawBytes
      ? rawHeader
      : !contentEncoding && Number.isFinite(lengthHeader) && lengthHeader > 0
        ? lengthHeader
        : null;
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    let lastEmit = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.byteLength;
      if (totalBytes !== null && !hasExactRawBytes && loadedBytes > totalBytes) totalBytes = null;
      const now = Date.now();
      if (lastEmit === 0 || now - lastEmit >= 50) {
        lastEmit = now;
        setCaseLoadProgress(progressKey, { phase: "downloading", loadedBytes, totalBytes });
      }
    }
    setCaseLoadProgress(progressKey, { phase: "parsing", loadedBytes, totalBytes: loadedBytes || totalBytes });
    if (loadedBytes > 256 * 1024) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
    const decoder = new TextDecoder("utf-8");
    let jsonText = "";
    for (const chunk of chunks) jsonText += decoder.decode(chunk, { stream: true });
    jsonText += decoder.decode();
    return JSON.parse(jsonText) as FeaturedCaseDetail;
  } finally {
    clearCaseLoadProgress(progressKey);
  }
}
export const caseWrite = <T,>(base: string, path: string, data: unknown) => caseRequest<T>(base, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

export async function uploadCaseCover(base: string, caseId: string, file: File, revision?: number): Promise<{ ok: true; cover: string; name: string }> {
  const query = revision === undefined ? "" : `?revision=${encodeURIComponent(String(revision))}`;
  return caseRequest<{ ok: true; cover: string; name: string }>(base, `admin/cases/${encodeURIComponent(caseId)}/cover${query}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
}

export async function captureProject(projectId: string, projectName?: string): Promise<CaseSnapshot> {
  const sessions = await listChatSessions(projectId);
  if (sessions.some((session) => session.busy)) throw new Error("项目仍有运行中的研究，请结束后再生成案例快照。");
  const aliases = new Map(sessions.map((session, index) => [session.id, `session-${index + 1}`]));
  const [experiments, runs] = await Promise.all([listExperiments(projectId), listRuns(projectId)]);
  if (runs.some((run) => run.status === "starting" || run.status === "running")) throw new Error("项目仍有运行中的实验，请结束后再生成案例快照。");
  const result: CaseSnapshot = { ...(projectName ? { projectName } : {}), sessions: [], experiments: experiments.map((row) => ({ ...row, projectId: "snapshot", chatSessionId: aliases.get(row.chatSessionId ?? "") ?? null })), runs: runs.map((row) => ({ ...row, projectId: "snapshot", backend: null })) };
  // Serial reads avoid overwhelming a large project's local database.
  for (const session of [...sessions].sort((a, b) => a.createdAt - b.createdAt)) {
    const record = await getChatMessages(session.id);
    if (record.queued.length) throw new Error("项目还有排队消息，请处理完毕后再生成案例快照。");
    if (record.messages.length) {
      const research = await getResearchStudy(session.id);
      const study = research.study ? structuredClone(research.study) : null;
      if (study) {
        study.sessionId = aliases.get(study.sessionId) ?? aliases.get(session.id)!;
        for (const plan of study.plans) for (const task of plan.tasks) task.sessionId = aliases.get(task.sessionId ?? "") ?? null;
      }
      const messages = snapshotMessages(record.messages);
      const leaf = record.messages.findIndex((message) => message.id === record.activeLeafId);
      result.sessions.push({
        id: aliases.get(session.id), title: session.title || "未命名研究会话", harness: session.harness,
        parentSessionId: aliases.get(session.parentSessionId ?? "") ?? null, archived: session.archived,
        activeLeafId: leaf >= 0 ? messages[leaf].id : null, messages,
        research: { study, runs: study ? research.runs.map((run) => ({ ...run, projectId: "snapshot", backend: null })) : [] },
      });
    }
  }
  const after = await listChatSessions(projectId);
  if (after.length !== sessions.length || after.some((session) => session.busy || sessions.find((before) => before.id === session.id)?.updatedAt !== session.updatedAt)) throw new Error("读取期间研究记录发生变化，请重新生成快照。");
  if (!result.sessions.length) throw new Error("这个项目还没有研究对话，不能发布为空案例。");
  return result;
}

export async function sourceFile(url: string): Promise<Blob> {
  const response = await fetch(appHref(url), { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`成果文件读取失败（${response.status}）`);
  const length = Number(response.headers.get("content-length"));
  if (length > 25 * 1024 * 1024) { await response.body?.cancel(); throw new Error("单个成果文件不能超过 25 MB。"); }
  const reader = response.body?.getReader();
  if (!reader) return new Blob();
  const chunks: ArrayBuffer[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 25 * 1024 * 1024) { await reader.cancel(); throw new Error("单个成果文件不能超过 25 MB。"); }
    chunks.push(value.slice().buffer);
  }
  return new Blob(chunks);
}

export async function caseFileBlob(base: string, caseId: string, fileId: string, admin: boolean) {
  const response = await fetch(`${base}/api/platform/${admin ? "admin/cases" : "cases"}/${encodeURIComponent(caseId)}/files/${encodeURIComponent(fileId)}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`文件不可访问，案例可能已下架（${response.status}）`);
  return response.blob();
}
