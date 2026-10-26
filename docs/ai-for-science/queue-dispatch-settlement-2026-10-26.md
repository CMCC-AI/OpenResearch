# 队列派发结果收尾隔离（2026-10-26）

接续 `c7970de` 的 Stop 治理；该提交及此前积累的 16 个提交已成功推送到现有 `origin/feat/ai4s-product`。本批继续 TD-05，产品版本与上游 partial 状态保持不变，不包含工作区已有的首页、主题和图片资源改动。

## 原因与范围

`drain_queue` 在发送结果返回后，原来直接在异步任务中进行以下同步操作：

- NotStarted：读取磁盘队列，恢复尚未准入的原始请求。
- 成功/幂等命中：删除已处理的持久化队列项。
- 失败：读取 harness、记录错误和尝试次数、保存原幂等键及下一次重试时间、重新入队，再启动既有重试计时器。

这些操作持有 queue-persistence 等同步锁，慢打开、SQL 或文件写入会占用异步调度线程。若只是把 SQL 简单 offload，取消等待还可能跳过后续 dispatch 清理与重试安排。

## 实现

1. 将三个分支抽入 `settle_queue_dispatch_with_store`，整个同步收尾阶段进入现有 8 并发执行池；不新增线程池、巡检或重试机制。
2. 用独立任务持有 popped item 与 QueueDispatchGuard，等待者取消后继续完成后台收尾及既有重试安排。派发守卫仍在 queue-persistence 临界区内结算。
3. 保留 Stop/删除检查：已取消或正在删除的失败请求不重新入队，不再打开存储；Stop 的持有计数仍控制何时解除取消。
4. 保留幂等键、队列顺序、尝试次数、退避和耗尽判定；成功删除与失败重试元数据仍使用既有 best-effort 语义。没有把存储失败改成无限重试或静默删除科研数据。
5. 去掉失败收尾中跨 SQL 持有的全局 suppression-map mutex。queue-persistence 仍序列化队列修改，抑制标记值与在途 dispatch 保护保持不变，其他会话可读取抑制表。
6. 判闲时同时检查 in-flight dispatch，并用现有 queue-persistence 的 try_lock 拒绝仍在执行 SQL 的收尾；不阻塞异步判闲线程，防止过早允许重启；目录迁移入口复用同样的队列存储忙检查，返回 409 并提示队列仍在保存。
7. 新增测试放在独立的 `queue_settlement_tests.rs`，仅将两个既有测试 fixture helper 的可见性扩大到父模块范围（仅测试编译），不扩展生产 API。

影响范围为队列派发完成后的收尾，以及重启/目录迁移的判闲保护。没有更改原生模型调用、审批规则、用户 API 字段、UI 或队列的 durable admission 事务；目录迁移增加后台队列仍忙时的拒绝保护。

## 验证

新增定向回归覆盖以下五项：

- 单线程 Tokio 中人为阻塞 Store opener，调度器与 turn-map 仍可用；取消等待者后，实际 worker 继续删除持久化队列项并完成 dispatch 状态清理；worker 执行前和慢存储期间拒绝判闲，实际收尾完成后才允许判闲。
- NotStarted 从隔离 Store 恢复原队列项；读取失败时保持磁盘项，清理在途状态，沿用既有巡检恢复而不立即循环重派。
- 派发失败后保留幂等键和错误，增加尝试次数并保存耗尽状态；打开/SQL 失败时保留既有“内存更新、磁盘仍为旧状态”的 best-effort 边界，未将其描述为耐久性保证。
- Stop 清理或会话删除先完成后，迟到失败结果不恢复队列、不打开存储，也不提前解除仍由 Stop 持有的取消保护。

- 失败收尾的慢存储期间，suppression-map 的全局 mutex 可读取，原会话抑制标记保持；最终重排后仍保持耗尽抑制。

完整验证通过：**1296 项 Rust 单元、18 项集成**，11 项专用测试忽略；5 项新增定向测试、fmt、Clippy all-targets/-D warnings、debug 构建、上游基线及 2 项产品版本测试通过。测试使用隔离 Store 与合成慢打开，不将结果换算为生产性能提升比例。

本地日志 `/tmp/orx-queue-settle-{targeted,full,clippy,build,fmt,version}.log`，候选及源码/日志哈希记录在被 Git 忽略的 `.mobilesci-run/queue-settlement/evidence.json`。现有工作区 ui/dist 单独记录，不作为本批发布或 UI 验收结果。

## 遗留与下一步

- claim 和忙队列写入仍持有全局 turn-map 跨 SQL/后台池排队；本批不消除跨会话等待。
- 同步 queue-persistence 仍覆盖存储，出队、取消/手动重试、dispatch guard 提前 Drop 等尚未迁移的调用仍可能等锁。本批只隔离派发结果收尾，不声称整个队列生命周期已异步化。
- 派发成功后的删除失败可留下磁盘旧项，靠既有 client-turn 幂等检查避免重复准入；重试元数据保存失败可造成内存/磁盘状态不同。跨进程重启与磁盘故障下的完整收敛需要后续独立验证。
- 当前服务未重启，未进行登录/真实模型/服务器或跨平台验收；构建使用工作区现有 ui/dist，既有首页改动不计入本批验证或发布结论。

下一步先建立跨会话锁等待基线，再缩小 claim/忙队列锁范围；保留同会话互斥、取消归属、client-turn 去重和目录迁移保护。压缩/扫描、材料及磁盘治理继续按[当前技术债清单](technical-debt-progress-2026-10-26.md)排期。
