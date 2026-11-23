import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ShieldCheck, UserCheck, UserX, Users, KeyRound, UserCog, Trash2, Gauge, X, RefreshCw } from "lucide-react";
import { Badge, Button, Input } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { useCasesBase } from "./FeaturedCases";
import { caseRequest, caseWrite } from "./featuredCasesApi";

interface UserSummary {
  total: number;
  enabled: number;
  disabled: number;
  admins: number;
}
interface ManagedUser {
  id: string;
  name: string;
  email: string;
  is_admin: boolean;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}
interface UsersResult {
  summary: UserSummary;
  users: ManagedUser[];
  total: number;
  page: number;
  pageSize: number;
}

export function AdminUsersPage() {
  const base = useCasesBase();
  const { user, logout } = useAuthSession();
  const [action, setAction] = useState<"password" | "role" | "delete">("password");
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [target, setTarget] = useState<ManagedUser | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (target) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [target]);

  function closeDialog() {
    setTarget(null);
    setDeleteEmail("");
    setPassword("");
    setConfirmation("");
    setAdminPassword("");
    setError("");
  }

  const result = useQuery({
    queryKey: ["admin-users", base, user?.id, page, query],
    queryFn: () =>
      caseRequest<UsersResult>(
        base,
        `admin/users?page=${page}&q=${encodeURIComponent(query)}`,
      ),
    enabled: Boolean(base && user?.isAdmin),
    retry: false,
  });

  const data = result.error ? undefined : result.data;

  async function saveUser() {
    if (!target) return;
    if (action === "password" && password !== confirmation) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await caseWrite<{ reauthenticate: boolean }>(
        base,
        `admin/users/${target.id}/${action}`,
        action === "password"
          ? { password, adminPassword }
          : action === "role"
            ? { isAdmin, adminPassword }
            : { email: deleteEmail, adminPassword },
      );
      setMessage(
        action === "password"
          ? `已更新 ${target.email} 的密码，旧登录会话已退出。`
          : action === "role"
            ? `已将 ${target.email} 设为${isAdmin ? "系统管理员" : "普通用户"}，该用户需要重新登录。`
            : `已删除 ${target.email} 的账号，关联研究数据和审计记录已保留。`,
      );
      closeDialog();
      if (action !== "password") {
        if (action === "delete" && data?.users.length === 1 && page > 1) {
          setPage(page - 1);
        } else {
          await result.refetch();
        }
      }
      if (response.reauthenticate) await logout();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      setPassword("");
      setConfirmation("");
      setAdminPassword("");
    } finally {
      setBusy(false);
    }
  }

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleString("zh-CN") : "尚未登录";

  const summaryCards = data
    ? [
        { label: "注册用户", value: data.summary.total, Icon: Users, tone: "bg-primary-subtle text-primary" },
        { label: "正常账号", value: data.summary.enabled, Icon: UserCheck, tone: "bg-accent-green-subtle text-accent-green" },
        { label: "停用账号", value: data.summary.disabled, Icon: UserX, tone: "bg-accent-red-subtle text-accent-red" },
        { label: "系统管理员", value: data.summary.admins, Icon: ShieldCheck, tone: "bg-accent-blue-subtle text-accent-blue" },
      ]
    : [];

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-6 py-7 max-md:px-4">
      <div className="mx-auto flex max-w-290 flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-2xl font-semibold tracking-tight text-text">用户管理</h1>
            <p className="m-0 text-sm text-subtext">
              管理注册账号、系统角色与登录密码。删除账号会禁止登录并保留关联研究数据及审计记录。
            </p>
          </div>
          <Button
            type="button"
            disabled={result.isFetching}
            onClick={() => void result.refetch()}
          >
            <RefreshCw size={14} className={result.isFetching ? "animate-spin" : undefined} />
            <span>刷新列表</span>
          </Button>
        </header>

        {message && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-xl border border-accent-green/40 bg-accent-green-subtle/60 px-4 py-3 text-sm text-text"
          >
            <span>{message}</span>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => setMessage("")}
              className="rounded p-1 text-subtext hover:bg-surface hover:text-text"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {data && (
          <section aria-label="用户概览" className="grid grid-cols-4 gap-4 max-md:grid-cols-2">
            {summaryCards.map(({ label, value, Icon, tone }) => (
              <div
                key={label}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4 shadow-xs"
              >
                <div className="min-w-0">
                  <span className="block text-xs font-medium text-subtext">{label}</span>
                  <strong className="mt-1.5 block text-2xl font-semibold tabular-nums text-text">
                    {value.toLocaleString()}
                  </strong>
                </div>
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
                  <Icon size={18} />
                </span>
              </div>
            ))}
          </section>
        )}

        <form
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-xs"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQuery(search.trim());
          }}
        >
          <div className="relative min-w-60 flex-1">
            <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              aria-label="搜索用户"
              type="search"
              maxLength={120}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="按姓名或邮箱搜索用户…"
              className="h-9 ps-9"
            />
          </div>
          {query && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch("");
                setQuery("");
                setPage(1);
              }}
            >
              清空筛选
            </Button>
          )}
          <Button type="submit" variant="primary">
            搜索
          </Button>
        </form>

        {result.isFetching && !data && (
          <p role="status" className="text-sm text-subtext">
            正在加载用户…
          </p>
        )}

        {result.error && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger-notice-border bg-accent-red-subtle px-4 py-3 text-sm text-accent-red"
          >
            <span>{result.error.message}</span>
            <Button size="small" onClick={() => void result.refetch()}>
              重试
            </Button>
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-3">
            <div
              tabIndex={0}
              role="region"
              aria-labelledby="admin-users-table-caption"
              className="overflow-x-auto rounded-xl border border-border bg-background shadow-xs focus-visible:outline-2 focus-visible:outline-primary"
            >
              <table className="w-full border-collapse text-start text-sm">
                <caption id="admin-users-table-caption" className="sr-only">
                  平台注册用户列表
                </caption>
                <thead className="sticky top-0 z-10 bg-surface/85 backdrop-blur-xs">
                  <tr>
                    {["用户", "邮箱", "系统角色", "账号状态", "注册时间", "最近登录", "操作"].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className="whitespace-nowrap border-b border-border px-4 py-3 text-start text-xs font-medium text-subtext"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-variant">
                  {data.users.map((item) => {
                    const initial = (item.name || item.email || "?").trim().slice(0, 1).toUpperCase();
                    return (
                      <tr key={item.id} className="transition-colors hover:bg-hover-faint">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <span
                              aria-hidden="true"
                              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-medium text-subtext ring-1 ring-border-variant"
                            >
                              {initial}
                            </span>
                            <span className="font-medium text-text">{item.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-subtext">{item.email}</td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <Badge size="small" variant={item.is_admin ? "warning" : "default"}>
                            {item.is_admin ? "系统管理员" : "普通用户"}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <Badge size="small" variant={item.disabled ? "error" : "success"}>
                            {item.disabled ? "已停用" : "正常"}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-subtext">
                          {formatDate(item.created_at)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-subtext">
                          {formatDate(item.last_login_at)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Link
                              to="/admin/quotas"
                              search={{ email: item.email }}
                              className="inline-flex h-7 items-center gap-1 rounded-sm border border-border-variant bg-surface/60 px-2.5 text-xs font-medium text-primary no-underline transition-colors hover:bg-primary-subtle"
                            >
                              <Gauge size={12} />
                              <span>Token 额度</span>
                            </Link>
                            <Button
                              size="small"
                              onClick={() => {
                                closeDialog();
                                setMessage("");
                                setAction("password");
                                setTarget(item);
                              }}
                            >
                              <KeyRound size={12} />
                              <span>改密</span>
                            </Button>
                            <Button
                              size="small"
                              disabled={item.id === user?.id || item.disabled}
                              onClick={() => {
                                closeDialog();
                                setMessage("");
                                setAction("role");
                                setIsAdmin(item.is_admin);
                                setTarget(item);
                              }}
                            >
                              <UserCog size={12} />
                              <span>角色</span>
                            </Button>
                            <Button
                              size="small"
                              variant="danger"
                              disabled={item.id === user?.id}
                              onClick={() => {
                                closeDialog();
                                setMessage("");
                                setAction("delete");
                                setTarget(item);
                              }}
                            >
                              <Trash2 size={12} />
                              <span>删除</span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!data.users.length && (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <Users size={28} className="text-muted" />
                  <p className="m-0 text-sm text-subtext">没有匹配的用户。</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-subtext">
              <span className="tabular-nums">
                共 {data.total.toLocaleString()} 位用户 · 第 {page} /{" "}
                {Math.max(1, Math.ceil(data.total / data.pageSize))} 页
              </span>
              <div className="flex gap-2">
                <Button
                  size="small"
                  disabled={page === 1 || result.isFetching}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="small"
                  disabled={page * data.pageSize >= data.total || result.isFetching}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="user-action-dialog-title"
        onCancel={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          closeDialog();
        }}
        className="m-auto w-full max-w-lg rounded-2xl border border-border bg-background p-6 text-text shadow-modal backdrop:bg-modal-backdrop backdrop:backdrop-blur-xs"
      >
        {target && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="user-action-dialog-title" className="m-0 text-lg font-semibold text-text">
                  {action === "password"
                    ? "修改用户密码"
                    : action === "role"
                      ? "配置系统角色"
                      : "删除用户"}
                </h2>
                <p className="mb-0 mt-1 break-all text-xs text-subtext">
                  {target.name}（{target.email}）
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭弹窗"
                disabled={busy}
                onClick={closeDialog}
                className="rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-text disabled:opacity-45"
              >
                <X size={16} />
              </button>
            </div>

            <p className="m-0 rounded-lg border border-border-variant bg-surface/60 px-3 py-2.5 text-xs text-subtext">
              {action === "delete"
                ? "删除后无法登录，关联研究数据和审计记录会保留，邮箱不能重新注册。"
                : action === "role"
                  ? "系统角色决定管理权限，不改变私人研究数据的访问权限。操作成功后，该用户需要重新登录。"
                  : "设置新密码，原密码不会显示。操作成功后，该用户需要重新登录。"}
            </p>

            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveUser();
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                你的管理员当前密码
                <Input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                  value={adminPassword}
                  disabled={busy}
                  onChange={(event) => setAdminPassword(event.target.value)}
                />
              </label>

              {action === "password" && (
                <>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                    用户新密码（至少 12 位）
                    <Input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                    确认新密码
                    <Input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      value={confirmation}
                      disabled={busy}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </label>
                </>
              )}

              {action === "role" && (
                <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                  系统角色
                  <select
                    value={isAdmin ? "admin" : "user"}
                    disabled={busy}
                    onChange={(event) => setIsAdmin(event.target.value === "admin")}
                    className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-text"
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">系统管理员</option>
                  </select>
                </label>
              )}

              {action === "delete" && (
                <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
                  输入用户完整邮箱确认删除
                  <Input
                    type="email"
                    required
                    placeholder={target.email}
                    value={deleteEmail}
                    disabled={busy}
                    onChange={(event) => setDeleteEmail(event.target.value)}
                  />
                </label>
              )}

              {error && (
                <p role="alert" className="m-0 rounded-lg border border-danger-notice-border bg-accent-red-subtle px-3 py-2 text-xs text-accent-red">
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2.5 pt-2">
                <Button type="button" disabled={busy} onClick={closeDialog}>
                  取消
                </Button>
                <Button
                  type="submit"
                  variant={action === "delete" ? "danger" : "primary"}
                  disabled={busy || (action === "delete" && deleteEmail !== target.email)}
                >
                  {busy
                    ? "正在保存…"
                    : action === "password"
                      ? "保存新密码"
                      : action === "role"
                        ? "保存角色"
                        : "确认删除用户"}
                </Button>
              </div>
            </form>
          </div>
        )}
      </dialog>
    </main>
  );
}
