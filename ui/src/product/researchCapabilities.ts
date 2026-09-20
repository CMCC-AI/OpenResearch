import {
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  BrainCircuit,
  ChartNoAxesCombined,
  CircleCheckBig,
  Code2,
  Database,
  FileSearch,
  FileText,
  FlaskConical,
  GitBranch,
  Lightbulb,
  Map,
  Microscope,
  PackageCheck,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface CapabilityItem {
  title: string;
  description: string;
  icon: LucideIcon;
  prompt: string;
}

export interface CapabilityStage {
  number: string;
  title: string;
  subtitle: string;
  items: CapabilityItem[];
}

export const capabilityStages: CapabilityStage[] = [
  {
    number: "01", title: "发现与理解", subtitle: "建立可信的研究认知",
    items: [
      { title: "论文发现", description: "从多个开放来源检索论文", icon: FileSearch, prompt: "帮我围绕研究主题检索并筛选关键论文" },
      { title: "论文精读", description: "拆解方法、证据与局限", icon: BookOpen, prompt: "精读这篇论文，解释核心方法、实验和局限" },
      { title: "跨论文问答", description: "对齐多篇论文中的证据", icon: Bot, prompt: "比较这些论文的结论和证据差异" },
      { title: "文献综述", description: "形成证据矩阵与研究空白", icon: Boxes, prompt: "生成可追溯的系统文献综述" },
      { title: "研究地图", description: "整理领域脉络和关键分支", icon: Map, prompt: "绘制该方向的研究脉络与关键分支" },
    ],
  },
  {
    number: "02", title: "构思与定义", subtitle: "把问题转化为可检验假设",
    items: [
      { title: "Idea 澄清", description: "界定目标、约束和价值", icon: Lightbulb, prompt: "把这个研究想法澄清成可执行的问题" },
      { title: "新颖性检查", description: "定位近似工作与差异", icon: SearchCheck, prompt: "检查这个想法的新颖性和最接近工作" },
      { title: "假设形成", description: "给出可证伪的研究假设", icon: BrainCircuit, prompt: "将研究问题转化为可证伪假设" },
      { title: "研究问题定义", description: "明确变量、范围和成功标准", icon: CircleCheckBig, prompt: "定义研究范围、变量与成功标准" },
    ],
  },
  {
    number: "03", title: "方法与实验设计", subtitle: "形成可执行的研究方案",
    items: [
      { title: "方法设计", description: "拆解方法和技术路线", icon: GitBranch, prompt: "设计研究方法和技术路线" },
      { title: "实验设计", description: "设置基线、对照和消融", icon: FlaskConical, prompt: "设计基线、对照组、消融和重复实验" },
      { title: "指标与基线", description: "定义可靠的评价协议", icon: BarChart3, prompt: "定义指标、基线和统计验证方案" },
      { title: "资源可行性", description: "评估数据、环境和算力", icon: Database, prompt: "评估数据、环境、预算和算力可行性" },
    ],
  },
  {
    number: "04", title: "实现与验证", subtitle: "用代码、数据和实验检验",
    items: [
      { title: "代码与数据接管", description: "理解并准备现有仓库", icon: Code2, prompt: "接管当前代码和数据，建立可运行基线" },
      { title: "论文复现", description: "从论文建立可验证基线", icon: Microscope, prompt: "复现目标论文并记录与原文结果的差异" },
      { title: "环境构建", description: "固定依赖、数据和运行配置", icon: Boxes, prompt: "构建可复现的实验环境" },
      { title: "实验执行", description: "运行实验并保留日志产物", icon: Sparkles, prompt: "执行已确认实验并记录全部运行事实" },
      { title: "失败诊断", description: "分析异常和负结果", icon: ShieldCheck, prompt: "诊断失败实验并提出最小验证步骤" },
    ],
  },
  {
    number: "05", title: "分析与表达", subtitle: "沉淀结果并接受评审",
    items: [
      { title: "结果分析", description: "比较运行、指标和不确定性", icon: ChartNoAxesCombined, prompt: "分析实验结果、误差和统计可靠性" },
      { title: "科研绘图", description: "生成可追溯图表", icon: BarChart3, prompt: "基于实验结果制作科研图表" },
      { title: "论文写作", description: "组织论证、引用与稿件", icon: FileText, prompt: "基于已验证证据撰写论文稿件" },
      { title: "引用核验", description: "检查结论与来源一致性", icon: SearchCheck, prompt: "核验稿件中的引用和结论强度" },
      { title: "模拟审稿", description: "独立评估并生成修订清单", icon: ShieldCheck, prompt: "以独立审稿人视角评估稿件" },
      { title: "研究包", description: "整理代码、数据和复现说明", icon: PackageCheck, prompt: "整理可交付的完整研究包" },
    ],
  },
];

export const quickCapabilities = [
  capabilityStages[0].items[1], capabilityStages[0].items[3], capabilityStages[1].items[0],
  capabilityStages[3].items[1], capabilityStages[4].items[0], capabilityStages[4].items[2],
];
