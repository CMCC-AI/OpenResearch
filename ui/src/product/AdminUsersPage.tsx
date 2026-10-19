import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui";
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
  const [action, setAction] = useState<"password" | "role" | "delete">(
    "password",
  );
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [target, setTarget] = useState<ManagedUser | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function closeDialog() {
    setTarget(null);
    setDeleteEmail("");
    setPassword("");
    setConfirmation("");
    setAdminPassword("");
    setError("");
  }
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
        if (action === "delete" && data?.users.length === 1 && page > 1)
          setPage(page - 1);
        else await result.refetch();
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
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
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
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString("zh-CN") : "尚未登录";
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto flex max-w-290 flex-col gap-6">
        <header>
          <h1 className="mb-2 text-3xl font-semibold">用户管理</h1>
          <p className="text-sm text-subtext">
            管理注册账号、系统角色和密码。删除账号会禁止登录并保留关联研究数据及审计记录；不能删除自己或变更自己的系统角色。
          </p>
        </header>
        {message && (
          <p role="status" className="text-sm text-primary">
            {message}
          </p>
        )}
        {data && (
          <div className="grid grid-cols-4 gap-4 max-md:grid-cols-2">
            {(
              [
                ["注册用户", data.summary.total],
                ["正常账号", data.summary.enabled],
                ["停用账号", data.summary.disabled],
                ["系统管理员", data.summary.admins],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="rounded-xl border border-border bg-background p-4"
              >
                <span className="text-sm text-subtext">{label}</span>
                <strong className="mt-2 block text-2xl">{value}</strong>
              </div>
            ))}
          </div>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQuery(search.trim());
          }}
        >
          <label className="flex flex-1 flex-col gap-2 text-sm">
            搜索用户
            <input
              type="search"
              maxLength={120}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="姓名或邮箱"
              className="rounded-lg border border-border bg-background p-2"
            />
          </label>
          <Button type="submit">搜索</Button>
        </form>
        {result.isFetching && (
          <p role="status" className="text-sm text-subtext">
            正在加载用户…
          </p>
        )}
        {result.error && (
          <div role="alert" className="text-sm text-accent-red">
            {result.error.message}{" "}
            <Button size="small" onClick={() => void result.refetch()}>
              重试
            </Button>
          </div>
        )}
        {data && (
          <>
            <div className="overflow-x-auto rounded-xl border border-border bg-background">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr>
                    {[
                      "姓名",
                      "邮箱",
                      "系统角色",
                      "账号状态",
                      "注册时间",
                      "最近登录",
                      "操作",
                    ].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className="whitespace-nowrap border-b border-border p-3 text-start font-medium"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((item) => (
                    <tr key={item.id}>
                      <td className="p-3">{item.name}</td>
                      <td className="p-3">{item.email}</td>
                      <td className="whitespace-nowrap p-3">
                        {item.is_admin ? "系统管理员" : "普通用户"}
                      </td>
                      <td className="whitespace-nowrap p-3">
                        {item.disabled ? "已停用" : "正常"}
                      </td>
                      <td className="whitespace-nowrap p-3">
                        {date(item.created_at)}
                      </td>
                      <td className="whitespace-nowrap p-3">
                        {date(item.last_login_at)}
                      </td>
                      <td className="whitespace-nowrap p-3">
                        <Button
                          size="small"
                          onClick={() => {
                            closeDialog();
                            setMessage("");
                            setAction("password");
                            setTarget(item);
                          }}
                        >
                          修改密码
                        </Button>{" "}
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
                          配置角色
                        </Button>{" "}
                        <Button
                          size="small"
                          disabled={item.id === user?.id}
                          onClick={() => {
                            closeDialog();
                            setMessage("");
                            setAction("delete");
                            setTarget(item);
                          }}
                        >
                          删除用户
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.users.length && (
                <p className="p-4 text-sm text-subtext">没有匹配的用户。</p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>
                共 {data.total} 位用户 · 第 {page} /{" "}
                {Math.max(1, Math.ceil(data.total / data.pageSize))} 页
              </span>
              <div className="flex gap-2">
                <Button
                  disabled={page === 1 || result.isFetching}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页
                </Button>
                <Button
                  disabled={
                    page * data.pageSize >= data.total || result.isFetching
                  }
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-dialog-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) {
                event.preventDefault();
                closeDialog();
              }
              if (event.key === "Tab") {
                const controls = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>(
                    "input:not(:disabled),select:not(:disabled),button:not(:disabled)",
                  ),
                ];
                const first = controls[0],
                  last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
            className="w-full max-w-lg rounded-xl border border-border bg-background p-6 shadow-menu"
          >
            <h2
              id="password-dialog-title"
              className="mt-0 text-xl font-semibold"
            >
              {action === "password"
                ? "修改用户密码"
                : action === "role"
                  ? "配置系统角色"
                  : "删除用户"}
            </h2>
            <p className="break-all text-sm text-subtext">
              {target.email} ·{" "}
              {action === "delete"
                ? "删除后无法登录，关联研究数据和审计记录会保留，邮箱不能重新注册。"
                : action === "role"
                  ? "系统角色决定管理权限，不改变私人研究数据的访问权限。"
                  : "设置新密码，原密码不会显示。"}
              {action !== "delete" && "操作成功后，该用户需要重新登录。"}
            </p>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveUser();
              }}
            >
              <label className="flex flex-col gap-2 text-sm">
                你的管理员当前密码
                <input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                  value={adminPassword}
                  disabled={busy}
                  onChange={(event) => setAdminPassword(event.target.value)}
                  className="rounded-lg border border-border bg-background p-2"
                />
              </label>
              {action === "password" && (
                <>
                  <label className="flex flex-col gap-2 text-sm">
                    用户新密码
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                      className="rounded-lg border border-border bg-background p-2"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm">
                    确认新密码
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      value={confirmation}
                      disabled={busy}
                      onChange={(event) => setConfirmation(event.target.value)}
                      className="rounded-lg border border-border bg-background p-2"
                    />
                  </label>
                </>
              )}
              {action === "role" && (
                <label className="flex flex-col gap-2 text-sm">
                  系统角色
                  <select
                    value={isAdmin ? "admin" : "user"}
                    disabled={busy}
                    onChange={(event) =>
                      setIsAdmin(event.target.value === "admin")
                    }
                    className="rounded-lg border border-border bg-background p-2"
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">系统管理员</option>
                  </select>
                </label>
              )}
              {action === "delete" && (
                <label className="flex flex-col gap-2 text-sm">
                  输入用户完整邮箱确认删除
                  <input
                    type="email"
                    required
                    value={deleteEmail}
                    disabled={busy}
                    onChange={(event) => setDeleteEmail(event.target.value)}
                    className="rounded-lg border border-border bg-background p-2"
                  />
                </label>
              )}
              {error && (
                <p role="alert" className="text-sm text-accent-red">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <Button type="button" disabled={busy} onClick={closeDialog}>
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (action === "delete" && deleteEmail !== target.email)
                  }
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
          </section>
        </div>
      )}
    </main>
  );
}
