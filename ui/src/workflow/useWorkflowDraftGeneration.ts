// AI 排流程的生成编排：一句话 → 阶段进度 → 流式节点预览 → 一次成稿。
// 状态挂在编排页（而不是小弹层）上，切到别的标签再回来不会丢掉正在跑的生成。
import { useCallback, useEffect, useRef, useState } from "react";
import { generateWorkflowDraft } from "../api";
import { createClientTurnId } from "../clientTurnId";
import { onWorkflowDraftDelta, onWorkflowDraftProgress, type WorkflowDraftStage } from "../events";
import { useLocale } from "../locale";
import {
  generatedToDraftInput,
  parsePartialTasks,
  type WorkflowDraftInput,
  type WorkflowTask,
} from "./model";

/** 生成状态条的阶段与文案；key 与后端 workflowDraft.progress 的 stage 一一对应。 */
export const WORKFLOW_DRAFT_STAGES = [
  { key: "inventory", label: "整理可用的专家" },
  { key: "engine", label: "启动生成引擎" },
  { key: "writing", label: "AI 正在编排流程" },
  { key: "reviewing", label: "检查并整理草稿" },
] as const;

export interface WorkflowDraftGeneration {
  running: boolean;
  stage: WorkflowDraftStage;
  /** 已等待秒数，生成期间每秒刷新。 */
  elapsed: number;
  /** 流式到达、已能解析出完整字段的任务；为空时画布保持原样。 */
  previewTasks: WorkflowTask[];
  start: (intent: string) => void;
  stop: () => void;
}

export function useWorkflowDraftGeneration(options: {
  onGenerated: (draft: WorkflowDraftInput) => void;
  onError: (message: string) => void;
}): WorkflowDraftGeneration {
  const locale = useLocale();
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<WorkflowDraftStage>("inventory");
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [previewTasks, setPreviewTasks] = useState<WorkflowTask[]>([]);
  // 当前请求标识与取消句柄：新请求会顶掉旧请求，迟到的结果一律忽略。
  const requestRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 回调放进 ref：调用方每次渲染新建函数，不该因此重开请求。
  const callbacks = useRef(options);
  callbacks.current = options;

  // 生成期间每秒刷新计时；结束即停。
  useEffect(() => {
    if (!running) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  // 卸载时取消还在跑的生成，服务端随之收尾。
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback((intent: string) => {
    abortRef.current?.abort();
    const requestId = createClientTurnId();
    const controller = new AbortController();
    requestRef.current = requestId;
    abortRef.current = controller;
    setStage("inventory");
    setStartedAt(Date.now());
    setElapsed(0);
    setPreviewTasks([]);
    setRunning(true);

    const active = (id: string) => requestRef.current === id;
    const unsubscribeProgress = onWorkflowDraftProgress((event) => {
      if (active(event.requestId)) setStage(event.stage);
    });
    // 同一帧内的多个快照只解析最后一个：每次都是按累计文本重算，丢中间态没有影响。
    let pending: string | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (pending === null) return;
      const text = pending;
      pending = null;
      if (active(requestId)) setPreviewTasks(parsePartialTasks(text));
    };
    const unsubscribeDelta = onWorkflowDraftDelta((event) => {
      if (!active(event.requestId)) return;
      pending = event.text;
      if (!frame) frame = window.requestAnimationFrame(flush);
    });

    void generateWorkflowDraft({ intent, locale, requestId }, controller.signal)
      .then((generated) => {
        if (active(requestId)) callbacks.current.onGenerated(generatedToDraftInput(generated));
      })
      .catch((error) => {
        // 用户主动停止或已被新请求顶掉：安静收尾，不弹错误。
        if (controller.signal.aborted || !active(requestId)) return;
        callbacks.current.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (requestRef.current !== requestId) return;
        unsubscribeProgress();
        unsubscribeDelta();
        if (frame) window.cancelAnimationFrame(frame);
        requestRef.current = null;
        abortRef.current = null;
        setRunning(false);
        setPreviewTasks([]);
      });
  }, [locale]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { running, stage, elapsed, previewTasks, start, stop };
}
