import { useLayoutEffect, useMemo } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { getProjectUiState } from "./api";
import { getReadOnlyApi } from "./readOnlyApi";
import { getWorkspaceGeneration, queryClient, subscribeWorkspace, workspaceScope } from "./queries/client";
import { getProjectUiStateQuery } from "./queries/projects";
import { getCachedProjectWorkspace, getProjectWorkspaceEpoch } from "./useProjectWorkspace";
import { createSessionNavigation } from "./sessionNavigation";
import { showAlert } from "./components/ui/Toast";
import { m } from "./paraglide/messages.js";

export function useSessionNavigation(personal = false) {
  const router = useRouter();
  const navigation = useMemo(() => {
    let notification: string | number | undefined;
    return createSessionNavigation({
      context: () => JSON.stringify([getWorkspaceGeneration(), getProjectWorkspaceEpoch(), workspaceScope(personal), router.state.location.href]),
      // The live cache is cleared on account/case transitions. A personal link
      // inside a case must never consume that case's in-memory workspace.
      cached: (id) => personal && getReadOnlyApi() ? undefined : getCachedProjectWorkspace(id),
      read: (id, signal) => getProjectUiState(id, signal, personal),
      remember: (id, workspace) => queryClient.setQueryData(getProjectUiStateQuery(id, personal).queryKey, workspace),
      loading: (active) => {
        if (notification !== undefined) toast.dismiss(notification);
        notification = active ? toast.loading(m.common_loading(), { position: "top-center" }) : undefined;
      },
      failed: (error) => showAlert(error instanceof Error ? error.message : String(error), "error"),
    });
  }, [router, personal]);
  useLayoutEffect(() => {
    const route = router.subscribe("onBeforeLoad", () => navigation.cancel());
    const workspace = subscribeWorkspace(() => navigation.cancel());
    return () => { route(); workspace(); navigation.cancel(); };
  }, [router, navigation]);
  return navigation;
}
