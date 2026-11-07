/** Static historical citations have no live/private executor fallback. */
export interface MetricCitation {
  selection: { evidenceId: string; name: string; split: string; step: number };
  snapshotSha256: string; reportSha256: string; runId: string; experimentId: string;
  commitSha: string; sourceSha256: string; unit: string; value: number;
  measuredAt: number; registeredAt: number; producerVersion: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const label = (v: unknown, limit: number): v is string => typeof v === "string" && !!v.trim() && new TextEncoder().encode(v).length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function parseMetricCitation(value: unknown): MetricCitation | null {
  if (!object(value) || !object(value.selection)) return null;
  const s = value.selection;
  if (typeof s.evidenceId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s.evidenceId)
    || !label(s.name, 128) || !label(s.split, 128) || !Number.isSafeInteger(s.step) || (s.step as number) < 0
    || !hash(value.snapshotSha256) || !hash(value.reportSha256) || !hash(value.sourceSha256)
    || typeof value.commitSha !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value.commitSha)
    || !label(value.unit, 64) || typeof value.value !== "number" || !Number.isFinite(value.value)
    || !label(value.runId, 256) || !label(value.experimentId, 256) || !label(value.producerVersion, 128)
    || !Number.isSafeInteger(value.measuredAt) || (value.measuredAt as number) < 0 || (value.measuredAt as number) > 8640000000000000
    || !Number.isSafeInteger(value.registeredAt) || (value.registeredAt as number) < 0 || (value.registeredAt as number) > 8640000000000000) return null;
  return value as unknown as MetricCitation;
}
