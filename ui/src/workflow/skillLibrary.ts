import type { WorkflowLibrarySkill } from "./model";

/** 技能库的展示逻辑：中文展示名、搜索、来源筛选与生效状态。
 *
 * 内置技能的 SKILL.md 是写给模型看的英文说明，直接铺在中文界面上既难扫读，
 * 也会挤掉真正要紧的信息。这里的名称与摘要只负责展示：技术标识（orx-*）照常
 * 保留，技能文件本身不做任何改写；没登记的条目回退到原始英文描述。
 *
 * 本模块不引入任何运行时依赖，UI 测试可以直接加载它。 */

interface BuiltinSkillLabel {
  title: string;
  summary: string;
}

const BUILTIN_LABELS: Record<string, BuiltinSkillLabel> = {
  "orx-research-team": { title: "科研专家团", summary: "组织专家会诊、独立评审与需要人拍板的决策。" },
  "orx-experiment-tree": { title: "实验树", summary: "规划实验节点、固定运行契约，推进整棵实验树。" },
  "orx-git": { title: "代码与分支", summary: "读写实验代码、提交与对比改动，协调共享工作树。" },
  "orx-agent-delegation": { title: "子会话派发", summary: "按新对话的配置派生独立项目会话，并行推进任务。" },
  "orx-compute": { title: "算力任务", summary: "在本机、SSH、HF、Modal、K8s 等算力上启动并监控实验。" },
  "orx-instances": { title: "算力实例", summary: "创建常驻实例，做手动或零散的计算工作。" },
  "orx-logs": { title: "运行日志", summary: "定位并读取实验输出，排查运行失败。" },
  "orx-results": { title: "结果解读", summary: "汇总测量结果、比较多次运行，给出下一步建议。" },
  "orx-reports": { title: "成果归档", summary: "把报告、数据集等长期产出存进成果目录。" },
  "orx-figures": { title: "图表", summary: "生成对话里的交互式图表和论文用的静态图。" },
  "orx-paper": { title: "论文写作", summary: "用 LaTeX 起草论文、预印本或其中某一节。" },
  "orx-customize": { title: "技能与模板", summary: "把可复用的技能和 LaTeX 模板登记到产品里。" },
  "orx-skill-creator": { title: "技能工坊", summary: "从问清需求到起草、登记、试用迭代，把重复做法写成可复用技能。" },
  "orx-lit-review": { title: "文献证据", summary: "基于原始文献解释、比较科学概念，支撑综述与相关工作。" },
  "orx-feedback": { title: "产品反馈", summary: "把使用中遇到的问题或建议通过 orx feedback 上报。" },
};

export function builtinSkillLabel(name: string, description?: string | null): BuiltinSkillLabel {
  const label = BUILTIN_LABELS[name];
  if (label) return label;
  return { title: name, summary: description?.trim() || "内置技能模块" };
}

export type SkillSourceFilter = "all" | "mine" | "builtin";

export const SOURCE_FILTERS: { value: SkillSourceFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "mine", label: "我的" },
  { value: "builtin", label: "内置" },
];

/** 卡片标题：内置技能用中文展示名，用户技能用技能名本身。 */
export function skillTitle(skill: Pick<WorkflowLibrarySkill, "name" | "source" | "description">): string {
  return skill.source === "builtin" ? builtinSkillLabel(skill.name, skill.description).title : skill.name;
}

/** 卡片摘要：内置技能用中文一句话用途，用户技能用自己的用途说明。 */
export function skillSummary(
  skill: Pick<WorkflowLibrarySkill, "name" | "source" | "description" | "origin">,
): string {
  if (skill.source === "builtin") return builtinSkillLabel(skill.name, skill.description).summary;
  const described = skill.description?.trim();
  if (described) return described;
  return skill.origin ? `来自 ${skill.origin} 的镜像技能` : "还没有用途说明";
}

/** 名称、展示名与用途都参与搜索；空查询视为全部命中。 */
export function skillMatchesQuery(
  skill: Pick<WorkflowLibrarySkill, "name" | "source" | "description" | "origin">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [skill.name, skillTitle(skill), skillSummary(skill)].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function skillMatchesFilter(skill: WorkflowLibrarySkill, filter: SkillSourceFilter): boolean {
  if (filter === "all") return true;
  return filter === "mine" ? skill.source === "user" : skill.source === "builtin";
}

export type SkillUsage =
  | { kind: "builtin" }
  | { kind: "legacy" }
  | { kind: "bound"; projects: number; agents: number }
  | { kind: "on-demand" };

/** 生效状态只映射现有的绑定模型，不额外造一套“启用/停用”语义。 */
export function skillUsage(
  skill: Pick<WorkflowLibrarySkill, "source" | "legacyGlobal" | "boundProjects" | "boundAgents">,
): SkillUsage {
  if (skill.source === "builtin") return { kind: "builtin" };
  if (skill.legacyGlobal) return { kind: "legacy" };
  const projects = skill.boundProjects?.length ?? 0;
  const agents = skill.boundAgents?.length ?? 0;
  if (projects + agents > 0) return { kind: "bound", projects, agents };
  return { kind: "on-demand" };
}

export function skillUsageLabel(usage: SkillUsage): string {
  switch (usage.kind) {
    case "builtin": return "内置";
    case "legacy": return "全局生效";
    case "bound": return "自动携带";
    default: return "按需使用";
  }
}

/** 详情页的生效范围说明：把绑定数量摊开成一句话。 */
export function skillScopeSummary(name: string, usage: SkillUsage): string {
  switch (usage.kind) {
    case "builtin":
      return "内置技能随产品发布，所有会话都会带上。";
    case "legacy":
      return "历史上传，保留全局生效：所有会话都会自动带上它。";
    case "bound": {
      const parts = [
        usage.projects > 0 ? `${usage.projects} 个项目` : null,
        usage.agents > 0 ? `${usage.agents} 个专家` : null,
      ].filter((part): part is string => part !== null);
      return `已绑定 ${parts.join("、")}：这些会话会自动带上它。`;
    }
    default:
      return `未绑定：不随任何会话自动携带；在对话里输入 /${name} 仍可直接使用。`;
  }
}
