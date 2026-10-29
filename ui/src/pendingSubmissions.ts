import type { ComposerStash } from "./composerStash";
import type { ChatImageAttachment, ChatTextAnnotation, TurnOptions } from "./api";

export interface PendingIdentity {
  signature: string;
  id: string;
  sessionId: string | null;
  mode?: "steer";
}
export interface PendingSubmission extends PendingIdentity {
  sessionId: string;
  key: string;
  owner: string;
  scope: string;
  composer: ComposerStash;
  wire: { images: ChatImageAttachment[]; options: TurnOptions; annotations: ChatTextAnnotation[] };
}
export const pendingOwner = (account: string, user: string) => JSON.stringify([account, user]);
export const pendingScope = (owner: string, app: string, runtime: string, project: string) => JSON.stringify([owner, app, runtime, project]);
export const pendingKey = (scope: string, session: string) => JSON.stringify([scope, session]);

export function samePendingComposer(a: ComposerStash, b: ComposerStash) {
  const content = (value: ComposerStash) => JSON.stringify({
    draft: value.draft, workMode: value.workMode ?? "normal",
    attachments: value.attachments.map(file => ({ dataUrl: file.dataUrl, mediaType: file.mediaType, name: file.name,
      size: file.size, fileName: file.file?.name, modified: file.file?.lastModified })),
    annotations: value.annotations.map(({ id, text }) => ({ id, text })),
  });
  return content(a) === content(b);
}

export class PendingConflictError extends Error {
  constructor() { super("上次发送仍未确认，请先核实结果或放弃本地记录。"); }
}

/** A reload changes the query generation, not the original request payload. */
export function rescopePendingSignature(signature: string, workspace: readonly unknown[]): string {
  const parsed = JSON.parse(signature);
  return JSON.stringify({ ...parsed, workspace });
}

export function recoveredSettings(signature: string) {
  const value = JSON.parse(signature).settings as {
    model?: string | null; serviceTier?: string | null; permissionMode?: string | null; planMode?: boolean; reasoningLevel?: string | null;
  } | null;
  return value;
}

export interface PendingStorage {
  read(key: string): Promise<unknown>;
  put(value: PendingSubmission): Promise<void | boolean>;
  remove(key: string, id: string): Promise<void>;
  clearOwner(owner: string): Promise<void>;
}

function valid(value: unknown, scope: string, session: string): value is PendingSubmission {
  if (!value || typeof value !== "object") return false;
  const row = value as PendingSubmission;
  if (row.key !== pendingKey(scope, session) || row.scope !== scope || row.sessionId !== session
    || typeof row.owner !== "string" || typeof row.id !== "string" || !row.id || row.id.length > 256
    || typeof row.signature !== "string" || (row.mode !== undefined && row.mode !== "steer")) return false;
  try {
    if (JSON.parse(scope)[0] !== row.owner) return false;
    const signature = JSON.parse(row.signature);
    if (signature.sessionId !== session || !Array.isArray(signature.workspace) || typeof signature.text !== "string") return false;
    const settings = signature.settings;
    if (settings !== null && (typeof settings !== "object" || !settings
      || ["model", "serviceTier", "permissionMode", "reasoningLevel"].some(key => settings[key] !== undefined && settings[key] !== null && typeof settings[key] !== "string")
      || (settings.planMode !== undefined && typeof settings.planMode !== "boolean"))) return false;
  } catch { return false; }
  if (!row.wire || !Array.isArray(row.wire.images) || !Array.isArray(row.wire.annotations)
    || !row.wire.options || typeof row.wire.options !== "object"
    || !row.wire.images.every(a => !!a && typeof a.mediaType === "string" && typeof a.dataBase64 === "string")
    || !row.wire.annotations.every(a => !!a && typeof a.text === "string")) return false;
  const composer = row.composer;
  return !!composer && typeof composer.draft === "string" && Array.isArray(composer.attachments) && Array.isArray(composer.annotations)
    && [undefined, "normal", "literature", "reproduction", "analysis", "proposal", "team", "design", "diagnosis", "review"].includes(composer.workMode)
    && composer.attachments.every(a => !!a && typeof a.dataUrl === "string" && typeof a.mediaType === "string" && typeof a.size === "number"
      && Number.isFinite(a.size) && a.size >= 0 && (a.file === undefined || a.file instanceof Blob))
    && composer.annotations.every(a => !!a && typeof a.id === "string" && typeof a.text === "string");
}

/** One unresolved request per session. Replacement requires explicit disposal. */
export function createPendingJournal(storage: PendingStorage) {
  return {
    async read(scope: string, session: string) {
      const row = await storage.read(pendingKey(scope, session));
      if (row === undefined || row === null) return null;
      if (!valid(row, scope, session)) throw new Error("本地待确认记录无效，未自动恢复；请先检查对话与排队消息。");
      return { ...row, composer: { ...row.composer, annotations: row.composer.annotations.map(({ range: _range, ...a }) => a) } };
    },
    save: async (value: PendingSubmission) => (await storage.put(value)) !== false,
    remove: (scope: string, session: string, id: string) => storage.remove(pendingKey(scope, session), id),
    clearOwner: (owner: string) => storage.clearOwner(owner),
  };
}

const revokedOwners = new Set<string>();
const DATABASE = "mobilesci-pending-submissions-v1";
const TABLE = "pending";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let finished = false;
    const fail = (error: unknown) => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new Error("恢复记录存储响应超时")), 3000);
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE, { keyPath: "key" }).createIndex("owner", "owner");
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error("恢复记录存储正被其他页面占用"));
    request.onsuccess = () => {
      if (finished) { request.result.close(); return; }
      finished = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(TABLE, mode);
    let value: T;
    let error: unknown;
    const timer = setTimeout(() => { error = new Error("恢复记录事务超时"); tx.abort(); }, 3000);
    tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { clearTimeout(timer); db.close(); reject(error ?? tx.error ?? new Error("无法保存发送恢复记录")); };
    const fail = (cause: unknown) => { error = cause; tx.abort(); };
    try { run(tx.objectStore(TABLE), next => { value = next; }, fail); }
    catch (cause) { fail(cause); }
  });
}

export const indexedPendingStorage: PendingStorage = {
  read: key => transaction("readonly", (store, result) => { const request = store.get(key); request.onsuccess = () => result(request.result); }),
  put: value => transaction<void>("readwrite", (store, result, fail) => {
    const request = store.get(value.key);
    request.onsuccess = () => {
      if (revokedOwners.has(value.owner)) { fail(new Error("账号已退出")); return; }
      if (valid(request.result, value.scope, value.sessionId) && request.result.id !== value.id) { fail(new PendingConflictError()); return; }
      store.put(value); result(undefined);
    };
  }),
  remove: (key, id) => transaction<void>("readwrite", (store, result) => {
    const request = store.get(key);
    request.onsuccess = () => { if (request.result?.id === id) store.delete(key); result(undefined); };
  }),
  clearOwner: owner => transaction<void>("readwrite", (store, result) => {
    const request = store.index("owner").openCursor(IDBKeyRange.only(owner));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else result(undefined);
    };
  }),
};
const memory = new Map<string, PendingSubmission>();
const persistedKeys = new Set<string>();
export const pendingJournal = createPendingJournal({
  async read(key) {
    try { const value = await indexedPendingStorage.read(key); if (value) persistedKeys.add(key); return value ?? memory.get(key); }
    catch (error) { if (memory.has(key)) return memory.get(key); throw error; }
  },
  async put(value) {
    if (revokedOwners.has(value.owner)) throw new Error("账号已退出");
    const previous = memory.get(value.key);
    if (previous && previous.id !== value.id) throw new PendingConflictError();
    try { await indexedPendingStorage.put(value); memory.set(value.key, value); persistedKeys.add(value.key); return true; }
    catch (error) {
      if (error instanceof PendingConflictError || revokedOwners.has(value.owner)) throw error;
      memory.set(value.key, value); return false;
    }
  },
  async remove(key, id) {
    if (memory.get(key)?.id === id) memory.delete(key);
    try { await indexedPendingStorage.remove(key, id); persistedKeys.delete(key); }
    catch (error) { if (persistedKeys.has(key)) throw error; }
  },
  async clearOwner(owner) {
    for (const [key, row] of memory) if (row.owner === owner) memory.delete(key);
    await indexedPendingStorage.clearOwner(owner);
  },
});
export async function revokePendingOwner(owner: string) {
  revokedOwners.add(owner);
  await pendingJournal.clearOwner(owner);
}

const flights = new Map<string, string>();
const flightListeners = new Set<(key: string) => void>();
export const hasPendingFlight = (key: string) => flights.has(key);
export function subscribePendingFlights(listener: (key: string) => void) {
  flightListeners.add(listener);
  return () => { flightListeners.delete(listener); };
}
export function beginPendingFlight(key: string, id: string) {
  if (flights.has(key)) throw new PendingConflictError();
  flights.set(key, id);
  return () => {
    if (flights.get(key) !== id) return;
    flights.delete(key);
    flightListeners.forEach(listener => listener(key));
  };
}
