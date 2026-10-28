import { useLayoutEffect, useMemo, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import App from "../App";
import { stripAppBase } from "../appBasePath";
import { PlatformFrame } from "./ProductNav";
import { clearProjectWorkspaceCache } from "../useProjectWorkspace";
import { resetGlobalWorkspace } from "../workspacePersistence";
import { useRuntime } from "../RemoteRuntime";
import { queryClient } from "../queries/client";
import { createReadOnlyProjectApi, installReadOnlyApi } from "../readOnlyApi";
import { parsePane } from "../workspaceState";
import { ReadOnlyWorkspaceContext, type ReadOnlyWorkspaceData } from "../components/ReadOnlyWorkspace";
import type { NativeProjectSnapshot } from "./nativeProjectSnapshot";

/** Supplies immutable native API responses to the actual project page. */
export function ReadOnlyProject({ id, base, admin, workspace }: { id: string; base: string; admin: boolean; workspace: NativeProjectSnapshot }) {
  const runtime = useRuntime();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const location = useRouterState({ select: (state) => state.location });
  const pane = useMemo(() => { try { return parsePane(JSON.parse(new URLSearchParams(location.searchStr).get("pane") || "null")); } catch { return undefined; } }, [location.searchStr]);
  useLayoutEffect(() => {
    clearProjectWorkspaceCache(); resetGlobalWorkspace();
    const clear = installReadOnlyApi(createReadOnlyProjectApi({ id, base, admin, workspace }));
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clear(); clearProjectWorkspaceCache(); resetGlobalWorkspace();
      void queryClient.cancelQueries({ queryKey: ["workspace", id] }).then(() => queryClient.removeQueries({ queryKey: ["workspace", id] }));
    };
    // The destination renders before React runs this page's unmount cleanup.
    // Restore the personal data source before it can create any query options.
    const unsubscribe = router.subscribe("onBeforeLoad", ({ toLocation }) => {
      if (stripAppBase(toLocation.pathname) !== `/cases/${encodeURIComponent(id)}`) dispose();
    });
    setReady(true);
    return () => { unsubscribe(); dispose(); };
  }, [id, base, admin, workspace, router]);
  const data = useMemo<ReadOnlyWorkspaceData>(() => ({ native: true, preview: admin, caseId: id, initialSessionId: workspace.sessionId, research: {}, messages: {} }), [id, workspace.sessionId, admin]);
  return ready ? <ReadOnlyWorkspaceContext value={data}><App projectId={workspace.projectId} runtime={runtime} pane={pane} /></ReadOnlyWorkspaceContext> : <PlatformFrame title="研究过程"><p className="p-6 text-sm text-subtext">正在打开项目历史记录…</p></PlatformFrame>;
}
