import { createFileRoute, redirect } from "@tanstack/react-router";

// Compatibility for bookmarks and persisted locations; no blank workspace page.
export const Route = createFileRoute("/projects/$projectId/tasks/new")({
  beforeLoad: ({ params }) => { throw redirect({ to: "/projects", search: { project: params.projectId }, replace: true }); },
});
