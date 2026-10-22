# 官方 v0.2.20 与当前产品差距核查（2026-10-22）

> 后续状态：本文保留回移前的核查基线。#677/#695/#714/#725、#718 标签滚动及 #716 侧聊持久化已完成源码回移与构建，#727 相关菜单按产品布局适配；测试、数据库现场迁移和服务器部署仍未完成。当前状态见[选择性回移批次](upstream-v0.2.20-backport-batches.md)。

## 口径与结论

本次读取 GitHub 官方 release，在临时共享 clone 拉取固定 tag，并逐项对比 24 个提交涉及的源码与当前工作区；没有升级、合并当前分支、重跑测试或改变运行服务。此前本地故障测试仍为未提交改动，保持原样。

- 官方仓库：[alphaXiv/OpenResearch](https://github.com/alphaXiv/OpenResearch)。
- 官方 [v0.2.20 release](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.20)：固定提交 `37a367bcdbc26ba2a492bccf12b85bddc5852567`，发布时间 2026-10-21 14:27:02（Asia/Shanghai）。
- 产品 HEAD：`6fc98a38f4ba0df57f650f2dac6b17b0a2ae4c7b`，另含本地未提交的可靠性测试与文档。
- `product-upstream.json` 与基线检查脚本仍确认 v0.2.19 / `1d8a285468aed5d5a1f1ea86ecf6e2f63fcaa8bd`，更新通道为 product-disabled。
- 官方从 v0.2.19 到 v0.2.20 为 24 个提交、173 个变动路径、15,848 行增加及 2,400 行删除；包括构建产物、翻译和测试，不能当作全部缺失业务代码。

当前产品是 v0.2.19 基线加选择性回移和产品修复，不是完整 v0.2.20。四组关键修复已回移，主要新能力未引入；产品自己的安全补丁、SSE/数据库/材料可靠性与私人空间能力又超出官方 tag，不能简单视为版本落后。

## 官方增量逐项状态

“未纳入”表示源码能力未完整引入，不等于已经在当前产品复现故障。功能优先级取决于产品是否需要；下述建议并非官方严重性评级。

| 官方 PR | 当前状态 | 差距及建议 |
| --- | --- | --- |
| [#674 Windows CMD](https://github.com/alphaXiv/OpenResearch/pull/674) | 已回移 | `bash.rs`、`jobs/localbox.rs` 与目标 tag 完全相同；`localrun.rs` 保留产品定制。 |
| [#635 Windows 进程树](https://github.com/alphaXiv/OpenResearch/pull/635) | 已回移 | `src/local/codex.rs` 与目标 tag 完全相同。 |
| [#676 使用统计说明](https://github.com/alphaXiv/OpenResearch/pull/676) | 产品定制 | README、遥测与发行策略应按 MobileSci 实际行为维护，不照搬官方说明。 |
| [#675 Codex 异步问题](https://github.com/alphaXiv/OpenResearch/pull/675) | 未纳入 | 现有同步 held question 已支持，但没有这次异步问题转 prompt、steering 回答及缓存协调的完整实现；建议 P1。 |
| [#678 非 UTF-8 SSH 测试](https://github.com/alphaXiv/OpenResearch/pull/678) | 已有等效 macOS 规避 | 我们使用 `all(unix, not(macos))`，官方仅 Linux；不是完全相同，但 macOS fixture 失败已避免。 |
| [#677 编辑器选中文字](https://github.com/alphaXiv/OpenResearch/pull/677) | 未纳入 | `base.css` 和对应测试仍为旧基线，选区文字与高亮层可能双重绘制；建议 P2，低成本先行。 |
| [#681 反馈提交告知](https://github.com/alphaXiv/OpenResearch/pull/681) | 未纳入 | feedback 命令与 skill 仍为旧基线；按产品实际反馈目的地适配，不应无意向官方提交产品数据。 |
| [#566 GitHub owner](https://github.com/alphaXiv/OpenResearch/pull/566) | 未纳入 | `local/github.rs` 仍为旧基线；缺少每项目 GitHub organization 选择及设置整合，建议 P2。 |
| [#679 ORX_RUN_ID](https://github.com/alphaXiv/OpenResearch/pull/679) | 仅有旧局部能力 | 当前只在本地 tinker_job 分支注入，缺少所有 run/执行后端的一致注入与 Trackio 指引，建议 P2。 |
| [#680 TensorBoard/Trackio](https://github.com/alphaXiv/OpenResearch/pull/680) | 未纳入 | 缺 `commands/tensorboard.rs`、`local/trackio.rs`，无对应日志目录、预检和链接，建议 P2。 |
| [#570 实验谱系](https://github.com/alphaXiv/OpenResearch/pull/570) | 未纳入 | 缺实验 lineage 组件及模型；现有科研任务 DAG 不是实验 fork 谱系，建议 P2。 |
| [#510 ACP](https://github.com/alphaXiv/OpenResearch/pull/510) | 未纳入 | Rust host/harness/store、认证、前端定义与配置均缺失；属较大功能整合，需按产品需求排期。 |
| [#695 关闭标签按钮间距](https://github.com/alphaXiv/OpenResearch/pull/695) | 未纳入 | ClosableTab 仍为旧基线；P2 体验项。 |
| [#714 设置切页滚动](https://github.com/alphaXiv/OpenResearch/pull/714) | 未纳入该修复 | 当前 `.settings-view-scroll` 缺少 `key={mainView}`；其他 rail 点击处清 scrollTop 不等价于该节点身份修复，P2。 |
| [#716 持久侧边聊天](https://github.com/alphaXiv/OpenResearch/pull/716) | 未纳入 | 后端启动仍执行 `delete_side_chats`；缺 `side_parent_leaf_id`、可空草稿和会话选择器。若侧聊需长期保存，建议 P1。 |
| [#717 租用监督](https://github.com/alphaXiv/OpenResearch/pull/717) | 未纳入、跨仓库待办 | 缺 rental supervisor/lease 协议及新 lost 终态；启用新租用模式前是门槛，不能只改本 CLI。 |
| [#725 环境变量末行边框](https://github.com/alphaXiv/OpenResearch/pull/725) | 未纳入 | env-table 缺末行去边框规则；P2 体验项。 |
| [#718 右面板标签滚动](https://github.com/alphaXiv/OpenResearch/pull/718) | 未纳入 | 缺 TabStrip，新标签溢出滚动方案未引入；P2。 |
| [#631 SSH 诊断和显式修复](https://github.com/alphaXiv/OpenResearch/pull/631) | 已回移 | `commands/compute.rs`、`jobs/ssh.rs`、SshConnectTerminal 及 remoteRepair 测试与 tag 相同；其他位置保留产品配置。 |
| [#709 嵌套资源](https://github.com/alphaXiv/OpenResearch/pull/709) | 已回移并适配 | markdownTarget 及三组相关测试与 tag 相同；预览组件保留 credentials 和只读案例约束。 |
| [#727 侧聊菜单和滚动条](https://github.com/alphaXiv/OpenResearch/pull/727) | 未纳入 | 与 #716/#718 配套，宜一并考虑，P2。 |
| [#729 统一聊天活动](https://github.com/alphaXiv/OpenResearch/pull/729) | 未纳入完整实现 | 缺公共 subagent 内容模块、ExperimentRunBanner 和活动状态整合；产品专家 DAG 不能视为同一能力，P2。 |
| [#726 onboarding](https://github.com/alphaXiv/OpenResearch/pull/726) | 产品流程已替代 | `/projects` 使用定制 ProjectsHome，未沿用“项目数为零就重播官方向导”的入口；不应照搬官方首页。 |
| [#719 版本号](https://github.com/alphaXiv/OpenResearch/pull/719) | 有意保持 v0.2.19 | 未整体整合前不只改版本号，官方 updater 保持关闭。 |

## 升级前必须解决的产品兼容点

1. **持久侧聊与专家数据**：当前启动会清理侧聊。引入新版持久会话后直接回退旧版有误删风险；`store.rs`、聊天生命周期、专家派发/唤醒及迁移保护必须语义合并，不能整块选择官方或产品版本。
2. **ACP 路径与来源协议**：`packages/platform/src/security.mjs:124` 的全局路径字符集不接受 `:`、`%`，会拒绝 ACP ID 的维护路径；`featured-cases.mjs` 只允许五种 harness。ACP 接入前需精确路径验证与授权适配，不能全局放开编码字符。普通对话与专家模式分别定义开放范围。
3. **lost 终态**：`featured-cases.mjs:83` 只接受 done/failed/cancelled。引入 #717 后需允许如实表达 lost，但不能将“结果不可取得”视为研究成功。
4. **租约服务**：#717 要求 sandbox 创建、激活、心跳及释放服务契约和伴随迁移。当前账号平台不等于官方 billing/sandbox 服务。本次未确认范围外服务实现或部署状态。
5. **保留产品改造**：共享材料上传、研究审批、私人空间权限、Deep Literature、产品路由与更新保护不能被官方同名文件覆盖；官方 UI 构建产物不能替代产品 ui/dist。

对当前已提交 HEAD 的临时三方合并预检显示：与上游增量重叠 71 个路径，报告 35 个冲突路径、33 条冲突事件（含一次资源重命名冲突，不等于 33 项功能）。核心冲突集中于 `store.rs`、`chat/mod.rs`、`up.rs`、workspace、ChatPanel、前端路由、翻译及锁文件。该预检不含未提交测试改动，也不代表已合并或可编译。相比 10-21 旧评估的 52 个交叉路径，当前交叉面已经扩大。

## 我们已有、官方 tag 不能替代的部分

- SSE 游标原子提交、共享采集、消息增量与周期检查点、事务迁移、有界同步执行池。
- 材料配额峰值、发布 journal、上传准入、GC 保护、SQLite runner 锁、实际部署证据门禁。
- 私人空间、统一账号、文献集成、专家审批/任务 DAG、精选案例和产品部署工具。
- 安全补丁后的锁文件：官方 h2 0.4.14 / quinn-proto 0.11.14 / rustls 0.23.40 / rustls-webpki 0.103.13 / zip 2.4.2；我们分别为 0.4.20 / 0.11.19 / 0.23.46 / 0.103.16 / 9.0.5。不能用官方锁文件覆盖这些改动；这只是版本比较，本次未刷新安全公告审计。
- 官方 v0.2.19 到 v0.2.20 没有变更 ui/package.json、ui/pnpm-lock.yaml；升级它不要求回退我们的前端安全补丁。

## 建议顺序

先选择性回移 Codex 异步问题及编辑器选区、设置滚动等低耦合修复；之后单独整合持久侧聊，保护专家和历史会话。实验追踪、GitHub owner 和 lineage 按科研工作流需求推进。ACP 作为独立能力批次处理，先明确私人空间授权。#717 待伴随服务纳入范围后再实施。

如果决定整体升级，应在独立候选中保留双方修复并重建产品包；目前只完成静态检查与临时合并预检，测试仍按用户要求暂停。
