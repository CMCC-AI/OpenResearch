import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getWorkspaceGeneration, subscribeWorkspace } from "../queries/client";
import type { MaterialPackage } from "../materialReader";
import { exclusionLabels, loadMaterialCoverage, type CoverageGroup, type MaterialCoverage } from "../materialReadCoverage";
import { useReadOnlyWorkspace } from "./ReadOnlyWorkspace";
import { Button, Spinner } from "./ui";

const pageSize = 25;
export function MaterialReadCoverage({ material, sessionId }: { material: MaterialPackage; sessionId?: string }) {
  const readOnly = useReadOnlyWorkspace();
  const generation = useSyncExternalStore(subscribeWorkspace, getWorkspaceGeneration);
  const [source, setSource] = useState("");
  const [currentOnly, setCurrentOnly] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ key: string; value?: MaterialCoverage; error?: string } | null>(null);
  const materialVersion = useMemo(() => JSON.stringify(material.files.map(file => [file.id, file.path, file.sha256, file.format])), [material.files]);
  const filteredSession = currentOnly && !readOnly ? sessionId : undefined;
  const key = JSON.stringify([material.id, materialVersion, source, filteredSession, generation, readOnly?.caseId, attempt]);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setPage(0);
    void loadMaterialCoverage(material, { source: source || undefined, session: filteredSession }, controller.signal)
      .then(value => { if (!disposed) setResult({ key, value }); })
      .catch(error => { if (!disposed) setResult({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => { disposed = true; controller.abort(); };
  }, [key, material, source, filteredSession]);
  const active = result?.key === key ? result : null;
  const value = active?.value;
  const groups = value?.coverage.groups ?? [];
  const lastPage = Math.max(0, Math.ceil(groups.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  return <section aria-label="读取范围记录" className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex flex-col gap-2 border-b border-border p-3 text-xs text-subtext">
        <p className="m-0">仅表示 CLI 已向 Agent 输出选区，不证明理解或审查。网页预览、下载及其他工具读取不计入记录；不同任务、计划和解析视图分别展示。</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2">文件<select aria-label="筛选读取记录的文件" className="min-w-0 flex-1 rounded-md border border-border bg-background p-1.5 text-text" value={source} onChange={event => setSource(event.target.value)}><option value="">整个材料包</option>{material.files.map(file => <option key={file.id} value={file.id}>{file.path}</option>)}</select></label>
          {sessionId && !readOnly && <label className="flex items-center gap-1.5"><input type="checkbox" checked={currentOnly} onChange={event => setCurrentOnly(event.target.checked)} />仅当前会话</label>}
          <Button size="small" onClick={() => setAttempt(value => value + 1)}>{readOnly ? "重新读取快照" : "刷新读取范围"}</Button>
        </div>
        {readOnly && <p className="m-0">此处为案例发布时保存的记录，不查询私人执行器。案例缺少记录时无法推断是否已读。</p>}
      </div>
      <div className="p-4">
        {!active ? <p role="status" className="flex items-center gap-2 text-sm text-subtext"><Spinner />正在汇总读取范围…</p>
          : active.error ? <div role="alert" className="text-sm text-subtext"><p>{active.error}</p><p>{readOnly ? "可选择已复制的单个文件记录；旧快照缺少记录时需由发布者更新。" : "可选择单个文件或当前会话缩小范围。"}查询失败不等于没有读取记录。</p><Button size="small" onClick={() => setAttempt(value => value + 1)}>重试读取范围</Button></div>
            : value && <>
              <p className="mt-0 text-sm text-subtext">检查 {value.coverage.consideredEvents} 条回执 · {groups.length} 组输出范围 · 查询时间 {new Date(value.measuredAt).toLocaleString("zh-CN")}</p>
              {Object.entries(value.coverage.excluded).length > 0 && <div className="mb-4 rounded-md border border-border p-3 text-xs text-subtext"><p className="mb-1 mt-0">以下记录未计入输出范围：</p><ul className="m-0 list-inside list-disc p-0">{Object.entries(value.coverage.excluded).map(([reason, count]) => <li key={reason}>{exclusionLabels[reason]}：{count}</li>)}</ul></div>}
              {!groups.length ? <p role="status" className="text-sm text-subtext">{value.coverage.consideredEvents === 0 ? "尚无此范围内登记的 CLI 读取记录。" : "没有可汇总的已确认输出范围。"} 这不能证明 Agent 未通过其他工具读取。</p>
                : <ul className="m-0 list-none space-y-3 p-0">{groups.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((group, index) => <CoverageRow key={`${currentPage}:${index}`} group={group} />)}</ul>}
            </>}
      </div>
    </div>
    {groups.length > pageSize && <nav aria-label="读取范围分页" className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3 text-xs text-subtext"><Button size="small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage + 1} / {lastPage + 1} 页 · 每页 {pageSize} 组</span><Button size="small" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一页</Button></nav>}
  </section>;
}

export function CoverageRow({ group }: { group: CoverageGroup }) {
  const scope = group.scope;
  const context = scope.taskId ? `任务 ${scope.taskId}` : scope.conversationId ? `会话 ${scope.conversationId}` : "终端调用 · 未关联会话";
  const plan = scope.planVersion == null ? "未关联计划" : scope.planVersion === 0 ? "尚无计划" : `计划 v${scope.planVersion}`;
  const ranges = group.ranges.map(([first, last]) => first === last ? `${first}` : `${first}–${last}`);
  return <li className="rounded-md border border-border p-3 text-sm">
    <h3 className="mb-1 mt-0 break-words text-sm font-medium">{scope.path} · {scope.source}</h3>
    <p className="my-1 break-all text-xs text-subtext">{context} · {plan}{scope.studyId ? ` · 研究 ${scope.studyId}` : ""}</p>
    <p className="my-2">{scope.page == null ? scope.format === "notebook" ? "Notebook 只读视图" : "文本解析视图" : `PDF 第 ${scope.page} 页解析视图`}：已确认输出 {group.coveredLines} / {group.viewTotalLines} 行</p>
    {scope.format === "pdf" && <p className="my-1 text-xs text-subtext">仅针对这一页，不代表整篇 PDF 的覆盖率。</p>}
    <p className="my-1 break-words text-xs text-subtext">行范围：{ranges.slice(0, 6).join("、")}{ranges.length > 6 ? `…（共 ${ranges.length} 段）` : ""}</p>
    <details className="mt-2 text-xs text-subtext"><summary className="cursor-pointer">全部范围与依据</summary><dl className="space-y-1 break-all"><div>全部行范围：{ranges.join("、")}</div><div>原件 SHA-256：{scope.sha256}</div><div>解析器：{scope.view.parser}{scope.view.parserVersion ? ` · ${scope.view.parserVersion}` : ""}</div><div>解析视图：{scope.view.viewRevision} · {scope.view.textSha256}</div>{scope.view.executableSha256 && <div>工具 SHA-256：{scope.view.executableSha256}</div>}<div>输出工具版本：{group.producerVersions.join("、")}</div>{scope.taskSessionId && <div>任务会话：{scope.taskSessionId}</div>}<div>属于当时计划输入：{scope.inPlanInputs === null ? "未记录" : scope.inPlanInputs ? "是" : "否"}</div></dl></details>
  </li>;
}
