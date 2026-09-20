import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as derive,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(derive);
export const id = () => randomUUID();
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const pkce = (value) =>
  createHash("sha256").update(value).digest("base64url");
export function secretEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function check(condition, status = 400, message = "请求参数无效") {
  if (!condition) throw new HttpError(status, message);
}
export function text(value, max = 120) {
  check(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
  );
  return value.trim();
}
export function email(value) {
  const result = text(value, 254).toLowerCase();
  check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result));
  return result;
}
export async function passwordHash(password) {
  check(
    typeof password === "string" &&
      password.length >= 12 &&
      password.length <= 256,
    400,
    "密码需为 12–256 个字符",
  );
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [, salt, key] = (encoded || "").split(":");
  const actual = await scrypt(password, salt || "unknown-account-salt", 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return !!key && timingSafeEqual(actual, Buffer.from(key, "hex"));
}
export function cookie(req, name) {
  return (
    (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ""
  );
}
export const cookieName = (secure) =>
  secure ? "__Host-orx_session" : "orx_session";
export function sessionCookie(value, secure, maxAge = 43200) {
  return `${cookieName(secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function workspaceOrigin(config, workspace) {
  return `${config.origin.protocol}//${workspace}.${config.origin.host}`;
}
export function hostWorkspace(config, host) {
  if (host === config.origin.host) return null;
  const suffix = `.${config.origin.host}`;
  check(host?.endsWith(suffix), 421, "未知访问域名");
  const workspace = host.slice(0, -suffix.length);
  check(/^[0-9a-f-]{36}$/.test(workspace), 421, "未知访问域名");
  return workspace;
}
export function sameOrigin(req, origin) {
  check(req.headers.origin === origin, 403, "请求来源不受信任");
}
// A workspace is a trust boundary: its members can access all its research projects.
// Never expose machine administration or internal callback endpoints through the gateway.
export function permitted(role, method, path) {
  if (!/^\/api\/[a-zA-Z0-9/_.,-]+$/.test(path)) return false;
  if (/^\/api\/(internal|remote|update|overleaf)(\/|$)/.test(path))
    return false;
  if (/^\/api\/settings\/(data-dir|ssh|commands|openresearch)(\/|$)/.test(path))
    return false;
  if (
    path === "/api/project-path/pick" ||
    path === "/api/harnesses/setup" ||
    path.endsWith("/file/open")
  )
    return false;
  if (role === "owner" || role === "editor") return true;
  if (
    role !== "viewer" ||
    !["GET", "HEAD"].includes(method) ||
    path.endsWith("/terminal")
  )
    return false;
  // Explicit read surfaces only: some upstream GET routes perform work or expose secrets.
  return /^\/api\/(health|projects(?:\/activity)?|projects\/[^/]+(?:\/(?:experiments|runs|git|code-tree|working-tree|ui-state|file|file\/raw|files|files\/file))?|runs\/[^/]+(?:\/(?:log|logs|diff))?|experiments\/[^/]+\/(?:diff|commits)|papers\/(?:search|discover|resolve)|deep-literature\/(?:status|papers)|events|chat\/sessions(?:\/[^/]+\/(?:messages|worktree))?|chat\/attachments\/[^/]+|harnesses|agent\/status|compute\/backends|instances|settings\/(?:ui-state|profile|git|lit-sources))$/.test(
    path,
  );
}
