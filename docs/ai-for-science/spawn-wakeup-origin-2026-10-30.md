# 专家通知领取恢复原始路径（2026-10-30）

本批基于 `38b92a4`，检查开始时工作区干净。上一批使有效目标租约保护慢发送，
本批继续检查目标确实失活后，领取回收是否恢复正确的业务路径。

## 问题与复现

`start_pending_chat_spawns` 在三次启动失败后，通过 pending→waking 通知父会话
“专家未能启动”。正常完成汇报则通过 running→waking 通知父会话。
两者共用 waking，但原 `prune_chat_spawns` 将所有过期 waking 都恢复成 running。

所以，失败通知领取后进程退出、目标租约失效，下一次回收会把从未成功启动的专家
送入普通完成摘要流程，丢失“启动失败”的通知含义。

新增隔离 Store 回归：领取 pending 来源的通知，令 claimed_at 过期，关闭原连接，
重新打开并回收。修复前测试报 `wake-up recovery lost Pending origin`，记录为
`/tmp/orx-spawn-origin-before.log`。没有实际等待 TTL 或调用模型。

## 最小处理及成本

- 在既有 chat_spawns 增加一个可空 `claim_from_state` 字段。
  `claim_chat_spawn` 在原有条件 UPDATE 中与 token、时间一起记录领取前状态。
- waking 的来源为 pending 时恢复 pending，其他情况保留 running 回退；
  starting 仍恢复 pending。回收和结算同语句清除来源字段，防止遗留元数据。
- 使用既有 `schema::migrate_columns` 新增独立 `spawn-claim-origin-v1` 迁移，
  不修改已应用的迁移批次；新库也包含该字段。
- 沿用现有启动耗尽判断和失败通知文本，不新增状态机框架、任务表或消息协议，
  公开 JSON 与 ChatSpawn 读取结构保持不变。

记录来源是恢复任务含义所必需的信息。尝试次数不能作为来源证明：历史数据或
其他恢复路径可能拥有相同计数。单个字段比扩展一组领取状态或另建通知队列更小，
也能让已有的 token 条件结算和目标租约保护继续工作。

## 兼容及回归边界

新增两项回归覆盖：

1. pending／running 两种通知来源，均在关闭原连接后恢复原路径；尝试次数不变，
   旧 token 失效，重新领取和结算成功，返回原状态及完成时都清除来源。
2. 模拟没有该列和迁移标记的旧数据库，重复打开验证迁移幂等并保留状态、token、
   attempts。旧 waking 行的来源为 NULL，回收仍沿用历史 running 回退，不伪造来源。

历史领取无法可靠补全来源，因此这项改动保证由新逻辑记录的领取恢复正确路径，
没有宣称修复所有既存的无来源领取。旧版本写入方也不会记录该字段；混合版本并发
写入不在本轮恢复保证范围内。该列为可空扩展，不要求旧写入方提供字段。

保留已有领取失效、失败次数原子性、有效租约保护及孤立会话清理测试。
没有变更 TTL、三次失败阈值、用户消息或科研产物，也不提供跨崩溃恰好一次投递保证。

## 验证结果

- 专家领取专项 16 项通过，新增恢复路径及旧库迁移两项回归。
- 完整 Rust：1,396 项单元、18 项集成通过，13 项按既有规则默认忽略，未增加忽略项。
- Clippy 全目标、`cargo build --locked`、格式及差异检查通过。
- 日志：`/tmp/orx-spawn-origin-{before,targeted,rust-full,clippy,build}.log`。
- 没有 UI 改动，未重建内嵌资源；未运行远端 CI、Windows/Linux 打包、
  平台 PostgreSQL 集成、在线依赖审计或真实模型验收。未推送或部署。
