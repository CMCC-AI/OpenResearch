# 官方更新方向核查与参考建议（2026-10-28）

核查时间：2026-10-28 00:57（Asia/Shanghai）。官方源为 `alphaXiv/OpenResearch`。本地为 `9d537b1` 加当前未提交修复，未合并或部署任何官方改动。

## 1. 版本、主分支和未合并提案必须分开

| 对象 | 本轮在线核查结果 |
| --- | --- |
| 最新公开正式发布 | [v0.2.21](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.21)，发布于 2026-10-23 10:20:25，目标 `5af82bb531a731698afc6e8e46f3e5157e20210b`；`releases/latest` 与公开发布列表一致 |
| 官方 main | `b3105858d1d9d8c9579eefa511ae33e542b6378a`，最后提交于 2026-10-27 07:16:45，内容是开发槽改进 [#795](https://github.com/alphaXiv/OpenResearch/pull/795) |
| 正式版之后的已合入代码 | [固定比较](https://github.com/alphaXiv/OpenResearch/compare/5af82bb531a731698afc6e8e46f3e5157e20210b...b3105858d1d9d8c9579eefa511ae33e542b6378a)：15 个提交，不属于已发布的 v0.2.21，不能自行称为 v0.2.22 |
| 与 10 月 25 日核查相比 | 原 main 为 `05d58d0`，本次新增 4 个已合入提交；此前的 11 个并非本轮新发生 |
| 本产品 | `0.2.21-mobilesci.1`，真实上游祖先仍为 v0.2.19 / `1d8a285`，v0.2.21 为 partial 回移，官方更新禁用。已运行本地基线脚本确认 |

本轮读取了发布 API、main 最近 35 个提交、固定比较的 15 个提交、最近更新的 25 个 open PR，以及重点 PR 的元数据/源码补丁。open PR 样本不是全部待办，PR 作者的验证记录也不是本产品的验收。

## 2. 新合入的四项

| 提交 | 内容 | 对本产品的价值与边界 |
| --- | --- | --- |
| `41db8ef` / [#771](https://github.com/alphaXiv/OpenResearch/pull/771) | OpenCode 健康检查成功后，插件仍可能激活中，模型/集成目录返回临时 503；在原 30 秒期限内只重试结构化 plugin activation 错误，保留最后完整目录，失败信息在设置页可见 | **优先候选**。本地 `opencode_v2.rs::discover_models` 仍直接 GET 两个目录，没有此特定 503 重试。不能把任意 503、鉴权失败或错误 JSON 变成无限等待 |
| `be7fdc6` / [#772](https://github.com/alphaXiv/OpenResearch/pull/772) | 原生 skill 搜索根显式化；Cursor 配置根/实际技能调用修正；Antigravity 缺 name 时使用目录名；技能页显示扫描目录、接受/跳过数量及原因 | **P2，建议分批吸收**。本地已有零隐式模型调用的本地扫描，但仍依赖 global_skills_dir/推导路径，缺少 SkillDiscovery 诊断。优先借鉴“扫描、安装、调用使用一致来源”的约束；不必为使用较少的 harness 整体改写技能系统 |
| `24328ff` / [#775](https://github.com/alphaXiv/OpenResearch/pull/775) | 修补选择性 CI 中 Windows 只 build 不 test 的缺口；测试删除目录前关闭 SQLite/锁句柄；多个 demo 测试共享只读 bundle 构造，每个测试仍独立克隆 | **参考测试工程方法**。我们的现有 Windows CI 已执行 cargo test，不应重复声称缺少 Windows 测试。可评估 demo fixture 的构造成本。作者的 Windows 基准只支持 demo 组改善，不能据此承诺本项目整体 CI 加速 |
| `b310585` / [#795](https://github.com/alphaXiv/OpenResearch/pull/795) | dev-slot 支持 Jujutsu；macOS 调试桌面壳加载 Vite，退出壳不停止外部 dev 服务 | **按需参考**。当前 Git 与浏览器开发流程无需为最新提交整体升级。原生 WebView、输入法和窗口行为验收时很有价值；JJ、桌面开发和 pnpm 构建策略应分别评估。仍须保持本产品入口、slot 所有权和账号 origin 配置 |

源码重点已核对 #771 的 plugin 类型判断/超时、#772 的根目录声明与扫描诊断、#775 的 Windows CI 条件、#795 的 dev-shell 生命周期，而非只根据标题判断。

## 3. 官方更新方向：基于提交分布的判断

以下是从已发布/合入代码与公开提案推导出的方向，不是官方承诺的路线图。

### A. 把原生 Agent 接入做成可靠基础设施

v0.2.21 的 [#670](https://github.com/alphaXiv/OpenResearch/pull/670) 控制所选模型和隐式推理，[#752](https://github.com/alphaXiv/OpenResearch/pull/752) 统一问答/权限；main 的 #761、#771、#772 继续处理压缩、就绪和技能来源。趋势是减少“装了却不可用、选了却没生效、失败原因看不到”的问题。

本产品可借鉴精确错误分类、能力声明、受期限约束的重试、目录/实际调用来源一致、用户可读诊断。#670、#752、#774 和 #761 的 OpenCode 核心部分已有本地选择性回移，不能重复排成尚未实施，也不能把自动化当作真实模型验收。

### B. 实验闭环从提交扩展到指标回读与异常收敛

已发布的 [#756](https://github.com/alphaXiv/OpenResearch/pull/756) 把 Trackio 接到本地/Space/server、实验可视化和 `orx metrics`。后者给 Agent 返回曲线摘要、步数、取样点、配置和告警，让实验结果能进入下一轮决策，而不只是展示运行状态。

main 的 [#741](https://github.com/alphaXiv/OpenResearch/pull/741) 做 SSH 共享监控和传输退避；open PR [#796](https://github.com/alphaXiv/OpenResearch/pull/796)、[#792](https://github.com/alphaXiv/OpenResearch/pull/792)、[#799](https://github.com/alphaXiv/OpenResearch/pull/799) 继续处理失联、坏退出回执、NFS 日志与唤醒。这些后者仍未合并，不能算作官方最新版已具备。

对本产品最有价值的是“指标与证据可被 Agent 读取”的闭环，以及多 Run 完成后合并唤醒。当前 `research_metrics.rs` 统计活动时间/token，尚不是训练 loss、accuracy 等实验曲线；两种 metrics 不能混为一谈。SSH/Slurm 专项仍应由实际执行后端需求决定，服务器上运行 OpenCode 不等于在使用 SSH 实验后端。

### C. 明确研究数据的生命周期和资源占用

v0.2.21 的 #689/#690/#691/#743/#751/#753/#755 与 main 的 [#758](https://github.com/alphaXiv/OpenResearch/pull/758)、[#759](https://github.com/alphaXiv/OpenResearch/pull/759)、[#757](https://github.com/alphaXiv/OpenResearch/pull/757)，覆盖原生历史、附件、运行目录、环境和 source snapshot 的删除/回收。

值得直接借鉴的是：先判断拒绝条件；保留其他会话引用；检查存活进程组；取消等待者后 guard 仍由实际 worker 持有；分批、有预算、可重试地回收。不能直接套“最新三个运行”或按年龄清理：我们的材料、G1–G4、研究 claim、历史 Run 日志和已验收产物有额外引用。本轮技术债分析已确认历史 Run 会影响当前交付，应先定义引用闭包，再实施 GC。

### D. 降低论文进入复现工作流的摩擦

未合并的 [#797](https://github.com/alphaXiv/OpenResearch/pull/797) 和堆叠其上的 [#798](https://github.com/alphaXiv/OpenResearch/pull/798) 提供 `openresearch://reproduce?arxiv=arXiv:<id>`，连接论文页面、桌面应用和预填复现项目。

可参考的重点是交互与权限边界：解析论文、打开创建对话框，由用户确认创建；创建后只预填复现提示，不自动发送；已有未保存内容仍受路由阻止保护。对于 MobileSci，可以先用浏览器内的论文发现/精读 → 复现项目/专家团草稿衔接，保留登录、子路径和 G1/G2/G3，原生协议注册另排，不因点击外部链接自动下载、克隆或启动付费模型。

### E. 同时治理长聊天体验与开发验证成本

main 的 [#774](https://github.com/alphaXiv/OpenResearch/pull/774) 处理聊天测量缓存/切换闪烁，#773/#641 处理桌面布局和缩放；[#763](https://github.com/alphaXiv/OpenResearch/pull/763)、#775、#795 则优化 CI 分工、测试 fixture 和原生开发体验。

我们已吸收 #774 核心策略，应继续验证产品自己的单消息虚拟行、长文档、半屏和流式高度，而非整体换官方 UI。CI 可以参考“PR 运行相关检查、发布运行完整验证及打包”，但必须保留本项目 required checks 名称、模拟 merge、平台 PostgreSQL、产品证据/版本检查和发布全量 CI；#763 要结合 #775 后续修正审查，不能只取早期选择规则。

## 4. 值得跟踪的未合并 PR 与本地差距

| PR / 状态 | 价值 | 本地判断 |
| --- | --- | --- |
| [#786](https://github.com/alphaXiv/OpenResearch/pull/786)，open | 中文产物文件名被 Markdown 编码后又被 API URL 编码，导致找不到文件 | **优先候选，已本地复现**。`ArtifactsTab.tsx::artifactTarget` 仍保留编码路径；`[data](数据.md#top)` 最终 API path 为 `notes/%E6%95%B0%E6%8D%AE.md`，应为 `notes/数据.md`。已有共享 resolver 可复用，但要保留畸形 `%`、query/hash、越界拒绝与科研目录解析 |
| [#776](https://github.com/alphaXiv/OpenResearch/pull/776)，open | SSE 重连等取消历史 fetchQuery，导致准备发送以 CancelledError 失败；本地错误独立展示 | **优先评估**。本地发送前仍直接 await fetchQuery，未处理该取消重试；localError 仍走普通 error part。只确认源码差距，未复现真实重连竞争。本地没有官方 groupResponseMessages，不能直接复制其分组修改或声称同样隐藏了上一轮回答 |
| [#780](https://github.com/alphaXiv/OpenResearch/pull/780)，open | 从用户原生 OpenCode DB 向隔离 DB 继承登录；处理四张凭据表、主键、时间戳和 schema 漂移 | **条件性评估，不直接回移**。本地没有同一套继承实现，但是否触发取决于 OpenCode 版本和认证方式。官方单用户桌面假设与我们的私人托管版不同，不能把宿主凭据复制到所有用户 executor；需核对认证 seed/live config 与每用户 HOME。一次 snapshot、原地更新和不回滚更新 token 的做法值得借鉴 |
| [#796](https://github.com/alphaXiv/OpenResearch/pull/796)，open | SSH host 连续不可达后标记 lost；同会话多个 Run 完成合并成一次隐藏唤醒 | **拆分评估**。批量唤醒可减少重复 turn；必须保留我们的分阶段后台存储、目录 gate、research nudge 和 token 结算，不能覆盖为官方的同步调用。失联 15 分钟是该 PR 策略，不能直接作为本产品默认，更不能把 lost 当作已杀死远程进程 |
| [#792](https://github.com/alphaXiv/OpenResearch/pull/792)，open | 磁盘满导致 exit_code 空/非数字，run 永久 running/Cancelling | 使用 SSH/container 回执时有价值；先判断数字回执和进程存活，保留坏文件作为证据，不伪造退出码 |
| [#799](https://github.com/alphaXiv/OpenResearch/pull/799)，open | Slurm/NFS 负查找缓存让已存在的远端日志被认为缺失 | 有 NFS Slurm 环境时优先；需要对应文件系统实测，不能把 PR 作者的 NFS 验证视为我们的验收 |
| [#789](https://github.com/alphaXiv/OpenResearch/pull/789)，open | 用户拥有的 symlink snapshot 根被误拒绝 | 不是“允许任意符号链接”；仅特定 snapshot/submission 根跟随目标、验证 ownership，其他运行根仍拒绝。与磁盘迁移一起评估 |
| [#797/#798](https://github.com/alphaXiv/OpenResearch/pull/797)，open；#798 base 是 #797 的功能分支 | 从论文链接进入复现 | 借鉴项目预填和明确确认，不视为已发布；浏览器工作台先评估内部入口，避免先扩原生客户端范围 |
| [#616](https://github.com/alphaXiv/OpenResearch/pull/616)，draft | 紧凑实验谱系导航和持久化选择/折叠 | 可借鉴层级导航和键盘操作，不直接再增加一个与现有科研 DAG 重叠的头部入口 |

## 5. 对本项目的建议顺序

1. **下一批低耦合正确性候选：#771、#786，并建立 #776 重连取消复现。** 它们直接覆盖当前 OpenCode/中文科研产物/聊天体验。open PR 应固定 head、审查测试后择取逻辑；不是直接跟随浮动分支，也不是本轮已经实施。
2. **继续本地 TD-14/TD-15/TD-05C。** 任务简报变化继承、心跳保障和用户 Stop 不会因回移官方最新 main 自动解决，不能用上游升级代替产品自己的科研正确性治理。
3. **再评估 #772 诊断和 #763/#775 的 CI 工程。** 优先降低排障和验证成本，保留现有产品契约和 release gates，不为追平官方提交而扩大重构。
4. **产品演进优先参考 #756 指标回读与 #797 的论文到复现衔接。** 这两项比整体复制官方视觉更接近 MobileSci 的科研目标；先明确 Run 证据/指标来源与用户确认，再做功能集成。
5. **删除回收、凭据继承、SSH/Slurm、原生桌面按环境与引用分批推进。** 不接收官方默认清理数量，不复制宿主全局凭据，不恢复官方安装包更新通道。

官方当前 README 仍定位为本地优先的 research-agent harness/workspace；本批提交主要补原生接入、实验运行与工作台基础设施。在所核查的 main 命令目录中没有本产品的 `research.rs` / 专家 DAG / G1–G4 编排实现。我们的材料追溯、私人托管隔离、Deep Literature 与科研审批仍是自身能力，不能期待一次官方升级替代。

## 6. 核查边界与证据

- 已在线读取官方公开 API、固定 main README、关键 PR 源码补丁，并与本地对应函数比较；没有拉取/合并官方 main、修改生产代码、运行真实模型、变更版本或部署。
- 正式版、main 和 open PR 状态以本轮快照为准，后续可能继续变化。PR 内勾选的测试与性能数据只代表其作者报告，本轮未代为重跑。
- 公开 API 读取 `alphaXiv/openresearch.sh` 提交列表返回 404，未检查该仓库的实际最新历史。论文入口的服务端衔接仅有客户端 PR 的描述，不能声称伴随服务已完成我们的兼容验收。
- #786 使用本地实际函数、TypeScript 转译及 Markdown 渲染链进行只读探针，已确认双重编码；#776 仅确认不同架构下的源码缺口，没有声称其完整 UI 症状已复现。
- 公开来源快照与选定补丁保存在被忽略的 `.mobilesci-run/upstream-review-2026-10-28/snapshot.json`。本地基线脚本通过，已有未提交修复保持原状。
