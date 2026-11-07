import { MetricCitationSource } from "./MetricCitationSource";
import { MaterialCitationSource } from "./MaterialCitationSource";
import { getReadOnlyApi } from "../readOnlyApi";
import type { ResearchStudy } from "../research";

/** Keep immutable statements visible while separating the current evidence set. */
export function ResearchEvidence({ study }: { study: ResearchStudy }) {
  if (!study.claims.length) return null;
  const changes = new Map((study.claimChanges ?? []).map(change => [change.claimId, change]));
  const activeIds = study.activeClaimIds ? new Set(study.activeClaimIds) : null;
  const current = study.claims.filter(claim => activeIds ? activeIds.has(claim.id) : !changes.has(claim.id));
  const history = study.claims.filter(claim => !current.includes(claim));
  const statement = (claim: ResearchStudy["claims"][number]) => <div key={claim.id} className="mt-2 min-w-0 border-t border-border py-2 text-sm">
    <p className="break-words">{claim.text}</p>
    <p className="break-words text-xs text-subtext">{claim.support === "experiment" ? "实验关联证据" : claim.support === "paper" ? "论文原文声明" : "推测"} · {claim.source} {claim.location}</p>
    <p className="break-all text-xs text-muted">声明：{claim.id}</p>
    {claim.materialCitation && <MaterialCitationSource key={`${study.id}:${claim.id}:${claim.materialCitation.readEventId}:${getReadOnlyApi()?.id ?? "live"}`} citation={claim.materialCitation} />}
    {claim.metricCitation != null && <MetricCitationSource citation={claim.metricCitation} />}
    {claim.excerpt && <pre className="mt-1 whitespace-pre-wrap break-words text-xs">{claim.excerpt}</pre>}
  </div>;
  return <section aria-label="证据声明" className="space-y-2">
    {study.evidenceReviewRequired && <p role="status" className="rounded-lg border border-accent-amber bg-accent-amber-subtle p-3 text-sm text-accent-amber">证据已修订，需要主理人修订计划、重新独立审查，再申请交付确认。</p>}
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">当前证据声明（{current.length}）</summary>
      {current.length ? current.map(statement) : <p className="mt-2 text-sm text-subtext">当前没有有效声明，历史声明仅供审计。</p>}
    </details>
    {history.length > 0 && <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">历史声明（{history.length}）· 不参与当前交付</summary>
      {history.map(claim => {
        const change = changes.get(claim.id);
        return <div key={claim.id}>
          {statement(claim)}
          <p className="break-words text-xs text-subtext">{change?.action === "replaced" ? "已替代" : "已撤回"}{change && ` · r${change.revision} · 原因：${change.reason}`}</p>
          {change && <p className="break-all text-xs text-muted">修订会话：{change.actorSessionId} · 计划 v{change.planVersion}</p>}
          {change?.replacementId && <p className="break-all text-xs text-subtext">替代声明：{change.replacementId}</p>}
        </div>;
      })}
    </details>}
  </section>;
}
