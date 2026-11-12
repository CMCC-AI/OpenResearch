import type { OptionChoice } from "./api";
import { getLocale } from "./paraglide/runtime.js";

/**
 * Harness CLIs report permission modes and reasoning variants with English
 * labels (see `src/local/harness`). The wire contract stays English; the
 * dashboard translates the known vocabulary for display only and leaves
 * unknown native ids untouched.
 */
const ZH_CN: Record<string, string> = {
  // Reasoning variants / effort tiers.
  Default: "默认",
  Minimal: "最低",
  Low: "低",
  Medium: "中",
  High: "高",
  XHigh: "超高",
  Max: "最高",
  // Permission modes.
  "Auto-approve": "自动批准",
  "Ask for approval": "请求批准",
  "Bypass permissions": "跳过权限确认",
  Manual: "手动",
  "Accept edits": "自动接受编辑",
  Plan: "计划",
  Auto: "自动",
  "Approve for me": "代为审批",
  "Full access": "完全访问",
  Ask: "仅问答",
  // Permission mode descriptions.
  "Ask before actions that need your approval": "执行需要授权的操作前先询问你",
  "Approve requests automatically, except actions you have denied": "自动批准请求，已拒绝的操作除外",
  "Ask before changes; allow read-only planning": "修改前先询问；允许只读规划",
  "Allow commands and skip tool confirmation prompts": "允许执行命令并跳过工具确认",
  "Always ask before making changes": "每次修改前都先询问",
  "Automatically accept all file edits": "自动接受所有文件编辑",
  "Create a plan before making changes": "修改前先制定计划",
  "Claude handles permission decisions": "由 Claude 自行决定权限",
  "Accepts all permissions": "接受所有权限请求",
  "Ask before commands that need elevated access": "执行需要提升权限的命令前先询问",
  "Codex reviews approval requests automatically": "由 Codex 自动审核批准请求",
  "Run without sandbox or approval prompts": "不使用沙箱，也不弹出批准确认",
  "Answer questions without changing files": "只回答问题，不修改文件",
  "Allow commands unless explicitly denied": "允许执行命令，明确拒绝的除外",
  "Allow commands and disable the sandbox": "允许执行命令并关闭沙箱",
};

function translate(text: string): string {
  return ZH_CN[text] ?? text;
}

export function localizeOptionChoices(choices: OptionChoice[]): OptionChoice[] {
  if (getLocale() !== "zh-CN") return choices;
  return choices.map((choice) => ({
    ...choice,
    label: translate(choice.label),
    ...(choice.description ? { description: translate(choice.description) } : {}),
  }));
}
