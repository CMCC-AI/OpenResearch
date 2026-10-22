import { useNavigate, useParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Spinner } from "../components/ui";
const SettingsView = lazy(() => import("../components/SettingsPage").then(module => ({ default: module.SettingsView })));
import { useRuntime } from "../RemoteRuntime";
import { isSettingsSection } from "../workspaceState";
import { m } from "../paraglide/messages.js";
import { PlatformFrame } from "./ProductNav";

/** Account settings belong to the workspace, including when it has no projects. */
export function WorkspaceSettingsPage() {
  const { tab } = useParams({ from: "/settings/$tab" });
  const navigate = useNavigate();
  const runtime = useRuntime();
  if (!isSettingsSection(tab) || tab === "git") return null;
  return (
    <PlatformFrame title={tab === "compute" || tab === "instances" ? m.settings_page_compute() : m.settings_page_settings()}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={<div role="status" className="flex h-full items-center justify-center"><Spinner /></div>}>
        <SettingsView
          tab={tab}
          project={null}
          remote={runtime.kind === "ssh"}
          onProjectUpdate={() => {}}
          onSelectTab={(next) => { void navigate({ to: "/settings/$tab", params: { tab: next } }); }}
        />
        </Suspense>
      </div>
    </PlatformFrame>
  );
}
