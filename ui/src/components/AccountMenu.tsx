import { useEffect, useId, useRef, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp, Cpu, LogOut, Settings, UserRound } from "lucide-react";
import { useAuthSession } from "../product/AuthSession";
import { useRuntime } from "../RemoteRuntime";
import { getUiStateQuery, listProjectsQuery } from "../queries/projects";
import { parseDestination } from "../workspaceState";
import { m } from "../paraglide/messages.js";
import { usePopover } from "./ModelPicker";
import { MenuItem } from "./ui";
import { WorkspaceConnection } from "./WorkspaceConnection";

type AccountSetting = "compute" | "settings";
export function AccountMenu({ onSettings, connectionInfo }: {
  onSettings?: (tab: AccountSetting) => void; connectionInfo?: ReactNode;
}) {
  const { user, logout } = useAuthSession();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const menu = usePopover(trigger);
  const projects = useQuery({ ...listProjectsQuery(), enabled: menu.open && Boolean(user) && !onSettings });
  const saved = useQuery({ ...getUiStateQuery(), enabled: menu.open && Boolean(user) && !onSettings });
  useEffect(() => {
    if (menu.open) menu.ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [menu.open, menu.ref]);
  const destination = parseDestination(pathname);
  const remembered = parseDestination((saved.data?.workspace?.lastLocation ?? "").split("?")[0]);
  const projectId = destination?.projectId ?? remembered?.projectId ?? projects.data?.[0]?.id;
  const go = (suffix: string) => {
    if (projectId) void navigate({ href: `/projects/${encodeURIComponent(projectId)}/${suffix}` });
    else void navigate({ to: "/projects", search: { new: true } });
  };
  if (!user && runtime.kind !== "ssh") return null;
  const userName = user?.name ?? "工作区用户";
  const userEmail = user?.email ?? "远程连接";
  return <div className="relative mt-2 shrink-0">
    <button ref={trigger} type="button" aria-label={`个人用户菜单 · ${userName}`} aria-haspopup="menu" aria-expanded={menu.open} aria-controls={menuId} onClick={() => menu.setOpen(!menu.open)} className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border-variant bg-canvas p-2.5 text-start text-text hover:bg-surface">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-subtle text-primary"><UserRound size={16} /></span>
      <span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{userName}</strong><span className="block truncate text-xs text-muted">{userEmail}</span></span>
      <ChevronUp size={14} className="shrink-0 text-subtext" />
    </button>
    <div ref={menu.ref} id={menuId} hidden={!menu.open} role="menu" aria-label="个人用户配置" className="absolute bottom-[calc(100%_+_8px)] start-0 z-50 w-60 rounded-lg border border-border bg-background p-1.5 shadow-menu" onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      if (!items.length) return;
      event.preventDefault(); event.stopPropagation();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      {([{ id: "compute", label: m.settings_page_compute(), Icon: Cpu }, { id: "settings", label: m.settings_page_settings(), Icon: Settings }] as const).map(({ id, label, Icon }) => <MenuItem key={id} role="menuitem" onClick={() => { menu.setOpen(false); onSettings ? onSettings(id) : go(`settings/${id}`); }}><span className="flex items-center gap-2.5"><Icon size={15} />{label}</span></MenuItem>)}
      <div className="my-1 border-t border-border-variant" />
      <details className="px-2 py-1 text-sm text-subtext"><summary role="menuitem" className="cursor-pointer rounded-md py-1 focus-visible:outline-2 focus-visible:outline-primary">连接状态与版本</summary>{connectionInfo ?? <WorkspaceConnection runtime={runtime} />}</details>
      <div className="my-1 border-t border-border-variant" />
      {user && <MenuItem role="menuitem" onClick={() => { menu.setOpen(false); void logout(); }}><span className="flex items-center gap-2.5"><LogOut size={15} />退出登录</span></MenuItem>}
    </div>
  </div>;
}
