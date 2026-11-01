/** Public comparable-task results. Detailed provenance is kept in docs/product/benchmark-comparison.md. */
export const benchmarkComparison = [
  { name: "Open Science", uplift: 31.0 },
  { name: "Claude Code", uplift: 36.8 },
  { name: "Codex CLI", uplift: 48.0 },
  { name: "OpenClaw", uplift: 78.5 },
] as const;

export const benchmarkFields = ["能源", "生命科学", "化学", "信息科学"] as const;

/** Each field is independently normalized to MobileSci=100; these are not absolute scores. */
export const benchmarkProducts = [
  { name: "MobileSci", values: [100, 100, 100, 100] },
  { name: "Open Science", values: [57.8, 60.1, 45.3, 49.6] },
  { name: "Claude Code", values: [68.2, 66.2, 10.4, 60.7] },
  { name: "Codex CLI", values: [72.3, 67.3, 16.7, 67.9] },
  { name: "OpenClaw", values: [69.0, 63.7, 3.5, 24.6] },
] as const;

export const benchmarkFieldNotes = [
  "能源研究中的仿真、参数识别与成本分析。",
  "生命科学中的数据建模、配方预测与优化。",
  "化学研究中的结构数据处理与专业建模。",
  "信息科学中的论文理解、多步推导与方法验证。",
] as const;
