import { useCasesBase } from "./FeaturedCases";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { accountCard, accountInput, QuotaUsage } from "./PersonalSettingsPage";
import { quotaRequestKey, reconcileQuota, saveQuota, userQuota, type ManagedQuota } from "./tokenQuotaApi";

function QuotaEditor({ base, quota, reload }: { base: string; quota: ManagedQuota; reload: () => Promise<unknown> }) {
  const [monthly, setMonthly] = useState(String(quota.monthlyLimit));
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(quotaRequestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { setMonthly(String(quota.monthlyLimit)); }, [quota.monthlyLimit]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      await saveQuota(base, { email: quota.user.email, monthlyLimit: Number(monthly), reason, idempotencyKey: key });
      await reload(); setKey(quotaRequestKey()); setMessage("月额度已保存，本月已用和在途消费保留。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }
  const pending = quota.requests.filter(r => r.state !== "settled");
  return <div className="flex flex-col gap-5">
    <section className={accountCard}><h2 className="mb-4 break-words text-lg font-semibold">{quota.user.name} · {quota.user.email}</h2><QuotaUsage quota={quota}/>
      <form onSubmit={event => void save(event)} className="mt-5 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">每月 Token 额度<input className={accountInput} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value={monthly} onChange={e => {setMonthly(e.target.value); setKey(quotaRequestKey());}} required disabled={busy}/></label>
        <label className="flex flex-col gap-1 text-sm">调整原因<input className={accountInput} value={reason} onChange={e => {setReason(e.target.value); setKey(quotaRequestKey());}} required maxLength={500} disabled={busy}/></label>
        <p className="text-sm text-subtext">配置同时作用于本月和以后月份。设置为 0 将禁止发起新的平台模型请求。</p>
        {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
        <div><Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存月额度"}</Button></div>
      </form>
    </section>
    <section className={accountCard}><h2 className="mb-2 text-lg font-semibold">待确认请求</h2><p className="mb-4 text-sm text-subtext">核实供应商用量后补账；填 0 表示确认未产生用量，不会自动退回不明消费。</p>
      {!pending.length && <p className="text-sm text-subtext">暂无待确认请求</p>}
      {pending.map(request => <ReconcileForm key={request.id} base={base} email={quota.user.email} request={request} reload={reload}/>)}
    </section>
  </div>;
}
function ReconcileForm({ base, email, request, reload }: { base: string; email: string; request: ManagedQuota["requests"][number]; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); setBusy(true); setError("");
    try { await reconcileQuota(base, {email, requestId: request.id, actualTokens: Number(data.actualTokens), reason: String(data.reason)}); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "补账失败"); }
    finally { setBusy(false); }
  }
  return <form onSubmit={e => void submit(e)} className="mt-4 flex flex-col gap-3 border-t border-border pt-4 text-sm"><p className="break-all">{request.period} · {request.model} · {request.id}<br/>上游请求：{request.upstream_request_id || "未返回"} · 预占 {request.reserved.toLocaleString()}</p>
    <label className="flex flex-col gap-1">实际 Token 用量<input className={accountInput} name="actualTokens" type="number" min="0" step="1" max={Number.MAX_SAFE_INTEGER} required disabled={busy}/></label>
    <label className="flex flex-col gap-1">补账依据<input className={accountInput} name="reason" maxLength={500} required disabled={busy}/></label>
    {error && <p role="alert" className="text-accent-red">{error}</p>}<div><Button type="submit" disabled={busy}>确认并补账</Button></div>
  </form>;
}
export function AdminTokenQuotasPage({ initialEmail = "" }: { initialEmail?: string }) {
  const { user } = useAuthSession();
  const accountUrl = useCasesBase();
  const [email, setEmail] = useState(initialEmail); const [selected, setSelected] = useState(initialEmail);
  useEffect(() => {setEmail(initialEmail); setSelected(initialEmail);}, [initialEmail]);
  const result = useQuery({queryKey: ["admin-token-quota", accountUrl, user?.id, selected], queryFn: () => userQuota(accountUrl, selected), enabled: !!selected && user?.isAdmin === true, retry: false});
  return <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"><div className="mx-auto flex max-w-3xl flex-col gap-5"><h1 className="text-2xl font-semibold">用户 Token 额度</h1><p className="text-sm text-subtext">按用户配置每月额度，并核对待确认的模型用量。</p>
    <form onSubmit={e => {e.preventDefault(); const next=email.trim().toLowerCase(); if(next===selected) void result.refetch(); else setSelected(next);}} className="flex flex-wrap items-end gap-3"><label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">用户邮箱<input className={accountInput} type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><Button type="submit">查询用户</Button></form>
    {selected && result.isPending && <p role="status">正在加载额度…</p>}{result.error && <p role="alert" className="text-accent-red">{result.error.message}</p>}
    {result.data && !result.error && <QuotaEditor key={result.data.user.id} base={accountUrl} quota={result.data} reload={result.refetch}/>}
  </div></main>;
}
