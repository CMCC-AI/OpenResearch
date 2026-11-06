import type { MaterialPackage } from "./materialReader";
import { projectRequest } from "./readOnlyApi";
import { readPreviewResponse } from "./previewText";

export interface CoverageFilter { source?: string; session?: string; study?: string }
export interface CoverageGroup {
  scope: { packageId: string; source: string; path: string; sha256: string; format: "text" | "notebook" | "pdf";
    studyId: string | null; planVersion: number | null; taskId: string | null; taskSessionId: string | null;
    conversationId: string | null; inPlanInputs: boolean | null; page: number | null;
    view: { parser: string; parserVersion: string | null; executableSha256: string | null; viewRevision: string; textSha256: string } };
  ranges: [number, number][]; coveredLines: number; viewTotalLines: number; producerVersions: string[];
}
export interface MaterialCoverage {
  schemaVersion: 1; projectId: string; packageId: string; source: string | null; session: string | null; study: string | null;
  measuredAt: number; coverage: { groups: CoverageGroup[]; consideredEvents: number; excluded: Record<string, number>; meaning: string };
}
export const exclusionLabels: Record<string, string> = {
  readFailed: "读取失败", outputPending: "输出待确认", outputFailed: "输出失败", invalidReceipt: "回执无效",
  invalidOrEmptySelection: "选区无效或为空", unknownView: "旧记录或解析身份未知",
};
function invalid(): never { throw new Error("读取范围记录的来源、范围或版本不一致，无法展示。请刷新或检查后端版本。"); }
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const integer = (v: unknown, minimum = 0): v is number => Number.isSafeInteger(v) && Number(v) >= minimum;
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const nullableId = (v: unknown) => v === null || (typeof v === "string" && v.length > 0 && v.length <= 200);

export function coverageUrl(id: string, filter: CoverageFilter = {}) {
  const query = new URLSearchParams();
  for (const name of ["source", "session", "study"] as const) if (filter[name]) query.set(name, filter[name]);
  query.sort();
  return `/api/materials/${encodeURIComponent(id)}/coverage${query.size ? `?${query}` : ""}`;
}

/** Reject partial or mismatched unions instead of displaying a plausible coverage figure. */
export function parseMaterialCoverage(input: unknown, material: MaterialPackage, filter: CoverageFilter = {}): MaterialCoverage {
  const data = object(input), coverage = object(data.coverage), excluded = object(coverage.excluded);
  if (data.schemaVersion !== 1 || data.projectId !== material.projectId || data.packageId !== material.id
    || !integer(data.measuredAt) || !integer(coverage.consideredEvents) || coverage.consideredEvents > 10_000
    || !Array.isArray(coverage.groups) || coverage.groups.length > 512 || typeof coverage.meaning !== "string" || coverage.meaning.length > 2048) invalid();
  for (const name of ["source", "session", "study"] as const) if (data[name] !== (filter[name] ?? null)) invalid();
  if (filter.source && !material.files.some(file => file.id === filter.source)) invalid();
  let excludedCount = 0;
  for (const [reason, count] of Object.entries(excluded)) {
    if (!Object.hasOwn(exclusionLabels, reason) || !integer(count)) invalid();
    excludedCount += Number(count);
  }
  if (excludedCount > Number(coverage.consideredEvents)) invalid();
  const eligible = Number(coverage.consideredEvents) - excludedCount;
  const seen = new Set<string>();
  let totalRanges = 0, totalVersions = 0;
  for (const inputGroup of coverage.groups as unknown[]) {
    const group = object(inputGroup), scope = object(group.scope), view = object(scope.view);
    const file = material.files.find(file => file.id === scope.source);
    if (!file || scope.packageId !== material.id || scope.path !== file.path || scope.sha256 !== file.sha256
      || scope.format !== file.format || (filter.study && scope.studyId !== filter.study) || !hash(scope.sha256) || (filter.source && scope.source !== filter.source)
      || !["text", "pdf", "notebook"].includes(String(scope.format))
      || !integer(group.viewTotalLines, 1) || !integer(group.coveredLines, 1) || Number(group.coveredLines) > Number(group.viewTotalLines)
      || !Array.isArray(group.ranges) || !group.ranges.length || group.ranges.length > 10_000
      || !Array.isArray(group.producerVersions) || !group.producerVersions.length || group.producerVersions.length > 10_000) invalid();
    for (const field of ["studyId", "taskId", "taskSessionId", "conversationId"]) if (!nullableId(scope[field])) invalid();
    if (scope.planVersion !== null && !integer(scope.planVersion)) invalid();
    if (scope.inPlanInputs !== null && typeof scope.inPlanInputs !== "boolean") invalid();
    if (scope.format === "pdf" ? !integer(scope.page, 1) : scope.page !== null) invalid();
    if (view.viewRevision !== "numbered-lines-v1" || !hash(view.textSha256)) invalid();
    if (scope.format === "pdf") {
      if (view.parser !== "pdftotext-layout" || typeof view.parserVersion !== "string" || !view.parserVersion.length || view.parserVersion.length > 64 || !hash(view.executableSha256)) invalid();
    } else if (view.parser !== (scope.format === "text" ? "utf8-lines" : "ipynb-cells") || view.parserVersion !== null || view.executableSha256 !== null) invalid();
    const identity = JSON.stringify([scope.packageId, scope.source, scope.sha256, scope.studyId, scope.planVersion, scope.taskId,
      scope.taskSessionId, scope.conversationId, scope.inPlanInputs, scope.page, view.parser, view.parserVersion, view.executableSha256, view.viewRevision, view.textSha256]);
    if (seen.has(identity)) invalid();
    seen.add(identity);
    let last = -1, covered = 0;
    for (const range of group.ranges as unknown[]) {
      if (!Array.isArray(range) || range.length !== 2 || !integer(range[0], 1) || !integer(range[1], range[0])
        || range[1] > Number(group.viewTotalLines) || range[0] <= last || range[0] - last === 1) invalid();
      covered += Number(range[1]) - Number(range[0]) + 1;
      last = Number(range[1]);
    }
    if (covered !== group.coveredLines) invalid();
    const versions = group.producerVersions as unknown[];
    if (versions.some(version => typeof version !== "string" || !version.length || version.length > 64) || new Set(versions).size !== versions.length) invalid();
    totalRanges += (group.ranges as unknown[]).length;
    totalVersions += versions.length;
  }
  if ((coverage.groups as unknown[]).length > eligible || totalRanges > eligible || totalVersions > eligible) invalid();
  return input as MaterialCoverage;
}

export async function loadMaterialCoverage(material: MaterialPackage, filter: CoverageFilter, signal: AbortSignal) {
  const response = await projectRequest(coverageUrl(material.id, filter), { signal, cache: "no-store" });
  const { bytes, truncated } = await readPreviewResponse(response, 2 * 1024 * 1024);
  signal.throwIfAborted();
  if (truncated) throw new Error("读取范围响应超过 2 MiB，请按文件或会话缩小范围；未展示部分汇总。");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("无法解析读取范围，请检查后端版本后重试。"); }
  if (!response.ok) {
    if (response.status === 404) throw new Error("此后端或案例快照尚未提供读取范围，不能据此判断 Agent 是否已读。");
    const detail = object(value).error;
    throw new Error(typeof detail === "string" ? detail.slice(0, 2048) : `读取范围查询失败（HTTP ${response.status}）`);
  }
  return parseMaterialCoverage(value, material, filter);
}
