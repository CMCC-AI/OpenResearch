import { useRef } from "react";
import { ArrowRight, Code2, Database, FileText, Paperclip, X } from "lucide-react";
import type { ComposerAttachment } from "../composerStash";
import { WorkModeSwitch, type WorkMode } from "../components/WorkModeSwitch";
import { ProductWordmark } from "./ProductNav";
import { quickCapabilities } from "./researchCapabilities";

export function ResearchStartPanel({ draft, onDraftChange, attachments, onAttachmentsChange, onStart, onError, workMode, onWorkModeChange }: {
  draft: string; onDraftChange: (value: string) => void;
  attachments: ComposerAttachment[]; onAttachmentsChange: (value: ComposerAttachment[]) => void;
  workMode: WorkMode; onWorkModeChange: (mode: WorkMode) => void;
  onStart: () => void; onError: (message: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const currentAttachments = useRef(attachments);
  currentAttachments.current = attachments;
  async function addFiles(files: FileList | null) {
    if (!files) return;
    try {
      const textMaterials: string[] = [];
      const added = await Promise.all(Array.from(files).map(async (file) => {
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB，请在研究工作区引用文件路径。`);
        if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(file.type)) {
          if (file.size > 100 * 1024 || !/\.(txt|md|csv|json|py|js|ts|r|yaml|yml|tex)$/i.test(file.name)) throw new Error(`${file.name} 请通过项目文件夹导入；此处支持 PDF、图片和小型文本材料。`);
          textMaterials.push(`材料：${file.name}\n${await file.text()}`);
          return null;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
          reader.readAsDataURL(file);
        });
        return { dataUrl, mediaType: file.type || "application/octet-stream", name: file.name, size: file.size };
      }));
      const combined = [...currentAttachments.current, ...added.filter((file) => file !== null)];
      if (combined.reduce((total, file) => total + (file.size ?? 0), 0) > 40 * 1024 * 1024) throw new Error("附件总大小不能超过 40 MB。");
      onAttachmentsChange(combined);
      if (textMaterials.length) onDraftChange([currentDraft.current, ...textMaterials].filter(Boolean).join("\n\n"));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { if (picker.current) picker.current.value = ""; }
  }
  return <section className="research-start mb-12" aria-labelledby="new-research-title">
    <header className="research-start-heading mb-8"><div className="flex flex-wrap items-center gap-4"><ProductWordmark heading /><h1 id="new-research-title" className="product-page-title m-0">今天，想推进哪一项研究</h1></div><p className="product-page-description mt-3 mb-0">从一个问题、一篇论文、一组数据或一份草稿开始，科研智能体将按需协作。</p></header>
    <form onSubmit={(event) => { event.preventDefault(); onStart(); }} className="research-start-composer rounded-2xl border border-border-variant bg-background p-4">
      <label htmlFor="research-objective" className="sr-only">研究目标</label>
      <textarea id="research-objective" ref={draftRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="描述你的研究目标，或上传论文、代码、数据与草稿……" className="research-objective min-h-24 w-full resize-y border-0 bg-transparent p-0 text-base focus:border-0" />
      {attachments.length > 0 && <ul className="m-0 mb-3 flex list-none flex-wrap gap-2 p-0">{attachments.map((file, index) => <li key={`${file.name}-${index}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs"><span className="truncate">{file.name}</span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => onAttachmentsChange(attachments.filter((_, i) => i !== index))}><X size={14} /></button></li>)}</ul>}
      <input ref={picker} type="file" multiple className="hidden" aria-label="上传研究材料" onChange={(event) => void addFiles(event.target.files)} />
      <div className="research-start-mode mb-3"><WorkModeSwitch value={workMode} onChange={onWorkModeChange} /></div>
      <div className="research-start-toolbar flex flex-wrap items-center gap-2 border-t border-border-variant pt-3">{[{ title: "论文", Icon: FileText }, { title: "代码", Icon: Code2 }, { title: "数据", Icon: Database }, { title: "草稿", Icon: Paperclip }].map(({ title, Icon }) => <button key={title} type="button" onClick={() => picker.current?.click()} className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-xs text-subtext hover:bg-surface hover:text-primary"><Icon size={16} />{title}</button>)}<button type="submit" className="research-start-submit ms-auto inline-flex min-h-10 items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium">{draft.trim() || attachments.length ? "准备研究" : "创建空白项目"} <ArrowRight size={16} /></button></div>
    </form>
    <p className="mt-2 text-sm text-muted">下一步确认项目名称与存储位置；不填写内容时仅创建空白项目。目标和材料会保留为草稿，点击发送后才启动研究。</p>
    <div className="research-quick-actions mt-4 flex flex-wrap gap-2">{quickCapabilities.map(({ title, prompt }) => <button key={title} onClick={() => { onDraftChange(prompt); draftRef.current?.focus(); }} aria-pressed={draft === prompt} className="inline-flex items-center justify-center rounded-full border border-border-variant bg-transparent px-3 py-1.5 text-sm text-subtext hover:border-primary hover:text-primary">{title}</button>)}</div>
  </section>;
}

export { ResearchCases } from "./FeaturedCases";
