import { createFileRoute, notFound } from "@tanstack/react-router";
import { isSettingsSection } from "../workspaceState";

export const Route = createFileRoute("/projects/$projectId/settings/$tab")({
  beforeLoad: ({ params }) => { if (!isSettingsSection(params.tab)) throw notFound(); },
});
