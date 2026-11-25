import { stripAppBase } from "../appBasePath";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeft, Star, Workflow } from "lucide-react";
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
];

function WorkflowNavigationLink({ projectId, active }: { projectId?: string; active: boolean }) {
  const label = projectId ? "工作流" : "我的工作流";
  const content = <><Workflow size={18} className="shrink-0" /><span className="research-nav-label">{label}</span></>;
  const props = { title: label, "aria-label": label, "aria-current": active ? "page" as const : undefined, className: "product-nav-item flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm font-medium text-text no-underline" };
  return projectId
    ? <Link to="/projects/$projectId/workflows" params={{ projectId }} {...props}>{content}</Link>
    : <Link to="/workflows" {...props}>{content}</Link>;
}

export function ProductWordmark({ compact = false, heading = false }: { compact?: boolean; heading?: boolean }) {
  return <Link to="/projects" className="no-underline text-text" aria-label="MobileSci 科研首页">
    <span className={`product-brand inline-flex items-center gap-3 font-semibold ${heading ? "product-brand-heading" : ""}`}>
      <img src={brand} width={heading ? 56 : 38} height={heading ? 56 : 38} alt="" className="shrink-0" />
      {!compact && <span className={`product-brand-text ${heading ? "product-brand-heading-text" : "text-2xl"}`}>MobileSci</span>}
    </span>
  </Link>;
}

export function ProductSidebar({ children, connectionInfo, onCollapse, collapsed = false, width, projectId }: { children?: ReactNode; connectionInfo?: ReactNode; onCollapse?: () => void; collapsed?: boolean; width?: number; projectId?: string }) {
  const pathname = useRouterState({ select: (state) => stripAppBase(state.location.pathname) });
  const { user, canAccessResearch } = useAuthSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  // 桌面端收缩复用窄屏图标栏的那套隐藏规则；窄屏自身的媒体查询行为保持不变。
  const collapsedClasses = "w-16 px-2 [&_.product-brand-text]:hidden [&_.research-nav-label]:hidden [&_.research-projects]:hidden";
  // 拖拽宽度只在大屏生效：内联 width 会盖过窄屏的 w-16 图标栏规则，
  // 所以用 CSS 变量 + 媒体查询消费，窄屏仍保持自己的收缩行为。
  const railStyle = width !== undefined ? ({ "--product-sidebar-width": `${width}px` } as CSSProperties) : undefined;
  return <aside style={railStyle} className={`product-sidebar session-rail [&_.rail-body]:ps-1 [&_.rail-body]:pe-1 flex min-h-0 shrink-0 flex-col py-4 mac-titlebar:pt-10 win-titlebar:pt-10 ${collapsed ? collapsedClasses : "w-70 px-3 [@media((min-width:_821px))]:w-[var(--product-sidebar-width)]"} ${mobileOpen ? "[@media((max-width:_820px))]:absolute [@media((max-width:_820px))]:inset-y-0 [@media((max-width:_820px))]:start-0 [@media((max-width:_820px))]:z-40" : ""} ${children || mobileOpen || collapsed ? "" : "[@media((max-width:_820px))]:w-16 [@media((max-width:_820px))]:px-2 [@media((max-width:_820px))]:[&_.product-brand-text]:hidden [@media((max-width:_820px))]:[&_.research-nav-label]:hidden [@media((max-width:_820px))]:[&_.research-projects]:hidden"}`}>
    <div className={`flex shrink-0 items-center justify-between gap-1 px-2 pb-4 ${!children && !mobileOpen ? "[@media((max-width:_820px))]:flex-col [@media((max-width:_820px))]:px-0 [@media((max-width:_820px))]:gap-2" : ""}`}><ProductWordmark compact={collapsed} />{!children && <button type="button" aria-label={mobileOpen ? "收起项目导航" : "展开历史项目"} aria-expanded={mobileOpen} onClick={() => setMobileOpen((value) => !value)} className="hidden [@media((max-width:_820px))]:block"><PanelLeft size={17} /></button>}{onCollapse && <IconButton size="small" aria-label={collapsed ? "展开导航" : "收起导航"} title={collapsed ? "展开导航" : "收起导航"} onClick={onCollapse}><PanelLeft size={17} /></IconButton>}</div>
    <nav aria-label="MobileSci 菜单" className="product-navigation flex shrink-0 flex-col gap-1 pb-4">
      {productLinks.filter(() => canAccessResearch).map(({ to, label, image }) => {
        const active = to === "/projects" ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
        return <Link key={to} to={to} title={label} aria-label={label} aria-current={active ? "page" : undefined} className="product-nav-item flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm font-medium text-text no-underline"><img src={image} width={18} height={18} alt="" className="shrink-0" /><span className="research-nav-label">{label}</span></Link>;
      })}
      {canAccessResearch && <WorkflowNavigationLink projectId={projectId} active={pathname === "/workflows" || pathname === `/projects/${encodeURIComponent(projectId ?? "")}/workflows`} />}
      <Link to="/cases" title="精选案例" aria-label="精选案例" aria-current={pathname === "/cases" || pathname.startsWith("/cases/") ? "page" : undefined} className="product-nav-item flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm font-medium text-text no-underline"><Star size={18} className="shrink-0" /><span className="research-nav-label">精选案例</span></Link>
    </nav>
    <div aria-label="OpenResearch 项目与会话" className="product-research-navigation flex min-h-0 flex-1 flex-col border-t border-border-variant pt-2">{children ?? (canAccessResearch ? <ResearchProjectNavigation enabled={Boolean(user) && pathname !== "/settings/account" && pathname !== "/settings/quota"} /> : <p className="px-2 text-xs text-subtext">浏览管理员发布的公共案例，原项目保持独立访问权限。</p>)}</div>
    <AccountMenu connectionInfo={connectionInfo} />
  </aside>;
}

export function ProductHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return <header className="product-header flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border-variant px-6">
    <div className="product-header-title min-w-0 flex-1 overflow-hidden text-sm">{title}</div>
    {actions && <div className="shrink-0">{actions}</div>}
  </header>;
}

// 侧栏宽度可拖拽调整并持久化；不带 title 的页面（如工作流编辑器）不渲染页头横幅。
const SIDEBAR_WIDTH_KEY = "product-sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "product-sidebar-collapsed";
const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 360;

function storedSidebarWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
  } catch { /* 隐私模式等场景忽略 */ }
  return SIDEBAR_DEFAULT_WIDTH;
}

export function PlatformFrame({ title, children, projectId }: { title?: string; children: ReactNode; projectId?: string }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const [width, setWidth] = useState(storedSidebarWidth);
  const toggleCollapse = () => setCollapsed((value) => {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "0" : "1"); } catch { /* 忽略 */ }
    return !value;
  });
  // 拖侧栏右缘调宽：与工作区右栏同一套指针捕获手法，松手时持久化。
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const rtl = document.documentElement.dir === "rtl";
    const onMove = (moveEvent: PointerEvent) => {
      const delta = rtl ? startX - moveEvent.clientX : moveEvent.clientX - startX;
      setWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = prevUserSelect;
      setWidth((current) => {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(current)); } catch { /* 忽略 */ }
        return current;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  return <div className="product-frame relative flex h-full min-h-0 overflow-hidden">
    <ProductSidebar projectId={projectId} collapsed={collapsed} onCollapse={toggleCollapse} width={width} />
    {!collapsed && <div role="separator" aria-orientation="vertical" aria-label="拖拽调整导航宽度" className="absolute top-0 bottom-0 z-30 hidden w-1.5 cursor-col-resize [&:hover]:bg-resizer-hover [&:active]:bg-resizer-hover [@media((min-width:_821px))]:block" style={{ insetInlineStart: `${width - 3}px` }} onPointerDown={startResize} />}
    <div className="flex min-w-0 flex-1 flex-col">{title != null && <ProductHeader title={title} />}{children}</div>
  </div>;
}
