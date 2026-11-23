import { useCasesBase } from "./FeaturedCases";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Gauge, Search, Sparkles, Clock } from "lucide-react";
import { Badge, Button, Input } from "../components/ui";
import { useAuthSession } from "./AuthSession";
import { QuotaUsage } from "./PersonalSettingsPage";
import {
  quotaRequestKey,
  reconcileQuota,
  saveQuota,
  userQuota,
  type ManagedQuota,
} from "./tokenQuotaApi";

function QuotaEditor({
  base,
  quota,
  reload,
}: {
  base: string;
  quota: ManagedQuota;
  reload: () => Promise<unknown>;
}) {
  const [monthly, setMonthly] = useState(String(quota.monthlyLimit));
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(quotaRequestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setMonthly(String(quota.monthlyLimit));
  }, [quota.monthlyLimit]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await saveQuota(base, {
        email: quota.user.email,
        monthlyLimit: Number(monthly),
        reason,
        idempotencyKey: key,
      });
      await reload();
      setKey(quotaRequestKey());
      setReason("");
      setMessage("月额度已保存，本月已用和在途消费保留。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const pending = quota.requests.filter((r) => r.state !== "settled");
  const initial = (quota.user.name || quota.user.email || "?").trim().slice(0, 1).toUpperCase();
  const parsedMonthly = Number(monthly);

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border border-border bg-background p-5 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border-variant pb-4">
          <div className="flex items-center gap-3 min-w-0">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-sm font-semibold text-primary"
            >
              {initial}
            </span>
            <div className="min-w-0">
              <h2 className="m-0 truncate text-base font-semibold text-text">
                {quota.user.name}
              </h2>
              <p className="m-0 truncate font-mono text-xs text-subtext">
                {quota.user.email}
              </p>
            </div>
          </div>
          <Badge size="small">账期 {quota.period}</Badge>
        </div>

        <QuotaUsage quota={quota} />

        <form
          onSubmit={(event) => void save(event)}
          className="mt-6 flex flex-col gap-4 border-t border-border-variant pt-5"
        >
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
              <span className="flex items-center justify-between gap-2">
                <span>每月 Token 额度</span>
                {Number.isFinite(parsedMonthly) && parsedMonthly >= 0 && (
                  <span className="font-mono text-xs font-normal text-subtext tabular-nums">
                    {parsedMonthly.toLocaleString()} tokens
                  </span>
                )}
              </span>
              <Input
                type="number"
                min="0"
                max={Number.MAX_SAFE_INTEGER}
                step="1"
                value={monthly}
                onChange={(e) => {
                  setMonthly(e.target.value);
                  setKey(quotaRequestKey());
                }}
                required
                disabled={busy}
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
              <span>调整原因</span>
              <Input
                value={reason}
                placeholder="例如：科研项目扩容 / 月度重置"
                onChange={(e) => {
                  setReason(e.target.value);
                  setKey(quotaRequestKey());
                }}
                required
                maxLength={500}
                disabled={busy}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border-variant bg-surface/60 px-3 py-2 text-xs text-subtext">
            <Sparkles size={14} className="shrink-0 text-primary" />
            <span>
              配置同时作用于本月和以后月份；设为 0 将禁止发起新的平台付费模型请求。OpenCode 官方免费模型不消耗此额度。
            </span>
          </div>

          {error && (
            <p role="alert" className="m-0 rounded-lg border border-danger-notice-border bg-accent-red-subtle px-3 py-2 text-xs text-accent-red">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="m-0 rounded-lg border border-accent-green/40 bg-accent-green-subtle/60 px-3 py-2 text-xs text-text">
              {message}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "正在保存…" : "保存月额度"}
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-border bg-background p-5 shadow-xs">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-base font-semibold text-text">待确认请求</h2>
            <p className="mb-0 mt-1 text-xs text-subtext">
              核实供应商用量后补账；填 0 表示确认未产生用量，不会自动退回不明消费。
            </p>
          </div>
          <Badge size="small" variant={pending.length > 0 ? "warning" : "default"}>
            {pending.length} 条待核实
          </Badge>
        </div>

        {!pending.length ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-border-variant bg-surface/40 px-4 py-5 text-sm text-subtext">
            <CheckCircle2 size={16} className="text-accent-green" />
            <span>暂无待确认请求</span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {pending.map((request) => (
              <ReconcileForm
                key={request.id}
                base={base}
                email={quota.user.email}
                request={request}
                reload={reload}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ReconcileForm({
  base,
  email,
  request,
  reload,
}: {
  base: string;
  email: string;
  request: ManagedQuota["requests"][number];
  reload: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    try {
      await reconcileQuota(base, {
        email,
        requestId: request.id,
        actualTokens: Number(data.actualTokens),
        reason: String(data.reason),
      });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "补账失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 rounded-lg border border-border-variant bg-surface/40 p-4 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{request.model}</span>
            <Badge size="small" variant="warning">{request.state}</Badge>
          </div>
          <p className="mb-0 mt-1 break-all font-mono text-xs text-subtext">
            {request.period} · 请求 {request.id} · 上游：{request.upstream_request_id || "未返回"}
          </p>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border-variant bg-background px-2.5 py-1 text-xs tabular-nums text-text">
          <Clock size={12} className="text-muted" />
          <span>预占 {request.reserved.toLocaleString()}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          实际 Token 用量
          <Input
            name="actualTokens"
            type="number"
            min="0"
            step="1"
            max={Number.MAX_SAFE_INTEGER}
            required
            disabled={busy}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          补账依据
          <Input
            name="reason"
            maxLength={500}
            placeholder="例如：上游账单核对结果"
            required
            disabled={busy}
          />
        </label>
      </div>

      {error && (
        <p role="alert" className="m-0 text-xs text-accent-red">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="small" variant="primary" disabled={busy}>
          {busy ? "处理中…" : "确认并补账"}
        </Button>
      </div>
    </form>
  );
}

export function AdminTokenQuotasPage({
  initialEmail = "",
}: {
  initialEmail?: string;
}) {
  const { user } = useAuthSession();
  const accountUrl = useCasesBase();
  const [email, setEmail] = useState(initialEmail);
  const [selected, setSelected] = useState(initialEmail);

  useEffect(() => {
    setEmail(initialEmail);
    setSelected(initialEmail);
  }, [initialEmail]);

  const result = useQuery({
    queryKey: ["admin-token-quota", accountUrl, user?.id, selected],
    queryFn: () => userQuota(accountUrl, selected),
    enabled: !!selected && user?.isAdmin === true,
    retry: false,
  });

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-6 py-7 max-md:px-4">
      <div className="mx-auto flex max-w-290 flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-tight text-text">Token 额度</h1>
          <p className="m-0 text-sm text-subtext">
            按用户邮箱查询并配置每月 Token 额度，核对待确认的模型请求用量。
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const next = email.trim().toLowerCase();
            if (next === selected) void result.refetch();
            else setSelected(next);
          }}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-xs"
        >
          <div className="relative min-w-60 flex-1">
            <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              aria-label="用户邮箱"
              type="email"
              placeholder="输入用户邮箱，例如 researcher@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 ps-9"
              required
            />
          </div>
          <Button type="submit" variant="primary">
            查询用户
          </Button>
        </form>

        {!selected && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background/60 px-6 py-12 text-center">
            <Gauge size={28} className="text-muted" />
            <p className="m-0 text-sm font-medium text-text">输入用户邮箱以管理额度</p>
            <p className="m-0 text-xs text-subtext">
              也可以从「用户管理」列表右侧直接点击对应用户的「Token 额度」快捷进入。
            </p>
          </div>
        )}

        {selected && result.isPending && (
          <p role="status" className="text-sm text-subtext">
            正在加载额度…
          </p>
        )}

        {result.error && (
          <p role="alert" className="m-0 rounded-xl border border-danger-notice-border bg-accent-red-subtle px-4 py-3 text-sm text-accent-red">
            {result.error.message}
          </p>
        )}

        {result.data && !result.error && (
          <QuotaEditor
            key={result.data.user.id}
            base={accountUrl}
            quota={result.data}
            reload={result.refetch}
          />
        )}
      </div>
    </main>
  );
}
