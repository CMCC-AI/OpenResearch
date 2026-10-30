# 专家启动结算的 token 保护与失败计数（2026-10-30）

本批基于 `35eed9b`，检查开始时工作区干净。复核自动唤醒失败路径时发现，
`start_pending_chat_spawns` 在启动失败后先调用不带 token 的
`record_chat_spawn_attempt`，随后调用 `settle_chat_spawn`，却忽略其 bool 返回值。

这有两个独立窗口：

- 旧领取过期并被另一连接重新领取后，旧工作者仍可增加新领取者行上的 attempts，
  并把没有实际结算的结果当作成功。
- 次数更新已提交，但后续状态结算 SQL 失败，留下 starting 状态及提前增加的次数；
  之后过期回收还会再次计数。

## 复现

将原有启动结算代码提取为私有 `settle_spawn_start`，供 watcher 和回归共用，
未先改变其行为。两个隔离回归均在修复前失败：

1. 两个 Store 连接共享临时数据库，旧 token 过期回收后由另一连接获得新 token。
   旧工作者继续结算时测试报 `a stale start was treated as settled`。
2. SQLite 触发器让 returning-to-pending 的状态结算失败。
   测试显示 attempts 已为 1，本应仍为 0，状态与领取仍未释放。

记录分别为 `/tmp/orx-spawn-start-before.log`、`/tmp/orx-spawn-settle-before.log`。
没有等待真实 TTL，也没有启动原生模型；第一项通过修改隔离数据库的 claimed_at
精确模拟过期边界，不修改生产 TTL。

## 最小处理

- 将次数更新并入 `Store::settle_chat_spawn` 已有的带 token 条件 UPDATE。
  仅原状态为 starting、目标为 pending 时增加一次 attempts。
- 次数、状态与领取释放在同一条 SQL 中完成。token 不匹配时零更新；SQL 失败时
  整条语句回滚，没有提前提交的失败计数。
- 删除已无调用方的不带 token 计数入口，减少遗漏调用约束的可能。
- 启动阶段检查结算 bool；失效领取向 watcher 返回错误，后续扫描按当前持久状态处理。

不增加表、列、锁、重试系统或第二套 token，也不改变三次启动失败阈值。
成功启动不增加次数，通知父会话失败返回 pending 也不增加启动次数；
过期 starting 的现有回收计数保持不变。

## 回归与边界

新增两项回归覆盖：旧 token 不消耗新领取者额度、当前 token 可正常结算、
结算 SQL 失败没有部分计数、移除故障后可重试、成功启动不计失败，
以及 waking→pending 不计启动失败。保留原有领取、回收、跨进程租约和唤醒测试。

本轮只保证持久结算与失败计数的所有权和原子性。启动动作先于结算，因而不把
跨进程过期接管、崩溃恢复或原生模型执行宣称为恰好一次；相关行为仍依赖既有
会话租约、TurnGuard 和回收流程。没有扩大 TTL、增加重试预算或重构调度器。

## 验证结果

- 运行唤醒专项 29 项通过，新增两项所有权及 SQL 故障回归。
- 完整 Rust：1,392 项单元、18 项集成通过，13 项按既有规则默认忽略，未增加忽略项。
- Clippy 全目标、`cargo build --locked`、格式及差异检查通过。
- 日志：`/tmp/orx-spawn-start-{before,targeted,rust-full,clippy,build}.log`，
  以及第二项基线 `/tmp/orx-spawn-settle-before.log`。
- 没有 UI 改动，未重建内嵌资源；未运行远端 CI、Windows/Linux 打包、
  平台 PostgreSQL 集成、在线依赖审计或真实模型验收。未推送或部署。
