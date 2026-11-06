import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as readOnlyApi from "../src/readOnlyApi.ts";
import { httpErrorMessage } from "../src/httpError.ts";
import { validateApiResponse } from "../src/apiValidation.ts";

const require = createRequire(import.meta.url);
function load(path, stubs) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => name in stubs ? stubs[name] : require(name), exports);
  return exports;
}
const messages = new Proxy({}, { get: (_, key) => () => key });
function fixture() {
  const client = load("../src/queries/client.ts", { "../readOnlyApi": readOnlyApi });
  client.activateWorkspace("personal");
  const live = load("../src/queries/live.ts", {});
  const invalidation = load("../src/queries/invalidation.ts", { "./client": client, "./live": live });
  const api = load("../src/api.ts", {
    "./filePreview": {}, "./previewText": {}, "./demo": {}, "./apiValidation": { validateApiResponse },
    "./readOnlyApi": readOnlyApi, "./queries/client": client, "./queries/invalidation": invalidation,
    "./workspaceState": {}, "./paraglide/messages.js": { m: messages }, "./paraglide/runtime.js": {}, "./i18n": {}, "./httpError": { httpErrorMessage },
  });
  const projects = load("../src/queries/projects.ts", { "./client": client, "./live": live, "../api": api });
  const chats = load("../src/queries/chat.ts", { "./client": client, "./live": live, "../api": api, "../events": { onChatEvent: () => () => {} } });
  const cleanup = readOnlyApi.installReadOnlyApi(readOnlyApi.createReadOnlyProjectApi({ id: "case-1", base: "", admin: false, workspace: {
    projectId: "source", sessionId: "source-chat", assets: {},
    responses: { "/api/projects": { projects: [{ id: "source", name: "Case", updatedAt: 1, repoPath: "/case" }] }, "/api/chat/sessions?projectId=source": { sessions: [{ id: "source-chat", archived: false }] } },
  } }));
  return { api, client, projects, chats, cleanup: () => { cleanup(); client.queryClient.clear(); } };
}

test("the existing navigation queries read personal data while case queries stay isolated", async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  const personal = { id: "mine", name: "My project", updatedAt: 1, repoPath: "/mine" };
  const responses = {
    "/api/projects": { projects: [personal] },
    "/api/projects/activity": { activity: [{ projectId: "mine" }] },
    "/api/settings/ui-state": { workspace: { lastLocation: "/projects/mine" } },
    "/api/chat/sessions?projectId=mine": { sessions: [{ id: "my-chat", projectId: "mine", title: "My chat", createdAt: 1, updatedAt: 1 }] },
  };
  globalThis.fetch = async (url) => Response.json(responses[url]);
  try {
    const query = f.projects.listProjectsQuery(true);
    assert.deepEqual(query.queryKey, ["workspace", f.client.getWorkspaceGeneration(), "listProjects"]);
    assert.deepEqual(await f.client.queryClient.fetchQuery(query), [personal]);
    assert.deepEqual(await f.client.queryClient.fetchQuery(f.projects.listProjectActivityQuery(true)), responses["/api/projects/activity"].activity);
    assert.deepEqual(await f.client.queryClient.fetchQuery(f.projects.getUiStateQuery(true)), responses["/api/settings/ui-state"]);
    assert.equal((await f.client.queryClient.fetchQuery(f.chats.listChatSessionsQuery("mine", true)))[0].id, "my-chat");
    assert.equal((await f.client.queryClient.fetchQuery(f.projects.listProjectsQuery()))[0].name, "Case");
  } finally { globalThis.fetch = originalFetch; f.cleanup(); }
});

test("existing project and chat actions stay writable in the personal cache while viewing a read-only case", async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    return Response.json({ ok: true, project: { id: "source", name: "Renamed" }, session: { id: "source-chat", title: "Renamed chat" } });
  };
  try {
    const ownKey = f.chats.listChatSessionsQuery("source", true).queryKey;
    const caseKey = f.chats.listChatSessionsQuery("source").queryKey;
    f.client.queryClient.setQueryData(ownKey, [{ id: "source-chat" }]);
    f.client.queryClient.setQueryData(caseKey, [{ id: "source-chat", title: "Case chat" }]);
    await f.api.updateProject("source", { name: "Renamed" }, true);
    await f.api.revealFileInManager("source", ".", {}, true);
    await f.api.renameChatSession("source-chat", "Renamed chat", true);
    await f.api.setChatSessionArchived("source-chat", true, true);
    await f.api.deleteChatSession("source-chat", true);
    assert.deepEqual(f.client.queryClient.getQueryData(ownKey), []);
    assert.equal(f.client.queryClient.getQueryData(caseKey)[0].title, "Case chat");
    assert.equal((await f.client.queryClient.fetchQuery({ ...f.chats.listChatSessionsQuery("source"), staleTime: 0 }))[0].id, "source-chat");
    await f.api.deleteProject("source", false, true);
    assert.equal(requests.length, 6);
    assert.deepEqual(requests.map((request) => request.method), ["PATCH", "POST", "PATCH", "PATCH", "DELETE", "DELETE"]);
    await assert.rejects(f.api.updateProject("source", { name: "Cannot edit case" }), /仅供浏览/);
    assert.equal(requests.length, 6, "case writes must never reach the live API");
    assert.equal((await f.api.listProjects())[0].name, "Case");
  } finally { globalThis.fetch = originalFetch; f.cleanup(); }
});

test("personal writes cannot finish in another user's workspace", async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  try {
    const pending = f.api.updateProject("mine", { name: "Pending" }, true);
    f.client.activateWorkspace("another-user");
    finish(Response.json({ project: { id: "mine" } }));
    await assert.rejects(pending, /Workspace changed/);
  } finally { globalThis.fetch = originalFetch; f.cleanup(); }
});

test("the original sidebar renders project menus and new-chat controls while a case is open", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const f = fixture();
  const button = ({ children, danger: _danger, ...props }) => React.createElement("button", props, children);
  const ui = { Button: button, IconButton: button, MenuItem: button, Tooltip: ({ children }) => children, showAlert: () => {} };
  const card = load("../src/components/ProjectInfoCard.tsx", {
    "../api": f.api, "../paraglide/messages.js": { m: messages }, "./ui": ui,
    "./DeleteProjectDialog": { DeleteProjectDialog: () => null }, "./useDialogFocus": { useDialogFocus: () => {} },
  });
  const project = { id: "mine", name: "我的项目", updatedAt: 1, repoPath: "/mine" };
  const { ResearchProjectNavigation } = load("../src/components/ResearchNavigation.tsx", {
    "../sidebarLayout": { sidebarClasses: {} },
    "@tanstack/react-router": { useNavigate: () => () => {} },
    "@tanstack/react-query": {
      useQuery: ({ queryKey }) => {
        assert.equal(queryKey[1], f.client.getWorkspaceGeneration());
        return { data: queryKey[2] === "listProjects" ? [project] : queryKey[2] === "getUiState" ? {} : [], isPending: false };
      },
      useQueries: ({ queries }) => queries.map(({ queryKey }) => {
        assert.equal(queryKey[1], f.client.getWorkspaceGeneration());
        return { data: [{ id: "my-chat", projectId: "mine", title: "我的对话", updatedAt: 1 }] };
      }),
    },
    "../queries/projects": f.projects, "../queries/chat": f.chats, "../locale": { useLocale: () => "zh-CN" },
    "../workspaceState": {}, "../useSessionNavigation": { useSessionNavigation: () => ({ open: () => {} }) }, "../api": f.api, "./ProjectInfoCard": card,
    "./NativeSidebarRows": { SessionFilterMenu: () => null, SessionRow: (props) => {
      assert.ok(!props.readOnly, "personal chats must retain their action menu");
      return React.createElement("span", {}, props.session.title);
    } },
    "../paraglide/messages.js": { m: messages }, "../researchSessions": { isSidebarSession: () => true },
    "../product/AuthSession": { useOptionalAuthSession: () => ({ user: {} }) }, "./ui": ui,
  });
  try {
    const html = renderToStaticMarkup(React.createElement(ResearchProjectNavigation, { enabled: true }));
    assert.ok(html.includes("我的项目"));
    assert.ok(html.includes("我的对话"));
    assert.ok(html.includes('aria-haspopup="menu"'));
    assert.ok(html.includes("sidebar_project_details"));
    assert.ok(html.includes("chat_panel_new_chat"));
    assert.ok(html.includes("activity_edit"));
    assert.ok(html.includes("projects_home_delete_project_action"));
    assert.equal(html.includes("Case"), false);
  } finally { f.cleanup(); }
});

function navigationFixture(f, cached) {
  const commits=[],errors=[],notifications=[],effects=[];
  const routeListeners=new Set();
  const router={state:{location:{href:"/cases/case-1"}},subscribe:(_event,callback)=>{routeListeners.add(callback);return()=>routeListeners.delete(callback);}};
  const pure=load("../src/sessionNavigation.ts",{"./workspaceState": {getTaskWorkspace:(doc,key)=>doc&&Object.hasOwn(doc.tasks,key)?doc.tasks[key]:undefined}});
  let epoch=0;
  const hook=load("../src/useSessionNavigation.ts",{
    react:{useMemo:fn=>fn(),useLayoutEffect:fn=>effects.push(fn)},
    "@tanstack/react-router":{useRouter:()=>router},
    sonner:{toast:{loading:()=>{notifications.push("loading");return 1;},dismiss:()=>notifications.push("dismiss")}},
    "./api":f.api,"./readOnlyApi":readOnlyApi,"./queries/client":f.client,"./queries/projects":f.projects,
    "./useProjectWorkspace":{getCachedProjectWorkspace:()=>cached,getProjectWorkspaceEpoch:()=>epoch},
    "./sessionNavigation":pure,"./components/ui/Toast":{showAlert:message=>errors.push(message)},"./paraglide/messages.js":{m:messages},
  });
  const nav=hook.useSessionNavigation(true);
  const cleanups=effects.map(fn=>fn());
  return {nav,commits,errors,notifications,router,open:()=>nav.open("source","s",pane=>commits.push(pane)),changeEpoch:()=>epoch++,route:()=>{router.state.location.href="/projects/other/tasks/new";routeListeners.forEach(fn=>fn());},cleanup:()=>cleanups.forEach(fn=>fn())};
}
const settleNavigation=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

test("project workspace reads use personal transport and keys even for the case's source project",async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;
  const own={version:1,tasks:{s:{active:{kind:"home",view:"materials"}}}};
  const requests=[];
  globalThis.fetch=async(url,init)=>{requests.push([url,init.signal]);return Response.json(own);};
  try{
    const options=f.projects.getProjectUiStateQuery("source",true);
    assert.deepEqual(options.queryKey,["workspace",f.client.getWorkspaceGeneration(),"getProjectUiState","source"]);
    assert.deepEqual(await f.client.queryClient.fetchQuery(options),own);
    await assert.rejects(f.client.queryClient.fetchQuery(f.projects.getProjectUiStateQuery("source")), error => error.status === 404);
    assert.equal(requests.length,1,"case-only request must not fall back to private data");
    assert.equal(requests[0][0],"/api/projects/source/ui-state");
  }finally{globalThis.fetch=originalFetch;f.cleanup();}
});

test("personal session restore ignores a case's live cache and preserves its distinct query cache",async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;
  const caseDoc={version:1,tasks:{s:{active:{kind:"side",sessionId:"case-side"}}}};
  const ownDoc={version:1,tasks:{s:{active:{kind:"home",view:"research"}}}};
  const caseKey=f.projects.getProjectUiStateQuery("source").queryKey;
  f.client.queryClient.setQueryData(caseKey,caseDoc);
  const n=navigationFixture(f,caseDoc);
  globalThis.fetch=async()=>Response.json(ownDoc);
  try{
    n.open();await settleNavigation();
    assert.deepEqual(n.commits,[ownDoc.tasks.s.active]);
    assert.deepEqual(f.client.queryClient.getQueryData(caseKey),caseDoc);
    assert.deepEqual(f.client.queryClient.getQueryData(f.projects.getProjectUiStateQuery("source",true).queryKey),ownDoc);
    assert.deepEqual(n.notifications,["loading","dismiss"]);
  }finally{n.cleanup();globalThis.fetch=originalFetch;f.cleanup();}
});
for(const cancel of ["account","route","unmount","epoch"]){
  test(`personal restore rejects stale data after ${cancel}`,async()=>{
    const f=fixture(),originalFetch=globalThis.fetch,n=navigationFixture(f);
    let finish,signal;
    globalThis.fetch=(_url,init)=>{signal=init.signal;return new Promise(resolve=>{finish=resolve;});};
    try{
      const oldKey=f.projects.getProjectUiStateQuery("source",true).queryKey;
      n.open();await settleNavigation();
      if(cancel==="account")f.client.activateWorkspace("second-account");
      if(cancel==="route")n.route();
      if(cancel==="unmount")n.cleanup();
      if(cancel==="epoch")n.changeEpoch();
      if(cancel!=="epoch")assert.equal(signal.aborted,true);
      finish(Response.json({version:1,tasks:{s:{active:{kind:"side",sessionId:"stale"}}}}));await settleNavigation();
      assert.deepEqual(n.commits,[]);assert.deepEqual(n.errors,[]);
      assert.equal(f.client.queryClient.getQueryData(oldKey),undefined);
      assert.equal(n.notifications.at(-1),"dismiss");
    }finally{n.cleanup();globalThis.fetch=originalFetch;f.cleanup();}
  });
}

test("the real home SessionRow opens the personal session with its saved pane",async()=>{
  const React=await import("react"),{renderToStaticMarkup}=await import("react-dom/server");
  const f=fixture(),originalFetch=globalThis.fetch,n=navigationFixture(f);
  const workspace=await import("../src/workspaceState.ts");
  const routes=[];let open;
  const project={id:"source",name:"Personal source",updatedAt:1,repoPath:"/mine"};
  const {ResearchProjectNavigation}=load("../src/components/ResearchNavigation.tsx",{
    "../sidebarLayout":{sidebarClasses:{}},"@tanstack/react-router":{useNavigate:()=>value=>routes.push(value)},
    "@tanstack/react-query":{useQuery:({queryKey})=>({data:queryKey[2]==="listProjects"?[project]:[],isPending:false}),useQueries:()=>[{data:[{id:"s",projectId:"source",title:"Personal session",updatedAt:1}]}]},
    "../queries/projects":f.projects,"../queries/chat":f.chats,"../locale":{useLocale:()=>"en"},
    "../workspaceState":workspace,"../useSessionNavigation":{useSessionNavigation:personal=>{assert.equal(personal,true);return n.nav;}},
    "../api":f.api,"./ProjectInfoCard":{ProjectInfoCard:()=>null},"./NativeSidebarRows":{SessionFilterMenu:()=>null,SessionRow:props=>{open=props.onOpen;return React.createElement("span",{},props.session.title);}},
    "../paraglide/messages.js":{m:messages},"../researchSessions":{isSidebarSession:()=>true},"../product/AuthSession":{useOptionalAuthSession:()=>({user:{}})},
    "./ui":{Button:({children})=>children,IconButton:({children})=>children,showAlert:()=>{}},
  });
  globalThis.fetch=async()=>Response.json({version:1,tasks:{s:{active:{kind:"side",sessionId:"own-side"}}}});
  try{
    renderToStaticMarkup(React.createElement(ResearchProjectNavigation,{enabled:true}));assert.equal(typeof open,"function");
    open();await settleNavigation();assert.deepEqual(routes,[{href:workspace.taskLocation("source","s",{kind:"side",sessionId:"own-side"})}]);
    assert.equal(routes[0].href.startsWith("/projects/"),true);
  }finally{n.cleanup();globalThis.fetch=originalFetch;f.cleanup();}
});
