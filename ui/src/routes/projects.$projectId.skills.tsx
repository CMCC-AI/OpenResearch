import { createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/skills")({
  beforeLoad: () => { throw notFound(); },
});
