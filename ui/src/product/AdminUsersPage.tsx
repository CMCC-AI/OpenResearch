import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { useCasesBase } from "./FeaturedCases";
import { caseRequest } from "./featuredCasesApi";

interface UserSummary { total: number; enabled: number; disabled: number; admins: number }
interface ManagedUser { id: string; name: string; email: string; is_admin: boolean; disabled: boolean; created_at: string; last_login_at: string | null; workspace_count: number }
interface UsersResult { summary: UserSummary; users: ManagedUser[]; total: number; page: number; pageSize: number }
export function AdminUsersPage() {
  const base = useCasesBase(); const { user } = useAuthSession();
  const [search, setSearch] = useState(""); const [query, setQuery] = useState(""); const [page, setPage] = useState(1);
  const result = useQuery({ queryKey: ["admin-users",base,user?.id,page,query], queryFn: () => caseRequest<UsersResult>(base,`admin/users?page=${page}&q=${encodeURIComponent(query)}`), enabled: Boolean(base && user?.isAdmin), retry: false });
  const data = result.error ? undefined : result.data;
  const date = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "尚未登录";
  return <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8"><div className="mx-auto flex max-w-290 flex-col gap-6">
    <header><h1 className="mb-2 text-3xl font-semibold">用户管理</h1><p className="text-sm text-subtext">查看注册账号、系统角色和登录情况。此处不展示密码或用户的私人研究内容。</p></header>
    {data && <div className="grid grid-cols-4 gap-4 max-md:grid-cols-2">{([["注册用户",data.summary.total],["正常账号",data.summary.enabled],["停用账号",data.summary.disabled],["系统管理员",data.summary.admins]] as const).map(([label,value]) => <div key={label} className="rounded-xl border border-border bg-background p-4"><span className="text-sm text-subtext">{label}</span><strong className="mt-2 block text-2xl">{value}</strong></div>)}</div>}
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {event.preventDefault();setPage(1);setQuery(search.trim());}}><label className="flex flex-1 flex-col gap-2 text-sm">搜索用户<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="姓名或邮箱" className="rounded-lg border border-border bg-background p-2" /></label><Button type="submit">搜索</Button></form>
    {result.isFetching && <p role="status" className="text-sm text-subtext">正在加载用户…</p>}{result.error && <div role="alert" className="text-sm text-accent-red">{result.error.message} <Button size="small" onClick={() => void result.refetch()}>重试</Button></div>}
    {data && <><div className="overflow-x-auto rounded-xl border border-border bg-background"><table className="w-full text-start text-sm"><thead><tr>{["姓名","邮箱","系统角色","账号状态","注册时间","最近登录","私人空间数"].map((label) => <th key={label} scope="col" className="whitespace-nowrap border-b border-border p-3 text-start font-medium">{label}</th>)}</tr></thead><tbody>{data.users.map((item) => <tr key={item.id}><td className="p-3">{item.name}</td><td className="p-3">{item.email}</td><td className="whitespace-nowrap p-3">{item.is_admin ? "系统管理员" : "普通用户"}</td><td className="whitespace-nowrap p-3">{item.disabled ? "已停用" : "正常"}</td><td className="whitespace-nowrap p-3">{date(item.created_at)}</td><td className="whitespace-nowrap p-3">{date(item.last_login_at)}</td><td className="p-3">{item.workspace_count}</td></tr>)}</tbody></table>{!data.users.length && <p className="p-4 text-sm text-subtext">没有匹配的用户。</p>}</div><div className="flex flex-wrap items-center justify-between gap-3 text-sm"><span>共 {data.total} 位用户 · 第 {page} / {Math.max(1,Math.ceil(data.total/data.pageSize))} 页</span><div className="flex gap-2"><Button disabled={page===1 || result.isFetching} onClick={() => setPage((value) => value-1)}>上一页</Button><Button disabled={page*data.pageSize>=data.total || result.isFetching} onClick={() => setPage((value) => value+1)}>下一页</Button></div></div></>}
  </div></main>;
}
