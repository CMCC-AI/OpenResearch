import { isChatMessage } from "./chatMessageDelta.ts";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const entity = (value: unknown) => record(value) && typeof value.id === "string" && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
const project = (value: unknown) => entity(value) && record(value) && typeof value.name === "string" && typeof value.repoPath === "string";
const run = (value: unknown) => entity(value) && record(value) && typeof value.projectId === "string" && typeof value.experimentId === "string" && typeof value.status === "string";
/** Validate core read contracts before malformed data reaches query caches.
 * Extra fields remain compatible with newer servers; optional fields stay optional. */
export function validateApiResponse(url: string, data: unknown): void {
  const path = new URL(url, "http://local.invalid").pathname;
  let key: string | undefined;
  let predicate: ((value: unknown) => boolean) | undefined;
  let many = false;
  if (path === "/api/projects") { key = "projects"; predicate = project; many = true; }
  else if (path === "/api/projects/activity") { key = "activity"; predicate = (value) => record(value) && typeof value.projectId === "string"; many = true; }
  else if (/^\/api\/projects\/[^/]+$/.test(path)) { key = "project"; predicate = project; }
  else if (/^\/api\/projects\/[^/]+\/runs$/.test(path)) { key = "runs"; predicate = run; many = true; }
  else if (/^\/api\/runs\/[^/]+$/.test(path)) { key = "run"; predicate = run; }
  else if (/^\/api\/chat\/sessions\/[^/]+\/messages$/.test(path)) { key = "messages"; predicate = isChatMessage; many = true; }
  if (!key || !predicate) return;
  const value = record(data) ? data[key] : undefined;
  if (!(many ? Array.isArray(value) && value.every(predicate) : predicate(value)))
    throw new Error("服务器数据格式不兼容，请刷新页面或更新客户端。");
}
