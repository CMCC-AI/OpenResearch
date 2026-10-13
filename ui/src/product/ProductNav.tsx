import { stripAppBase } from "../appBasePath";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { BookOpen, Boxes, Home, Library, PanelLeft, Search } from "lucide-react";
import { BrandMark } from "../components/Wordmark";
import { IconButton } from "../components/ui";
import { ResearchProjectNavigation } from "../components/ResearchNavigation";
import { AccountMenu } from "../components/AccountMenu";
import { useAuthSession } from "./AuthSession";

const productLinks = [
  { to: "/projects" as const, label: "新建项目", Icon: Home },
  { to: "/discover" as const, label: "论文发现", Icon: BookOpen },
  { to: "/literature" as const, label: "论文精读", Icon: Library },
  { to: "/capabilities" as const, label: "能力中心", Icon: Boxes },
];

export function ProductWordmark({ compact = false }: { compact?: boolean }) {
  return <Link to="/projects" className="no-underline text-text" aria-label="SONA 科研首页">
    <span className="inline-flex items-center gap-2 font-semibold tracking-[-0.03em]">
      <span className="h-8 w-8 [&_svg]:h-full [&_svg]:w-full"><BrandMark /></span>
      {!compact && <span className="product-brand-text flex flex-col leading-tight"><span>SONA</span><small className="text-xs font-normal tracking-normal text-muted">AI for Science</small></span>}
    </span>
  </Link>;
}

export function ProductSidebar({ children, connectionInfo, onCollapse, onSettings }: { children?: ReactNode; connectionInfo?: ReactNode; onCollapse?: () => void; onSettings?: (tab: "compute" | "settings") => void }) {
  const pathname = useRouterState({ select: (state) => stripAppBase(state.location.pathname) });
  const { user } = useAuthSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  return <aside className={`product-sidebar flex w-64 min-h-0 shrink-0 flex-col border-e border-border-variant bg-background px-3 py-4 mac-titlebar:pt-10 win-titlebar:pt-10 ${mobileOpen ? "[@media((max-width:_820px))]:absolute [@media((max-width:_820px))]:inset-y-0 [@media((max-width:_820px))]:start-0 [@media((max-width:_820px))]:z-40" : ""} ${children ? "session-rail [&_.rail-body]:ps-1 [&_.rail-body]:pe-1" : mobileOpen ? "" : "[@media((max-width:_820px))]:w-16 [@media((max-width:_820px))]:px-2 [@media((max-width:_820px))]:[&_.product-brand-text]:hidden [@media((max-width:_820px))]:[&_.research-nav-label]:hidden [@media((max-width:_820px))]:[&_.research-projects]:hidden"}`}>
    <div className={`flex shrink-0 items-center justify-between gap-1 px-2 pb-4 ${!children && !mobileOpen ? "[@media((max-width:_820px))]:flex-col [@media((max-width:_820px))]:px-0 [@media((max-width:_820px))]:gap-2" : ""}`}><ProductWordmark />{!children && <button type="button" aria-label={mobileOpen ? "收起项目导航" : "展开历史项目"} aria-expanded={mobileOpen} onClick={() => setMobileOpen((value) => !value)} className="hidden [@media((max-width:_820px))]:block"><PanelLeft size={17} /></button>}{onCollapse && <IconButton size="small" aria-label="收起导航" title="收起导航" onClick={onCollapse}><PanelLeft size={17} /></IconButton>}</div>
    <nav aria-label="SONA 菜单" className="flex shrink-0 flex-col gap-0.5 pb-2">{productLinks.map(({ to, label, Icon }) => {
      const active = pathname === to || pathname.startsWith(`${to}/`);
      return <Link key={to} to={to} title={label} aria-label={label} aria-current={active ? "page" : undefined} className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm no-underline ${active ? "bg-primary-subtle text-primary font-medium" : "text-subtext hover:bg-surface hover:text-text"}`}><Icon size={15} className="shrink-0" /><span className="research-nav-label">{label}</span></Link>;
    })}</nav>
    <div aria-label="OpenResearch 项目与会话" className="mt-1 flex min-h-0 flex-1 flex-col border-t border-border-variant pt-2">{children ?? <ResearchProjectNavigation enabled={Boolean(user)} />}</div>
    <AccountMenu onSettings={onSettings} connectionInfo={connectionInfo} />
  </aside>;
}

export function ProductHeader({ title }: { title: ReactNode }) {
  return <header className="product-header flex h-16 shrink-0 items-center justify-between border-b border-border-variant bg-background px-6">
    <div className="min-w-0 text-sm text-subtext">{title}</div>
    <Link to="/discover" className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-subtext no-underline hover:text-text"><Search size={14} />搜索论文</Link>
  </header>;
}

export function PlatformFrame({ title, children }: { title: string; children: ReactNode }) {
  return <div className="flex h-full min-h-0 overflow-hidden bg-canvas">
    <ProductSidebar />
    <div className="flex min-w-0 flex-1 flex-col"><ProductHeader title={title} />{children}</div>
  </div>;
}
