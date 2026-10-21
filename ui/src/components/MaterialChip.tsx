import { useState } from "react";
import { FileText } from "lucide-react";
import { projectRequest, projectAssetUrl } from "../readOnlyApi";

type Material = { id: string; files: { id: string; path: string; size: number; format: string; status: string; note?: string }[] };
const statuses: Record<string, string> = { ready: "可读取", "on-demand": "按页读取", "needs-vision": "需要视觉读取", unsupported: "原件已保存，需专用工具", failed: "解析失败", stored: "已保存" };
export function MaterialChip({ id }: { id: string }) {
  const [material, setMaterial] = useState<Material | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  async function toggle() {
    setOpen(!open);
    if (material || loading) return;
    setLoading(true); setError("");
    try {
      const result = await projectRequest(`/api/materials/${encodeURIComponent(id)}`);
      if (!result.ok) throw new Error("无法读取材料清单");
      setMaterial(await result.json());
    } catch (error) { setError(String(error)); }
    finally { setLoading(false); }
  }
  return <div className="mt-2 max-w-full rounded-md border border-border-variant text-sm">
    <button type="button" className="flex items-center gap-2 px-3 py-2" aria-expanded={open} onClick={() => void toggle()}><FileText size={16} />研究材料{material ? ` · ${material.files.length} 个文件` : ` · ${id.slice(0, 8)}`}</button>
    {open && <div className="max-h-80 overflow-auto border-t border-border-variant p-3">
      <p className="m-0 mb-2 text-xs text-muted">材料已保存不代表已完整阅读。引用以本次导入版本为准。</p>
      {loading && <p role="status">正在读取清单…</p>}{error && <p role="alert">{error}</p>}
      {material?.files.map(file => <div key={file.id} className="mb-2 flex flex-col gap-1">
        <a className="break-all text-primary" href={projectAssetUrl(`/api/materials/${encodeURIComponent(id)}/${encodeURIComponent(file.id)}/download`)} download={file.path.split("/").at(-1)}>{file.path}</a>
        <span className="text-xs text-subtext">{file.id} · {statuses[file.status] || file.status}{file.note ? ` · ${file.note}` : ""}</span>
      </div>)}
    </div>}
  </div>;
}
