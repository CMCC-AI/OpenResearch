import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Spinner } from "../components/ui";

/** Persistent personal storage, with compute leased only while in use. */
export function PersonalResearchGate({ accountUrl, children }: { accountUrl: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState("starting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let lastInteraction = Date.now();
    let current = "starting";
    let pending = false;
    setError(""); setReady(false); setStatus("starting");
    const interact = () => { lastInteraction = Date.now(); };
    for (const event of ["pointerdown", "keydown", "touchstart", "wheel"])
      window.addEventListener(event, interact, { passive: true });
    async function read(method: "GET" | "POST") {
      if (pending || controller.signal.aborted) return;
      pending = true;
      clearTimeout(timer);
      try {
        const res = await fetch(`${accountUrl}/api/platform/personal-space`, {
          method, credentials: "include", cache: "no-store", signal: controller.signal,
          ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ retry: attempt > 0 }) } : {}),
        });
        const data = await res.json();
        if (!res.ok) throw Error(data.error || "个人研究环境暂时不可用");
        if (controller.signal.aborted) return;
        if (data.status === "failed") throw Error(data.error || "研究环境准备失败，请重试或联系管理员");
        current = data.status;
        setStatus(current);
        const available = data.online && current === "ready";
        setReady(available);
        if (available) setOpened(true);
        timer = setTimeout(() => void read(
          current === "ready" && document.visibilityState === "visible" && Date.now() - lastInteraction < 45000 ? "POST" : "GET",
        ), available || current === "sleeping" ? 10000 : 1500);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setReady(false);
          setError(cause instanceof Error ? cause.message : "无法连接账号服务");
        }
      } finally { pending = false; }
    }
    void read("POST");
    return () => {
      controller.abort(); clearTimeout(timer);
      for (const event of ["pointerdown", "keydown", "touchstart", "wheel"])
        window.removeEventListener(event, interact);
    };
  }, [accountUrl, attempt]);
  // Keep the workspace mounted across sleep/wake so unsent drafts survive.
  return <div className="flex h-full min-h-0 flex-col">
    <div className="h-full min-h-0" hidden={!ready}>{opened ? children : null}</div>
    {!ready && <main className="flex h-full flex-col items-center justify-center gap-4 bg-background p-6">
      <h1 className="text-xl font-semibold">{error ? "研究环境暂未就绪" : status === "sleeping" ? "你的研究空间已休息" : "正在准备你的个人研究环境"}</h1>
      <p className="max-w-140 text-center text-sm text-subtext">你的个人空间已建立，项目、对话和成果仅对你开放，闲置休眠不会删除数据。</p>
      {error ? <><p role="alert" className="max-w-140 text-center text-sm text-accent-red">{error}</p><Button onClick={() => setAttempt(value => value + 1)}>重新准备</Button></> : status === "sleeping" ? <Button onClick={() => setAttempt(value => value + 1)}>继续研究</Button> : <><Spinner /><p role="status" className="text-sm text-subtext">{status === "waiting" ? "正在等待计算资源，系统会自动准备，无需反复重试。" : "正在启动研究环境，请稍候…"}</p></>}
      <Link to="/cases" className="text-sm text-primary">先浏览公共精选案例</Link>
    </main>}
  </div>;
}
