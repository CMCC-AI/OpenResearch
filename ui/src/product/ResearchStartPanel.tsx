import { pendingMaterials, validateMaterialFiles } from "../materialUploads";
import { useRef } from "react";
import { ArrowRight, FileText, FileUp, FolderUp, X } from "lucide-react";
import type { ComposerAttachment } from "../composerStash";
import { WorkModeSwitch, type WorkMode } from "../components/WorkModeSwitch";
import { ProductWordmark } from "./ProductNav";
import { IconButton } from "../components/ui/IconButton";
import { quickCapabilities } from "./researchCapabilities";

export function ResearchStartPanel({ draft, onDraftChange, attachments, onAttachmentsChange, onStart, onError, workMode, onWorkModeChange }: {
  draft: string; onDraftChange: (value: string) => void;
  attachments: ComposerAttachment[]; onAttachmentsChange: (value: ComposerAttachment[]) => void;
  workMode: WorkMode; onWorkModeChange: (mode: WorkMode) => void;
  onStart: () => void; onError: (message: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const currentAttachments = useRef(attachments);
  currentAttachments.current = attachments;
  async function addFiles(files: FileList | null) {
    if (!files) return;
    try {
      const selected = pendingMaterials(Array.from(files));
      validateMaterialFiles(selected.map(file => ({ name: file.name || "file", size: file.size })), currentAttachments.current);
      onAttachmentsChange([...currentAttachments.current, ...selected]);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { if (picker.current) picker.current.value = ""; }
  }
  return <section className="research-start mb-12" aria-labelledby="new-research-title">
    <header className="research-start-heading mb-8"><div className="flex flex-wrap items-center gap-4"><ProductWordmark heading /><h1 id="new-research-title" className="product-page-title m-0">今天，想推进哪一项研究</h1></div><p className="product-page-description mt-3 mb-0">从一个问题、一篇论文、一组数据或一份草稿开始，科研智能体将按需协作。</p></header>
    <form onSubmit={(event) => { event.preventDefault(); onStart(); }} className="research-start-composer rounded-2xl border border-border-variant bg-background p-4">
      <label htmlFor="research-objective" className="sr-only">研究目标</label>
      <textarea id="research-objective" ref={draftRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="描述你的研究目标，或上传论文、代码、数据与草稿……" className="research-objective min-h-24 w-full resize-y border-0 bg-transparent p-0 text-base focus:border-0" />
      {attachments.length > 0 && <ul className="composer-attachments m-0 mb-3 flex list-none flex-wrap gap-1.5 p-0">
        {attachments.map((file, index) => <li key={`${file.name}-${index}`} title={file.name} className="attachment-file relative inline-flex max-w-55 items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-2 text-text">
          <FileText size={22} className="shrink-0 text-muted" />
          <span className="attachment-file-name truncate text-sm">{file.name}</span>
          <button type="button" className="absolute -right-[5px] -top-[5px] inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-surface p-0 text-text hover:bg-text hover:text-background" title="移除文件" aria-label={`移除 ${file.name}`} onClick={() => onAttachmentsChange(attachments.filter((_, i) => i !== index))}><X size={11} /></button>
        </li>)}
      </ul>}
      <input ref={picker} type="file" multiple className="hidden" aria-label="选择文件（支持多选）" onChange={(event) => void addFiles(event.target.files)} />
      <input ref={element => { folderPicker.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" multiple className="hidden" aria-label="上传文件夹" onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
      <div className="research-start-mode mb-3"><WorkModeSwitch value={workMode} onChange={onWorkModeChange} /></div>
      <div className="research-start-toolbar flex flex-wrap items-center gap-2 border-t border-border-variant pt-3">
        <IconButton type="button" className="composer-attach" title="上传文件或 ZIP（支持多选）" aria-label="上传文件或 ZIP（支持多选）" onClick={() => picker.current?.click()}><FileUp size={16} /></IconButton>
        <IconButton type="button" title="上传整个文件夹" aria-label="上传整个文件夹" onClick={() => folderPicker.current?.click()}><FolderUp size={16} /></IconButton>
        <button type="submit" className="research-start-submit ms-auto inline-flex min-h-10 items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium">{draft.trim() || attachments.length ? "准备研究" : "创建空白项目"} <ArrowRight size={16} /></button>
      </div>
    </form>
    <p className="mt-2 text-sm text-muted">下一步确认项目名称与存储位置；不填写内容时仅创建空白项目。目标和材料会保留为草稿，点击发送后才启动研究。</p>
    <div className="research-quick-actions mt-4 flex flex-wrap gap-2">{quickCapabilities.map(({ title, prompt }) => <button key={title} onClick={() => { onDraftChange(prompt); draftRef.current?.focus(); }} aria-pressed={draft === prompt} className="inline-flex items-center justify-center rounded-full border border-border-variant bg-transparent px-3 py-1.5 text-sm text-subtext hover:border-primary hover:text-primary">{title}</button>)}</div>
  </section>;
}

export { ResearchCases } from "./FeaturedCases";
