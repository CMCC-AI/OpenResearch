import { useRef, useState } from "react";
import { ArrowLeft, MessagesSquare, Trash2, Upload } from "lucide-react";
import { bindSkill, deleteUserSkill, demoteLegacySkill, unbindSkill, uploadUserSkill } from "../api";
import { fileToBase64 } from "../components/SkillsTab";
import { Badge, Button, showAlert } from "../components/ui";
import type { Project } from "../api";
import { stageComposerDraft } from "../composerStash";
import { getWorkspaceGeneration } from "../queries/client";
import { skillConversationRequest, stageComposerHandoff } from "./conversation";
import { CapabilityTile, skillCardSummary } from "./CapabilityTile";
import type { WorkflowAgent, WorkflowLibrarySkill } from "./model";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 能力库的技能视图：单栏库页面，页头是说明与操作，卡片总览外显说明，点卡片进详情。
 * 用户技能默认不生效：绑定到项目或专家的会话才自动携带，对话里 /名字 始终可用。
 * 内置只读；用户技能可上传、可删除（镜像技能归原生 coding agent 所有，只读）。 */
export function SkillsLibrary({ skills, agents, projects, projectId, sessionId = null, onOpenSession, onOpenChats, onChanged }: { skills: WorkflowLibrarySkill[]; agents: WorkflowAgent[]; projects: Project[]; projectId?: string; sessionId?: string | null; onOpenSession?: (sessionId: string, projectId: string) => void; onOpenChats?: () => void; onChanged: () => Promise<unknown> }) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = skills.find((skill) => skill.name === selectedName) ?? null;
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const builtin = skills.filter((skill) => skill.source === "builtin");
  const mine = skills.filter((skill) => skill.source === "user");
  // 项目工作区跳项目主对话；全局技能库去科研首页的起始输入框，选个项目再发。
  const canOpenConversation = Boolean(projectId && onOpenSession) || Boolean(onOpenChats);

  function openConversation() {
    if (projectId && onOpenSession) {
      const text = skillConversationRequest();
      if (sessionId) stageComposerHandoff(projectId, sessionId, text);
      // 还没有可跳的主对话：预填科研首页该项目的起始输入框，发送时才建会话。
      else stageComposerDraft(getWorkspaceGeneration(), `${projectId}:new`, text);
      onOpenSession(sessionId ?? "new", projectId);
      return;
    }
    if (onOpenChats) {
      stageComposerDraft(getWorkspaceGeneration(), "research-home", skillConversationRequest());
      onOpenChats();
    }
  }

  async function upload(file: File) {
    setBusy(true);
    try {
      // 技能名取自 SKILL.md frontmatter，可能与上传文件名不同；选中后端返回的真实名字。
      const saved = await uploadUserSkill({ filename: file.name, contentBase64: await fileToBase64(file) });
      await onChanged();
      setSelectedName(saved.name);
      showAlert("技能已上传。默认不随会话生效：绑定到项目或专家后才会自动携带；对话里输入 /技能名 也可以直接使用。", "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: WorkflowLibrarySkill) {
    if (!window.confirm(`删除技能“${skill.name}”？绑定了它的项目和专家将不再携带该技能。`)) return;
    setBusy(true);
    try {
      await deleteUserSkill(skill.name);
      await onChanged();
      setSelectedName(null);
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleProject(skill: WorkflowLibrarySkill, projectId: string, bound: boolean) {
    setBusy(true);
    try {
      if (bound) await unbindSkill({ scopeKind: "project", scopeId: projectId, skillName: skill.name });
      else await bindSkill({ scopeKind: "project", scopeId: projectId, skillName: skill.name });
      await onChanged();
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function demote(skill: WorkflowLibrarySkill) {
    setBusy(true);
    try {
      await demoteLegacySkill(skill.name);
      await onChanged();
      showAlert("已改为按需绑定：之后只在绑定的项目和专家的会话里生效。", "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  // 未选中时的总览卡片：说明外显，像能力中心一样按彩色磁贴浏览。
  function card(skill: WorkflowLibrarySkill) {
    return <button key={`${skill.source}:${skill.name}`} type="button" onClick={() => setSelectedName(skill.name)} className="capability-card flex min-w-0 items-start gap-3 rounded-lg border border-border-variant bg-background p-3 text-start">
      <CapabilityTile kind="skill" name={skill.name} size="md" />
      <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-normal text-text">{skill.name}</strong><span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-subtext">{skillCardSummary(skill)}</span></span>
      {skill.source === "builtin" ? <Badge size="small">内置</Badge> : skill.legacyGlobal ? <Badge size="small">全局</Badge> : null}
    </button>;
  }

  // 生效范围的专家侧是只读摘要：挂载在专家的表单里编辑（AgentLibrary）。
  const boundAgentNames = (selected?.boundAgents ?? [])
    .map((id) => agents.find((agent) => agent.id === id)?.name ?? id);
  const scopeSummary = !selected || selected.source !== "user"
    ? null
    : selected.legacyGlobal
      ? "历史上传，保留全局生效：所有会话自动携带。"
      : (selected.boundProjects?.length ?? 0) + boundAgentNames.length > 0
        ? "只在下面勾选的项目和这些专家的会话里自动携带。"
        : "未绑定：不随任何会话自动携带；对话里输入 /技能名 仍可直接使用。";
  const scope = selected && selected.source === "user"
    ? <SkillScopeSection skill={selected} projects={projects} busy={busy} scopeSummary={scopeSummary} boundAgentNames={boundAgentNames} onToggleProject={(projectId, bound) => void toggleProject(selected, projectId, bound)} onDemote={() => void demote(selected)} />
    : null;

  return <section className="min-h-0 flex-1 overflow-y-auto p-5" aria-label={selected ? "技能详情" : "技能库"}>
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {selected ? <>
        <Button variant="ghost" className="self-start" onClick={() => setSelectedName(null)}><ArrowLeft size={14} />返回技能库</Button>
        <div className="flex items-start gap-3">
          <CapabilityTile kind="skill" name={selected.name} size="md" />
          <div className="min-w-0"><h2 className="m-0 text-lg font-normal">{selected.name}</h2><p className="mb-0 mt-1 text-sm text-subtext">{selected.source === "builtin" ? "内置技能模块，只读" : selected.origin ? `来自 ${selected.origin} 的镜像技能，归原生 coding agent 所有，请在其技能目录中修改` : "本地上传的技能包"}</p></div>
        </div>
        <section className="flex flex-col gap-1.5 text-sm" aria-label="用途说明">
          <h3 className="m-0 text-sm font-normal">用途说明</h3>
          <p className="m-0 whitespace-pre-wrap break-words leading-relaxed text-text">{selected.description || "暂无说明"}</p>
        </section>
        {scope}
        {selected.source === "user" && <section className="flex flex-col gap-1.5 text-sm" aria-label="技能信息">
          <h3 className="m-0 text-sm font-normal">技能信息</h3>
          <ul className="m-0 flex list-disc flex-col gap-1 ps-8 leading-relaxed text-text">
            {selected.bytes != null && <li>大小：{formatBytes(selected.bytes)}</li>}
            {selected.updatedAt != null && <li>更新时间：{new Date(selected.updatedAt).toLocaleString()}</li>}
          </ul>
        </section>}
        {selected.source === "user" && !selected.origin && <div><Button variant="danger" disabled={busy} onClick={() => void remove(selected)}><Trash2 size={14} />删除</Button></div>}
      </> : <>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-lg font-normal">技能库</h2>
            <p className="mb-0 mt-1 text-sm leading-relaxed text-subtext">内置技能随产品发布，覆盖文献、实验、写作等研究环节；上传的 SKILL.md 或 zip 会进入“我的技能”。默认不生效——绑定到项目或专家后随对应会话携带，对话里输入 /技能名 随时可用。{canOpenConversation ? "也可以点「在对话中创建」，回对话让 AI 帮你起草、登记技能。" : "也可以在对话里让 AI 登记技能。"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canOpenConversation && <Button variant="ghost" onClick={openConversation}><MessagesSquare size={15} />在对话中创建</Button>}
            <Button variant="primary" disabled={busy} onClick={() => inputRef.current?.click()}><Upload size={15} />上传技能</Button>
          </div>
        </header>
        <input ref={inputRef} type="file" accept=".md,.markdown,.zip" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }} />
        {skills.length === 0 && <p className="m-0 text-sm text-subtext">还没有任何技能：点「上传技能」传一个 SKILL.md 或 zip 开始。</p>}
        {mine.length > 0 && <section aria-label="我的技能总览"><h3 className="mb-2 mt-0 text-sm font-normal text-subtext">我的技能（{mine.length}）</h3><div className="grid gap-2 sm:grid-cols-2">{mine.map(card)}</div></section>}
        {builtin.length > 0 && <section aria-label="内置技能总览"><h3 className="mb-2 mt-0 text-sm font-normal text-subtext">内置技能（{builtin.length}）</h3><div className="grid gap-2 sm:grid-cols-2">{builtin.map(card)}</div></section>}
      </>}
    </div>
  </section>;
}

/** 用户技能的生效范围：绑定状态摘要 + 项目勾选 + 挂载的专家只读摘要。 */
export function SkillScopeSection({ skill, projects, busy, scopeSummary, boundAgentNames, onToggleProject, onDemote }: {
  skill: WorkflowLibrarySkill;
  projects: Project[];
  busy: boolean;
  scopeSummary: string | null;
  boundAgentNames: string[];
  onToggleProject: (projectId: string, bound: boolean) => void;
  onDemote: () => void;
}) {
  return <section className="flex flex-col gap-1.5 text-sm" aria-label="生效范围">
    <h3 className="m-0 text-sm font-normal">生效范围</h3>
    <p className="m-0 leading-relaxed text-text">{scopeSummary}</p>
    {skill.legacyGlobal && !skill.origin && <div><Button variant="ghost" disabled={busy} onClick={onDemote}>改为按需绑定</Button></div>}
    <fieldset className="m-0 flex flex-col gap-1.5">
      <legend className="p-0 text-xs text-subtext">在哪些项目自动携带</legend>
      {projects.length === 0 ? <p className="m-0 text-xs text-subtext">还没有研究项目。</p> : projects.map((project) => {
        const bound = (skill.boundProjects ?? []).includes(project.id);
        return <label key={project.id} className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={bound} disabled={busy} onChange={() => onToggleProject(project.id, bound)} />
          <span className="truncate">{project.name}</span>
        </label>;
      })}
    </fieldset>
    <fieldset className="m-0 flex flex-col gap-1.5">
      <legend className="p-0 text-xs text-subtext">哪些专家自动携带</legend>
      {boundAgentNames.length === 0 ? <p className="m-0 text-xs text-subtext">还没有专家挂载这个技能；在 Agents 页编辑自定义专家时勾选。</p> : <ul className="m-0 flex list-disc flex-col gap-1 ps-8 leading-relaxed text-text">{boundAgentNames.map((name) => <li key={name}>{name}</li>)}</ul>}
    </fieldset>
  </section>;
}
