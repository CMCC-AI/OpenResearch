import { createFileRoute, redirect } from "@tanstack/react-router";

// Compatibility for bookmarks and persisted locations; research results live in the main conversation.
export const Route = createFileRoute("/projects/$projectId/deliverables")({
  beforeLoad: ({ params }) => { throw redirect({ to: "/projects/$projectId", params: { projectId: params.projectId }, replace: true }); },
});
