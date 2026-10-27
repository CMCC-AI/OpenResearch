import { stripAppBase } from "../appBasePath";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { PanelLeft, Star } from "lucide-react";
import brand from "../assets/workbench/brand.svg";
import newChat from "../assets/workbench/new-chat.svg";
import discover from "../assets/workbench/discover.svg";
import literature from "../assets/workbench/literature.svg";
import capabilities from "../assets/workbench/capabilities.svg";
import { IconButton } from "../components/ui";
import { ResearchProjectNavigation } from "../components/ResearchNavigation";
import { AccountMenu } from "../components/AccountMenu";
import { useAuthSession } from "./AuthSession";

const productLinks = [
  { to: "/projects" as const, label: "新对话", image: newChat },
  { to: "/discover" as const, label: "论文发现", image: discover },
  { to: "/literature" as const, label: "论文精读", image: literature },
  { to: "/capabilities" as const, label: "能力中心", image: capabilities },
  { to: "/cases" as const, label: "精选案例", image: null },
];

export function ProductWordmark({ compact = false, heading = false }: { compact?: boolean; heading?: boolean }) {
  return <Link to="/projects" className="no-underline text-text" aria-label="MobileSci 科研首页">
    <span className={`product-brand inline-flex items-center gap-3 font-semibold ${heading ? "product-brand-heading" : ""}`}>
      <img src={brand} width={heading ? 56 : 38} height={heading ? 56 : 38} alt="" className="shrink-0" />
      {!compact && <span className={`product-brand-text ${heading ? "product-brand-heading-text" : "text-2xl"}`}>MobileSci</span>}
    </span>
  </Link>;
}

export function ProductSidebar({ children, connectionInfo, onCollapse }: { children?: ReactNode; connectionInfo?: ReactNode; onCollapse?: () => void }) {
  const pathname = useRouterState({ select: (state) => stripAppBase(state.location.pathname) });
  const { user, canAccessResearch } = useAuthSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  return <aside className={`product-sidebar session-rail [&_.rail-body]:ps-1 [&_.rail-body]:pe-1 flex w-70 min-h-0 shrink-0 flex-col px-3 py-4 mac-titlebar:pt-10 win-titlebar:pt-10 ${mobileOpen ? "[@media((max-width:_820px))]:absolute [@media((max-width:_820px))]:inset-y-0 [@media((max-width:_820px))]:start-0 [@media((max-width:_820px))]:z-40" : ""} ${children || mobileOpen ? "" : "[@media((max-width:_820px))]:w-16 [@media((max-width:_820px))]:px-2 [@media((max-width:_820px))]:[&_.product-brand-text]:hidden [@media((max-width:_820px))]:[&_.research-nav-label]:hidden [@media((max-width:_820px))]:[&_.research-projects]:hidden"}`}>
    <div className={`flex shrink-0 items-center justify-between gap-1 px-2 pb-4 ${!children && !mobileOpen ? "[@media((max-width:_820px))]:flex-col [@media((max-width:_820px))]:px-0 [@media((max-width:_820px))]:gap-2" : ""}`}><ProductWordmark />{!children && <button type="button" aria-label={mobileOpen ? "收起项目导航" : "展开历史项目"} aria-expanded={mobileOpen} onClick={() => setMobileOpen((value) => !value)} className="hidden [@media((max-width:_820px))]:block"><PanelLeft size={17} /></button>}{onCollapse && <IconButton size="small" aria-label="收起导航" title="收起导航" onClick={onCollapse}><PanelLeft size={17} /></IconButton>}</div>
    <nav aria-label="MobileSci 菜单" className="product-navigation flex shrink-0 flex-col gap-1 pb-4">{productLinks.filter(({ to }) => canAccessResearch || to === "/cases").map(({ to, label, image }) => {
      const active = pathname === to || pathname.startsWith(`${to}/`);
      return <Link key={to} to={to} title={label} aria-label={label} aria-current={active ? "page" : undefined} className="product-nav-item flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm font-medium text-text no-underline">{image ? <img src={image} width={18} height={18} alt="" className="shrink-0" /> : <Star size={18} className="shrink-0" />}<span className="research-nav-label">{label}</span></Link>;
    })}</nav>
    <div aria-label="OpenResearch 项目与会话" className="product-research-navigation flex min-h-0 flex-1 flex-col border-t border-border-variant pt-2">{children ?? (canAccessResearch ? <ResearchProjectNavigation enabled={Boolean(user)} /> : <p className="px-2 text-xs text-subtext">浏览管理员发布的公共案例，原项目保持独立访问权限。</p>)}</div>
    <AccountMenu connectionInfo={connectionInfo} />
  </aside>;
}

export function ProductHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return <header className="product-header flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border-variant px-6">
    <div className="product-header-title min-w-0 flex-1 overflow-hidden text-sm">{title}</div>
    {actions && <div className="shrink-0">{actions}</div>}
  </header>;
}

export function PlatformFrame({ title, children }: { title: string; children: ReactNode }) {
  return <div className="product-frame flex h-full min-h-0 overflow-hidden">
    <ProductSidebar />
    <div className="flex min-w-0 flex-1 flex-col"><ProductHeader title={title} />{children}</div>
  </div>;
}
