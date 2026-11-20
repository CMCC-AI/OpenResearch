import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlatformFrame } from "../product/ProductNav";
import { WorkflowStudio } from "../workflow/WorkflowStudio";

export const Route = createFileRoute("/workflows")({ component: WorkflowPage });

function WorkflowPage() {
  const navigate = useNavigate();
  // 不带页头横幅：工具栏和画布直接顶到框架顶部；列表视图的标题由工作流库自己渲染。
  return <PlatformFrame>
    <div className="min-h-0 flex-1"><WorkflowStudio onOpenSession={(sessionId, projectId) => {
      void navigate({ to: "/projects/$projectId/tasks/$sessionId", params: { projectId, sessionId } });
    }} onOpenChats={() => void navigate({ to: "/projects" })} /></div>
  </PlatformFrame>;
}
