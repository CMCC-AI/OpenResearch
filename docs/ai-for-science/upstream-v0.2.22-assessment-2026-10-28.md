# OpenResearch v0.2.22 与 MobileSci 差异评估

核查日期：2026-10-28（Asia/Shanghai）。官方正式版为 `15f2b59bda0208dbaba536adb253cb8dc1ff7d62`，发布于本日 09:32:54；相对 v0.2.21 有 22 个提交。[发布页](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.22)、[固定版本比较](https://github.com/alphaXiv/OpenResearch/compare/v0.2.21...v0.2.22)。此前本日 00:57 的核查仍以 v0.2.21 为最新正式版，是历史快照，不能沿用其中的 open PR 状态。

本地核查基点 `bf9f218`，包含 `e03386f` 的继承/续租/Stop 修复、`9ad8e4f` 的证据读取修复，以及后续项目主页/草稿隔离。`product-upstream.json` 仍为真实 v0.2.19 祖先、v0.2.21 partial 回移，产品版本 `0.2.21-mobilesci.1`；官方更新关闭，基线脚本本轮通过。工作区另有未提交的部署/执行器候选，不视作已经上线或验收完成。

优先级：P1 为近期接入/投递/科研正确性；P2 为下一阶段生命周期、容量和工程治理；P3 为特定部署或原生桌面需求下的功能。以下方向判断是源码比较后的建议，不是官方路线图。

## 一、有价值、可考虑回移的官方改动

| 优先级 | 官方改动与依据 | 本地差异、影响与建议 |
| --- | --- | --- |
| P1 | [#771 OpenCode 插件激活就绪](https://github.com/alphaXiv/OpenResearch/pull/771)：仅对结构化插件激活 503，在原 30 秒期限内重试，保留完整目录与明确诊断 | `src/local/harness/opencode_v2.rs:864` 仍直接读取模型/集成目录，临时 503 会立即失败。影响冷启动、重启和模型设置页。择取错误分类、截止期限、完整目录回退及设置页选择保留；不要泛化为任意 503 重试。 |
| P1 | [#776 历史查询取消与本地发送错误](https://github.com/alphaXiv/OpenResearch/pull/776)：历史 fetch 被取消后，在原 scope/session 内重新等待；本地错误独立标识 | `ChatPanel.tsx:5564` 直接 await fetchQuery，错误仍产生普通 error part。存在 SSE 重连与准备发送竞争的源码缺口，尚未本轮重现真实网络竞争。优先回移查询取消处理与错误归属；本地消息虚拟行不同于官方 response grouping，不能复制整套分组逻辑。 |
| P1，拆分 | [#803 投递结果不确定、草稿恢复和 steering 回执](https://github.com/alphaXiv/OpenResearch/pull/803)；固定 tag 源码含 `unconfirmedSend`、恢复用 pendingClientTurn 和持久 `chat_steer_receipts` | 本地已有普通 turn/队列幂等、会话级提交锁和 `bf9f218` 草稿隔离，但 `steer_message` 在 sink.send 成功后直接返回，SteerMessage 不带 client_turn_id；前端仍用会话 busy 推断请求成功。影响丢回包、重发、切换会话后的恢复。优先补请求归属与 steering/turn/queue 互斥，保留本地有界存储池、取消持有、workMode、材料包和 workspace/runtime 身份，不整体替换该 348 文件 PR。 |
| P2；Windows/本地文件高频时提升 | [#765 共享 Markdown 本地路径](https://github.com/alphaXiv/OpenResearch/pull/765)：Windows 盘符、file://、空/拒绝路径安全处理 | 本地 `markdownTarget.ts` 没有 nativeMarkdownPath，Md 仍按 URL scheme 排除本地文件。影响聊天/文档预览的原生路径链接。可以独立择取解析和安全 URL 测试，继续通过私人 executor 文件权限入口打开；它不修复 ArtifactsTab 的中文编码问题。 |
| P2 | [#772 原生技能根与诊断](https://github.com/alphaXiv/OpenResearch/pull/772)：搜索、安装和实际调用来源一致；显示接受/忽略原因 | 本地仍由 global_skills_dir/skill_target 推导，缺少同一扫描产生的诊断对象。影响技能不可见、路径错误与排障。优先接入实际使用的 OpenCode 路径与诊断；所有路径按当前用户 executor HOME 解析，不能扫描或复制宿主其他用户的凭据。 |
| P2 | [#763 CI 分工](https://github.com/alphaXiv/OpenResearch/pull/763)、[#775 Windows/fixture 修正](https://github.com/alphaXiv/OpenResearch/pull/775) | 借鉴受影响检查、发布才打包和昂贵只读 demo fixture 复用。本地 Windows 已运行 cargo test，不能重复列为缺失。保留项目 required checks、PR 模拟合并、平台 PostgreSQL、产品证据/版本验证、执行器候选检查及 release 的 ./ci 全量门禁。 |
| P2，有 SSH/Slurm 部署时优先 | [#741 共享监控和持久传输退避](https://github.com/alphaXiv/OpenResearch/pull/741) | 本地有既有 SSH 复用/个别退避，但缺少官方新增的 src/jobs/ssh/service 层，不能视为完整等价。影响多 Run 连接数、故障重试与远端日志一致性。须连同身份键、重连历史、日志重写与 teardown 测试评估；服务器托管 OpenCode 本身不等于使用 SSH 实验后端。 |
| P2，先统一引用契约 | [#757 远端回收](https://github.com/alphaXiv/OpenResearch/pull/757)、[#758 原生历史清理](https://github.com/alphaXiv/OpenResearch/pull/758)、[#759 实验永久删除](https://github.com/alphaXiv/OpenResearch/pull/759) | 可借鉴拒绝条件、保留共享引用、存活进程检查、预算化重试和删除顺序。本地目前实验入口仍以 archive 为主；新增永久删除前必须把研究 claims、所有计划 Run 和材料引用纳入检查。不能照搬“每项目保留最新三个远端 Run”或直接删除旧日志。 |

补充取舍：

- [#797 论文链接到复现](https://github.com/alphaXiv/OpenResearch/pull/797) 已进入 v0.2.22，不再是 open 提案。P2 借鉴论文解析、预填和用户确认，优先适配浏览器内论文发现/精读到研究草稿；macOS 协议注册是 P3，且该 PR 不代表 Windows/Linux 协议已实现。
- #803 的模型选择、实验可见性和小窗口布局可按控件拆分评估（P2）；本地新建会话路由和基础草稿隔离已经实施，不重复重做，也不引入第二个聊天头部或论文搜索入口。
- [#805](https://github.com/alphaXiv/OpenResearch/pull/805)/[#809](https://github.com/alphaXiv/OpenResearch/pull/809) 的渠道、祖先校验和发布组织值得借鉴，但官方安装包更新通道不适用于本地分叉。原生桌面缩放/标题栏 #641/#808 按实际客户端需求列 P3，私人托管版不必为这些扩大升级范围。
- #761 压缩、#774 闪烁和 #752 原生问答已有本地选择性适配；当前 Codex compact 已有 thread/resume，不能重列为完全缺失。仍需维护能力矩阵及真实环境验收，不将“已有关键逻辑”等同“整个 PR 完整回移”。

## 二、当前项目残留的技术债

第一部分的接入、投递和链接差距也是正确性待办。下面聚焦产品特有债务和已修复问题的剩余边界。

| 优先级 | 依据与现状 | 影响范围与处理建议 |
| --- | --- | --- |
| P1 | 材料版本尚未进入任务身份。TaskSpec 仅含 id/role/brief/dependsOn/outputs/forceRerun；已修复 brief/workflow 比较，但未绑定输入材料哈希 | 材料内容变了而任务字段不变时，旧任务仍可能继承。明确 task → source ID/hash/读取范围，按输入变化使任务及下游审查失效；旧记录标为缺少输入版本，不推断其已读。 |
| P1 | 中文产物双重编码：ArtifactsTab::artifactTarget 保留编码片段，再交给 API 编码。当前文件与本日已复现探针时的 9d537b1 完全一致 | 中文 Markdown/图片/PDF 相对链接可能找不到文件。复用共享 resolver，统一只解码一次，覆盖 query/hash、畸形百分号、目录越界；与 #765 的原生文件协议修复分别验收。 |
| P1，验收债 | 本地/私人托管入口、账号 origin、executor 工具和权限是产品能力；当前 Dockerfile/部署脚本/工具探针仍有未提交候选 | 影响材料解析、首次与替换容器、已有 HOME 卷、非 root 写入及未来 provisioner 实例。源码声明有 pdftotext/Python 工具不证明现有执行器具备；需在固定镜像/二进制/配置上验收实际读取、真实模型权限问答/Stop和重连。不是本轮确认了线上故障。 |
| P2，TD-16 | delivery 审批只更新 decision；研究仍 active，CLI/API 缺少研究级暂停/结束入口 | 影响停止整个 DAG、后续恢复、归档和删除保护。先定义研究暂停/结束与单聊天 Stop、运行中实验取消的区别，再实现状态转换；不能直接去掉活动研究的删除保护。 |
| P2，TD-17 | research_runs 遍历全部 plans 的 run_ids/previous_run_ids 及 claims；package_scope 对整集合验证日志 | 旧失败 Run 日志缺失也可能阻断当前交付。属于待明确的审计契约，不直接认定错误。划分当前结论引用闭包和完整历史审计包，再设计 GC 与永久删除。 |
| P2，TD-18 剩余 | 摘录和 CLI 读取已有界，但 research_studies 仍整份 document JSON，更新前后序列化；历史 plans/claims/decisions 无累计总量约束 | 影响长期项目内存、JSON 复制和 SQLite 写锁持有。先测量大小/更新耗时，再拆分可增长记录、按需分页及明确迁移版本；不能将单次 64 KiB 限制说成整体容量已治理。 |
| P2，TD-05D | while_idle 在全局 turns 内执行 Store 检查与同步 Git 回调；调用点是旧 worktree 迁移 | 低频发布/迁移仍可影响其他会话。以项目/会话迁移保护维持生命周期，再移出全局锁和异步调度线程，不能检查完简单解锁。steer_message 本身的同步 Store 路径可随 #803 改造一起隔离。 |
| P2，存活性剩余边界 | Stop 已先取消再持久化，但 HTTP 仍等待全局队列清理；删除失败/提交前崩溃保留磁盘队列。续租独立后仍可能遇到持续 SQLite 写锁或系统停顿 | 保留失败可见性与取消保护，先定义未完成取消的重启语义，再评估 durable cancel journal。记录真实续租间隔、排队与锁等待；不只扩大 TTL，也不承诺任意负载下硬实时。 |
| P2，维护债 | chat/mod.rs 约 1.8 万行（含大量测试），ChatPanel 约 7 千行；本地生命周期修复与上游 #803 同区域变化显著 | 影响回移成本和竞态评审。沿准入、队列、取消、watcher、composer 恢复职责逐步抽取，保持回归和同一套状态契约；避免为拆文件重写调度器。 |

已从待修清单剔除：TD-14 brief/workflow 继承、TD-15 扫描耦合续租、TD-05C 慢存储前置原生取消、TD-18 整份日志/请求读取。其已修复部分有提交和测试记录；表中仅保留明确剩余边界。

## 三、可优化的方向

| 优先级 | 方向与依据 | 影响范围与落地建议 |
| --- | --- | --- |
| P1/P2 | 材料—阅读—结论—产物可追溯闭环。材料已有来源 ID/hash 和按需读取接口，但结构化阅读覆盖仍是材料合同中的后续项 | P1 先建立任务输入身份；P2 把读取来源/范围、解析失败、引用位置与 claim、产物 hash 关联并支持核查。上传或目录树不代表已读，保留普通问答无需材料、材料数量与工作模式独立。 |
| P2 | 论文发现/精读到研究草稿。参考 #797 的确认与预填，复用本地已有发现/精读入口 | 携带论文身份、材料引用和研究目标到同一创建流程；保留登录、部署子路径和未保存草稿。创建、下载/克隆与发送各自遵循确认边界，不因外部链接自动启动模型或绕过 G1–G4。 |
| P2 | 实验指标回读，不止计时/token。[#756](https://github.com/alphaXiv/OpenResearch/pull/756) 已在 v0.2.21 提供 orx metrics/Trackio，v0.2.22 继续包含 | 本地 research_metrics 是研究活动/用量统计，非 loss/accuracy 等实验曲线。先绑定 run ID、commit、数据版本和指标来源，让专家能读取并形成证据；绘图和 Trackio adapter 后接，私人托管凭据按用户隔离。 |
| P2 | 产品专属版本/发布兼容。当前仅记录 v0.2.21 partial；官方 #805 引入渠道和祖先校验 | 按 PR/固定 SHA 记录未回移、部分适配、已验证、主动排除，以及对应本地提交与 schema 条件。保持真实 v0.2.19 祖先，产品包、平台、provisioner、executor 与 Compose 一致；官方渠道继续禁用，借鉴兼容检查而非恢复官方包覆盖升级。 |
| P2 | 可观测性驱动性能优化。已有有界后台池、独立续租和节流，但尚无本轮真实负载 p95 证据 | 分开记录准入、SQLite 等待、队列落盘、native 中断、续租间隔与 G4 全文校验；以固定数据集和负载验证，优先解决可见跨会话等待，不用测试数量或文件拆分作为性能收益。 |
| P2/P3 | 小范围吸收 #803 的模型/实验可见性、窄屏与菜单改进，按需评估 #795 开发槽体验 | 复用全局工作区头部和现有专家 DAG，避免重复入口；保留材料草稿和 runtime 隔离。原生桌面布局/Jujutsu 等按实际使用排期；现有私人空间 connector 是执行链路，不应因“框架清理”删掉。 |

建议批次：先 #771/#776 → #803 投递归属与中文产物链接 → 材料输入身份及研究生命周期/引用契约 → 受保护的回收、聚合容量和指标闭环。CI 与诊断可独立推进，SSH/Slurm 和原生桌面专项按部署需求插入。

本次只做版本/源码核查及报告，未实施回移、修改产品版本、提交、部署或调用真实模型。未复跑全量 CI、未重测生产环境、未重新审计依赖。官方 PR 验证是作者记录，不当作本产品验收。比较 API 的文件列表触达 300 项上限，未据此声称全量文件差异数或完成全面安全审计；重点 PR 使用跨页补丁及固定 tag 关键源码核查。公开证据在 `.mobilesci-run/upstream-v0.2.22-assessment/snapshot.json`。
