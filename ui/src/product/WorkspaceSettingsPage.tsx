import { useNavigate, useParams } from "@tanstack/react-router";
import { lazy, Suspense, type ReactNode } from "react";
import { Spinner } from "../components/ui";
const SettingsView = lazy(() => import("../components/SettingsPage").then(module => ({ default: module.SettingsView })));
import { useRuntime } from "../RemoteRuntime";
import { isSettingsSection } from "../workspaceState";
import { m } from "../paraglide/messages.js";
import { PersonalSettingsFrame } from "./PersonalSettingsPage";
import { useOptionalAuthSession } from "./AuthSession";
import { PlatformFrame } from "./ProductNav";

/** Account settings belong to the workspace, including when it has no projects. */
export function WorkspaceSettingsPage() {
  const { tab } = useParams({ from: "/settings/$tab" });
  const navigate = useNavigate();
  const runtime = useRuntime();
  const session = useOptionalAuthSession();
  if (!isSettingsSection(tab) || tab === "git") return null;
  const personal = Boolean(session?.user) && tab !== "compute" && tab !== "instances";
  const wrap = (children: ReactNode) => personal
    ? <PersonalSettingsFrame>{children}</PersonalSettingsFrame>
    : <PlatformFrame title={tab === "compute" || tab === "instances" ? m.settings_page_compute() : m.settings_page_settings()}><div className="min-h-0 flex-1 overflow-y-auto">{children}</div></PlatformFrame>;
  return wrap(
        <Suspense fallback={<div role="status" className="flex h-full items-center justify-center"><Spinner /></div>}>
        <SettingsView
          embedded={personal}
          tab={tab}
          project={null}
          remote={runtime.kind === "ssh"}
          onProjectUpdate={() => {}}
          onSelectTab={(next) => { void navigate({ to: "/settings/$tab", params: { tab: next } }); }}
        />
        </Suspense>
  );
}
