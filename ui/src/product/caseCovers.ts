import reproductionCover from "../assets/workbench/reproduction.png";
import experimentCover from "../assets/workbench/experiment.png";
import reviewCover from "../assets/workbench/review.png";
import analysisCover from "../assets/workbench/cover-analysis.svg";
import ideationCover from "../assets/workbench/cover-ideation.svg";
import computationCover from "../assets/workbench/cover-computation.svg";

export interface CaseCoverPreset {
  id: string;
  label: string;
  src: string;
}

export const CASE_COVER_PRESETS: CaseCoverPreset[] = [
  { id: "preset:experiment", label: "科学实验", src: experimentCover },
  { id: "preset:review", label: "文献综述", src: reviewCover },
  { id: "preset:reproduction", label: "实验复现", src: reproductionCover },
  { id: "preset:analysis", label: "数据分析", src: analysisCover },
  { id: "preset:ideation", label: "课题构思", src: ideationCover },
  { id: "preset:computation", label: "数值仿真", src: computationCover },
];

const PRESET_MAP = new Map(CASE_COVER_PRESETS.map((preset) => [preset.id, preset.src]));

export function pickAutoCaseCover(item: { category?: string; title?: string }, index: number): string {
  const source = `${item.category ?? ""} ${item.title ?? ""}`;
  if (/综述|文献|survey|review/i.test(source)) return reviewCover;
  if (/构思|idea|假设|灵感|探索|proposal|ideation/i.test(source)) return ideationCover;
  if (/数据|统计|预测|回归|实证|分析|analysis|forecast/i.test(source)) return analysisCover;
  if (/仿真|计算|算法|架构|模型|数值|simulation|compute/i.test(source)) return computationCover;
  if (/实验|测试|benchmark|experiment/i.test(source)) return experimentCover;
  if (/复现|reproduction/i.test(source)) return reproductionCover;
  return CASE_COVER_PRESETS[index % CASE_COVER_PRESETS.length].src;
}

export function resolveCaseCoverSrc(
  base: string,
  item: { id: string; cover?: string | null; category?: string; title?: string },
  index: number,
  admin = false,
): string {
  const cover = item.cover?.trim();
  if (cover && PRESET_MAP.has(cover)) {
    return PRESET_MAP.get(cover)!;
  }
  if (cover?.startsWith("asset:") && base) {
    const assetName = cover.slice("asset:".length);
    return `${base}/api/platform/${admin ? "admin/cases" : "cases"}/${encodeURIComponent(item.id)}/assets?name=${encodeURIComponent(assetName)}`;
  }
  return pickAutoCaseCover(item, index);
}
