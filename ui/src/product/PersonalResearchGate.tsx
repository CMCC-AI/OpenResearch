import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Spinner } from "../components/ui";

/** Logical ownership is immediate; compute starts on first research access. */
export function PersonalResearchGate({ accountUrl, children }: { accountUrl: string; children: ReactNode }) {
  const [ready,setReady]=useState(false); const [error,setError]=useState(""); const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    setError(""); setReady(false);
    async function read(method: "GET" | "POST") {
      try {
        const res=await fetch(`${accountUrl}/api/platform/personal-space`,{method,credentials:"include",cache:"no-store",signal:controller.signal,...(method==="POST"?{headers:{"content-type":"application/json"},body:JSON.stringify({retry:attempt>0})}:{})});
        const data=await res.json();
        if(!res.ok)throw Error(data.error || "个人研究环境暂时不可用");
        if(controller.signal.aborted)return;
        if(data.status==="failed")throw Error(data.error || "研究环境准备失败，请重试或联系管理员");
        if(data.online && data.status==="ready"){setReady(true);return;}
        timer=setTimeout(()=>void read("GET"),1500);
      }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"无法连接账号服务");}
    }
    void read("POST");
    return()=>{controller.abort();clearTimeout(timer);};
  },[accountUrl,attempt]);
  if(ready)return children;
  return <main className="flex h-full flex-col items-center justify-center gap-4 bg-background p-6"><h1 className="text-xl font-semibold">{error?"研究环境暂未就绪":"正在准备你的个人研究环境"}</h1><p className="max-w-140 text-center text-sm text-subtext">你的个人空间已建立，项目、对话和成果仅对你开放。</p>{error?<><p role="alert" className="max-w-140 text-center text-sm text-accent-red">{error}</p><Button onClick={()=>setAttempt((value)=>value+1)}>重新准备</Button></>:<><Spinner /><p role="status" className="text-sm text-subtext">首次准备可能需要一些时间，请稍候…</p></>}<Link to="/cases" className="text-sm text-primary">先浏览公共精选案例</Link></main>;
}
