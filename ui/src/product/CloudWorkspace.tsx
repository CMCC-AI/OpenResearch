import { PersonalResearchGate } from "./PersonalResearchGate";
import { Spinner } from "../components/ui";
import { useEffect, useState, type ReactNode } from "react";

export const isCloudWorkspace = () => typeof location !== "undefined" && /^[0-9a-f-]{36}\./.test(location.hostname);
interface Context { workspace: string; online: boolean; portal: string; privateSpaces?: boolean; user: { name: string } }

/** Identity is rechecked independently of the research API and never cached across workspaces. */
export function CloudWorkspace({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cloud = isCloudWorkspace();
  useEffect(() => {
    if (!cloud) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/_platform/context", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("登录已过期或工作空间权限已变更，请返回平台重新进入。");
        setContext(await response.json() as Context); setError(null);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法连接平台"); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [cloud]);
  if (!cloud) return children;
  const portal = context?.portal || `${location.protocol}//${location.host.replace(/^[0-9a-f-]{36}\./, "")}`;
  if (error) return <main className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-6 text-text">
    <p role="alert" className="max-w-140 text-center text-subtext">{error}</p>
    <a href={portal} className="rounded-lg bg-primary px-4 py-2 text-background no-underline">返回首页</a>
  </main>;
  if (!context) return <main className="flex h-full items-center justify-center bg-canvas"><Spinner /></main>;
  return context.privateSpaces
    ? <PersonalResearchGate accountUrl={location.origin} endpoint="/_platform/activity">{children}</PersonalResearchGate>
    : children;
}
