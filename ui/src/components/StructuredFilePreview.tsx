import { lazy, Suspense } from "react";
import { Spinner } from "./ui";
const StructuredPreview = lazy(() => import("./StructuredPreview").catch(() => ({ default: ({ url, name }: { url: string; name: string }) => <div className="p-4 text-sm text-subtext">预览组件加载失败，请刷新页面或 <a href={url} download={name} className="text-primary">下载原文件</a>。</div> })));
/** Share one bounded parser and rendering surface between artifacts and file tabs. */
export function StructuredFilePreview({ url, name }: { url: string; name: string }) {
  return <Suspense fallback={<div className="flex items-center gap-2 p-4 text-sm text-subtext"><Spinner />正在加载文件预览…</div>}><StructuredPreview key={`${url}:${name}`} url={url} name={name} /></Suspense>;
}
