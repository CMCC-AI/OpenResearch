import { useState } from "react";
import { sidebarClasses } from "../sidebarLayout";
import { useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { FolderPlus } from "lucide-react";
import { listProjectsQuery, getUiStateQuery, listProjectActivityQuery } from "../queries/projects";
import { listChatSessionsQuery } from "../queries/chat";
import { parseDestination } from "../workspaceState";
import { deleteChatSession, renameChatSession, setChatSessionArchived, type ChatSession } from "../api";
import { ProjectInfoCard } from "./ProjectInfoCard";
import { SessionFilterMenu, SessionRow, type SessionFilter } from "./NativeSidebarRows";
import { m } from "../paraglide/messages.js";
import { useOptionalAuthSession } from "../product/AuthSession";
import { IconButton, Button, showAlert } from "./ui";

export function ResearchNavigationMore({ onClick, indented = true }: { onClick: () => void; indented?: boolean }) {
  return <div className={`flex h-8.5 items-start ${indented ? sidebarClasses.indent : ""}`}>
    <Button size="small" variant="ghost" className="font-normal text-subtext" onClick={onClick}>{m.common_show_more()}</Button>
  </div>;
}

function storedIds(key: string): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
}

export function ResearchProjectNavigation({ enabled }: { enabled: boolean }) {
  const navigate = useNavigate();
  const canPublish = useOptionalAuthSession()?.user?.isAdmin === true;
  const projects = useQuery({ ...listProjectsQuery(), enabled });
  const state = useQuery({ ...getUiStateQuery(), enabled });
  const activity = useQuery({ ...listProjectActivityQuery(), enabled });
  const [filter, setFilter] = useState<SessionFilter>("active");
  const [grouping, setGrouping] = useState<"projects" | "list">(() => { try { return localStorage.getItem("sidebar-grouping") === "list" ? "list" : "projects"; } catch { return "projects"; } });
  const [pinned, setPinned] = useState(() => storedIds("sidebar-pinned-projects"));
  const [collapsed, setCollapsed] = useState(() => storedIds("sidebar-collapsed-projects"));
  const [limits, setLimits] = useState<Record<string, number>>({});
  const sorted = [...(projects.data ?? [])].sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) || (activity.data?.find((row) => row.projectId === b.id)?.lastActivityAt ?? b.updatedAt) - (activity.data?.find((row) => row.projectId === a.id)?.lastActivityAt ?? a.updatedAt));
  const sessions = useQueries({ queries: sorted.map((project) => ({ ...listChatSessionsQuery(project.id), enabled: enabled && (grouping === "list" || !collapsed.includes(project.id)), refetchInterval: 5000 })) });
  const remembered = parseDestination((state.data?.workspace?.lastLocation ?? "").split("?")[0]);
  const projectId = sorted.find((project) => project.id === remembered?.projectId)?.id ?? sorted[0]?.id;
  const go = (suffix: string, id = projectId) => {
    if (id) void navigate({ href: `/projects/${encodeURIComponent(id)}/${suffix}` });
    else void navigate({ to: "/projects", search: { new: true } });
  };
  const toggleId = (id: string, values: string[], update: (next: string[]) => void, key: string) => {
    const next = values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
    update(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Preferences are optional. */ }
  };
  async function act(action: () => Promise<unknown>, session: ChatSession) {
    try { await action(); await sessions[sorted.findIndex((project) => project.id === session.projectId)]?.refetch(); }
    catch (error) { showAlert(error instanceof Error ? error.message : String(error), "error"); }
  }
  const matching = (rows: ChatSession[]) => rows.filter((session) => !session.sideParentSessionId && (filter === "all" || (filter === "archived" ? session.archived : !session.archived))).sort((a, b) => b.updatedAt - a.updatedAt);
  const renderSession = (session: ChatSession) => <SessionRow key={session.id} session={session} active={false} unread={false} busy={session.busy} waiting={false} revealTitle={undefined}
    onOpen={() => go(`tasks/${encodeURIComponent(session.id)}`, session.projectId)}
    onRename={(title) => void act(() => renameChatSession(session.id, title), session)}
    onSetArchived={(archived) => void act(() => setChatSessionArchived(session.id, archived), session)}
    onDelete={() => { if (window.confirm(m.chat_delete_session_confirm({ title: session.title || m.chat_untitled() }))) void act(() => deleteChatSession(session.id), session); }} />;
  return <>
    <div className="research-projects flex min-h-0 flex-1 flex-col">
      <div className={sidebarClasses.heading}><h2 className={sidebarClasses.label}>{grouping === "projects" ? m.projects_home_projects() : m.chat_all_sessions()}</h2><div className={sidebarClasses.actions}><IconButton size="small" aria-label={m.projects_home_new_project()} onClick={() => void navigate({ to: "/projects", search: { new: true } })}><FolderPlus size={15} /></IconButton><SessionFilterMenu value={filter} onChange={setFilter} grouping={grouping} onGroupingChange={(next) => { setGrouping(next); try { localStorage.setItem("sidebar-grouping", next); } catch { /* optional */ } }} /></div></div>
      <div className="rail-body min-h-0 flex-1 overflow-y-auto">
        {!enabled ? <p className="px-2 text-xs text-subtext">登录后查看研究项目</p> : projects.error ? <div className="px-2 text-xs text-accent-red">项目读取失败<Button size="small" onClick={() => void projects.refetch()}>重试</Button></div> : projects.isPending ? <p className="px-2 text-xs text-subtext">正在读取项目…</p> : !sorted.length ? <p className="px-2 text-xs text-subtext">尚无项目，点击上方按钮新建</p> : grouping === "list" ? <>{matching(sessions.flatMap((query) => query.data ?? [])).map(renderSession)}{sessions.some((query) => query.isPending) && <p className={`m-0 ${sidebarClasses.status}`}>正在读取会话…</p>}{sessions.some((query) => query.error) && <Button size="small" onClick={() => sessions.forEach((query) => { if (query.error) void query.refetch(); })}>重试会话列表</Button>}</> : sorted.map((project, index) => {
          const query = sessions[index];
          const rows = matching(query.data ?? []);
          const limit = limits[project.id] ?? 6;
          return <section key={project.id} aria-label={`项目 ${project.name}`}>
            <div className={sidebarClasses.project}><ProjectInfoCard onNewChat={() => go("tasks/new", project.id)} onOpen={() => void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })} onFeature={canPublish ? () => void navigate({ to: "/admin/cases", search: { project: project.id } }) : undefined} project={project} chatCount={activity.data?.find((row) => row.projectId === project.id)?.totalAgents} collapsed={collapsed.includes(project.id)} busy={rows.some((session) => session.busy)} onToggleCollapsed={() => toggleId(project.id, collapsed, setCollapsed, "sidebar-collapsed-projects")} pinned={pinned.includes(project.id)} onPin={() => toggleId(project.id, pinned, setPinned, "sidebar-pinned-projects")} onRemoved={() => void projects.refetch()} /></div>
            {!collapsed.includes(project.id) && <div className={sidebarClasses.indent}>{query.isPending ? <p className={`m-0 ${sidebarClasses.status}`}>正在读取会话…</p> : query.error ? <Button size="small" onClick={() => void query.refetch()}>重试会话列表</Button> : !rows.length ? <p className={`m-0 ${sidebarClasses.status}`}>{filter === "archived" ? m.chat_no_archived_sessions() : m.chat_no_sessions_yet()}</p> : rows.slice(0, limit).map(renderSession)}{rows.length > limit && <ResearchNavigationMore indented={false} onClick={() => setLimits((current) => ({ ...current, [project.id]: limit + 6 }))} />}</div>}
          </section>;
        })}
      </div>
    </div>
  </>;
}
