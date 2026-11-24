import { lazy, Suspense } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlatformFrame } from "../product/ProductNav";

// 工作室（画布/AI 生成/能力库）只在 /workflows 路由需要；懒加载让主入口
// 不背这块体积，CI 的 UI entry budget 才守得住。
const WorkflowStudio = lazy(() => import("../workflow/WorkflowStudio").then((module) => ({ default: module.WorkflowStudio })));

export const Route = createFileRoute("/workflows")({ component: WorkflowPage });

function WorkflowPage() {
  const navigate = useNavigate();
  // 不带页头横幅：工具栏和画布直接顶到框架顶部；列表视图的标题由工作流库自己渲染。
  return <PlatformFrame>
    <div className="min-h-0 flex-1"><Suspense fallback={<div role="status" className="flex h-full items-center justify-center text-sm text-subtext">正在打开工作流…</div>}><WorkflowStudio onOpenSession={(sessionId, projectId) => {
      void navigate({ to: "/projects/$projectId/tasks/$sessionId", params: { projectId, sessionId } });
    }} onOpenChats={() => void navigate({ to: "/projects" })} /></Suspense></div>
  </PlatformFrame>;
}
