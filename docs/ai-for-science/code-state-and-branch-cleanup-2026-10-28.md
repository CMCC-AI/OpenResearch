# 代码状态复核与本地分支清理（2026-10-28）

后续实施：下文是 `a421c09` 的检查快照。steering 持久登记、跨通道去重与原身份回退已继续实施，见 [steering 回执记录](steering-receipts-2026-10-28.md)；pending 跨刷新恢复仍未完成。

## 检查基线

- 检查开始时工作区干净，唯一 worktree 为当前仓库，无其他已检出的开发分支。
- 已发布标签 `v0.2.22-mobilesci.1` 指向 `e72bc1b2faea37cfdf0fd336d41020a1a49038f5`。
- 当前代码为 `a421c093e2f50c5901b545eb2674829dc7b51701`，比发布标签多一笔科研交付、刷新合并及平台限流修复。其部署记录见[故障修复记录](../product/research-delivery-incident-2026-10-28.md)；本次未重新核验服务器。
- 开始时分支为 `codex/release-mobilesci-0.2.22-mobilesci.1`。该分支上的新提交会触发 source release 工作流，而 publish 步骤要求既有标签指向本次 SHA；因此后续开发已从当前 HEAD 转到 `refactor/technical-debt-followups`。未重置发布分支或移动标签，也未查询远端 Actions 的最新运行结果。
- `main`、`feat/ai4s-product` 均为当前 HEAD 的祖先，但继续保留其长期开发／远端跟踪用途。`main` 在本地显示落后 `origin/main` 165 笔；这是本地跟踪引用的比较，不能当作刚刚查询的远端状态。

## 当前已解决的项目

不能将旧评估的所有问题重新列成待修复项：

- #771 模型目录等待插件就绪、#776 发送前历史取消处理与本地错误归属、#803 A 普通发送／队列请求回执均已进入发布标签。后续不应退回 busy 推断投递成功。
- TD-14 的任务 brief 变化及下游继承失效、TD-15 独立续租、TD-05C Stop 中断顺序、TD-18 有界证据读取已有修复记录。本次 Rust 科研过滤回归通过，不等于重新验收所有运行时负载边界。
- `a421c09` 已区分 experiment 与 inference 声明的日志校验，保存交付失败原因，合并流式刷新，并隔离平台活动／读取／写入限流。它不代表研究暂停／结束生命周期或当前引用闭包已经实现。

## 遗留问题与实施顺序

| 优先级 | 问题与依据 | 影响范围及下一批验收 |
| --- | --- | --- |
| P1，第一批 | steering 缺少持久请求回执和跨通道去重。`src/local/chat/mod.rs` 的 `SteerMessage` 只有 display/text；`steer_message` 在内存 channel 成功后返回，未登记请求；`park_steer_with_store` 另生成 client ID。`src/store.rs::chat_submission_by_client_id` 仅查询 turn/queued。 | 弱网、客户端重试、native steer 回退排队时可能无法判定同一请求身份。先统一 `(session_id, client_turn_id)` 和请求 hash 的准入契约，持久记录登记状态，回退保留原身份，跨普通发送／队列／steer 互斥。测试并发、串号、同 ID 异 payload、崩溃恢复及回退，严格区分服务器登记与模型实际接收。 |
| P1，第二批 | 待确认发送身份只存于 `ChatPanel.tsx` 的 `pendingClientTurn` ref，切换会话时清空，刷新后也不会恢复。 | 一旦投递结果未知，刷新／返回会话可能丢失安全重试身份。依赖上一批回执契约，按账号、workspace/runtime、项目和会话隔离持久 pending；提供恢复、确认、拒绝和显式放弃规则，避免恢复到其他用户或会话。 |
| P2，可独立实施 | `ArtifactsTab.tsx::artifactTarget` 未对 URL 路径解码，直接交给 `api.ts::artifactUrl` 再编码，未复用 `markdownTarget.ts` 的路径契约。 | 对实际函数做只读探针：输入 `%E7%BB%93%E6%9E%9C.md`，服务端一次 URL 解码后仍为 `reports/%E7%BB%93%E6%9E%9C.md`，预期为 `reports/结果.md`。中文、空格和保留字符链接可能找不到产物。统一为仅解码一次，覆盖 `%25`、query/hash、非法编码和越根路径，再重建 UI。 |
| P1，输入身份后续 | `src/store/research.rs` 的继承检查已有 workflow、brief、role、outputs、depends_on 等比较，但材料来源／hash 尚未作为任务输入版本参与继承身份。 | 材料内容改变后，已有产物不能仅凭文件 hash 未变就自动继承。先定义任务实际使用哪些材料及对应版本，再使受影响任务与下游审查失效，避免任意上传都导致全部重做；材料目录展示不能当作 AI 已读。 |
| P2，先确定契约 | 研究级暂停／结束入口不足；`research_decide` 在交付批准后更新决策，没有结束 study；CLI `ResearchCommand` 无研究暂停／结束命令。 | 影响持续调度、活跃研究列表及删除保护。明确暂停调度、结束研究、停止已有 Run、归档的区别，再实现状态转换；不删除 active 保护来绕过问题。 |
| P2，回收前置 | `research_runs` 聚合所有计划的 run_ids/previous_run_ids 及 claims 引用；`research_package_scope` 仍要求此全集的日志存在并完成 hash。 | 历史日志丢失可能阻塞当前交付。明确“当前结论引用闭包”和“完整历史审计”的产品契约，再统一交付、容量统计与回收。`a421c09` 的 inference 校验修复不解决此范围问题。 |
| P2，CI 稳定性 | `event_flush_preserves_cadence_tail_and_final_order` 在真实 SQLite 写入后立即断言 75ms 节流窗口尚未过；依赖真实 I/O 耗时。上一版发布过程已有 Windows 首次失败、重跑通过记录。 | 拆出可注入 elapsed/clock 的节流判断，保留真实存储和最终事件顺序回归。不要靠增加时间窗口或跳过 Windows 测试解决。本次未在 Windows 重新复现。 |
| P2/P3，测量后推进 | 研究聚合 JSON、历史日志总量与受保护回收仍需容量边界；平台刷新／限流已有修复但缺长期负载结论。`chat/mod.rs` 约 1.8 万行、`ChatPanel.tsx` 约 7100 行，投递状态分散。 | 先记录聚合字节数、读取/hash 耗时、后台池等待、heartbeat 间隔和 429 桶分布，再决定分页、迁移与模块拆分。按投递／回执契约划模块，避免先做大规模文件搬迁。 |

先处理 steering 持久回执与跨通道去重，再落地 pending 恢复；产物链接与确定性节流测试可独立提交。材料输入身份优先于容量重构；生命周期和引用契约应在 GC 实现前收敛。

## 本地分支清理结果

下列 5 个分支均以 `git merge-base --is-ancestor <branch> v0.2.22-mobilesci.1` 验证通过，且无 worktree 占用。使用 `git branch -d` 删除，没有使用强制删除；提交仍可由发布标签的历史访问。

| 已删除的本地分支 | 原提交（可恢复） |
| --- | --- |
| `codex/backup-before-v0.2.17` | `aa9aa36ff7138f90db7dd44c8716e877016a6bc1` |
| `codex/backup-before-v0.2.18` | `4ccb0f38dbd7448f3d134587baae3c4452675223` |
| `codex/backup-before-v0.2.19-20261016` | `951c38422bdd1911d43234dd18e4c15c311c6d46` |
| `codex/upgrade-v0.2.18` | `3b69786bc1c04f162e54b60952ffd7de11cce458` |
| `codex/upgrade-v0.2.19` | `26126e081e602337b5e631f14c066223baf4c955` |

保留 `main`、`feat/ai4s-product`、既有发布分支及全部标签。新开发分支从 `a421c09` 建立，采用用户要求的不含 `codex/` 的命名。没有删除远端分支、清理对象、重置文件、重启服务或更改部署。必要时可用 `git branch <恢复名称> <原提交>` 恢复上述分支。

## 本次验证

- 前端全量：500/500 通过；`pnpm typecheck` 通过，路由生成器有既有 circular dependency 警告。
- 平台单元测试：38/38 通过；Prettier 检查通过。
- Rust：`cargo test --locked --bin orx research` 72/72 通过（过滤器也匹配 OpenResearch 命名的测试，并非只含科研编排）。
- 平台首次有 3 项、Rust 首次有 1 项因沙箱禁止监听本地端口失败；允许本机测试端口后，上述同一套回归全部通过。
- 产品版本／上游祖先检查及 `git diff --check` 通过。Git 连通性检查无 missing/corrupt 错误，有 dangling 对象；保留这些对象以避免影响恢复，不运行 gc/prune。
- 本轮未修改业务代码或 UI，无需重新生成 `ui/dist`。未重跑全量 Rust、PostgreSQL 集成、Windows、打包、在线依赖审计或发布 CI；不把旧发布的全量通过记录冒充本次结果。

短期日志：`/tmp/mobilesci-audit-ui-tests.log`、`/tmp/mobilesci-audit-platform-tests-unrestricted.log`、`/tmp/mobilesci-audit-rust-research-unrestricted.log`、`/tmp/mobilesci-audit-typecheck.log`、`/tmp/mobilesci-audit-platform-format.log`、`/tmp/mobilesci-audit-git-fsck.log`。
