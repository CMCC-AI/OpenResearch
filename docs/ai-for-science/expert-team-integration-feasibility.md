# 科研专家团与 OpenResearch 流程对比及接入可行性

核查日期：2026-10-09。本文是静态代码与配置分析，不是接入实现或端到端验收。

分析范围：当前 OpenResearch 工作区，以及 `/Users/levent/cmccProjects/ai-agents/opencode` 中的 `app-cmcc`、专家配置和 OpenCode 调度实现。后者才是本机包含科研专家团的 OpenCode 项目，另一个 `cmccProjects/opencode` 不含 `app-cmcc`。

OpenResearch 当前处于有未完成合并的工作区，存在多个 unmerged 文件；结论按已读的当前文件判断，不代表某个可发布提交。本文不处理原有合并冲突，不修改两个项目的业务代码。

## 1. 决策建议

接入可行。建议采用 **独立的用户入口与研究模式，融合执行、证据和项目数据**：用户可以选择“科研专家团”，专家团内部真实实验仍进入 OpenResearch 的实验树、运行记录与计算后端。

先融合文献策略、资产审计、实验方案、独立审查等能力，再接入完整动态组队。暂不把全体 20 位专家及 G1–G4 流程强制加入每个普通研究会话，也不另建一套与 OpenResearch 并行的实验运行系统。

两者是可互补的不同层：OpenResearch 提供研究工作空间与运行基础设施；专家团提供角色分工和科研过程规范。两者都能支持文献、实验与写作，不能简单归类为一个只执行、另一个只思考。

## 2. 当前两条流程

### OpenResearch

用户目标 / 论文 / 本地仓库 → 项目和会话 → Agent 理解材料、检索文献、提出假设 → 建立或运行基线 → 创建实验子节点 → 在 Git 分支实施并提交 → 固定代码 revision 的快照 → 提交计算后端 → supervise 跟踪日志与终态 → 等待完成或注册会话唤醒 → 分析结果 → 修复、补充候选、晋升优胜节点或停止 → 报告 / 图表 / 论文。

- 主 Agent 通过 harness 执行，支持 OpenCode、Codex、Claude Code 等；专用技能指导科研工作。
- 自动实验迭代是 Agent 依据技能执行的流程，不能视为一个由后端自动判定科学结论的固定状态机。
- 实验树体现假设之间的继承：同轮候选是兄弟，下一轮从上一轮胜者向下发展。
- 每个 Run 有命令、提交、后端、退出码、日志、终态与取消意图；源代码快照有摘要校验。
- 已有通用助手会话调度。`orx agent spawn` 当前最多 5 个同时存活助手，助手不能再经该命令递归派生；这不是所有 harness 原生子代理机制的统一上限。
- Copilot 与 Agentic 通过每轮上下文控制研究自主程度；Copilot 要求先征求决策，属于 Agent 指令层。
- “已回答节点冻结”“固定命令和环境”等也是科研技能纪律。数据库/API 仍支持命令更新，不应将这些全部描述为程序强制不变量。

我们改造后增加了科研能力入口、论文发现、Deep Literature 和统一账号；能力卡片主要提供会话提示，不代表已建立每项能力的独立执行器。Deep Literature 中的个人文库与笔记也尚未自动成为本地项目的证据关系。

### OpenCode app-cmcc 科研专家团

任意阶段需求 → 主理人阿顾接管 → 意图识别 / 资产审计 / 可行性 → 研究章程与接管计划 → G1 范围确认 → 按任务 DAG 选择专家 → 文献或方法或写作路径 → 涉及实验时通过 G2 资源、G3 方案确认 → 工程实现与真实实验 → 诊断 / 结果分析 → 写作 → 独立审查和引用审计 → G4 发布确认 → Research Package。

- 1 位主理人、20 位成员，划分规划、文献、方法、实验、写作、审查六组。
- 主理人调用 OpenCode `task`，按 Agent ID 启动真实子会话，成员结果经主理人中转。这并非只在同一回答中模拟多个角色。
- 专家按需选择，支持综述、复现、已有数据分析、Idea 到实验方案等路径，不要求每次走完全部角色。
- 实验执行专家规范要求用 Bash 探测条件、执行实验、记录真实日志，具备执行意图；所读实现没有与 OpenResearch 相同的跨后端 Run 控制器。
- Evidence Claim 区分原文声明、实验支持、推测等；独立审稿人不得审自己参与生成的结论。
- G1–G4、DAG 依赖、计划版本和产物校验主要来自 Agent/Skill 指令和文件契约。在所查后端代码中，未找到这些科研闸门和 schema 作为专用调度状态机强制执行的接入。
- `task` 的参数与权限检查由程序执行，但它返回成员文本，不会自动核验该文本是否符合科研产物 schema 或是否科学有效。
- 前端主要从会话、task 与文件扫描投影团队状态；拓扑是预定义角色能力图，不能等同于逐次研究计划的动态任务 DAG。进度也主要由 Agent 状态估算，不能当作科学有效性百分比。

## 3. 核心差异

| 比较项 | OpenResearch | 科研专家团 | 接入含义 |
|---|---|---|---|
| 工作中心 | Git 项目、实验树和 Run | 研究需求、角色任务和研究包 | 保留两类对象，并建立关联 |
| 主体组织 | 主 Agent + 通用助手 / harness 子代理 | 主理人 + 命名专家子集 | 复用会话基础设施，增加角色和任务身份 |
| 科研推进 | 根据实验完成结果持续探索 | 根据产物、依赖与决策分阶段推进 | 上层阶段计划包含下层实验迭代 |
| 图结构 | 假设 / 代码继承树 | 工作依赖 DAG | 不能把两种节点直接一一替换 |
| 实验执行 | 快照、计算适配器、supervise、持久 Run | 成员调用 Bash，按规范写运行记录 | 执行专家转为调用已有运行服务 |
| 人工控制 | 自主级别、工具权限、计划模式 | G1 范围、G2 资源、G3 方案、G4 发布 | 将关键科研批准补成持久后端对象 |
| 证据 | 日志、代码快照、文件；Agent 解读 | Claim / Finding / 审查 / 引用状态契约 | 连接原始运行事实与允许表达的结论 |
| 失败处理 | 执行终态 + Agent 的 repair/refill/promote/stop | REFINE/PIVOT/STOP、重新确认计划 | 执行失败和科学假设否定必须分开 |
| 非计算研究 | 文献与报告技能可用，仍处于项目会话 | 明确裁剪，支持方案及外部实验回传 | 可提供不必立即建立实验树的入口 |
| 交付 | 项目产物、图表、LaTeX/Overleaf | 审查后的报告与 manifest | 复用产物存储，增加审计关系 |

## 4. 三种产品方案

| 方案 | 可行性 | 成本与问题 | 判断 |
|---|---|---|---|
| 完全独立的专家团功能 | 独立部署现有 OpenCode 系统可行 | 两套会话、文件、运行与证据状态；项目衔接成本持续存在 | 适用于确实需要独立产品，不优先用于当前个人工作台 |
| 全面替换或强制融入原生流程 | 技术上可做，改动最大 | 影响普通用户、自主实验速度、harness 兼容；容易重复编排 | 暂不推荐 |
| 独立入口、共用底座、逐步融合 | 可行，边界清楚 | 需角色适配、数据映射和关键闸门实现 | 推荐 |

“独立入口”不代表独立数据孤岛。首页可发起专家团综述或方案任务；已有项目可发起“方案会诊”“结果分析”“独立审查”。需要运行时绑定一个本地项目，同一 Run 只由 OpenResearch 创建和管理。

## 5. 直接迁移的具体障碍

1. **Agent 选择与配置加载。** OpenResearch 的 OpenCode 适配器当前按模式选择 `build` / `plan`，尚未选择团队 lead。CMCC 自定义专家目录加载也来自其配置实现，不能假设任意官方 OpenCode 二进制能原样识别 `.opencode/experts`。需要显式角色选择和配置注入，并核对 V1/V2 协议。
2. **提问和批准。** OpenResearch 生成的 OpenCode 配置明确禁用 `question`；CMCC 主理人允许该工具并依赖人工闸门。适配器已有部分问题事件处理，不等于科研闸门已持久化。接入应使用平台批准记录与 UI，必要时桥接问题工具，而非只改一个开关。
3. **工作目录。** CMCC 为会话分配 `runs/<时间-ID>` 独立产物目录，团队规范又描述 `research-workspace/<run-id>`；OpenResearch 代码在会话 worktree 中，产物另有项目目录。需显式传递 codeRoot 与 artifactRoot，并统一研究包路径；不能把实验代码全部写进报告目录，也不能让不同角色同时改同一 worktree。
4. **ID 和状态。** CMCC 的整次研究 run-id 与 OpenResearch 的计算 Run ID 语义不同。一次专家团研究包含多个任务、实验节点与运行，必须有独立 Study ID。不能把任务“已完成”直接映射成 Run `done` 或把退出码 0 写成“假设已验证”。
5. **命令与方案版本。** 专家团的 PIVOT 允许改变方法、数据或评测；OpenResearch 强调同一比较系列固定运行契约。改变评价协议时应新建方案版本和比较系列，必要时新项目，不能静默改命令后混排旧指标。
6. **模型和角色可移植性。** 20 个 Agent 定义不代表要启动 20 个进程；按需选择并限制并发。复用 `orx agent spawn` 时还需明确角色 prompt、输出契约、返回产物与任务绑定；直接迁移 `task` 专家命名空间只能先验证 OpenCode 路径，不能宣称同时覆盖其他 harness。
7. **产物契约一致性。** 实验执行专家要求的 YAML 字段与 `experiment-run.schema.json` 字段并不完全一致，接管计划里的短角色 ID 也要映射完整 Agent ID。先规范输出、由程序做格式和关系校验；格式通过仍不等于科研事实已经成立。

## 6. 推荐融合边界

### 优先复用的专家能力

- 资产审计：识别用户提供的是论文声明、历史运行、代码还是草稿，建立版本和可用性记录。
- 文献检索策略与证据分析：增强现有文献技能，统一检索入口，避免两套来源策略；允许保留现有来源之外的合理补充。
- 方法和实验设计：明确基线、指标、重复次数、统计和停止条件，绑定批准的方案版本。
- 诊断与结果分析：读取真实 Run 与日志，保留负结果；将程序失败与科学不支持分开。
- 独立审查、引用审计和研究包：约束结论强度，增强现有报告与论文交付。

### 共用 OpenResearch 的基础能力

项目与仓库、会话、worktree、实验树、源码快照、计算后端、Run 生命周期、日志、取消和唤醒、项目产物目录。专家执行角色通过已有接口调用这些能力，不维护第二份权威运行记录。

### 需要新建的少量研究对象（设计建议，尚未实现）

| 对象 | 用途及关系 |
|---|---|
| Study | 一次研究委托，可暂未绑定 Project；执行前明确绑定 |
| PlanVersion / Task | 保存目标、角色、依赖、预算、状态、输出；任务可引用多个 Experiment / Run |
| HumanDecision | 记录批准人、范围、方案版本与内容 hash；Agent 无权自行将等待改为批准 |
| EvidenceClaim / Finding | 引用 paper/version/position 或 runId/commit/log/metric，区分支持等级 |
| Artifact / Review / Manifest | 关联路径、hash、产出任务、审查人和发布状态 |

论文身份和项目文献关系沿用现有文档中的待建设契约，暂不另造第二套 Paper 数据库。Deep Literature 可以提供材料来源，但登录已统一不代表本地证据自动同步。

建议对实际实验启动做后端 G2/G3 检查，并对研究包发布做 G4 检查；批准绑定计划与资源范围，范围内无需反复确认。G1 可确认目标与边界。审批对象被计划变化影响时才失效；普通研究模式可保持现有体验。

DAG 中“实验执行”是一个或若干工作任务，其内部使用实验树探索和并行 Run；DAG 负责工作依赖，实验树负责假设继承。图上直接显示真实 Study 任务，角色能力图仅作为可选展示。

## 7. 分阶段验证与上线范围

### 第一阶段：不跑实验的能力融合

引入“研究方案会诊”和“独立审查”，按任务裁剪资产审计、方法、审稿和引用核验。共用项目材料和产物目录，不强制全团。验证专业产出是否比原有单 Agent 流程更完整，并观察用户确认次数、耗时和 token。

### 第二阶段：专家团入口与真实执行桥接

先验证一个确定的 OpenCode 版本或实现跨 harness 角色调度层，不同时维护两套研究编排。接入 Study、PlanVersion、Task 和关键批准记录；实验执行专家通过 OpenResearch 提交运行并读取事实。首个端到端案例使用小型 CPU 实验，不必先配置 GPU 或云服务。

验收至少包括：G3 未批准不能启动；一次重复提交不生成重复实验任务；进程重启后能核对已提交 Run 而不盲目重跑；批准后方案变化会重新检查；实验失败保留日志；Run `done` 不自动成为 Claim“实验支持”；取消后待执行节点停止派发且在途运行状态如实显示。

### 第三阶段：动态计划和完整研究包

增加真实任务 DAG、失败回退、有限重试、并发预算、证据关系和审查归档。再扩展其他 harness、远端计算及外部实验回传。评估多代理是否值得默认启用，以交付质量和用户成本判断，不以专家数量判断。

目前无法从静态代码合理给出可靠工期或固定 token 倍数；需要先确定支持的 harness、闸门强制程度、独立入口是否允许未绑定 Git 项目，并用真实案例测量。

## 8. 主要证据位置

OpenResearch：

- [科研会话总规范](../../SYSTEM_PROMPT.md)：全科研过程、worktree、原始事实入口与产物。
- [实验树技能](../../agent-skills/orx-experiment-tree/SKILL.md)：实验迭代、固定契约、失败和节点选择。
- [实验分支创建](../../src/local/experiments.rs)、[源码快照与计算提交](../../src/compute.rs)、[Run 存储](../../src/store.rs)。
- [通用助手调度](../../src/commands/agent.rs)、[自主程度](../../src/local/autonomy.rs)。
- [OpenCode 配置与启动](../../src/local/opencode.rs)、[V1 适配](../../src/local/harness/opencode.rs)、[V2 适配](../../src/local/harness/opencode_v2.rs)。
- [现有产品数据流](architecture.md)、[当前产品边界](product-experience.md)、[能力入口](../../ui/src/product/researchCapabilities.ts)。

OpenCode CMCC（以下为本机另一仓库的绝对链接）：

- [主理人规范](/Users/levent/cmccProjects/ai-agents/opencode/.opencode/experts/ai-for-science-team/agents/ai-for-science-team-team-lead.md)：20 位成员、动态路由、G1–G4。
- [实验执行专家](/Users/levent/cmccProjects/ai-agents/opencode/.opencode/experts/ai-for-science-team/agents/as-experiment-operator.md)：Bash 执行和运行记录要求。
- [task 实现](/Users/levent/cmccProjects/ai-agents/opencode/packages/opencode/src/tool/task.ts)：真实子会话、权限、结果返回。
- [专家加载](/Users/levent/cmccProjects/ai-agents/opencode/packages/opencode/src/config/agent.ts)：自定义专家目录与打包配置目录。
- [工作台状态投影](/Users/levent/cmccProjects/ai-agents/opencode/packages/app-cmcc/src/pages/session/ai-science/workbench-context.tsx)、[角色拓扑](/Users/levent/cmccProjects/ai-agents/opencode/packages/app-cmcc/src/pages/session/ai-science/topology.ts)、[进度与文件投影](/Users/levent/cmccProjects/ai-agents/opencode/packages/app-cmcc/src/pages/session/ai-science/data.ts)。
- [会话目录规范](/Users/levent/cmccProjects/ai-agents/opencode/packages/app-cmcc/src/utils/cmcc-workspace.ts)、[科研产物契约](/Users/levent/cmccProjects/ai-agents/opencode/.opencode/experts/ai-for-science-team/skills/research-workflow/references/contracts)。

以上规范按被分析项目内容读取，不代表本次比较调用了科研专家团或执行了其中的科研工作流。没有运行实验、调用模型或验证线上部署。
