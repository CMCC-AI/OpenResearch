import { useEffect, useState } from "react";
import { appHref } from "../appBasePath";

/** Cache headers affect document requests, not an already running SPA. Compare
 * its loaded entry with the deployment without restarting active conversations. */
export function DeploymentUpdateNotice() {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    const entry = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).at(-1)?.src;
    if (!entry) return;
    const index = new URL(appHref("/index.html"), location.origin);
    let disposed = false;
    let pending = false;
    let lastCheck = 0;
    let controller: AbortController | undefined;
    async function check() {
      if (disposed || pending || document.visibilityState !== "visible" || Date.now() - lastCheck < 10000) return;
      pending = true;
      lastCheck = Date.now();
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 5000);
      try {
        const response = await fetch(index, { cache: "no-store", signal: controller.signal });
        if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
        const html = new DOMParser().parseFromString(await response.text(), "text/html");
        const src = Array.from(html.querySelectorAll('script[type="module"][src]')).at(-1)?.getAttribute("src");
        if (!src) return;
        const next = new URL(src, index);
        if (!disposed && next.origin === index.origin && next.href !== entry) setUpdated(true);
      } catch {
        // An offline page or transient gateway response is not a deployment.
      } finally {
        clearTimeout(timeout);
        pending = false;
      }
    }
    void check();
    const timer = setInterval(() => void check(), 60000);
    const resume = () => { void check(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  return updated ? <div role="status" className="fixed top-3 left-1/2 z-100 w-fit max-w-full -translate-x-1/2 rounded-lg border border-border bg-background px-4 py-3 text-sm text-text shadow-elevated">
    页面已更新，请保存当前输入后刷新，以使用最新版本。
  </div> : null;
}
