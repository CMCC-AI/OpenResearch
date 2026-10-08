import { useEffect, useState, type ReactNode } from "react";

export const isCloudWorkspace = () => typeof location !== "undefined" && /^[0-9a-f-]{36}\./.test(location.hostname);
interface Context { workspace: string; role: "owner" | "editor" | "viewer"; online: boolean; portal: string; privateSpaces?: boolean; user: { name: string } }

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
  if (error || !context || !context.online) return <main className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-6 text-text">
    <h1 className="text-2xl">{error ? "工作空间访问已暂停" : !context ? "正在验证工作空间" : context.privateSpaces ? "运行环境暂未就绪" : "执行器尚未连接"}</h1>
    <p className="max-w-140 text-center text-subtext">{error || (context ? context.privateSpaces ? "请返回首页查看服务器环境状态或重新准备环境。" : context.role === "owner" ? "按照接入向导连接一台电脑，完成后即可开始科研任务。" : "请让管理员连接此工作空间的专属执行器。原有实验不会因页面断开而自动停止。" : "正在获取账户权限…")}</p>
    <a href={context?.role === "owner" && !context.privateSpaces ? `${portal}/#setup=${context.workspace}` : portal} className="rounded-lg bg-primary px-4 py-2 text-background no-underline">{context?.privateSpaces ? "返回首页" : context?.role === "owner" ? "配置专属执行器" : "返回团队平台"}</a>
  </main>;
  return <div className="flex h-full min-h-0 flex-col"><div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-variant bg-primary-subtle px-5 py-2 text-xs text-primary">
    <span>{context.user.name} · {context.privateSpaces ? "私人科研空间" : context.role === "viewer" ? "只读成员 · 可查看项目和结果，不能运行或修改" : context.role === "owner" ? "工作空间管理员" : "研究成员 · 可执行科研任务"}</span>
    <a href={portal} className="text-primary">{context.privateSpaces ? "返回首页 ↗" : "返回团队平台 ↗"}</a>
  </div><div className="min-h-0 flex-1">{children}</div></div>;
}
