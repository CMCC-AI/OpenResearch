import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { createPool, transaction } from "./db.mjs";
import {
  check,
  HttpError,
  id,
  token,
  hash,
  text,
  email,
  passwordHash,
  verifyPassword,
  cookie,
  cookieName,
  sessionCookie,
  hostWorkspace,
  workspaceOrigin,
  workspaceEntryOrigin,
  sameOrigin,
  permitted,
  secretEqual,
  pkce,
} from "./security.mjs";
import { Tunnel, body } from "./tunnel.mjs";

export function configuration(env = process.env) {
  const origin = new URL(env.PLATFORM_ORIGIN || "http://localhost:5300");
  check(
    !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash,
  );
  const approvedHttpOrigin = env.PLATFORM_INSECURE_PUBLIC_ORIGIN || "";
  const permitsHttp = (url) =>
    url.protocol === "http:" && url.origin === approvedHttpOrigin;
  const secure = origin.protocol === "https:";
  check(
    secure ||
      (origin.protocol === "http:" && origin.hostname === "localhost") ||
      permitsHttp(origin),
    400,
    "Public deployments require HTTPS",
  );
  const appOrigin = new URL(
    env.OPENRESEARCH_APP_ORIGIN || "http://127.0.0.1:4791",
  );
  check(
    !appOrigin.username &&
      !appOrigin.password &&
      appOrigin.pathname === "/" &&
      !appOrigin.search &&
      !appOrigin.hash &&
      (appOrigin.protocol === "https:" ||
        (appOrigin.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(appOrigin.hostname)) ||
        permitsHttp(appOrigin)),
    500,
    "OPENRESEARCH_APP_ORIGIN must be HTTPS or a loopback HTTP origin",
  );
  check(env.DATABASE_URL, 500, "DATABASE_URL is required");
  check(
    env.PRIVATE_USER_SPACES !== "true" || env.MANAGED_EXECUTORS === "true",
    500,
    "PRIVATE_USER_SPACES requires MANAGED_EXECUTORS",
  );
  const appPath = env.OPENRESEARCH_APP_PATH || "";
  check(
    appPath === "" || appPath === "/sona",
    500,
    "Unsupported application path",
  );
  const managedCapacity = Number(env.MANAGED_CAPACITY || 4);
  check(
    Number.isSafeInteger(managedCapacity) && managedCapacity > 0,
    500,
    "MANAGED_CAPACITY must be a positive integer",
  );
  const deepLiteratureOrigin = env.DEEPLIT_ORIGIN
    ? new URL(env.DEEPLIT_ORIGIN)
    : null;
  const deepLiteratureSecret = env.DEEPLIT_SSO_CLIENT_SECRET || "";
  check(
    (!deepLiteratureOrigin && !deepLiteratureSecret) ||
      (deepLiteratureOrigin && deepLiteratureSecret.length >= 32),
    500,
    "DEEPLIT_ORIGIN and a 32-character DEEPLIT_SSO_CLIENT_SECRET are required together",
  );
  if (deepLiteratureOrigin)
    check(
      ["http:", "https:"].includes(deepLiteratureOrigin.protocol) &&
        !deepLiteratureOrigin.username &&
        !deepLiteratureOrigin.password &&
        deepLiteratureOrigin.pathname === "/" &&
        !deepLiteratureOrigin.search &&
        !deepLiteratureOrigin.hash &&
        (deepLiteratureOrigin.protocol === "https:" ||
          deepLiteratureOrigin.hostname === "localhost" ||
          permitsHttp(deepLiteratureOrigin)),
      500,
      "DEEPLIT_ORIGIN must be an HTTPS origin (localhost may use HTTP)",
    );
  return {
    origin,
    appOrigin: appOrigin.origin,
    appEntry: `${appOrigin.origin}${appPath}`,
    secure,
    researchOwnerEmail: env.PLATFORM_RESEARCH_OWNER_EMAIL || "",
    managed: env.MANAGED_EXECUTORS === "true",
    privateSpaces: env.PRIVATE_USER_SPACES === "true",
    managedCapacity,
    database: env.DATABASE_URL,
    port: Number(env.PORT || 5300),
    bind: env.BIND_ADDRESS || "127.0.0.1",
    deepLiterature: deepLiteratureOrigin
      ? { origin: deepLiteratureOrigin.origin, secret: deepLiteratureSecret }
      : null,
    ui: resolve(
      env.ORX_UI_DIST ||
        fileURLToPath(new URL("../../../ui/dist", import.meta.url)),
    ),
  };
}
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const input = async (req) => {
  check(req.headers["content-type"]?.split(";")[0] === "application/json", 415);
  try {
    const value = JSON.parse((await body(req, 32 * 1024)).toString());
    check(value && typeof value === "object" && !Array.isArray(value));
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "JSON 格式无效");
  }
};
const audit = (db, actor, workspace, action, resource = null) =>
  db.query(
    "INSERT INTO audit_events(actor_id,workspace_id,action,resource) VALUES($1,$2,$3,$4)",
    [actor, workspace, action, resource],
  );

export async function createPlatform(
  config,
  pool = createPool(config.database),
) {
  const tunnels = new Map();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 12 * 1024 * 1024,
    perMessageDeflate: false,
  });
  async function limit(key, maximum, seconds) {
    const { rows } = await pool.query(
      `INSERT INTO auth_limits(key,attempts,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_limits.expires_at<now() THEN 1 ELSE auth_limits.attempts+1 END,
      expires_at=CASE WHEN auth_limits.expires_at<now() THEN now()+$2*interval '1 second' ELSE auth_limits.expires_at END RETURNING attempts`,
      [key, seconds],
    );
    check(rows[0].attempts <= maximum, 429, "请求过于频繁，请稍后再试");
  }
  async function session(req) {
    const digest = hash(cookie(req, cookieName(config.secure)));
    const { rows } = await pool.query(
      `SELECT s.*,u.email,u.name FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id
      LEFT JOIN platform_sessions p ON p.token_hash=s.parent_hash
      WHERE s.token_hash=$1 AND s.host=$2 AND s.expires_at>now() AND NOT u.disabled
      AND (s.parent_hash IS NULL OR p.expires_at>now())`,
      [digest, req.headers.host],
    );
    check(rows[0], 401, "请先登录");
    return rows[0];
  }
  async function member(
    user,
    workspace,
    roles = ["owner", "editor", "viewer"],
    db = pool,
  ) {
    check(/^[0-9a-f-]{36}$/.test(workspace), 404, "工作空间不存在");
    if (config.privateSpaces) {
      const owner = await db.query(
        "SELECT id FROM workspaces WHERE id=$1 AND created_by=$2",
        [workspace, user],
      );
      check(owner.rows.length, 404, "工作空间不存在");
    }
    const { rows } = await db.query(
      "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [workspace, user],
    );
    check(rows[0], 404, "工作空间不存在");
    check(roles.includes(rows[0].role), 403, "当前角色没有此权限");
    return rows[0].role;
  }
  async function access(req, workspace, websocket = false) {
    const s = await session(req);
    const role = await member(s.user_id, workspace);
    const url = new URL(req.url, config.origin);
    check(
      permitted(role, req.method, url.pathname),
      403,
      "此操作未对当前角色开放",
    );
    if (websocket || !["GET", "HEAD"].includes(req.method))
      sameOrigin(req, workspaceOrigin(config, workspace));
    return { s, role };
  }
  async function newSession(db, user, host, parent = null) {
    const secret = token();
    await db.query(
      `INSERT INTO platform_sessions(token_hash,user_id,host,parent_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')`,
      [hash(secret), user, host, parent],
    );
    return secret;
  }
  function deepLiteratureRedirect() {
    check(config.deepLiterature, 404, "Deep Literature SSO is disabled");
    return `${config.deepLiterature.origin}/api/auth/openresearch/callback`;
  }
  async function authorizeDeepLiterature(req, res, s, workspace = null) {
    await limit(`sso-authorize:${s.user_id}`, 120, 60);
    const url = new URL(req.url, config.origin);
    check(url.searchParams.get("client_id") === "deeplit", 400);
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    check(
      redirectUri === deepLiteratureRedirect(),
      400,
      "Invalid redirect URI",
    );
    const state = url.searchParams.get("state") || "";
    const challenge = url.searchParams.get("code_challenge") || "";
    check(/^[A-Za-z0-9_-]{43}$/.test(state), 400, "Invalid state");
    check(/^[A-Za-z0-9_-]{43}$/.test(challenge), 400, "Invalid PKCE challenge");
    check(url.searchParams.get("code_challenge_method") === "S256", 400);
    const code = token();
    const root = s.parent_hash || s.token_hash;
    await pool.query(
      `INSERT INTO sso_authorization_codes(token_hash,root_session_hash,user_id,workspace_id,redirect_uri,code_challenge,state,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '60 seconds')`,
      [hash(code), root, s.user_id, workspace, redirectUri, challenge, state],
    );
    await audit(pool, s.user_id, workspace, "sso.authorize", "deeplit");
    const destination = new URL(redirectUri);
    destination.searchParams.set("code", code);
    destination.searchParams.set("state", state);
    res.writeHead(303, { location: destination.href });
    res.end();
  }
  function requireSsoService(req) {
    check(config.deepLiterature, 404, "Deep Literature SSO is disabled");
    check(
      secretEqual(
        req.headers["x-sso-client-secret"],
        config.deepLiterature.secret,
      ),
      401,
      "Invalid client credentials",
    );
  }
  async function ssoIdentity(grantId, subject) {
    const { rows } = await pool.query(
      `SELECT g.id,g.user_id,g.workspace_id,g.expires_at,u.name,u.email
       FROM sso_grants g JOIN platform_sessions s ON s.token_hash=g.root_session_hash
       JOIN platform_users u ON u.id=g.user_id
       LEFT JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id
       WHERE g.id=$1 AND g.user_id=$2 AND g.expires_at>now() AND s.expires_at>now()
       AND NOT u.disabled AND (g.workspace_id IS NULL OR m.user_id IS NOT NULL)`,
      [grantId, subject],
    );
    check(rows[0], 401, "SSO session expired");
    const row = rows[0];
    return {
      issuer: "openresearch",
      audience: "deeplit",
      subject: row.user_id,
      name: row.name,
      email: row.email,
      sessionId: row.id,
      workspaceId: row.workspace_id,
      expiresAt: new Date(row.expires_at).toISOString(),
      requestId: null,
    };
  }
  async function staticFile(res, directory, pathname) {
    check(!pathname.includes("\\") && !pathname.includes("\0"), 400);
    const path = resolve(directory, `.${pathname}`);
    check(path === directory || path.startsWith(directory + sep), 404);
    let file = path;
    try {
      if (!(await stat(file)).isFile()) file = resolve(directory, "index.html");
    } catch {
      if (extname(pathname)) throw new HttpError(404, "文件不存在");
      file = resolve(directory, "index.html");
    }
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
    };
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
    });
    res.end(await readFile(file));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' " +
        `${config.origin.protocol}//*.${config.origin.host}`,
    );
    if (config.secure)
      res.setHeader(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    try {
      const path = new URL(req.url, config.origin).pathname;
      const ssoServicePath = [
        "/api/auth/sso/exchange",
        "/api/auth/sso/session",
        "/api/auth/sso/logout",
      ].includes(path);
      const localDockerSsoBridge =
        ssoServicePath &&
        req.method === "POST" &&
        config.origin.hostname === "localhost" &&
        req.headers.host ===
          `host.docker.internal:${config.origin.port || "80"}`;
      const requestedWorkspace = localDockerSsoBridge
        ? null
        : hostWorkspace(config, req.headers.host);
      if (requestedWorkspace) {
        const workspace = requestedWorkspace;
        if (path === "/_platform/enter" && req.method === "GET")
          return await staticFile(res, publicDir, "/workspace-enter.html");
        if (path === "/workspace-enter.js" && req.method === "GET")
          return await staticFile(res, publicDir, path);
        if (path === "/_platform/enter" && req.method === "POST") {
          workspaceEntryOrigin(req, workspaceOrigin(config, workspace));
          const params = new URLSearchParams(
            (await body(req, 4096)).toString(),
          );
          const secret = await transaction(pool, async (db) => {
            const { rows } = await db.query(
              `DELETE FROM launch_tickets WHERE token_hash=$1 AND workspace_id=$2 AND expires_at>now() RETURNING session_hash`,
              [hash(params.get("ticket") || ""), workspace],
            );
            check(rows[0], 401, "工作空间链接已过期，请重新打开");
            const root = await db.query(
              `SELECT s.* FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND NOT u.disabled`,
              [rows[0].session_hash],
            );
            check(root.rows[0], 401, "请重新登录");
            await member(root.rows[0].user_id, workspace, undefined, db);
            return newSession(
              db,
              root.rows[0].user_id,
              req.headers.host,
              rows[0].session_hash,
            );
          });
          res.writeHead(303, {
            "set-cookie": sessionCookie(secret, config.secure),
            location: "/projects",
          });
          return res.end();
        }
        const s = await session(req);
        const role = await member(s.user_id, workspace);
        if (path === "/api/auth/sso/authorize" && req.method === "GET")
          return await authorizeDeepLiterature(req, res, s, workspace);
        if (path === "/_platform/context" && req.method === "GET")
          return json(res, {
            workspace,
            role,
            online: tunnels.has(workspace),
            portal: config.origin.origin,
            privateSpaces: !!config.privateSpaces,
            deepLiteratureUrl: config.deepLiterature?.origin || null,
            user: { id: s.user_id, name: s.name, email: s.email },
          });
        if (path === "/_platform/logout" && req.method === "POST") {
          sameOrigin(req, workspaceOrigin(config, workspace));
          const root = s.parent_hash || s.token_hash;
          const children = await pool.query(
            "SELECT token_hash FROM platform_sessions WHERE token_hash=$1 OR parent_hash=$1",
            [root],
          );
          await pool.query(
            "DELETE FROM platform_sessions WHERE token_hash=$1",
            [root],
          );
          for (const tunnel of tunnels.values())
            for (const row of children.rows)
              tunnel.revokeSession(row.token_hash);
          res.setHeader("set-cookie", sessionCookie("", config.secure, 0));
          return json(res, { ok: true });
        }
        if (path === "/_orx/runtime" && req.method === "GET")
          return json(res, { kind: "local", version: "platform" });
        // Navigation and model selection are personal preferences, never shared runner state.
        if (
          path === "/api/settings/ui-state" ||
          /^\/api\/projects\/[a-zA-Z0-9_-]+\/ui-state$/.test(path)
        ) {
          check(["GET", "POST"].includes(req.method), 405);
          const global = path === "/api/settings/ui-state";
          if (req.method === "POST") {
            sameOrigin(req, workspaceOrigin(config, workspace));
            const data = await input(req);
            check(data && typeof data === "object" && !Array.isArray(data));
            if (global)
              check(
                Object.keys(data).every((key) =>
                  ["workspace", "tourCompleted", "preferredAgent"].includes(
                    key,
                  ),
                ),
              );
            await pool.query(
              `INSERT INTO workspace_preferences VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id,key) DO UPDATE SET data=CASE WHEN $5 THEN workspace_preferences.data || excluded.data ELSE excluded.data END`,
              [workspace, s.user_id, path, JSON.stringify(data), global],
            );
          }
          const result = await pool.query(
            "SELECT data FROM workspace_preferences WHERE workspace_id=$1 AND user_id=$2 AND key=$3",
            [workspace, s.user_id, path],
          );
          return json(
            res,
            global
              ? {
                  workspace: null,
                  onboardingCompleted: true,
                  tourCompleted: false,
                  preferredAgent: null,
                  ...result.rows[0]?.data,
                }
              : result.rows[0]?.data || null,
          );
        }
        if (path.startsWith("/api/")) {
          await access(req, workspace);
          await limit(`api:${workspace}:${s.user_id}`, 600, 60);
          const tunnel = tunnels.get(workspace);
          check(tunnel, 503, "执行器离线，请联系工作空间管理员");
          if (!["GET", "HEAD"].includes(req.method))
            await audit(
              pool,
              s.user_id,
              workspace,
              `research.${req.method}`,
              path,
            );
          await tunnel.http(req, res, s.token_hash, () =>
            access(req, workspace),
          );
          return;
        }
        check(req.method === "GET" || req.method === "HEAD", 405);
        return await staticFile(res, config.ui, path);
      }
      if (path === "/healthz") {
        await pool.query("SELECT 1");
        return json(res, { ok: true });
      }
      if (path === "/api/auth/sso/authorize" && req.method === "GET") {
        const s = await session(req);
        return await authorizeDeepLiterature(req, res, s);
      }
      if (
        [
          "/api/auth/sso/exchange",
          "/api/auth/sso/session",
          "/api/auth/sso/logout",
        ].includes(path) &&
        req.method === "POST"
      ) {
        requireSsoService(req);
        await limit(
          `sso-service:${path}:${hash(req.socket.remoteAddress || "")}`,
          path === "/api/auth/sso/session" ? 6000 : 300,
          60,
        );
        const b = await input(req);
        if (path === "/api/auth/sso/exchange") {
          check(/^[A-Za-z0-9_-]{43}$/.test(b.code || ""), 401);
          check(/^[A-Za-z0-9_-]{43}$/.test(b.verifier || ""), 401);
          check(b.redirectUri === deepLiteratureRedirect(), 401);
          const grant = id();
          // Consume before validation so a bad verifier cannot be retried online.
          const consumed = await pool.query(
            `DELETE FROM sso_authorization_codes
             WHERE token_hash=$1 AND expires_at>now()
             RETURNING *`,
            [hash(b.code)],
          );
          const issued = consumed.rows[0];
          check(issued, 401, "Authorization code expired");
          check(
            issued.redirect_uri === b.redirectUri &&
              pkce(b.verifier) === issued.code_challenge,
            401,
            "Invalid authorization code",
          );
          const inserted = await pool.query(
            `INSERT INTO sso_grants(id,client,root_session_hash,user_id,workspace_id,expires_at)
             SELECT $1,'deeplit',$2,$3,$4,LEAST(expires_at,now()+interval '12 hours')
             FROM platform_sessions WHERE token_hash=$2 AND expires_at>now()
             RETURNING expires_at`,
            [
              grant,
              issued.root_session_hash,
              issued.user_id,
              issued.workspace_id,
            ],
          );
          check(inserted.rows[0], 401, "Platform session expired");
          const identity = await ssoIdentity(grant, issued.user_id);
          identity.requestId = issued.state;
          return json(res, { code: 200, data: identity });
        }
        check(/^[0-9a-f-]{36}$/.test(b.subject || ""), 401);
        check(/^[0-9a-f-]{36}$/.test(b.sessionId || ""), 401);
        if (path === "/api/auth/sso/session")
          return json(res, {
            code: 200,
            data: await ssoIdentity(b.sessionId, b.subject),
          });
        const grant = await pool.query(
          "SELECT root_session_hash FROM sso_grants WHERE id=$1 AND user_id=$2",
          [b.sessionId, b.subject],
        );
        check(grant.rows[0], 401, "SSO session expired");
        const children = await pool.query(
          "SELECT token_hash FROM platform_sessions WHERE token_hash=$1 OR parent_hash=$1",
          [grant.rows[0].root_session_hash],
        );
        await pool.query("DELETE FROM platform_sessions WHERE token_hash=$1", [
          grant.rows[0].root_session_hash,
        ]);
        for (const tunnel of tunnels.values())
          for (const row of children.rows) tunnel.revokeSession(row.token_hash);
        return json(res, { code: 200, data: { ok: true } });
      }
      const browserSessionPath = [
        "/api/platform/browser-session",
        "/api/platform/browser-logout",
      ].includes(path);
      if (browserSessionPath) {
        sameOrigin(req, config.appOrigin);
        res.setHeader("access-control-allow-origin", config.appOrigin);
        res.setHeader("access-control-allow-credentials", "true");
        res.setHeader("vary", "Origin");
        if (req.method === "OPTIONS") {
          res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
          res.setHeader("access-control-allow-headers", "content-type");
          res.writeHead(204);
          return res.end();
        }
        const s = await session(req);
        if (path === "/api/platform/browser-session" && req.method === "GET") {
          if (config.researchOwnerEmail)
            check(
              s.email === config.researchOwnerEmail,
              403,
              "该账号无权访问此研究空间",
            );
          return json(res, {
            user: { id: s.user_id, email: s.email, name: s.name },
            deepLiteratureUrl: config.deepLiterature?.origin || null,
          });
        }
        if (path === "/api/platform/browser-logout" && req.method === "POST") {
          const children = await pool.query(
            "SELECT token_hash FROM platform_sessions WHERE token_hash=$1 OR parent_hash=$1",
            [s.token_hash],
          );
          await pool.query(
            "DELETE FROM platform_sessions WHERE token_hash=$1",
            [s.token_hash],
          );
          for (const tunnel of tunnels.values())
            for (const row of children.rows)
              tunnel.revokeSession(row.token_hash);
          res.setHeader("set-cookie", sessionCookie("", config.secure, 0));
          return json(res, { ok: true });
        }
        throw new HttpError(405, "不支持的操作");
      }
      if (!path.startsWith("/api/platform/")) {
        check(req.method === "GET" || req.method === "HEAD", 405);
        if (config.privateSpaces && path === "/projects") {
          res.writeHead(303, { location: "/" });
          return res.end();
        }
        return await staticFile(res, publicDir, path);
      }
      if (!["GET", "HEAD"].includes(req.method))
        sameOrigin(req, config.origin.origin);
      if (path === "/api/platform/login" && req.method === "POST") {
        await limit(
          `login-ip:${hash(req.socket.remoteAddress || "")}`,
          40,
          900,
        );
        const b = await input(req);
        const address = email(b.email);
        await limit(`login-email:${hash(address)}`, 10, 900);
        const { rows } = await pool.query(
          "SELECT * FROM platform_users WHERE email=$1",
          [address],
        );
        const valid = await verifyPassword(b.password, rows[0]?.password_hash);
        check(valid && !rows[0].disabled, 401, "邮箱或密码错误");
        const secret = await newSession(pool, rows[0].id, req.headers.host);
        await audit(pool, rows[0].id, null, "login");
        res.setHeader("set-cookie", sessionCookie(secret, config.secure));
        return json(res, { ok: true });
      }
      if (path === "/api/platform/register" && req.method === "POST") {
        await limit(
          `register-ip:${hash(req.socket.remoteAddress || "")}`,
          10,
          3600,
        );
        const b = await input(req);
        const address = email(b.email);
        const name = text(b.name);
        const encoded = await passwordHash(b.password);
        const user = id();
        let secret;
        try {
          secret = await transaction(pool, async (db) => {
            await db.query(
              "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
              [user, address, name, encoded],
            );
            const created = await newSession(db, user, req.headers.host);
            await audit(db, user, null, "account.register");
            return created;
          });
        } catch (error) {
          if (error.code === "23505")
            throw new HttpError(409, "该邮箱已注册，请直接登录");
          throw error;
        }
        res.setHeader("set-cookie", sessionCookie(secret, config.secure));
        return json(res, { ok: true }, 201);
      }
      if (path === "/api/platform/invites/accept" && req.method === "POST") {
        check(!config.privateSpaces, 403, "私人空间不支持邀请");
        await limit(
          `invite-ip:${hash(req.socket.remoteAddress || "")}`,
          20,
          900,
        );
        const b = await input(req);
        let existing = null;
        try {
          existing = await session(req);
        } catch (error) {
          if (error.status !== 401) throw error;
        }
        const pwd = existing ? null : await passwordHash(b.password);
        await transaction(pool, async (db) => {
          const { rows } = await db.query(
            `DELETE FROM workspace_invites WHERE token_hash=$1 AND expires_at>now() RETURNING *`,
            [hash(text(b.token, 128))],
          );
          check(rows[0], 400, "邀请已过期或已使用");
          const invite = rows[0];
          // Lock membership changes against the owner having been removed since issuance.
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            invite.workspace_id,
          ]);
          await member(invite.created_by, invite.workspace_id, ["owner"], db);
          let user;
          if (existing) {
            check(existing.email === invite.email, 403, "请使用受邀邮箱登录");
            user = existing.user_id;
          } else {
            const found = await db.query(
              "SELECT id FROM platform_users WHERE email=$1",
              [invite.email],
            );
            check(
              !found.rows.length,
              409,
              "该邮箱已有账户，请先登录再接受邀请",
            );
            user = id();
            await db.query(
              "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
              [user, invite.email, text(b.name), pwd],
            );
          }
          await db.query(
            "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [invite.workspace_id, user, invite.role],
          );
          await audit(db, user, invite.workspace_id, "invite.accept");
        });
        return json(res, { ok: true });
      }
      const s = await session(req);
      await limit(`portal:${s.user_id}`, 180, 60);
      if (path === "/api/platform/capabilities" && req.method === "GET")
        return json(res, {
          privateSpaces: !!config.privateSpaces,
          deepLiteratureUrl: config.deepLiterature?.origin || null,
          openResearchAppUrl: config.appEntry || config.appOrigin,
        });
      if (path === "/api/platform/me" && req.method === "GET")
        return json(res, { id: s.user_id, email: s.email, name: s.name });
      if (path === "/api/platform/personal-space" && req.method === "POST") {
        check(
          config.privateSpaces && config.managed,
          409,
          "私人托管空间未启用",
        );
        const workspace = await transaction(pool, async (db) => {
          await db.query("SELECT pg_advisory_xact_lock(721947)");
          await db.query(
            "SELECT id FROM platform_users WHERE id=$1 FOR UPDATE",
            [s.user_id],
          );
          const existing = await db.query(
            "SELECT w.id FROM workspaces w JOIN workspace_runtimes r ON r.workspace_id=w.id WHERE w.created_by=$1 AND r.desired='running' ORDER BY w.created_at LIMIT 1",
            [s.user_id],
          );
          if (existing.rows.length) return existing.rows[0].id;
          const capacity = await db.query(
            "SELECT count(*)::int AS n FROM workspace_runtimes WHERE desired='running'",
          );
          check(
            capacity.rows[0].n < (config.managedCapacity || 4),
            409,
            "服务器运行容量已满，请联系管理员",
          );
          const workspace = id();
          await db.query(
            "INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)",
            [workspace, "我的科研空间", s.user_id],
          );
          await db.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
            workspace,
            s.user_id,
          ]);
          await db.query(
            "INSERT INTO workspace_runtimes(workspace_id) VALUES($1)",
            [workspace],
          );
          await audit(db, s.user_id, workspace, "workspace.create");
          return workspace;
        });
        return json(res, { id: workspace });
      }
      if (path === "/api/platform/logout" && req.method === "POST") {
        const children = await pool.query(
          "SELECT token_hash FROM platform_sessions WHERE token_hash=$1 OR parent_hash=$1",
          [s.token_hash],
        );
        await pool.query("DELETE FROM platform_sessions WHERE token_hash=$1", [
          s.token_hash,
        ]);
        for (const tunnel of tunnels.values())
          for (const row of children.rows) tunnel.revokeSession(row.token_hash);
        res.setHeader("set-cookie", sessionCookie("", config.secure, 0));
        return json(res, { ok: true });
      }
      if (path === "/api/platform/password" && req.method === "POST") {
        const b = await input(req);
        await limit(`password:${s.user_id}`, 5, 900);
        const user = await pool.query(
          "SELECT password_hash FROM platform_users WHERE id=$1",
          [s.user_id],
        );
        check(
          await verifyPassword(b.current, user.rows[0].password_hash),
          403,
          "当前密码错误",
        );
        const next = await passwordHash(b.password);
        await transaction(pool, async (db) => {
          await db.query(
            "UPDATE platform_users SET password_hash=$2 WHERE id=$1",
            [s.user_id, next],
          );
          await db.query("DELETE FROM platform_sessions WHERE user_id=$1", [
            s.user_id,
          ]);
          await audit(db, s.user_id, null, "password.change");
        });
        res.setHeader("set-cookie", sessionCookie("", config.secure, 0));
        return json(res, { ok: true });
      }
      if (path === "/api/platform/workspaces") {
        if (req.method === "GET") {
          const { rows } = await pool.query(
            `SELECT w.id,w.name,m.role,r.last_seen,r.expires_at AS credential_expires_at,rt.status AS runtime_status,rt.error AS runtime_error FROM workspaces w JOIN memberships m ON m.workspace_id=w.id LEFT JOIN runners r ON r.workspace_id=w.id LEFT JOIN workspace_runtimes rt ON rt.workspace_id=w.id WHERE m.user_id=$1 AND ($2::boolean=false OR w.created_by=$1) ORDER BY w.created_at`,
            [s.user_id, !!config.privateSpaces],
          );
          return json(
            res,
            rows.map((w) => ({ ...w, online: tunnels.has(w.id) })),
          );
        }
        check(req.method === "POST", 405);
        check(!config.privateSpaces, 403, "私人空间由平台自动创建");
        const b = await input(req);
        const managed = b.mode === "managed";
        check(!b.mode || ["managed", "external"].includes(b.mode));
        check(!managed || config.managed, 409, "平台托管暂未启用");
        const workspace = id();
        await transaction(pool, async (db) => {
          if (managed) {
            await db.query("SELECT pg_advisory_xact_lock(721947)");
            const capacity = await db.query(
              "SELECT count(*)::int AS n FROM workspace_runtimes WHERE desired='running'",
            );
            check(
              capacity.rows[0].n < (config.managedCapacity || 4),
              409,
              "本地托管容量已满（4 个空间），请删除闲置空间后重试",
            );
          }
          await db.query(
            "SELECT id FROM platform_users WHERE id=$1 FOR UPDATE",
            [s.user_id],
          );
          const count = await db.query(
            "SELECT count(*)::int AS n FROM workspaces WHERE created_by=$1",
            [s.user_id],
          );
          check(count.rows[0].n < 10, 409, "每个账户最多创建 10 个工作空间");
          await db.query(
            "INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)",
            [workspace, text(b.name), s.user_id],
          );
          await db.query(`INSERT INTO memberships VALUES($1,$2,'owner')`, [
            workspace,
            s.user_id,
          ]);
          await audit(db, s.user_id, workspace, "workspace.create");
          if (managed)
            await db.query(
              "INSERT INTO workspace_runtimes(workspace_id) VALUES($1)",
              [workspace],
            );
        });
        return json(res, { id: workspace }, 201);
      }
      const deleteWorkspace = path.match(
        /^\/api\/platform\/workspaces\/([0-9a-f-]{36})$/,
      );
      if (deleteWorkspace && req.method === "PATCH") {
        const workspace = deleteWorkspace[1];
        const b = await input(req);
        const name = text(b.name);
        await transaction(pool, async (db) => {
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            workspace,
          ]);
          await member(s.user_id, workspace, ["owner"], db);
          await db.query("UPDATE workspaces SET name=$2 WHERE id=$1", [
            workspace,
            name,
          ]);
          await audit(db, s.user_id, workspace, "workspace.rename", name);
        });
        return json(res, { name });
      }
      if (deleteWorkspace && req.method === "DELETE") {
        const workspace = deleteWorkspace[1];
        const b = await input(req);
        const revoked = await transaction(pool, async (db) => {
          const found = await db.query(
            "SELECT name FROM workspaces WHERE id=$1 FOR UPDATE",
            [workspace],
          );
          check(found.rows[0], 404, "工作空间不存在");
          await member(s.user_id, workspace, ["owner"], db);
          check(b.name === found.rows[0].name, 409, "空间名称不匹配");
          await db.query(
            "UPDATE workspace_runtimes SET desired='deleted',checked_at=NULL WHERE workspace_id=$1",
            [workspace],
          );
          const sessions = await db.query(
            "DELETE FROM platform_sessions WHERE host=$1 RETURNING token_hash",
            [new URL(workspaceOrigin(config, workspace)).host],
          );
          await db.query("DELETE FROM launch_tickets WHERE workspace_id=$1", [
            workspace,
          ]);
          await db.query(
            "DELETE FROM workspace_invites WHERE workspace_id=$1",
            [workspace],
          );
          await db.query(
            "DELETE FROM workspace_preferences WHERE workspace_id=$1",
            [workspace],
          );
          await db.query("DELETE FROM runners WHERE workspace_id=$1", [
            workspace,
          ]);
          await db.query("DELETE FROM memberships WHERE workspace_id=$1", [
            workspace,
          ]);
          await db.query(
            "UPDATE audit_events SET workspace_id=NULL WHERE workspace_id=$1",
            [workspace],
          );
          await db.query("DELETE FROM workspaces WHERE id=$1", [workspace]);
          await audit(
            db,
            s.user_id,
            null,
            "workspace.delete",
            `${workspace}:${found.rows[0].name}`,
          );
          return sessions.rows;
        });
        const tunnel = tunnels.get(workspace);
        for (const row of revoked) tunnel?.revokeSession(row.token_hash);
        tunnel?.close();
        return json(res, { ok: true });
      }
      const match = path.match(
        /^\/api\/platform\/workspaces\/([0-9a-f-]{36})\/(launch|members|invites|runner|runtime|audit)(?:\/([0-9a-f-]{36}))?$/,
      );
      check(match, 404, "接口不存在");
      const [, workspace, action, target] = match;
      check(
        !config.privateSpaces ||
          !["members", "invites", "runner"].includes(action),
        403,
        "私人空间不允许共享或外部执行器配置",
      );
      await member(
        s.user_id,
        workspace,
        action === "launch" ? undefined : ["owner"],
      );
      if (action === "runtime") {
        if (req.method === "POST") {
          check(config.managed, 409, "平台托管暂未启用");
          await transaction(pool, async (db) => {
            await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
              workspace,
            ]);
            await member(s.user_id, workspace, ["owner"], db);
            const result = await db.query(
              "UPDATE workspace_runtimes SET status='queued',error=NULL,checked_at=NULL WHERE workspace_id=$1 AND desired='running' AND status='failed' RETURNING workspace_id",
              [workspace],
            );
            check(result.rows.length, 409, "仅失败的托管环境可以重试");
            await audit(db, s.user_id, workspace, "runtime.retry");
          });
        } else check(req.method === "GET", 405);
        const { rows } = await pool.query(
          "SELECT status,error,checked_at FROM workspace_runtimes WHERE workspace_id=$1",
          [workspace],
        );
        check(rows[0], 404, "该空间使用自有设备");
        return json(res, { ...rows[0], online: tunnels.has(workspace) });
      }
      if (action === "runner" && req.method !== "GET") {
        const managed = await pool.query(
          "SELECT workspace_id FROM workspace_runtimes WHERE workspace_id=$1",
          [workspace],
        );
        check(!managed.rows.length, 409, "托管空间的连接凭据由平台自动管理");
      }
      if (action === "launch" && req.method === "POST") {
        const ticket = token();
        await pool.query(
          `INSERT INTO launch_tickets VALUES($1,$2,$3,now()+interval '60 seconds')`,
          [hash(ticket), workspace, s.token_hash],
        );
        return json(res, {
          url: `${workspaceOrigin(config, workspace)}/_platform/enter`,
          ticket,
        });
      }
      if (action === "members" && req.method === "GET") {
        const { rows } = await pool.query(
          "SELECT u.id,u.email,u.name,m.role FROM memberships m JOIN platform_users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.email",
          [workspace],
        );
        return json(res, rows);
      }
      if (
        action === "members" &&
        target &&
        ["DELETE", "PATCH"].includes(req.method)
      ) {
        const next = req.method === "PATCH" ? (await input(req)).role : null;
        check(next === null || ["owner", "editor", "viewer"].includes(next));
        await transaction(pool, async (db) => {
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            workspace,
          ]);
          await member(s.user_id, workspace, ["owner"], db);
          const old = await member(target, workspace, undefined, db);
          if (old === "owner" && next !== "owner") {
            const count = await db.query(
              `SELECT count(*)::int AS n FROM memberships WHERE workspace_id=$1 AND role='owner'`,
              [workspace],
            );
            check(count.rows[0].n > 1, 409, "必须保留至少一位管理员");
          }
          if (next)
            await db.query(
              "UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2",
              [workspace, target, next],
            );
          else
            await db.query(
              "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
              [workspace, target],
            );
          await db.query(
            "DELETE FROM workspace_invites WHERE workspace_id=$1 AND created_by=$2",
            [workspace, target],
          );
          await audit(
            db,
            s.user_id,
            workspace,
            next ? `member.${next}` : "member.remove",
            target,
          );
        });
        // Fail closed for all active streams; reconnect re-evaluates current membership.
        tunnels.get(workspace)?.close();
        return json(res, { ok: true });
      }
      if (action === "invites" && req.method === "GET") {
        const { rows } = await pool.query(
          "SELECT email,role,expires_at FROM workspace_invites WHERE workspace_id=$1 ORDER BY expires_at DESC",
          [workspace],
        );
        return json(res, rows);
      }
      if (action === "invites" && req.method === "DELETE") {
        const b = await input(req);
        await transaction(pool, async (db) => {
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            workspace,
          ]);
          await member(s.user_id, workspace, ["owner"], db);
          await db.query(
            "DELETE FROM workspace_invites WHERE workspace_id=$1 AND email=$2",
            [workspace, email(b.email)],
          );
          await audit(
            db,
            s.user_id,
            workspace,
            "invite.revoke",
            email(b.email),
          );
        });
        return json(res, { ok: true });
      }
      if (action === "invites" && req.method === "POST") {
        const b = await input(req);
        check(["editor", "viewer"].includes(b.role));
        const secret = token();
        await transaction(pool, async (db) => {
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            workspace,
          ]);
          await member(s.user_id, workspace, ["owner"], db);
          await db.query(
            `DELETE FROM workspace_invites WHERE workspace_id=$1 AND email=$2`,
            [workspace, email(b.email)],
          );
          await db.query(
            `INSERT INTO workspace_invites VALUES($1,$2,$3,$4,now()+interval '24 hours',$5)`,
            [hash(secret), workspace, email(b.email), b.role, s.user_id],
          );
          await audit(db, s.user_id, workspace, "invite.create");
        });
        return json(
          res,
          { url: `${config.origin.origin}/#invite=${secret}` },
          201,
        );
      }
      if (action === "runner" && req.method === "GET") {
        const { rows } = await pool.query(
          "SELECT last_seen,expires_at FROM runners WHERE workspace_id=$1",
          [workspace],
        );
        return json(res, {
          issued: !!rows[0],
          online: tunnels.has(workspace),
          lastSeen: rows[0]?.last_seen || null,
          expiresAt: rows[0]?.expires_at || null,
        });
      }
      if (action === "runner" && req.method === "POST") {
        const secret = token();
        await transaction(pool, async (db) => {
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            workspace,
          ]);
          await member(s.user_id, workspace, ["owner"], db);
          await db.query(
            `INSERT INTO runners(id,workspace_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '90 days') ON CONFLICT(workspace_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,last_seen=NULL`,
            [id(), workspace, hash(secret)],
          );
          await audit(db, s.user_id, workspace, "runner.rotate");
        });
        tunnels.get(workspace)?.close();
        return json(
          res,
          { token: secret, platform: config.origin.origin, expiresInDays: 90 },
          201,
        );
      }
      if (action === "runner" && req.method === "DELETE") {
        await transaction(pool, async (db) => {
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            workspace,
          ]);
          await member(s.user_id, workspace, ["owner"], db);
          await db.query("DELETE FROM runners WHERE workspace_id=$1", [
            workspace,
          ]);
          await audit(db, s.user_id, workspace, "runner.revoke");
        });
        tunnels.get(workspace)?.close();
        return json(res, { ok: true });
      }
      if (action === "audit" && req.method === "GET") {
        const { rows } = await pool.query(
          "SELECT action,actor_id,resource,created_at FROM audit_events WHERE workspace_id=$1 ORDER BY id DESC LIMIT 100",
          [workspace],
        );
        return json(res, rows);
      }
      throw new HttpError(405, "不支持的操作");
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const failedPath = new URL(req.url, config.origin).pathname;
      if (
        error.status === 401 &&
        req.method === "GET" &&
        failedPath === "/api/auth/sso/authorize"
      ) {
        const destination = new URL(config.origin);
        destination.searchParams.set("continue", req.url);
        res.writeHead(303, { location: destination.href });
        return res.end();
      }
      if (
        error.status === 401 &&
        req.method === "GET" &&
        req.headers.accept?.includes("text/html")
      ) {
        res.writeHead(303, { location: config.origin.origin });
        return res.end();
      }
      if (error.status === 429) res.setHeader("retry-after", "60");
      json(
        res,
        { error: error instanceof HttpError ? error.message : "服务暂不可用" },
        error.status || 500,
      );
      if (!error.status)
        console.error("Platform request failed", error.code || error.name);
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    try {
      const workspace = hostWorkspace(config, req.headers.host);
      if (!workspace && req.url === "/_platform/runner") {
        check(!req.headers.origin, 403);
        const secret = req.headers.authorization?.replace(/^Bearer /, "") || "";
        const { rows } = await pool.query(
          "SELECT * FROM runners WHERE token_hash=$1 AND expires_at>now()",
          [hash(secret)],
        );
        check(rows[0], 401);
        const runner = rows[0];
        check(!tunnels.has(runner.workspace_id), 409, "执行器已连接");
        wss.handleUpgrade(req, socket, head, (ws) => {
          const tunnel = new Tunnel(ws);
          tunnels.set(runner.workspace_id, tunnel);
          ws.on("pong", () => {
            ws.alive = true;
          });
          ws.alive = true;
          const interval = setInterval(async () => {
            try {
              const valid = await pool.query(
                "UPDATE runners SET last_seen=now() WHERE id=$1 AND token_hash=$2 AND expires_at>now() RETURNING id",
                [runner.id, runner.token_hash],
              );
              if (!valid.rows.length || !ws.alive) return ws.terminate();
              ws.alive = false;
              ws.ping();
            } catch {
              ws.terminate();
            }
          }, 15000);
          ws.on("close", () => {
            clearInterval(interval);
            if (tunnels.get(runner.workspace_id) === tunnel)
              tunnels.delete(runner.workspace_id);
          });
        });
      } else {
        check(workspace, 404);
        const { s } = await access(req, workspace, true);
        check(/\/terminal(?:\?|$)/.test(req.url), 403, "仅允许科研终端连接");
        const tunnel = tunnels.get(workspace);
        check(tunnel, 503);
        wss.handleUpgrade(req, socket, head, (ws) => {
          try {
            tunnel.socket(req, ws, s.token_hash, () =>
              access(req, workspace, true),
            );
          } catch {
            ws.close(1013);
          }
        });
      }
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status || 503} Rejected\r\nConnection: close\r\n\r\n`,
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxConnections = 4096;
  const cleanup = setInterval(
    () =>
      pool
        .query(
          `DELETE FROM auth_limits WHERE expires_at<now(); DELETE FROM platform_sessions WHERE expires_at<now(); DELETE FROM launch_tickets WHERE expires_at<now(); DELETE FROM workspace_invites WHERE expires_at<now(); DELETE FROM sso_authorization_codes WHERE expires_at<now(); DELETE FROM sso_grants WHERE expires_at<now()`,
        )
        .catch(() => {}),
    60000,
  );
  const close = async () => {
    clearInterval(cleanup);
    for (const tunnel of tunnels.values()) tunnel.ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await pool.end();
  };
  return { server, pool, tunnels, close };
}
async function main() {
  const config = configuration();
  const app = await createPlatform(config);
  await app.pool.query("SELECT 1 FROM platform_users LIMIT 1");
  app.server.listen(config.port, config.bind, () =>
    console.log(`Research platform: ${config.origin.origin}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error("Platform startup failed", error.code || error.message);
    process.exit(1);
  });
