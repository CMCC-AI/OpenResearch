import { useCasesBase } from "./FeaturedCases";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { PlatformFrame } from "./ProductNav";
import { caseWrite } from "./featuredCasesApi";
import { ownQuota, type QuotaBalance } from "./tokenQuotaApi";

export const accountInput = "w-full rounded-lg border border-border bg-background p-2 text-text";
export const accountCard = "rounded-xl border border-border bg-background p-5";

export function PersonalSettingsNav() {
  return <nav aria-label="设置导航" className="flex flex-wrap gap-4 text-sm">
    <Link to="/settings/account" activeProps={{ className: "font-semibold text-primary" }}>账户与安全</Link>
    <Link to="/settings/quota" activeProps={{ className: "font-semibold text-primary" }}>Token 额度</Link>
    <Link to="/settings/$tab" params={{ tab: "settings" }} activeProps={{ className: "font-semibold text-primary" }}>工作区设置</Link>
  </nav>;
}

export function QuotaUsage({ quota }: { quota: QuotaBalance }) {
  return <dl className="grid grid-cols-2 gap-3 text-sm">{[
    ["当前月份", `${quota.period}（上海时间）`], ["月额度", quota.monthlyLimit.toLocaleString()],
    ["已用", quota.used.toLocaleString()], ["在途及待确认", quota.reserved.toLocaleString()], ["可用", quota.available.toLocaleString()],
  ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-canvas p-3"><dt className="text-subtext">{label}</dt><dd className="mt-1 break-words font-semibold text-text">{value}</dd></div>)}</dl>;
}

function AccountSecurity() {
  const { user, logout } = useAuthSession();
  const accountUrl = useCasesBase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    if (data.password !== data.confirmation) { setError("两次输入的新密码不一致"); return; }
    setBusy(true); setError("");
    try { await caseWrite(accountUrl, "password", { current: data.current, password: data.password }); form.reset(); await logout(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "密码修改失败"); }
    finally { setBusy(false); }
  }
  return <>
    <section className={accountCard}><h2 className="mb-4 text-lg font-semibold">账户资料</h2><dl className="space-y-3 text-sm"><div><dt className="text-subtext">姓名</dt><dd className="break-words">{user?.name}</dd></div><div><dt className="text-subtext">邮箱</dt><dd className="break-all">{user?.email}</dd></div></dl></section>
    <section className={accountCard}><h2 className="mb-2 text-lg font-semibold">修改密码</h2><p className="mb-4 text-sm text-subtext">保存后将退出所有登录会话，请使用新密码重新登录。</p>
      <form onSubmit={event => void changePassword(event)} className="flex flex-col gap-4">
        {([{name:"current",label:"当前密码",autoComplete:"current-password"},{name:"password",label:"新密码",autoComplete:"new-password"},{name:"confirmation",label:"确认新密码",autoComplete:"new-password"}] as const).map(field => <label key={field.name} className="flex flex-col gap-1 text-sm">{field.label}<input className={accountInput} name={field.name} type="password" autoComplete={field.autoComplete} minLength={field.name === "current" ? undefined : 12} maxLength={256} required disabled={busy}/></label>)}
        {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}
        <div><Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存并重新登录"}</Button></div>
      </form>
    </section>
  </>;
}

function PersonalQuota() {
  const { user } = useAuthSession();
  const accountUrl = useCasesBase();
  const result = useQuery({ queryKey: ["token-quota", accountUrl, user?.id], queryFn: () => ownQuota(accountUrl), enabled: !!user, retry: false });
  return <section className={accountCard}><h2 className="mb-4 text-lg font-semibold">我的 Token 额度</h2>
    {result.isPending && <p role="status">正在加载额度…</p>}
    {result.error && <p role="alert">{result.error.message} <Button onClick={() => void result.refetch()}>重试</Button></p>}
    {result.data?.enabled === false && <p>当前部署尚未启用平台模型额度。</p>}
    {result.data?.enabled && <><QuotaUsage quota={result.data}/><p className="mt-4 text-sm text-subtext">每月按上海时间重置，余额不累积；仅计入平台提供的模型。在途请求按发起月份结算。</p><p className="mt-2 text-sm text-subtext">请求先按模型上下文和输出上限预占，结束后按实际用量退回差额。余额不足预占时也会拒绝请求，可选择上限较小的模型或联系管理员。</p></>}
  </section>;
}

export function PersonalSettingsPage({ section }: { section: "account" | "quota" }) {
  return <PlatformFrame title="个人设置"><main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"><div className="mx-auto flex max-w-2xl flex-col gap-5"><h1 className="text-2xl font-semibold">个人设置</h1><PersonalSettingsNav/>{section === "account" ? <AccountSecurity/> : <PersonalQuota/>}</div></main></PlatformFrame>;
}
