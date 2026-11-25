import { useState } from "react";
import { CircleStop } from "lucide-react";
import { endResearchStudy } from "../api";
import type { ResearchStudy } from "../research";
import { Button } from "./ui/Button";
import { MenuItem } from "./ui";

/**
 * 结束本轮研究：停止后续自动调度并保留材料、实验、产物与确认记录；
 * 不批准交付、不取消实验。对话卡片只保留确认门，入口放在工作区卡片与研究管理面板。
 */
export function EndResearchControl({ study, version, disabled = false, onDone, variant = "details" }: {
  study: ResearchStudy;
  version: number;
  disabled?: boolean;
  onDone?: () => Promise<unknown> | void;
  /** details 供确认区展开说明；menu 供工作区卡片直接列出。 */
  variant?: "details" | "menu";
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  async function act() {
    setWorking(true); setError(null);
    try { await endResearchStudy(study.id, version); setConfirming(false); await onDone?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  }
  if (variant === "menu") return <div className="flex flex-col">
    {confirming ? <div className="mx-2 my-1 flex flex-col gap-2 rounded-lg border border-accent-amber bg-background p-2 text-xs">
      <span className="text-subtext">结束后专家任务不再自动开始；材料、实验、产物和确认记录保留。不会批准交付或取消实验。</span>
      <span className="flex flex-wrap gap-2"><Button size="small" disabled={working || disabled} onClick={() => void act()}>{working ? "正在结束…" : "确认结束研究"}</Button><Button size="small" variant="ghost" disabled={working} onClick={() => setConfirming(false)}>取消</Button></span>
    </div> : <MenuItem className="min-h-7 py-1" disabled={disabled} onClick={() => setConfirming(true)}>
      <span className="flex items-center gap-4"><CircleStop size={15} />结束本轮研究</span>
    </MenuItem>}
    {error && <p role="alert" className="m-0 px-2 py-1 text-xs text-accent-red">结束失败：{error}</p>}
  </div>;
  return <details className="rounded border border-border p-3">
    <summary className="cursor-pointer text-sm text-subtext">结束本轮研究</summary>
    <p className="my-2 text-sm text-subtext">结束后专家任务不再自动开始，材料、实验、产物和确认记录均保留。这不会批准交付或取消实验；仍有任务、实验或消息在处理时，请先完成或停止后再结束。结束后不能继续修订本轮计划。</p>
    <Button size="small" disabled={working || disabled} onClick={() => void act()}>{working ? "正在结束…" : "确认结束研究"}</Button>
    {error && <p role="alert" className="mt-2 text-sm text-accent-red">结束失败：{error}</p>}
  </details>;
}
