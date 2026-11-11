import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlatformFrame } from "../product/ProductNav";
import { WorkflowStudio } from "../workflow/WorkflowStudio";

export const Route = createFileRoute("/workflows")({ component: WorkflowPage });

function WorkflowPage() {
  const navigate = useNavigate();
  return <PlatformFrame title="工作流编排">
    <div className="min-h-0 flex-1"><WorkflowStudio onOpenSession={(sessionId, projectId) => {
      void navigate({ to: "/projects/$projectId/tasks/$sessionId", params: { projectId, sessionId } });
    }} /></div>
  </PlatformFrame>;
}
