# 准入 claim 与占位释放隔离（2026-10-25）

本批接续[租约心跳隔离](lease-heartbeat-isolation-2026-10-25.md)，处理 TD-05 的准入数据库操作及提前退出后的租约释放。产品版本和上游 partial 状态保持不变。

## 实施范围

原有 `TurnGuard::claim`、隐藏唤醒及带 client turn ID 的空闲发送均在异步任务中直接打开 SQLite、取得租约。同步 token-map mutex 还跨越 Store 打开及 SQL。提前退出的 guard 释放租约时也在异步任务内持有全局 turn 锁执行同步 SQL。

- 普通/隐藏/直接准入及两条队列重派路径复用 `claim_locked_with_store`，在既有 8 并发后台池完成数据库 claim 和 reservation。实际 worker 持有 owned turn-map 锁以及生成的 `TurnGuard`；等待者取消后，成功 claim 的结果仍通过 guard 的归属清理释放，不留下无主租约。
- token-map mutex 仅用于短暂检查和插入，不跨 Store 打开或 SQL。后台任务完成前仍保留全局 turn-map 锁，以保持忙闲判定、同会话互斥、隐藏唤醒不越过用户队列、client turn 去重及设置 revision 的既有顺序。
- 成功 claim 的 Store 随 guard 保存；后续 setup 可复用，取消或错误退出时也可在原连接释放租约，避免重新定位存储。
- 提前退出且无需排队时，复用既有 `Releasing` 状态和后台释放任务。先保留占位，移出全局 turn 锁执行释放，再按 release ID 结束占位并发出一次 busy=false。Store/SQL 释放失败仍保留原有 best-effort 语义，不新增重试队列或改变租约 TTL。
- 需要排队的退出路径仍转为 Draining 并沿用现有派发；队列重派先取得 worker 返回的 guard，再在同一 turn-map 临界区移交给 Draining。旧 guard 不得释放后继占位。

## 验证

新增四项定向回归通过：

1. 在单线程 Tokio 中阻塞 opener，定时器和同步 token-map 仍可用；准入互斥保持，同会话第二次 claim 被拒绝。
2. 取消 claim 等待者，实际 worker 继续持有准入锁；结束后隔离 SQLite 租约、内存 token 和 reservation 均被清理，仅广播一次 busy=false。
3. 用真实 SQLite 写事务阻塞释放，Releasing 期间全局 turn-map 可获取，完成前不发空闲事件，完成后才释放占位。
4. 打开失败、SQL 错误、外部进程租约冲突及重启禁止准入均不产生本机 token 或 reservation；外部租约保留，重启状态不打开存储。

完整 Rust 回归通过：**1287 项单元、18 项集成**，11 项专用测试忽略。格式检查、Clippy（all-targets / -D warnings）、debug 构建、上游基线核查和 2 项产品版本测试通过。未修改 UI，不重复计入上一批 UI 验证。测试为隔离 Store 与合成等待，不将其换算为实际吞吐或响应时间提升。

本地日志 `/tmp/orx-claim-{full,clippy,build,fmt,version}.log`；提交候选和源码/日志 SHA-256 记录在被 Git 忽略的 `.mobilesci-run/admission-claim/evidence.json`。

## 未解决的边界

- **全局 turn-map 在 claim 期间仍被占用**，其他会话的准入/Stop 仍会等待。后台池排队也在此锁保护范围内。本批解决调度线程和同步 token-map 的阻塞，不能声明多会话锁等待已经消除；更改锁范围需另批验证跨会话占位、取消与数据目录迁移。
- 已将 `resume_persisted_queues` 和队列刷新重派处的 claim 接入同一后台 helper；出队/失败重排、Stop 清队列/历史标记、压缩和 run/spawn 扫描仍需按证据处理。
- 不引入新锁表、准入状态机或线程池，不做大模块拆分。下一步优先评估 Stop 同步存储；全局锁缩窄须独立验证。

本批不改 UI、不重启现有服务、不部署服务器，不进行登录或真实模型验收，也不自动推送。
