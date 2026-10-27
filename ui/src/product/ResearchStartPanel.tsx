import { droppedMaterials, pendingMaterials, validateMaterialFiles } from "../materialUploads";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { reasoningFor, updateUiState, type AgentSelection, type Project, type ProjectActivity, type SkillInfo } from "../api";
import { getHarnessesQuery, getSkillsQuery } from "../queries/settings";
import { getUiStateQuery } from "../queries/projects";
import { setScopedQueryData } from "../queries/client";
import { ModelPicker, defaultSelection } from "../components/ModelPicker";
import { ComposerProjectPicker } from "../components/ComposerProjectPicker";
import { SkillMenu } from "../components/SkillMenu";
import { commandsForHarness, commandMatchesQuery, insertSlashCommand, removeSlashCommand, slashCommandContext } from "../composerCommands";
import { CornerDownLeft, FileText, FileUp, FolderUp, X } from "lucide-react";
import type { ComposerAttachment } from "../composerStash";
import { WorkModeSwitch, type WorkMode } from "../components/WorkModeSwitch";
import { ProductWordmark } from "./ProductNav";
import { IconButton } from "../components/ui/IconButton";

export function ResearchStartPanel({ draft, onDraftChange, attachments, onAttachmentsChange, onStart, onError, workMode, onWorkModeChange, preferredAgent, projects, activity, project, onSelectProject }: {
  preferredAgent: AgentSelection | null; projects: Project[]; activity: ProjectActivity[]; project?: Project; onSelectProject: (id: string) => void;
  draft: string; onDraftChange: (value: string) => void;
  attachments: ComposerAttachment[]; onAttachmentsChange: (value: ComposerAttachment[]) => void;
  workMode: WorkMode; onWorkModeChange: (mode: WorkMode) => void;
  onStart: () => void; onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const { data: harnesses = [] } = useQuery(getHarnessesQuery());
  const selection = defaultSelection(harnesses, preferredAgent);
  const harness = harnesses.find((item) => item.id === selection?.harness);
  const { data: skills = [] } = useQuery(getSkillsQuery(selection?.harness, project?.id));
  const reasoning = reasoningFor(harness, selection?.model);
  const uiOptions = getUiStateQuery();
  const { data: uiState } = useQuery(uiOptions);
  const saveSelection = useMutation({
    mutationFn: updateUiState,
    onSuccess: (state) => { setScopedQueryData(uiOptions.queryKey, state); },
    onError: (error) => onError(error.message),
  });
  const [cursor, setCursor] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [modelRequest, setModelRequest] = useState(0);
  const slash = slashCommandContext(draft, cursor);
  const commands = commandsForHarness(skills, harness?.options.planActivation).filter((item) => item.source !== "command" || ["model", "new", "plan", "goal"].includes(item.name));
  const matches = !menuDismissed && slash && slash.end === cursor ? commands.filter((item) => commandMatchesQuery(item, slash.query)) : [];
  const selectedIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));
  useEffect(() => setActiveIndex(0), [slash?.query]);
  function pickCommand(skill: SkillInfo) {
    if (!slash) return;
    const next = skill.source === "command" && (skill.name === "model" || skill.name === "new")
      ? removeSlashCommand(draft, slash)
      : insertSlashCommand(draft, slash, skill.name.replace(/@u$/, "^").replace(/@p$/, "~"));
    onDraftChange(skill.source === "command" && skill.name === "new" ? "" : next.text);
    if (skill.source === "command" && skill.name === "model") setModelRequest((value) => value + 1);
    setMenuDismissed(true);
    setCursor(next.cursor);
    requestAnimationFrame(() => { draftRef.current?.focus(); draftRef.current?.setSelectionRange(next.cursor, next.cursor); });
  }
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const currentAttachments = useRef(attachments);
  currentAttachments.current = attachments;
  function addEntries(selected: ComposerAttachment[]) {
    validateMaterialFiles(selected.map(file => ({ name: file.name || "file", size: file.size })), currentAttachments.current);
    onAttachmentsChange([...currentAttachments.current, ...selected]);
  }
  async function addFiles(files: FileList | null) {
    if (!files) return;
    try {
      addEntries(pendingMaterials(Array.from(files)));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { if (picker.current) picker.current.value = ""; }
  }
  return <section className="research-start mb-12" aria-labelledby="new-research-title">
    <header className="research-start-heading mb-8"><div className="flex flex-wrap items-center gap-4"><ProductWordmark heading /><h1 id="new-research-title" className="product-page-title m-0">今天，想推进哪一项研究</h1></div><p className="product-page-description mt-3 mb-0">汇聚科研专家能力，联动文件、终端、实验与成果产物，侧边对话随时交互，让每一项研究高效落地。</p></header>
    <form onSubmit={(event) => { event.preventDefault(); if (!saveSelection.isPending) onStart(); }} className="@container new-chat-composer research-home-composer !m-0 !max-w-none !w-full">
      <div className="composer-box research-start-composer relative rounded-2xl border border-border-variant bg-background px-4 pt-4 pb-2.5">
      {matches.length > 0 && <SkillMenu skills={matches} activeIndex={selectedIndex} onPick={pickCommand} onHover={setActiveIndex} />}
      <label htmlFor="research-objective" className="sr-only">研究目标</label>
      <textarea id="research-objective" ref={draftRef} value={draft} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles(event.clipboardData.files); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void droppedMaterials(event.dataTransfer).then(addEntries).catch((error) => onError(String(error))); } }} onChange={(event) => { onDraftChange(event.target.value); setCursor(event.target.selectionStart); setMenuDismissed(false); }} onSelect={(event) => setCursor(event.currentTarget.selectionStart)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (matches.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); return; }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pickCommand(matches[selectedIndex]); return; }
          if (event.key === "Escape") { event.preventDefault(); setMenuDismissed(true); return; }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!saveSelection.isPending && (draft.trim() || attachments.length)) onStart(); }
      }} placeholder="请输入您的研究内容，输入/使用命令和技能" className="research-objective block min-h-24 w-full resize-none border-0 bg-transparent p-0 text-base focus:border-0" />
      {attachments.length > 0 && <ul className="composer-attachments m-0 mb-3 flex list-none flex-wrap gap-1.5 p-0">
        {attachments.map((file, index) => <li key={`${file.name}-${index}`} title={file.name} className="attachment-file relative inline-flex max-w-55 items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-2 text-text">
          <FileText size={22} className="shrink-0 text-muted" />
          <span className="attachment-file-name truncate text-sm">{file.name}</span>
          <button type="button" className="absolute -right-[5px] -top-[5px] inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-surface p-0 text-text hover:bg-text hover:text-background" title="移除文件" aria-label={`移除 ${file.name}`} onClick={() => onAttachmentsChange(attachments.filter((_, i) => i !== index))}><X size={11} /></button>
        </li>)}
      </ul>}
      <input ref={picker} type="file" multiple className="hidden" aria-label="选择文件（支持多选）" onChange={(event) => void addFiles(event.target.files)} />
      <input ref={element => { folderPicker.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" multiple className="hidden" aria-label="上传文件夹" onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
      <div className="composer-actions research-start-toolbar flex min-h-12.5 flex-wrap items-center gap-2 border-t border-border-variant pt-2.5">
        <IconButton type="button" className="composer-attach" title="上传文件或 ZIP（支持多选）" aria-label="上传文件或 ZIP（支持多选）" onClick={() => picker.current?.click()}><FileUp size={16} /></IconButton>
        <IconButton type="button" title="上传整个文件夹" aria-label="上传整个文件夹" onClick={() => folderPicker.current?.click()}><FolderUp size={16} /></IconButton>
        <div className="min-w-0 flex-1" />
        <ModelPicker value={selection} onSelect={(preferredAgent) => saveSelection.mutate({ preferredAgent })} onOpenSettings={() => void navigate({ to: "/settings/$tab", params: { tab: "harnesses" } })} permissionChoices={harness?.options.permissionModes} defaultPermissionId={harness?.options.defaultPermissionMode} onSelectPermission={(permissionMode) => { if (selection) saveSelection.mutate({ preferredAgent: { ...selection, permissionMode } }); }} reasoningChoices={reasoning.choices} defaultReasoningId={reasoning.defaultId} onSelectReasoning={(reasoningLevel) => { if (selection) saveSelection.mutate({ preferredAgent: { ...selection, reasoningLevel } }); }} openRequest={modelRequest} autonomy={uiState?.preferredAutonomy ?? undefined} onSelectAutonomy={(preferredAutonomy) => saveSelection.mutate({ preferredAutonomy })} />
        <WorkModeSwitch value={workMode} onChange={onWorkModeChange} compact />
        <IconButton type="submit" variant="primary" className="send-btn ms-auto" title={draft.trim() || attachments.length ? "准备研究" : "创建空白项目"} aria-label={draft.trim() || attachments.length ? "准备研究" : "创建空白项目"} disabled={saveSelection.isPending}><CornerDownLeft size={16} /></IconButton>
      </div>
      </div>
    </form>
    <div className="mt-2 flex justify-start"><div className="new-chat-project-picker"><ComposerProjectPicker projects={projects} activity={activity} projectId={project?.id ?? ""} projectName={project?.name ?? "新项目"} onSelect={onSelectProject} onNewProject={() => onSelectProject("")} /></div></div>
  </section>;
}

export { ResearchCases } from "./FeaturedCases";
