import type { Project } from "../api";
import { captureNativeProject } from "./captureNativeProject";
import { caseRequest, caseWrite, type FeaturedCaseDetail } from "./featuredCasesApi";

/** One user action: preserve the original project page, then make it visible in cases. */
export async function addProjectToCases(base: string, project: Pick<Project, "id" | "name">, progress: (message: string) => void, existingId?: string) {
  let current = existingId ? await caseRequest<FeaturedCaseDetail>(base, `admin/cases/${existingId}`) : null;
  if (current?.status === "published") return current.id;
  // Send the project manifest separately from file bytes so a large archive stays resumable.
  const native = await captureNativeProject(project.id, () => progress("正在准备项目内容，请稍候…"));
  if (current) {
    await caseWrite(base, `admin/cases/${current.id}/native`, { revision: current.revision, workspace: native.workspace });
  } else {
    const sessions = native.workspace.responses[`/api/chat/sessions?projectId=${project.id}`] as { sessions: { id: string; title: string }[] };
    const summary = sessions.sessions.find((session) => session.id === native.workspace.sessionId)?.title || project.name;
    const saved = await caseWrite<{ id: string }>(base, "admin/cases", {
      sourceProjectId: project.id, title: project.name, summary, category: "科研实践",
      snapshot: { sessions: [], projectName: project.name, workspace: native.workspace }, expectedFileCount: native.assets.length,
    });
    current = { id: saved.id } as FeaturedCaseDetail;
  }
  current = await caseRequest<FeaturedCaseDetail>(base, `admin/cases/${current!.id}`);
  const uploaded = new Set(current.files.map((file) => file.name));
  for (const [index, asset] of native.assets.entries()) {
    if (uploaded.has(asset.name)) continue;
    progress(`正在复制项目文件 ${index + 1}/${native.assets.length}…`);
    const bytes = Uint8Array.from(atob(asset.content), (char) => char.charCodeAt(0));
    await caseRequest(base, `admin/cases/${current.id}/files?name=${encodeURIComponent(asset.name)}`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Blob([bytes]),
    });
  }
  current = await caseRequest<FeaturedCaseDetail>(base, `admin/cases/${current.id}`);
  if (!current || current.files.length !== current.expected_file_count) throw new Error("项目内容尚未准备完成，请重试。");
  progress("正在加入案例集…");
  await caseWrite(base, `admin/cases/${current.id}/publish`, { revision: current.revision, reviewed: true });
  return current.id;
}
