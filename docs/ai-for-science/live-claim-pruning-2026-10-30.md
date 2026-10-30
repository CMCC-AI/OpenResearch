# 领取回收尊重发送目标的存活租约（2026-10-30）

本批基于 `069cc1c`，工作区检查开始时干净。上一批使旧 token 无法扣减新领取者
的重试额度，本批继续核查什么情况下领取会被判为失效。

## 问题与复现

`prune_chat_spawns` 和 `prune_run_wakeups` 原先仅按 claimed_at 判断领取过期，
没有检查 `TurnGuard` 为发送目标持有的持久会话租约。
因此，即使会话心跳正常，超过 60 秒的准备／受理工作仍可能被其他服务进程撤销领取。
专家启动还会提前消耗一次 attempts；后续结算因 token 失效而失败。

两项隔离 Store 回归均在修复前失败：

- 活跃子会话的 starting 被重置为 pending，报 `live target reclaimed in Starting`。
- 活跃订阅会话的运行唤醒从 claimed 被重置为 pending，报 `live run wake-up was reclaimed`。

记录为 `/tmp/orx-live-prune-before.log`。测试使用两个数据库连接，将领取时间推到
过期边界，保留真实写入的新鲜会话租约；没有实际等待一分钟或调用模型，
也没有据此声称线上准备阶段一定超过 TTL。

## 最小处理

在原有回收 UPDATE 中增加对 `chat_turn_leases` 的 NOT EXISTS 检查，沿用既有租约 TTL：

| 领取阶段 | 应保护的发送目标 |
| --- | --- |
| 专家 starting | 专家子会话 session_id |
| 专家 waking | 被唤醒的父会话 parent_session_id |
| 运行完成通知 claimed | 通知订阅会话 chat_session_id |

每次回收使用同一个 now 计算领取与租约边界。只有领取过期且目标没有有效租约，
才沿原规则恢复状态、清除 token；starting 的回收计数也只在实际回收时发生。
原有目录迁移保护、孤立会话清理和已取消 Run 的订阅清理保持不变。

没有增加租约类型、后台线程、数据表或字段，不扩大 TTL，不新增轮询式补偿系统。
改动只为两条回收 UPDATE 增加现有主键表查询，避免撤销仍在受理工作的领取。

## 回归与边界

新增两项回归共覆盖 12 组：starting／waking 各 4 组，运行完成通知 4 组。
每个阶段分别验证新鲜目标租约、无关会话租约、过期目标租约、无租约：

- 新鲜目标租约保留状态、token 和 attempts；释放租约后仍可正常回收。
- 无关会话或过期租约不阻止回收；旧 token 失效，新领取者可继续结算。
- 专家启动回收仍只增加一次 attempts，父会话唤醒不增加启动次数。
- 保留既有目录迁移、领取接管、废弃工作恢复和孤立会话清理回归。

租约不是领取 token 的归属证明：目标上其他正常轮次的有效租约也可能延后回收。
这与隐藏发送须等待目标空闲的既有规则一致；目标空闲或租约过期后可继续恢复。
本轮没有保证跨崩溃恰好一次执行，仍依赖既有心跳、token 条件结算和恢复流程。

## 验证结果

- 两项专项回归通过，覆盖 12 组租约场景，修复前两项均失败。
- 完整 Rust：1,394 项单元、18 项集成通过，13 项按既有规则默认忽略，未增加忽略项。
- Clippy 全目标、`cargo build --locked`、格式及差异检查通过。
- 日志：`/tmp/orx-live-prune-{before,targeted,rust-full,clippy,build}.log`。
- 没有 UI 改动，未重建内嵌资源；未运行远端 CI、Windows/Linux 打包、
  平台 PostgreSQL 集成、在线依赖审计或真实模型验收。未推送或部署。
