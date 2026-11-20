import { Activity, Blocks, BookOpen, Bot, ChartColumn, CodeXml, Compass, Cpu, FileText, FlaskConical, GitBranch, Globe, ListChecks, ListTree, PenLine, Play, Scale, ScrollText, Search, Server, ShieldCheck, Table2, Users, Workflow } from "lucide-react";
import type { WorkflowLibrarySkill } from "./model";

/** 能力库的彩色图标磁贴：按名称关键词确定性映射图标与色系，
 * 与能力中心的彩色图标语言保持一致；未知名称按名字哈希轮换色系，不引入随机性。 */

type CapabilityTone = "blue" | "green" | "amber" | "teal" | "purple";

const TONE_CLASSES: Record<CapabilityTone, string> = {
  blue: "bg-accent-blue-subtle text-accent-blue",
  green: "bg-accent-green-subtle text-accent-green",
  amber: "bg-accent-amber-subtle text-accent-amber",
  teal: "bg-accent-teal-subtle text-accent-teal",
  purple: "bg-accent-purple-subtle text-accent-purple",
};

const TONES: CapabilityTone[] = ["blue", "green", "amber", "teal", "purple"];

const SIZE_CLASSES = { sm: "size-6 rounded-md", md: "size-10 rounded-lg" } as const;
const ICON_SIZES = { sm: 14, md: 20 } as const;

type Icon = typeof Blocks;

// 技能：先按文献/实验/数据等关键词对号入座，未命中的用默认块图标 + 哈希色。
const SKILL_RULES: Array<[RegExp, Icon, CapabilityTone]> = [
  [/lit|paper|review|survey|文献|综述/, BookOpen, "blue"],
  [/search|retriev|discover|检索|发现/, Search, "blue"],
  [/experiment|protocol|实验/, FlaskConical, "green"],
  [/result|table|dataset|结果|数据/, Table2, "teal"],
  [/report|报告/, FileText, "purple"],
  [/figure|chart|plot|图/, ChartColumn, "amber"],
  [/git|branch|repo/, GitBranch, "amber"],
  [/compute|instance|cpu|sandbox|uv|算力|实例/, Cpu, "purple"],
  [/log|history|日志/, ScrollText, "teal"],
  [/team|delegation|collab|协作|团队/, Users, "teal"],
  [/run|执行/, Play, "green"],
];

// 专家：按角色职责映射；规则顺序即优先级，更具体的职责放前面。
const AGENT_RULES: Array<[RegExp, Icon, CapabilityTone]> = [
  [/审计|盘点|audit/, Scale, "purple"],
  [/代码|code/, CodeXml, "blue"],
  [/写作|引用|citation|编辑|润色/, PenLine, "purple"],
  [/实验/, FlaskConical, "green"],
  [/诊断|失败|diagnos/, Activity, "teal"],
  [/执行|operator|run/, Play, "green"],
  [/审稿|独立|independent|验证|gate/, ShieldCheck, "teal"],
  [/图表|figure|图/, ChartColumn, "amber"],
  [/检索|search|策略/, Search, "blue"],
  [/可行性|需求|intent|顾问|advisor|识别|router/, Compass, "blue"],
  [/方法|method/, ListChecks, "teal"],
  [/大纲|outline/, ListTree, "blue"],
  [/文献|literature|论文|paper/, BookOpen, "blue"],
];

function toneFor(seed: string): CapabilityTone {
  const sum = [...seed].reduce((total, ch) => total + ch.charCodeAt(0), 0);
  return TONES[sum % TONES.length];
}

function iconFor(kind: "skill" | "agent" | "mcp" | "workflow", text: string, hint: string | undefined): { icon: Icon; tone: CapabilityTone } {
  if (kind === "workflow") return { icon: Workflow, tone: "blue" };
  if (kind === "mcp") return hint === "http" ? { icon: Globe, tone: "teal" } : { icon: Server, tone: "teal" };
  const rules = kind === "agent" ? AGENT_RULES : SKILL_RULES;
  for (const [pattern, icon, tone] of rules) {
    if (pattern.test(text)) return { icon, tone };
  }
  return { icon: kind === "agent" ? Bot : Blocks, tone: toneFor(text) };
}

export function CapabilityTile({ kind, name, size = "sm", hint }: { kind: "skill" | "agent" | "mcp" | "workflow"; name: string; size?: keyof typeof SIZE_CLASSES; hint?: string }) {
  const { icon: Icon, tone } = iconFor(kind, name.toLowerCase(), hint);
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center ${SIZE_CLASSES[size]} ${TONE_CLASSES[tone]}`}>
    <Icon size={ICON_SIZES[size]} strokeWidth={1.75} />
  </span>;
}

/** 技能卡片的说明行：有描述用描述，没有则回退到来源说明（与侧栏行一致）。 */
export function skillCardSummary(skill: Pick<WorkflowLibrarySkill, "source" | "origin" | "description">): string {
  return skill.description || (skill.source === "builtin" ? "内置技能模块" : skill.origin ? `来自 ${skill.origin} 的镜像技能` : "本地上传的技能包");
}
