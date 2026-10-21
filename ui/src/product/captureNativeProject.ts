import type { ChatSession, Project, ProjectArtifacts, CodeTree, Run, Experiment, ProjectFile } from "../api";
import { canonicalRequest } from "../readOnlyApi";
import type { NativeProjectSnapshot } from "./nativeProjectSnapshot";

export interface NativeCapture { workspace: NativeProjectSnapshot; assets: { name: string; content: string }[] }
const encode = (bytes: Uint8Array) => { let value = ""; for (let at = 0; at < bytes.length; at += 32768) value += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(value); };

/** Capture the API responses consumed by the actual project page without flattening them. */
export async function captureNativeProject(projectId: string, progress: (message: string) => void = () => {}): Promise<NativeCapture> {
  const workspace: NativeProjectSnapshot = { version: 1, projectId, sessionId: "", responses: {}, assets: {} };
  const assets: NativeCapture["assets"] = [];
  let total = 0;
  async function read<T>(path: string): Promise<T> {
    const key = canonicalRequest(path);
    if (key in workspace.responses) return workspace.responses[key] as T;
    const response = await fetch(path, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`项目资源读取失败（${response.status}）：${path}`);
    const value = await response.json() as T;
    workspace.responses[key] = value;
    return value;
  }
  async function asset(path: string, filename: string) {
    const key = canonicalRequest(path);
    if (workspace.assets[key]) return;
    progress(`正在复制原项目文件：${filename}`);
    const response = await fetch(path, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`原项目文件读取失败（${response.status}）：${filename}`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>128*1024*1024){await reader.cancel();throw new Error(`文件超过 128 MB，不能省略发布：${filename}`);}chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
    const extension = filename.match(/\.[a-z0-9]{1,10}$/i)?.[0] || ".bin";
    const name = `native-${digest}${extension}`;
    if (!assets.some((file)=>file.name===name)) { total+=size; if(total>512*1024*1024 || assets.length>=2000)throw new Error("完整项目文件超过发布上限，不能省略文件发布。"); assets.push({name,content:encode(bytes)}); }
    workspace.assets[key]=name;
  }
  const source = (await read<{projects:Project[]}>("/api/projects")).projects.find((project)=>project.id===projectId);
  if(!source)throw new Error("无权读取案例原项目，或原项目已被删除。");
  workspace.responses["/api/projects"]={projects:[source]};
  const before = await read<{sessions:ChatSession[]}>(`/api/chat/sessions?projectId=${projectId}`);
  if(before.sessions.some((session)=>session.busy))throw new Error("原项目仍有运行中的会话，请结束后再同步。");
  const runs = (await read<{runs:Run[]}>(`/api/projects/${projectId}/runs`)).runs;
  if(runs.some((run)=>run.status==="running"||run.status==="starting"))throw new Error("原项目仍有运行中的实验，请结束后再同步。");
  const state = await read<{lastTaskId:string|null}>(`/api/projects/${projectId}/ui-state`);
  workspace.sessionId = state.lastTaskId && before.sessions.some((session)=>session.id===state.lastTaskId) ? state.lastTaskId : before.sessions.find((session)=>!session.parentSessionId)?.id || before.sessions[0]?.id || "";
  if(!workspace.sessionId)throw new Error("原项目没有会话历史。");
  const global = await read<{workspace:unknown}>("/api/settings/ui-state");
  workspace.responses["/api/settings/ui-state"]={...global,workspace:global.workspace};
  const activity = await read<{activity:{projectId:string}[]}>("/api/projects/activity");
  workspace.responses["/api/projects/activity"]={activity:activity.activity.filter((row)=>row.projectId===projectId)};
  await read("/api/harnesses");
  await read(`/api/skills?project=${projectId}`);
  for (const harness of new Set(before.sessions.map((session) => session.harness))) await read(`/api/skills?${new URLSearchParams({harness,project:projectId})}`);
  await read(`/api/settings/compute?projectId=${projectId}`);
  const artifacts = await read<ProjectArtifacts>(`/api/projects/${projectId}/files`);
  if(artifacts.truncated)throw new Error("原项目成果列表未读取完整，不能省略发布。");
  async function tree(query: string) {
    const listing=await read<CodeTree>(`/api/projects/${projectId}/code-tree${query ? `?${query}` : ""}`);
    if(listing.truncated)throw new Error("原项目文件列表未读取完整，不能省略发布。");
    for(const path of listing.entries) {
      const params=new URLSearchParams(query);params.set("path",path);
      const file=await read<ProjectFile>(`/api/projects/${projectId}/file?${params}`);
      if(!file.notFound) {
        const raw=`/api/projects/${projectId}/file/raw?${params}`;
        await asset(raw,path);
        if(listing.path) {
          const absolute=`${listing.path.replace(/\/$/,"")}/${path}`;
          workspace.assets[canonicalRequest(`/api/files/abs/raw?path=${encodeURIComponent(absolute)}`)]=workspace.assets[canonicalRequest(raw)];
          workspace.responses[canonicalRequest(`/api/files/abs?path=${encodeURIComponent(absolute)}`)]=file;
        }
      }
    }
  }
  await tree("");
  await tree(new URLSearchParams({ref:source.baselineBranch}).toString());
  const copyArtifacts=async(entries:ProjectArtifacts["entries"])=>{for(const entry of entries)if(entry.isDir)await copyArtifacts(entry.children??[]);else {
      const raw=`/api/projects/${projectId}/files/file?path=${encodeURIComponent(entry.path)}`;
      await asset(raw,entry.name);
      workspace.assets[canonicalRequest(`/api/files/abs/raw?path=${encodeURIComponent(`${artifacts.dir}/${entry.path}`)}`)]=workspace.assets[canonicalRequest(raw)];
    }};
  await copyArtifacts(artifacts.entries);
  for(const session of before.sessions) {
    progress(`正在复制原会话：${session.title || session.id}`);
    const messages=await read<{messages:{parts:{type:string;text?:string;name?:string}[]}[];queued:unknown[]}>(`/api/chat/sessions/${session.id}/messages`);
    if(messages.queued?.length)throw new Error("原项目还有排队消息，请处理后再同步。");
    workspace.responses[`/api/chat/sessions/${session.id}`]={session};
    const research = await read<{study:{id:string;decisions:{gate:string;status:string}[]}|null}>(`/api/research/sessions/${session.id}`);
    if(research.study){
      await asset(`/api/research/studies/${research.study.id}/package?approved=false`,"research-draft.zip");
      if(research.study.decisions.some((decision)=>["G3","G4"].includes(decision.gate)&&decision.status==="approved")) await asset(`/api/research/studies/${research.study.id}/package?approved=true`,"research-approved.zip");
    }
    const wt=await read<{exists:boolean}>(`/api/chat/sessions/${session.id}/worktree`);
    if(wt.exists)await tree(new URLSearchParams({sessionId:session.id}).toString());
    for(const message of messages.messages)for(const part of message.parts)if(part.type==="image"&&part.text&&!part.text.startsWith("data:"))await asset(`/api/chat/attachments/${encodeURIComponent(part.text)}`,part.name||part.text);
    for (const message of messages.messages) for (const part of message.parts) if (part.type === "material" && part.text) {
      const material = await read<{ id: string; files: { id: string; path: string }[] }>(`/api/materials/${encodeURIComponent(part.text)}`);
      for (const file of material.files) await asset(`/api/materials/${encodeURIComponent(material.id)}/${encodeURIComponent(file.id)}/download`, file.path.split("/").at(-1) || file.id);
    }
  }
  const experiments=(await read<{experiments:Experiment[]}>(`/api/projects/${projectId}/experiments`)).experiments;
  for(const experiment of experiments){await tree(new URLSearchParams({ref:experiment.branchName}).toString());await read(`/api/experiments/${experiment.id}/diff`);}
  for(const run of runs){
    await read(`/api/runs/${run.id}/diff`);
    const chunks:Uint8Array[]=[];let offset=0;
    for(;;){const response=await read<{dataBase64:string;nextOffset:number;eof:boolean}>(`/api/runs/${run.id}/log?offset=${offset}`);const chunk=Uint8Array.from(atob(response.dataBase64),(char)=>char.charCodeAt(0));chunks.push(chunk);if(response.eof)break;if(response.nextOffset<=offset)throw new Error("运行日志未读取完整。");offset=response.nextOffset;}
    const size=chunks.reduce((sum,chunk)=>sum+chunk.length,0);const bytes=new Uint8Array(size);offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    workspace.responses[canonicalRequest(`/api/runs/${run.id}/log?offset=0`)]={dataBase64:encode(bytes),nextOffset:size,eof:true};
  }
  const after=await fetch(`/api/chat/sessions?projectId=${projectId}`,{credentials:"include",cache:"no-store"}).then((response)=>response.json()) as typeof before;
  if(JSON.stringify(after)!==JSON.stringify(before))throw new Error("复制期间原项目会话发生变化，请重试。");
  return {workspace,assets};
}
