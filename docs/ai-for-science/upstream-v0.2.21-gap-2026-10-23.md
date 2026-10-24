# 官方 v0.2.21 与当前产品的回移评估（2026-10-23）

> 后续实施状态（2026-10-25）：产品版本为 `0.2.21-mobilesci.1`，保持真实 v0.2.19 上游祖先。Stop/持久准入隔离和 #670 产品相关模型调用治理已分批回移，包含 one-shot 与 starter；整体 v0.2.21 仍为部分回移。本文保留实施前的静态核查基线，当前状态、验证和统一性能治理顺序见[回移批次](upstream-v0.2.21-backport-batches.md)。

## 结论与核查口径

建议继续选择性回移，不整体升级、不覆盖本产品的同名核心文件。先处理 #670 的模型选择和隐式生成调用，再处理 #752 的 OpenCode 交互与权限正确性；删除和空间回收作为下一组有依赖的治理批次。Trackio 等功能继续暂缓。

本轮只做静态分析，未回移功能代码、未运行模型或实验、未删除任何实际数据、未部署服务器。没有读取生产账单或进行故障复现；下文的风险是源码差距和潜在影响，不表示已经发生生产扣费、误删或数据泄漏。没有足够依据新增 P0。

- 官方：[v0.2.21 release](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.21)，2026-10-23 10:20:25（Asia/Shanghai）发布。
- 固定 tag：`5af82bb531a731698afc6e8e46f3e5157e20210b`；Git tag ref、release target 和 compare 最后提交一致，不以 main 代替发布内容。
- 对比起点：v0.2.20 / `37a367bcdbc26ba2a492bccf12b85bddc5852567`。[完整差异](https://github.com/alphaXiv/OpenResearch/compare/v0.2.20...v0.2.21)为 18 个提交、108 个路径、9,017 行增加、2,458 行删除，包含构建产物和翻译，不能当成 108 项缺失功能。
- 本地核查 HEAD：`ca0fdf04401b40c64c1cff6d2d4b3049ec591585`，核查开始时工作区干净。`product-upstream.json` 仍是 v0.2.19 / `1d8a285468aed5d5a1f1ea86ecf6e2f63fcaa8bd`，官方更新通道 `product-disabled`；`node scripts/check-upstream-base.mjs` 通过。
- 方法：读取官方 release、tag ref、完整 compare 和各业务提交的文件差异，与本地调用、删除流程、数据结构和已有回移记录交叉核查。本轮未执行新补丁的构建或测试，不能将此前回归通过解释为 0.2.21 已验收。

优先级：P1 为应先于普通性能微调处理的调用控制、数据生命周期或恢复正确性；P2 为下一批低风险修复或满足条件后治理；P3 为功能暂缓或非必要体验项。回移“必要”不等于本轮立即启用破坏性清理。

## 逐项评估：建议回移或适配

| 官方项 | 当前状态与新增变化 | 理由、影响范围及优先级 |
| --- | --- | --- |
| [#670 模型选择及取消 AI 技能筛选](https://github.com/alphaXiv/OpenResearch/pull/670) / `f1b6c2d` | 未覆盖。当前驻留进程启动仅保留 `orx-local-*` 的会话模型，其他情况退到 host 默认；目录检测仍通过 `dead_providers` 对每个 provider 的首个模型发生成探测；`user_skills::refresh_imports` 仍用 one-shot 分批筛选技能。官方还把 V1 small_model、title/compaction 及 V2 agents 的辅助模型绑定到选择，并核对生效配置；无模型时停止隐式生成，starter 使用静态后备。 | **P1，第一优先。** 涉及不必要请求、费用控制、检测耗时和所选模型一致性。范围包括 `opencode.rs`、`local_models.rs`、OpenCode V1/V2 harness、starter、标题/压缩、技能导入和模型选择传递。普通回复可已通过请求体使用选择模型，不能据此断言所有主对话都用错；关键缺口包括驻留配置和辅助/后台调用。分批处理，不能只改一行过滤条件。 |
| [#752 统一问题与权限处理](https://github.com/alphaXiv/OpenResearch/pull/752) / `3f5bac6` | 部分旧能力存在，新增修复缺失。当前 V1 配置禁用 question，事件解析/回复只取批次第一问，批准工具请求发送 always；V2 存在 reply/decision schema、跳过与中断状态的差异。官方支持批次答案聚合、跳过、自由输入，修复失效 prompt、权限显示及 once 作用域，并解除聊天 question 禁用；另有 Claude/Codex 适配。 | **P1：OpenCode 协议、授权作用域与停止后失效问题；P2：统一交互外观。** 涉及前后端 prompt、WirePrompt、V1/V2 reply、ChatPanel。只使用 OpenCode 也直接受益；不能把整个 PR 当成 Codex 专项跳过。必须先完成问答闭环再解除 question 禁用，不能把 once 直接推广为研究 G1–G4 审批规则。 |
| [#689 删除原生 OpenCode 历史](https://github.com/alphaXiv/OpenResearch/pull/689) / `822d918` | 当前删除会话会停止子进程并删除本地记录/工作树，但未见 native store purge。官方删除 isolated/legacy V1/V2 库中的原生会话、分支及后代，保留仍被其他聊天引用的 ID；引入跨进程删除锁、升级中的拒绝和取消请求后继续完成的删除任务。 | **P1，需与 #690/#753 的拒绝顺序适配。** 解决“界面删了、原生历史仍可读取”和空间残留。范围：chat/project 删除、native_store、opencode_db、Store 的原生 ID 归属查询。必须保留本产品侧聊、研究和材料关系；不是删除整个原生数据库。该 PR 不处理全部历史孤儿，也不保证 SQLite 底层页安全擦除。 |
| [#690 项目目录与产物清理](https://github.com/alphaXiv/OpenResearch/pull/690) / `4cecfe4` | 部分已有产品替代：现有 project_lifecycle、工作目录保护、可恢复目录迁移和数据库失败时恢复。缺官方产物清理计划、空工作树父目录清理、产物操作与项目删除串行、请求取消后的生命周期保持。官方可选删除的是 artifacts 目录。 | **P1：删除一致性和生命周期；P2：可选产物删除入口。** 范围：up.rs、files.rs、git.rs、项目删除 UI/返回值。不能用官方 `deleteArtifacts` 覆盖我们的 `deleteFolder`/recoveryPath，也不能把用户源仓库或材料原件当作可再生成产物。保留数据库成功后再应用产物清理及 artifactsError 告知。 |
| [#691 运行产物与快照回收](https://github.com/alphaXiv/OpenResearch/pull/691) / `8056c78` | 未完整实现。现有 adopt_orphaned_runs 是恢复运行监督器，不等于清理已无记录的运行目录。官方回收运行目录、监督器/取消锁与日志、提交句柄、无引用源码快照，处理放弃启动；增加提交/清理/数据目录迁移互斥和后台分批回收。 | **P1，资源治理批次。** 影响磁盘增长、项目删除和数据迁移，涉及 Store、compute 提交、localbox、up 后台任务。按 #751 的活进程保护和 #753 的删除顺序一起设计。保留远端恢复句柄、仍引用的快照及损坏记录的不确定归属；没有实验负载时不承诺显著提速。 |
| [#751 进程组存活保护](https://github.com/alphaXiv/OpenResearch/pull/751) / `23ea218` | 当前未见这组保护。针对 #691/#743 的补强：即使已有 exit_code 且主进程退出，进程组仍活着时保留目录；Unix 用 signal 0/EPERM 判断，排除危险 PID，设退出后 1 小时窗口降低 PGID 复用误判。 | **P1，启用回收前的必要门槛。** 涉及 localbox、项目删除、孤儿回收、环境瘦身，防止 checkpoint 子进程仍用文件时被清理。当前不把它宣称为已复现故障；1 小时窗口也不保护无限长的遗留子进程。Windows 保持其 job-object 规则。 |
| [#753 先拒绝删除再 purge](https://github.com/alphaXiv/OpenResearch/pull/753) / `8f13ca3` | 未引入 native purge，故新 purge 误序目前尚未出现。官方确保活跃运行、清理锁、数据迁移、路径/文件拒绝等检查在 native purge 之前完成，并缩窄原生删除锁的持有区间。我们的材料/活跃研究拒绝条件还需额外保留。 | **P1，随 #689/#691 一起纳入。** 属依赖安全条件，不能先引入 purge 再事后补它。范围：项目删除编排、Store 删除接口及跨进程锁；保留失败时的本地行和可重试引用，避免“删除被拒绝但原生聊天已消失”。 |
| [#755 附件随聊天清理与孤儿扫描](https://github.com/alphaXiv/OpenResearch/pull/755) / `4cf67c0` | 未覆盖 legacy chat-attachments 生命周期。官方在数据库删除后回收无消息引用的合法附件名，并按 24 小时宽限期、数据迁移互斥及分批预算扫孤儿。我们已有 materials 包的配额/journal/GC，但就绪材料明确保留，不能视为同一机制。 | **P1，适配 legacy 附件清理。** 范围：Store、chat 附件路径、后台清理。回移时引用集需考虑持久队列、未发送草稿、侧聊/专家引用及产品材料规则；不能仅凭官方用户消息 image.text 查询去删所有上传材料。新鲜文件、未知归属及证据材料继续保留。 |
| [#672 checkout 命令按 shell 引用](https://github.com/alphaXiv/OpenResearch/pull/672) / `7e39bce` | 未覆盖。当前输出 `cd {repo_path}`、`git checkout {branch}` 未引用；官方按 POSIX、PowerShell、CMD 生成命令并识别调用 shell。 | **P2，低耦合可顺带。** 带空格/特殊字符路径的 CLI 提示可能不可用；影响 plane checkout hint、CLI 回归。与使用哪种 coding agent 无关，但不是当前性能瓶颈。 |
| [#694 侧聊输入焦点](https://github.com/alphaXiv/OpenResearch/pull/694) / `b51131e` | 未覆盖。已有 composerFocusNonce 用于产品欢迎入口，但 embedded 侧聊未收到独立激活请求，显式打开/重开仍只是 openSideTab；官方消费一次性 nonce，等 loading/error/history 可交互后聚焦，草稿持久化不重新抢焦点。 | **P2。** 影响侧聊打开、/side、保存后重开、主副输入框焦点。需接产品 SideChatMenu 和中性 loading shell，保留欢迎入口；不应因响应刷新把用户移回的主聊天焦点抢走。 |
| [#732 禁止原生内联写作预测](https://github.com/alphaXiv/OpenResearch/pull/732) / `e3952c5` | 未覆盖。官方在聊天、消息编辑和计划修改 textarea 加 writingsuggestions=false，防止原生预测文本导致光标/文字跳动。当前代码未见该属性。 | **P2，低成本。** 主要是支持该属性的浏览器/WebKit 输入体验；保留 IME、技能 token 镜像和选区修复，不能宣称所有中文输入故障因此消失。 |
| [#762 虚拟侧栏菜单层叠](https://github.com/alphaXiv/OpenResearch/pull/762) / `df4d098` | 未覆盖。当前虚拟行仍用 transform: translateY；官方改为 top 定位以避免每行 stacking context 让三点菜单被邻行遮挡。 | **P2，低耦合可验证。** 范围：ChatPanel 虚拟列表及菜单；回归长列表、滚动、RTL、窄屏。现有 product header/侧栏布局修正不等同于这个修复。 |
| [#743 已完成运行环境瘦身](https://github.com/alphaXiv/OpenResearch/pull/743) / `d682709` | 未覆盖。官方在各项目最新 3 个本地完成运行之外，移除旧运行 repo/.venv、repo/.cache/uv，demo 改共用 uv cache。 | **条件 P2，暂不立即启用。** 磁盘占用大时有价值，但当前未取得此类目录占用测量。需先有 #691/#751，明确可重建和保留策略，再由需求决定是否采用“只保留 3 个”的官方默认；不能直接删除需复现实验的环境。 |

## 逐项评估：当前无需回移或暂缓

| 官方项 | 判断 | 原因和重新评估条件 |
| --- | --- | --- |
| [#733 侧聊整行可点击](https://github.com/alphaXiv/OpenResearch/pull/733) / `a3a640c` | **已有等效实现，无需重复回移。** | 产品使用独立 SideChatMenu；创建与保存会话项都是 MenuItem 全宽 button，并具有 hover/focus 样式。官方修复针对“图标可点、旁边文字是独立 span”的旧 SideChatPicker。无需为此扩改全局 OptionPicker；不把这个等效判断扩展为 #694 焦点已解决。 |
| [#728 按语言显示文件图标](https://github.com/alphaXiv/OpenResearch/pull/728) / `b933617` | **P3，暂缓。** | 主要是 Seti 风格 glyph、颜色与主题 token，未发现与服务器 OpenCode 的性能、可靠性或当前产品阻塞有关。功能/外观恢复排期后再考虑。 |
| [#754 SSH/Slurm 远程存储根](https://github.com/alphaXiv/OpenResearch/pull/754) / `29dcdc0` | **P3，按需引入。** | 新增 remoteRoot 配置并贯穿远程提交、缓存、监督、取消、容器与指标路径，支持 scratch 大盘。目前没有 SSH/Slurm 实验存储根需求。OpenCode 部署在服务器不等于使用这些实验后端；将来启用时必须整条路径适配并保留旧 job handle，不能只迁移配置字段。 |
| [#756 Trackio/Visualize/orx metrics](https://github.com/alphaXiv/OpenResearch/pull/756) / `dceecf9` | **P3，功能暂缓。** | 扩展 HF Spaces/token、hf Jobs、零设置本地 dashboard、嵌入图表、每 run 上下文和 CLI metrics。依赖此前有意未引入的 0.2.20 Trackio/运行上下文等基础；当前科研任务 DAG 也不等于官方实验谱系。对服务器私人空间还需验证 iframe、反向代理、token 和权限边界，不能只拷新版 UI。 |
| [#764 发布版本号](https://github.com/alphaXiv/OpenResearch/pull/764) / `5af82bb` | **无需回移版本号或官方产物。** | 产品仍是 v0.2.19 加选择性补丁和产品能力，不能因选择几项修复改称完整 v0.2.21。该增量中 Cargo.toml/Cargo.lock 仅改变本包版本，未新增第三方依赖；ui/package.json 与 lockfile 未变。继续保留本地安全锁文件、产品 updater 禁用、版本证据和自行构建的 ui/dist。 |

## 本地依据索引

以下是当前 HEAD 的静态依据，函数名比会继续移动的行号更稳定：

- 模型：`src/local/opencode.rs::AgentHost::ensure_started` 只接受 orx-local- 前缀；`src/local/harness/opencode.rs::dead_providers` / `probe_rejects_key` / `opencode_one_shot`；`src/local/local_models.rs::prepare_env`；`src/local/starter.rs::resolve_agent`；`src/local/user_skills.rs::refresh_imports`；up.rs 的技能目录入口仍触发 refresh_imports。
- 提问/授权：`opencode_config_json` 禁用 question；V1 `question_card` 只读第一问，`reply_inline` 用 always 和单个答案数组。V2 `reply`、WirePrompt/PromptAnswer 和前端渲染需一并核查，不能仅改配置开关。
- 删除：`src/commands/up.rs::delete_project`、`delete_chat_session`；`ChatHost::delete_session`；Store 现有删除接口未见 native purge、run artifact 回收及附件 orphan sweep；`src/local/projects.rs::delete_project` 已有 recovery 及失败恢复，须保留。
- 材料：`src/local/materials/storage.rs::collect_at` 保留 ready 包，只收集满足年龄及归属条件的未完成包。这既是已有保护，也说明其不是 chat-attachments 全量生命周期回收。
- UI：`ui/src/components/SideChatMenu.tsx` + `ui/src/components/ui/MenuItem.tsx` 等效覆盖 #733；App 的 embedded ChatPanel 未传独立 focus nonce；虚拟行仍使用 transform；相关 textarea 未设置 writingsuggestions。

## 建议执行批次与回归门槛

1. **模型请求治理**：#670 先取消可能计费的目录生成探测和 AI 技能筛选，保留显式排除、harness 归属与用户选择；再贯通所选模型的主/辅助调用、预热和缓存。保留无模型静态 starter 与中性 loading shell，不改成自动选目录第一个模型。用 fake provider/本地 HTTP 证明目录和技能读取零生成请求、主/辅助模型一致、managed config 冲突明确失败。官方有效配置探测存在等待，需评估对我们的启动性能和取消语义影响。
2. **问答与授权正确性**：#752 的 OpenCode V1/V2 路径，验证一次权限、批准/拒绝、全部跳过、部分跳过、批次乱序回答、自由输入、断线和停止后卡片。统一 UI 可随后做；Claude/Codex 及 ACP 专项不因这次回移自动纳入。官方 question_reply 在响应时读全会话历史，回移时应保留我们已实施的有界存储/索引与异步 flush，不能引回同步热路径。
3. **删除与磁盘生命周期**：先画清检查 → 清理计划 → 原生 purge → 行删除 → 无引用附件/产物回收的产品顺序，再整合 #690/#689/#753、#691/#751 和 #755。不同资源的可重试边界按实现细化，不能把文件系统和多个数据库描述为一个原子事务。拒绝分支、请求取消、跨进程竞争、数据迁移、软链接、共享 native ID/快照/附件、活跃研究、队列/材料引用必须有回归。后台清理优先 dry-run 和统计后启用；官方“5 秒”是移除阶段预算，不是整个扫描和 60 秒锁等待都受 5 秒约束。
4. **小型界面与 CLI 修复**：#732/#762/#694/#672 可独立提交，UI 改动自行重建 ui/dist 并验收焦点、IME、滚动及宽窄屏。#743 仅在空间证据和保留策略明确后实施。

0.2.20 已完成的选区、设置滚动、关闭按钮、TabStrip、持久侧聊与菜单适配不重复排期，状态以[既有批次](upstream-v0.2.20-backport-batches.md)及[验收](upstream-v0.2.20-backport-acceptance-2026-10-22.md)为准。0.2.20 未引入的 Codex 异步问题、ACP、实验追踪/谱系和 managed compute 租约协议不会因 0.2.21 发布自动变成当前必选项。

全过程需保留产品材料合同、私人空间/账号网关、研究 G1–G4、精选案例、官方更新禁用和性能治理的 guarded write/有界后台池；不将官方同名文件或 bundle 当作合并结果。服务器仍暂停部署，待选定批次实施并针对候选验收后再单独安排。
