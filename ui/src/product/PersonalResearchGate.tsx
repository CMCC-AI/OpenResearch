import { cancelRuntimeRequests } from "../runtimeRequest";
import { useEffect, type ReactNode } from "react";

/** Prepare compute in the background; the workspace never depends on its state. */
export function PersonalResearchGate({ accountUrl, endpoint = "/api/platform/personal-space", children }: { accountUrl: string; endpoint?: string; children: ReactNode }) {
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let lastInteraction = Date.now();
    let lastRequest = 0;
    const prepare = async (retry = false) => {
      if (pending || controller.signal.aborted || document.visibilityState !== "visible") return;
      pending = true;
      lastRequest = Date.now();
      try {
        await fetch(`${accountUrl}${endpoint}`, {
          method: "POST", credentials: "include", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          headers: { "content-type": "application/json" }, body: JSON.stringify({ retry }),
        });
      } catch { /* Operations report genuine failures through their normal UI. */ }
      finally { pending = false; }
    };
    const interact = () => {
      lastInteraction = Date.now();
      if (lastInteraction - lastRequest >= 10000) void prepare(true);
    };
    const visible = () => { if (document.visibilityState === "visible") interact(); };
    for (const event of ["pointerdown", "keydown", "touchstart", "wheel"])
      window.addEventListener(event, interact, { passive: true });
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => {
      if (Date.now() - lastInteraction < 45000) void prepare();
    }, 30000);
    void prepare(true);
    return () => {
      controller.abort(); clearInterval(timer); cancelRuntimeRequests();
      for (const event of ["pointerdown", "keydown", "touchstart", "wheel"])
        window.removeEventListener(event, interact);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [accountUrl, endpoint]);
  return children;
}
