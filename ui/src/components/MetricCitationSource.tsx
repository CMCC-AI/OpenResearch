import { parseMetricCitation } from "../metricCitation";

export function MetricCitationSource({ citation }: { citation: unknown }) {
  const metric = parseMetricCitation(citation);
  if (!metric) return <p role="status" className="mt-2 text-xs text-accent-amber">指标引用信息不完整，无法展示。</p>;
  return <div aria-label="指标登记来源" className="mt-2 min-w-0 rounded-lg border border-border p-3 text-xs">
    <p className="break-words font-medium">{metric.selection.name} · {metric.selection.split} · step {metric.selection.step}</p>
    <p className="break-words">登记值：{String(metric.value)} · 单位：{metric.unit}</p>
    <p className="mt-1 break-all text-subtext">登记：{metric.selection.evidenceId} · Run：{metric.runId}</p>
    <details className="mt-1 text-subtext"><summary className="cursor-pointer">核验身份</summary>
      <p className="break-all">登记快照 SHA-256：{metric.snapshotSha256}</p>
      <p className="break-all">报告 SHA-256：{metric.reportSha256}</p>
      <p className="break-all">代码：{metric.commitSha} · {metric.sourceSha256}</p>
      <p className="break-words">核验时间：{new Date(metric.measuredAt).toISOString()} · 生产者：{metric.producerVersion}</p>
    </details>
    <p className="mt-2 break-words text-subtext">历史核验记录；关联由报告生产者声明，仍需独立审查。登记不证明运行时使用了这些输入。</p>
  </div>;
}
