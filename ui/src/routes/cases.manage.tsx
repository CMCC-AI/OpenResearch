import { createFileRoute, Navigate } from "@tanstack/react-router";
export const Route = createFileRoute("/cases/manage")({
  validateSearch: (value: Record<string, unknown>): { project?: string } => ({ project: typeof value.project === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.project) ? value.project : undefined }),
  component: Page,
});
function Page() { return <Navigate to="/admin/cases" search={{ project: Route.useSearch().project }} replace />; }
