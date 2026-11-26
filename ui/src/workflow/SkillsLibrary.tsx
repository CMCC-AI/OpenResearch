import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, MessagesSquare, PencilLine, Search, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  bindSkill,
  deleteUserSkill,
  demoteLegacySkill,
  fmtBytes,
  getWorkflowSkillDetail,
  timeAgo,
  unbindSkill,
  updateUserSkill,
  uploadUserSkill,
  userSkillArchiveUrl,
} from "../api";
import type { Project } from "../api";
import { Md } from "../components/Md";
import { fileToBase64 } from "../components/SkillsTab";
import { Badge, Button, ButtonLink, Input, showAlert, Spinner } from "../components/ui";
import { stageComposerDraft } from "../composerStash";
import { getWorkspaceGeneration, workspaceKey } from "../queries/client";
import { skillConversationRequest, stageComposerHandoff } from "./conversation";
import { CapabilityTile } from "./CapabilityTile";
import type { WorkflowAgent, WorkflowLibrarySkill, WorkflowSkillDetail } from "./model";
import {
  SOURCE_FILTERS,
  skillMatchesFilter,
  skillMatchesQuery,
  skillScopeSummary,
  skillSummary,
  skillTitle,
  skillUsage,
  skillUsageLabel,
  type SkillSourceFilter,
} from "./skillLibrary";

const EMPTY_DRAFT = { name: "", description: "", instructions: "" };
type SkillDraft = typeof EMPTY_DRAFT;
type Mode = "browse" | "edit";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function accepted(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".zip");
}

/** 能力库的技能视图：列表 → 详情 → 编辑。
 *
 * 列表给出真实用途、来源、生效方式与包内文件数；详情能看到 SKILL.md 正文和
 * 包里的每个文件，并支持在对话中使用、下载、页内编辑与删除。
 * 新技能靠上传 SKILL.md/zip 或在对话里让 AI 起草，不做空白表单新建。
 * 用户技能默认不生效：绑定到项目或专家的会话才自动携带，对话里 /名字 始终可用。
 * 内置技能只读；镜像技能归原生 coding agent 所有，也只读。 */
export function SkillsLibrary({ skills, agents, projects, projectId, sessionId = null, onOpenSession, onOpenChats, onChanged }: { skills: WorkflowLibrarySkill[]; agents: WorkflowAgent[]; projects: Project[]; projectId?: string; sessionId?: string | null; onOpenSession?: (sessionId: string, projectId: string) => void; onOpenChats?: () => void; onChanged: () => Promise<unknown> }) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("browse");
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillSourceFilter>("all");
  const [contentExpanded, setContentExpanded] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = skills.find((skill) => skill.name === selectedName) ?? null;
  const detailQuery = useQuery({
    queryKey: workspaceKey("workflowSkill", selectedName ?? ""),
    queryFn: ({ signal }) => getWorkflowSkillDetail(selectedName as string, signal),
    enabled: selectedName !== null,
  });
  const detail: WorkflowSkillDetail | null = selectedName ? detailQuery.data ?? null : null;

  const visible = skills.filter((skill) => skillMatchesFilter(skill, filter) && skillMatchesQuery(skill, query));
  const mine = visible.filter((skill) => skill.source === "user");
  const builtin = visible.filter((skill) => skill.source === "builtin");
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

  /** 详情页的“在对话中使用”：把 /名字 预填进输入框，发送仍是用户自己的动作。 */
  function useSkill(name: string) {
    const text = `/${name} `;
    if (projectId && onOpenSession) {
      if (sessionId) stageComposerHandoff(projectId, sessionId, text);
      else stageComposerDraft(getWorkspaceGeneration(), `${projectId}:new`, text);
      onOpenSession(sessionId ?? "new", projectId);
      return;
    }
    if (onOpenChats) {
      stageComposerDraft(getWorkspaceGeneration(), "research-home", text);
      onOpenChats();
    }
  }

  async function upload(file: File) {
    if (!accepted(file.name)) {
      showAlert("请上传 SKILL.md 文件或技能 zip 包。", "error");
      return;
    }
    setBusy(true);
    try {
      // 技能名取自 SKILL.md frontmatter，可能与上传文件名不同；选中后端返回的真实名字。
      const saved = await uploadUserSkill({ filename: file.name, contentBase64: await fileToBase64(file) });
      await onChanged();
      setMode("browse");
      setSelectedName(saved.name);
      showAlert("技能已上传。默认不随会话生效：绑定到项目或专家后才会自动携带；对话里输入 /技能名 也可以直接使用。", "success");
    } catch (error) {
      showAlert(errorMessage(error), "error");
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
      setMode("browse");
    } catch (error) {
      showAlert(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleProject(skill: WorkflowLibrarySkill, targetProjectId: string, bound: boolean) {
    setBusy(true);
    try {
      if (bound) await unbindSkill({ scopeKind: "project", scopeId: targetProjectId, skillName: skill.name });
      else await bindSkill({ scopeKind: "project", scopeId: targetProjectId, skillName: skill.name });
      await onChanged();
    } catch (error) {
      showAlert(errorMessage(error), "error");
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
      showAlert(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    if (!selected) return;
    setDraft({
      name: selected.name,
      description: detail?.description ?? selected.description ?? "",
      instructions: detail?.body ?? "",
    });
    setFormError(null);
    setMode("edit");
  }

  function cancelForm() {
    setFormError(null);
    setMode("browse");
  }

  async function save() {
    if (busy || !selected) return;
    const description = draft.description.trim();
    const instructions = draft.instructions.trim();
    const problem = (description ? null : "写一句用途：模型靠它判断什么时候该用这个技能")
      ?? (description.length > 2048 ? "用途说明最多 2048 个字符" : null)
      ?? (instructions ? null : "写点指令正文：告诉 AI 按什么步骤做");
    if (problem) {
      setFormError(problem);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await updateUserSkill(selected.name, { description, instructions });
      await onChanged();
      await detailQuery.refetch();
      setMode("browse");
      showAlert("已保存修改，技能包里的其他文件没有改动。", "success");
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function card(skill: WorkflowLibrarySkill) {
    const usage = skillUsage(skill);
    const meta = skill.source === "builtin"
      ? "随产品发布 · 只读"
      : [
        skill.files != null ? `${skill.files} 个文件` : null,
        skill.bytes != null ? fmtBytes(skill.bytes) : null,
        skill.updatedAt ? timeAgo(skill.updatedAt) : null,
      ].filter(Boolean).join(" · ");
    return <button key={`${skill.source}:${skill.name}`} type="button" onClick={() => { setSelectedName(skill.name); setMode("browse"); }} className="capability-card flex min-w-0 items-start gap-3 rounded-lg border border-border-variant bg-background p-3 text-start transition-colors hover:border-primary">
      <CapabilityTile kind="skill" name={skill.name} size="md" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <strong className="min-w-0 flex-1 truncate text-sm font-normal text-text">{skillTitle(skill)}</strong>
          <Badge size="small" variant={usage.kind === "bound" ? "success" : usage.kind === "legacy" ? "warning" : "default"}>{skillUsageLabel(usage)}</Badge>
        </span>
        {skill.source === "builtin" && <span className="mt-0.5 block truncate font-mono text-xs text-muted">{skill.name}</span>}
        <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-subtext">{skillSummary(skill)}</span>
        {meta && <span className="mt-2 block text-xs text-muted">{meta}</span>}
      </span>
    </button>;
  }

  function formView() {
    return <>
      <Button variant="ghost" className="self-start" onClick={cancelForm}><ArrowLeft size={14} />返回技能库</Button>
      <div className="rounded-lg border border-border-variant bg-background p-4">
        <h2 className="m-0 text-lg font-normal">编辑 {draft.name}</h2>
        <p className="mb-0 mt-1 text-sm leading-relaxed text-subtext">只改写 SKILL.md 里的用途说明和指令正文，包里的其它文件保持不变。</p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-text">名称</span>
            <span className="font-mono text-sm text-text">{draft.name}</span>
            <span className="text-xs text-muted">名称就是对话里 /名字 的调用方式，要改它需要重新上传整个技能包。</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-text">用途说明</span>
            <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={2} placeholder="例：梳理某个方向的研究空白，并给出一页可执行的选题清单。" className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-text outline-none placeholder:text-muted focus:border-text" />
            <span className="text-xs text-muted">写清“什么时候该用”，模型靠这句话判断是否触发。</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-text">指令正文</span>
            <textarea value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} rows={14} placeholder={"# 做法\n\n1. 先读……\n2. 再……"} className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs leading-relaxed text-text outline-none placeholder:text-muted focus:border-text" />
            <span className="text-xs text-muted">Markdown：写清步骤、检查项和产出要求。</span>
          </label>
        </div>
        {formError && <p role="alert" className="mb-0 mt-3 text-sm text-accent-red">{formError}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : null}保存修改</Button>
          <Button disabled={busy} onClick={cancelForm}>取消</Button>
        </div>
      </div>
    </>;
  }

  function detailView(skill: WorkflowLibrarySkill) {
    const usage = skillUsage(skill);
    const boundAgentNames = (skill.boundAgents ?? []).map((id) => agents.find((agent) => agent.id === id)?.name ?? id);
    const files = detail?.files ?? [];
    const shownFiles = filesExpanded ? files : files.slice(0, 12);
    const body = detail?.body ?? "";
    const longContent = body.length > 900 || body.split("\n").length > 14;
    const isMine = skill.source === "user";
    // 内置技能的大小与文件数只在详情里才有，加载前先留空而不是显示 0 B。
    const size = skill.bytes ?? detail?.bytes;
    const fileCount = skill.files ?? detail?.files.length;
    return <>
      <Button variant="ghost" className="self-start" onClick={() => { setSelectedName(null); setMode("browse"); }}><ArrowLeft size={14} />返回技能库</Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <CapabilityTile kind="skill" name={skill.name} size="md" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 text-lg font-normal">{skillTitle(skill)}</h2>
              <Badge size="small" variant={usage.kind === "bound" ? "success" : usage.kind === "legacy" ? "warning" : "default"}>{skillUsageLabel(usage)}</Badge>
            </div>
            <p className="mb-0 mt-1 text-xs text-muted">{skill.source === "builtin" ? `${skill.name} · 内置技能，只读` : skill.origin ? `${skill.name} · 来自 ${skill.origin} 的镜像技能，请在其技能目录中修改` : "我的技能 · 可在页内修改用途与指令"}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isMine && canOpenConversation && <Button onClick={() => useSkill(skill.name)}><MessagesSquare size={15} />在对话中使用</Button>}
          {isMine && !skill.origin && <ButtonLink href={userSkillArchiveUrl(skill.name)} download={`${skill.name}.zip`}><Download size={15} />下载</ButtonLink>}
          {detail?.editable && <Button disabled={busy} onClick={startEdit}><PencilLine size={15} />编辑</Button>}
        </div>
      </div>
      <div className="rounded-lg border border-border-variant bg-background">
        <section className="p-4" aria-label="用途">
          <h3 className="m-0 text-xs font-normal text-subtext">用途</h3>
          <p className="mb-0 mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-text">{skillSummary(skill)}</p>
          {skill.source === "builtin" && <details className="mt-2 text-xs text-subtext"><summary className="cursor-pointer select-none">模型看到的原始说明</summary><p className="mb-0 mt-1 leading-relaxed">{skill.description}</p></details>}
        </section>
        <section className="border-t border-border p-4" aria-label="技能内容">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-xs font-normal text-subtext">技能内容（SKILL.md）</h3>
            {detail && <span className="text-xs text-muted">{body.split("\n").length} 行</span>}
          </div>
          {detailQuery.isPending ? <p role="status" className="mb-0 mt-2 flex items-center gap-2 text-sm text-subtext"><Spinner />正在读取技能内容…</p>
            : detailQuery.error ? <p role="alert" className="mb-0 mt-2 text-sm text-accent-red">读取失败：{errorMessage(detailQuery.error)}</p>
              : detail ? <>
                <div className={`mt-2 ${longContent && !contentExpanded ? "relative max-h-64 overflow-hidden" : ""}`}>
                  <Md text={body} />
                  {longContent && !contentExpanded && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />}
                </div>
                {longContent && <Button size="small" variant="ghost" className="mt-1" onClick={() => setContentExpanded((value) => !value)}>{contentExpanded ? "收起" : "展开全部"}</Button>}
              </> : null}
        </section>
        <section className="border-t border-border p-4" aria-label="包内文件">
          <h3 className="m-0 text-xs font-normal text-subtext">文件{detail ? `（${files.length}）` : ""}</h3>
          {files.length === 0 ? <p className="mb-0 mt-1 text-xs text-subtext">{detailQuery.isPending ? "读取中…" : "没有可列出的文件。"}</p> : <>
            <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
              {shownFiles.map((file) => <li key={file.path} className="flex items-center justify-between gap-3 text-xs"><span className="min-w-0 truncate font-mono text-text">{file.path}</span><span className="shrink-0 text-muted">{fmtBytes(file.bytes)}</span></li>)}
            </ul>
            {files.length > shownFiles.length && <Button size="small" variant="ghost" className="mt-1" onClick={() => setFilesExpanded(true)}>还有 {files.length - shownFiles.length} 个文件</Button>}
          </>}
        </section>
        <section className="border-t border-border p-4" aria-label="生效范围">
          {isMine
            ? <SkillScopeSection skill={skill} projects={projects} busy={busy} scopeSummary={skillScopeSummary(skill.name, usage)} boundAgentNames={boundAgentNames} onToggleProject={(targetProjectId, bound) => void toggleProject(skill, targetProjectId, bound)} onDemote={() => void demote(skill)} />
            : <><h3 className="m-0 text-xs font-normal text-subtext">生效范围</h3><p className="mb-0 mt-1 text-sm leading-relaxed text-text">{skillScopeSummary(skill.name, usage)}</p></>}
        </section>
        <section className="border-t border-border p-4" aria-label="技能信息">
          <h3 className="m-0 text-xs font-normal text-subtext">详情</h3>
          <dl className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-subtext">来源</dt><dd className="m-0 text-text">{skill.source === "builtin" ? "随产品发布" : skill.origin ? `镜像自 ${skill.origin}` : "本地上传"}</dd>
            <dt className="text-subtext">大小</dt><dd className="m-0 text-text">{size != null ? fmtBytes(size) : "—"}{fileCount != null ? ` · ${fileCount} 个文件` : ""}</dd>
            <dt className="text-subtext">更新时间</dt><dd className="m-0 text-text">{skill.updatedAt ? new Date(skill.updatedAt).toLocaleString() : "随产品发布"}</dd>
          </dl>
          {isMine && !skill.origin && <div className="mt-3"><Button variant="danger" disabled={busy} onClick={() => void remove(skill)}><Trash2 size={14} />删除技能</Button></div>}
        </section>
      </div>
    </>;
  }

  return <section
    className="min-h-0 flex-1 overflow-y-auto p-5"
    aria-label={mode === "browse" ? (selected ? "技能详情" : "技能库") : "编辑技能"}
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    }}
    onDrop={(event) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void upload(file);
    }}
  >
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {mode !== "browse" ? formView() : selected ? detailView(selected) : <>
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="m-0 text-lg font-normal">技能库</h2>
              <p className="mb-0 mt-1 text-sm leading-relaxed text-subtext">内置技能随产品发布；我的技能默认不生效，绑定项目或专家后自动带上，也可以在对话里用 /技能名 调用。{canOpenConversation ? "不知道怎么写，可以点「在对话中创建」让 AI 起草。" : "也可以回对话让 AI 帮你创建。"}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? <Spinner /> : <Upload size={15} />}上传</Button>
              {canOpenConversation && <Button variant="ghost" onClick={openConversation}><MessagesSquare size={15} />在对话中创建</Button>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-subtext" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或用途" aria-label="搜索技能" className="ps-8" />
            </label>
            <div role="group" aria-label="按来源筛选" className="flex items-center gap-1">
              {SOURCE_FILTERS.map((option) => <Button key={option.value} size="small" variant="ghost" active={filter === option.value} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</Button>)}
            </div>
            <span className="text-xs text-muted">SKILL.md 或 zip 也可以直接拖进来</span>
          </div>
        </header>
        <input ref={inputRef} type="file" accept=".md,.markdown,.zip" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }} />
        {skills.length === 0
          ? <p className="m-0 text-sm text-subtext">还没有任何技能：上传 SKILL.md 或 zip 开始，也可以在对话里让 AI 帮你创建。</p>
          : visible.length === 0
            ? <p className="m-0 text-sm text-subtext">没有匹配的技能，换个关键词或切回「全部」。</p>
            : <>
              {mine.length > 0 && <section aria-label="我的技能总览"><h3 className="mb-2 mt-0 text-sm font-normal text-subtext">我的技能（{mine.length}）</h3><div className="grid gap-2 sm:grid-cols-2">{mine.map(card)}</div></section>}
              {builtin.length > 0 && <section aria-label="内置技能总览"><h3 className="mb-2 mt-0 text-sm font-normal text-subtext">内置技能（{builtin.length}）</h3><div className="grid gap-2 sm:grid-cols-2">{builtin.map(card)}</div></section>}
            </>}
      </>}
    </div>
    {dragging && <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-background/80 text-sm text-subtext">松开导入 SKILL.md 或技能 zip</div>}
  </section>;
}

/** 用户技能的生效范围：绑定摘要 + 项目勾选 + 挂载的专家只读摘要。
 * 专家侧挂载在 Agents 页的专家表单里编辑，这里只读出结果。 */
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
    <h3 className="m-0 text-xs font-normal text-subtext">生效范围</h3>
    <p className="m-0 leading-relaxed text-text">{scopeSummary}</p>
    {skill.legacyGlobal && !skill.origin && <div><Button size="small" variant="ghost" disabled={busy} onClick={onDemote}>改为按需绑定</Button></div>}
    <div className="mt-1 flex flex-col gap-0.5">
      <p className="m-0 text-xs text-subtext">在哪些项目自动携带</p>
      {projects.length === 0 ? <p className="m-0 text-xs text-subtext">还没有研究项目。</p> : projects.map((project) => {
        const bound = (skill.boundProjects ?? []).includes(project.id);
        return <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text hover:bg-surface">
          <input type="checkbox" className="accent-primary" checked={bound} disabled={busy} onChange={() => onToggleProject(project.id, bound)} />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {bound && <Badge size="small">自动携带</Badge>}
        </label>;
      })}
    </div>
    <div className="mt-2 flex flex-col gap-1">
      <p className="m-0 text-xs text-subtext">哪些专家自动携带</p>
      {boundAgentNames.length === 0 ? <p className="m-0 text-xs text-subtext">还没有专家挂载这个技能；在 Agents 页编辑自定义专家时勾选。</p> : <ul className="m-0 flex list-disc flex-col gap-1 ps-8 leading-relaxed text-text">{boundAgentNames.map((name) => <li key={name}>{name}</li>)}</ul>}
    </div>
  </section>;
}
