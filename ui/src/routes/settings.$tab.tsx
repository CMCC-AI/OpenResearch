import { createFileRoute, notFound } from "@tanstack/react-router";
import { isSettingsSection } from "../workspaceState";
import { WorkspaceSettingsPage } from "../product/WorkspaceSettingsPage";

export const Route = createFileRoute("/settings/$tab")({
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.tab) || params.tab === "git") throw notFound();
  },
  component: WorkspaceSettingsPage,
});
