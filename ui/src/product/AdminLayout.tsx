import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ShieldCheck, Star, Users, Gauge, Cpu, ArrowLeft, LogOut, ExternalLink } from "lucide-react";
import { useAuthSession } from "./AuthSession";
import { stripAppBase } from "../appBasePath";

const NAV_ITEMS = [
  { to: "/admin/users" as const, label: "用户管理", description: "账号、角色与安全", Icon: Users },
  { to: "/admin/quotas" as const, label: "Token 额度", description: "月度配额与补账", Icon: Gauge },
  { to: "/admin/cases" as const, label: "精选案例管理", description: "公开案例与成果", Icon: Star },
  { to: "/admin/opencode" as const, label: "大模型接入", description: "网关与免费模型", Icon: Cpu },
];

/** One administration shell; private research permissions remain independent. */
export function AdminLayout() {
  const { user, canAccessResearch, logout } = useAuthSession();
  const pathname = useRouterState({ select: (state) => stripAppBase(state.location.pathname) });

  if (!user?.isAdmin) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 bg-canvas p-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-border bg-background p-8 text-center shadow-elevated">
          <div className="flex size-12 items-center justify-center rounded-xl bg-accent-red-subtle text-accent-red">
            <ShieldCheck size={24} />
          </div>
          <h1 className="m-0 text-xl font-semibold text-text">无权访问系统管理</h1>
          <p role="alert" className="m-0 text-sm text-subtext">
            系统管理仅对系统管理员开放。如需权限请联系平台管理员。
          </p>
          <Link
            to="/cases"
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-background no-underline transition-colors hover:bg-primary-hover"
          >
            返回精选案例
          </Link>
        </div>
      </main>
    );
  }

  const currentNav = NAV_ITEMS.find((item) => item.to === pathname) ?? NAV_ITEMS[0]!;
  const avatarInitial = (user.name || user.email || "A").trim().slice(0, 1).toUpperCase();

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-canvas max-md:flex-col">
      <aside className="flex w-64 shrink-0 flex-col border-e border-border bg-background max-md:w-full max-md:border-b max-md:border-e-0">
        <div className="flex h-15 shrink-0 items-center gap-3 border-b border-border-variant px-4">
          <Link
            to="/admin/users"
            className="flex min-w-0 items-center gap-2.5 text-text no-underline"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary">
              <ShieldCheck size={18} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight">系统管理</span>
              <span className="block truncate text-xs text-muted">平台控制台</span>
            </span>
          </Link>
        </div>

        <nav
          aria-label="系统管理导航"
          className="flex flex-1 flex-col gap-1 overflow-y-auto p-3 max-md:flex-row max-md:flex-wrap max-md:gap-1.5 max-md:p-2.5"
        >
          {NAV_ITEMS.map(({ to, label, Icon }) => {
            const active = pathname === to;
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? "page" : undefined}
                className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm no-underline transition-colors duration-150 ${
                  active
                    ? "bg-primary-subtle font-medium text-primary"
                    : "text-subtext hover:bg-surface hover:text-text"
                }`}
              >
                <Icon
                  size={16}
                  className={active ? "text-primary" : "text-muted transition-colors group-hover:text-text"}
                />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3 border-t border-border-variant p-3 max-md:hidden">
          <Link
            to={canAccessResearch ? "/projects" : "/cases"}
            className="flex items-center gap-2 rounded-lg border border-border-variant bg-surface/60 px-3 py-2 text-xs font-medium text-text no-underline transition-colors hover:bg-surface"
          >
            <ArrowLeft size={14} className="text-primary" />
            <span>{canAccessResearch ? "返回科研工作台" : "查看公共案例"}</span>
          </Link>

          <div className="flex items-center gap-2.5 rounded-lg px-1 py-1">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold text-text ring-1 ring-border"
            >
              {avatarInitial}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-text">{user.name}</span>
                <span className="inline-flex shrink-0 items-center rounded-full bg-surface px-1.5 py-px text-xs text-subtext">管理员</span>
              </div>
              <span className="block truncate text-xs text-subtext">{user.email}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void logout()}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-start text-xs text-subtext transition-colors hover:bg-danger-hover hover:text-accent-red"
          >
            <LogOut size={14} />
            <span>退出登录</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-15 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-6 max-md:px-4">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-muted">系统管理</span>
            <span aria-hidden="true" className="text-muted">/</span>
            <span className="truncate font-medium text-text">{currentNav.label}</span>
          </div>
          <div className="flex items-center gap-3">
            {canAccessResearch && (
              <Link
                to="/projects"
                className="hidden items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text no-underline transition-colors hover:bg-surface max-md:inline-flex"
              >
                <ArrowLeft size={13} />
                <span>工作台</span>
              </Link>
            )}
            <Link
              to="/cases"
              className="inline-flex items-center gap-1.5 rounded-md border border-border-variant bg-surface/60 px-3 py-1.5 text-xs font-medium text-text no-underline transition-colors hover:bg-surface"
            >
              <span>查看公共案例</span>
              <ExternalLink size={12} className="text-muted" />
            </Link>
          </div>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
