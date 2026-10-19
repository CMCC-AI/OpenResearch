import type { NativeProjectSnapshot } from "./product/nativeProjectSnapshot";
/** A scoped data source for the real project UI. Never intercepts global fetch. */
export interface ReadOnlyApi {
  id: string;
  projectId: string;
  sessionId: string;
  read: (url: string, init?: RequestInit) => Promise<Response>;
  asset: (url: string) => string;
}
let current: ReadOnlyApi | null = null;
export const getReadOnlyApi = () => current;
export function installReadOnlyApi(api: ReadOnlyApi) {
  if (current && current !== api) throw new Error("另一个只读项目正在打开");
  current = api;
  return () => { if (current === api) current = null; };
}
export const projectAssetUrl = (url: string) => current ? current.asset(url) : url;
export const projectRequest = (url: string, init?: RequestInit): Promise<Response> => current && url.startsWith("/api/") ? current.read(url, init) : fetch(url, init);
export function canonicalRequest(url: string) {
  const parsed = new URL(url, "http://snapshot.invalid");
  parsed.searchParams.sort();
  return parsed.pathname + parsed.search;
}

export function createReadOnlyProjectApi({ id, base, admin, workspace }: { id: string; base: string; admin: boolean; workspace: NativeProjectSnapshot }): ReadOnlyApi {
    const responses = structuredClone(workspace.responses);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    return {
      id, projectId: workspace.projectId, sessionId: workspace.sessionId,
      asset(url) {
        const name = workspace.assets[canonicalRequest(url)];
        return name ? `${base}/api/platform/${admin ? "admin/cases" : "cases"}/${encodeURIComponent(id)}/assets?name=${encodeURIComponent(name)}` : `${base}/api/platform/${admin ? "admin/cases" : "cases"}/${encodeURIComponent(id)}/assets?name=missing`;
      },
      async read(url, init) {
        init?.signal?.throwIfAborted();
        const key = canonicalRequest(url);
        const method = init?.method || "GET";
        if (method !== "GET" && method !== "HEAD") {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          if (key.endsWith("/ui-state")) { responses[key] = key === "/api/settings/ui-state" ? { ...(responses[key] as object), ...body } : body; return json(responses[key]); }
          const branch = key.match(/^\/api\/chat\/sessions\/([^/]+)\/branch$/);
          if (branch) {
            const saved = responses[`/api/chat/sessions/${branch[1]}/messages`] as { messages: {id:string}[]; activeLeafId: string } | undefined;
            if (!saved?.messages.some((message) => message.id === body.leafId)) return json({ error: "分支不存在" }, 404);
            saved.activeLeafId = body.leafId; return json({ ok: true });
          }
          return json({ error: "此案例仅供浏览，不能更改项目或执行操作。" }, 403);
        }
        if (key in responses) return json(responses[key]);
        const parsed = new URL(url, "http://snapshot.invalid");
        if (parsed.pathname === "/api/chat/sessions") {
          const all = responses[canonicalRequest(`/api/chat/sessions?projectId=${workspace.projectId}`)] as { sessions: {archived:boolean}[] };
          if (parsed.searchParams.has("limit")) return json({ sessions: all.sessions.filter((session) => parsed.searchParams.get("filter") === "all" || session.archived === (parsed.searchParams.get("filter") === "archived")), next: null });
          return json(all);
        }
        if (parsed.pathname === "/api/skills") return json({ skills: [], importing: false });
        return json({ error: "这份项目副本中没有该资源。" }, 404);
      },
    };
}
