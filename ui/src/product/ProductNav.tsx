import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BookOpen, Boxes, Home, Info, Library, LogOut, Search, UserRound } from "lucide-react";
import { BrandMark } from "../components/Wordmark";
import { useAuthSession } from "./AuthSession";

const links = [
  { to: "/projects" as const, label: "开始研究", icon: Home },
  { to: "/discover" as const, label: "论文发现", icon: BookOpen },
  { to: "/literature" as const, label: "深度文献", icon: Library },
  { to: "/capabilities" as const, label: "能力中心", icon: Boxes },
  { to: "/" as const, label: "产品介绍", icon: Info },
];

export function ProductWordmark({ compact = false }: { compact?: boolean }) {
  return <Link to="/" className="no-underline text-text" aria-label="SONA 首页">
    <span className="inline-flex items-center gap-2 font-semibold tracking-[-0.03em]">
      <span className="h-8 w-8 [&_svg]:h-full [&_svg]:w-full"><BrandMark /></span>
      {!compact && <span>SONA <small className="ms-1 font-normal tracking-normal text-muted">AI for Science</small></span>}
    </span>
  </Link>;
}

export function ProductSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { user, logout } = useAuthSession();
  return <aside className="product-sidebar flex w-52 shrink-0 flex-col border-e border-border-variant bg-background px-3 py-5 [@media((max-width:_820px))]:w-full [@media((max-width:_820px))]:border-e-0 [@media((max-width:_820px))]:border-b">
    <div className="px-2 pb-7"><ProductWordmark /></div>
    <nav className="flex flex-col gap-1 [@media((max-width:_820px))]:flex-row [@media((max-width:_820px))]:overflow-x-auto" aria-label="产品导航">
      {links.map(({ to, label, icon: Icon }) => {
        const active = pathname === to || (to !== "/" && pathname.startsWith(`${to}/`));
        return <Link key={to} to={to} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm no-underline transition-colors ${active ? "bg-primary-subtle text-primary font-medium" : "text-subtext hover:bg-surface hover:text-text"}`}>
          <Icon size={17} />{label}
        </Link>;
      })}
    </nav>
    {user && <div className="mt-auto rounded-lg border border-border-variant bg-canvas p-3 [@media((max-width:_820px))]:hidden">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-subtle text-primary"><UserRound size={16} /></span>
        <span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium text-text">{user.name}</strong><span className="block truncate text-xs text-muted">{user.email}</span></span>
        <button type="button" onClick={() => void logout()} title="退出登录" aria-label="退出登录" className="grid h-8 w-8 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-background hover:text-text"><LogOut size={15} /></button>
      </div>
    </div>}
  </aside>;
}

export function ProductHeader({ title }: { title: string }) {
  return <header className="flex h-16 shrink-0 items-center justify-between border-b border-border-variant bg-background px-6">
    <span className="text-sm text-subtext">{title}</span>
    <Link to="/discover" className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-subtext no-underline hover:text-text"><Search size={14} />搜索论文</Link>
  </header>;
}

export function PlatformFrame({ title, children }: { title: string; children: ReactNode }) {
  return <div className="flex h-full min-h-0 bg-canvas [@media((max-width:_820px))]:flex-col">
    <ProductSidebar />
    <div className="flex min-w-0 flex-1 flex-col"><ProductHeader title={title} />{children}</div>
  </div>;
}
