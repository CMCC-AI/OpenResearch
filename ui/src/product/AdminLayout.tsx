import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ShieldCheck, Star, Users, ArrowLeft, LogOut } from "lucide-react";
import { useAuthSession } from "./AuthSession";
import { stripAppBase } from "../appBasePath";

/** One administration shell; private research permissions remain independent. */
export function AdminLayout() {
  const { user, canAccessResearch, logout } = useAuthSession();
  const pathname = useRouterState({ select: (state) => stripAppBase(state.location.pathname) });
  if (!user?.isAdmin) return <main className="flex h-full flex-col items-center justify-center gap-4 bg-canvas p-6"><h1 className="text-xl font-semibold">无权访问系统管理</h1><p role="alert" className="text-sm text-subtext">系统管理仅对系统管理员开放。</p><Link to="/cases" className="text-primary">返回精选案例</Link></main>;
  const links = [
    { to: "/admin/users" as const, label: "用户管理", Icon: Users },
    { to: "/admin/cases" as const, label: "精选案例管理", Icon: Star },
  ];
  return <div className="flex h-full min-h-0 overflow-hidden bg-canvas max-md:flex-col">
    <aside className="flex w-60 shrink-0 flex-col gap-5 border-e border-border bg-background p-4 max-md:w-full max-md:border-b max-md:border-e-0">
      <Link to="/admin/users" className="flex items-center gap-2 text-lg font-semibold text-text no-underline"><ShieldCheck size={20} />系统管理</Link>
      <nav aria-label="系统管理导航" className="flex flex-col gap-1 max-md:flex-row">{links.map(({to,label,Icon}) => <Link key={to} to={to} aria-current={pathname===to ? "page" : undefined} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm no-underline ${pathname===to ? "bg-primary-subtle font-medium text-primary" : "text-subtext hover:bg-surface"}`}><Icon size={16} />{label}</Link>)}</nav>
      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4 text-sm"><Link to={canAccessResearch ? "/projects" : "/cases"} className="flex items-center gap-2 text-primary"><ArrowLeft size={16} />{canAccessResearch ? "返回科研工作台" : "查看公共案例"}</Link><div className="min-w-0"><span className="block truncate font-medium">{user.name}</span><span className="block truncate text-xs text-subtext">{user.email} · 系统管理员</span></div><button type="button" onClick={() => void logout()} className="flex items-center gap-2 text-start text-subtext"><LogOut size={16} />退出登录</button></div>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col"><header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-6"><span className="text-sm text-subtext">系统管理 / {pathname==="/admin/cases" ? "精选案例管理" : "用户管理"}</span><Link to="/cases" className="text-sm text-primary">查看公共案例</Link></header><Outlet /></div>
  </div>;
}
