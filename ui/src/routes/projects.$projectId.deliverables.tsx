import { createFileRoute } from "@tanstack/react-router";

// 内容由项目布局（App 的 mainView=deliverables 分支）渲染，与 /projects/$projectId/workflows 相同。
export const Route = createFileRoute("/projects/$projectId/deliverables")({});
