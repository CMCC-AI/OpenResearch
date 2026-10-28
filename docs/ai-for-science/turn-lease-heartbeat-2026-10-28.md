# 会话租约独立续租（2026-10-28）

本批处理 [TD-15](technical-debt-next-priorities-2026-10-28.md)：原来 `watch_runs` 每轮取得目录 gate，续租后依次等待 Run 唤醒、专家扫描、自动派发和产物验收。3 秒休眠不等于心跳间隔，慢扫描和人工交付校验都可能推迟下一次续租。

## 实现

- `src/local/chat/mod.rs`：`watch_turn_leases` 独立运行，每次续租结束后约 3 秒再尝试；`watch_runs` 只负责扫描和唤醒。失去 token 的会话通过原有 token 检查入口异步中断，同一个 session/token 的未完成中断不重复派发，慢收尾不阻塞其他会话续租。
- `src/local/blocking.rs`：续租使用单并发有界通道，通用 Store/文件/Git 工作仍维持 8 并发。续租不再竞争这 8 个工作许可；底层仍共用 Tokio blocking 线程，不引入无限线程或无限续租任务。
- 续租批次在一次写事务中更新所有当前 token，统一提交后才报告确实丢失的 token。数据库忙、打开失败或 SQL 错误向外报告，不把它们当作所有权丢失；后续循环重试。生产打开和批次锁等待采用 1 秒 SQLite busy timeout，避免逐会话各等待一次。
- `src/commands/up.rs`：启动独立续租循环。目录迁移先取得原扫描 gate，再取得专用续租 gate；等待长扫描时续租继续，实际检查和迁移时停止续租存储。续租 worker 持有 gate 至真实工作完成，等待者取消不会提前释放；迁移文件 worker 同样持有续租 gate。
- 保留 60 秒 TTL、跨进程 token 归属检查、崩溃恢复和原有过期租约巡检。续租尝试间隔超过 10 秒且存在本地 token 时写延迟日志，存储失败记录错误。

## 回归场景

新增五项测试：

1. 阻塞真实扫描存储阶段并排队迁移，连续两次注入过期时间再验证续租恢复；另一 Store 连接不能抢占已恢复的 token。
2. 持有迁移续租 gate 时不打开存储；续租已进入 worker 后取消循环，gate 保持至 worker 完成。
3. 一个失去 token 的会话在 cleanup 锁上等待时，其他会话仍连续续租，且不触碰新所有者的 token。
4. 真实 SQLite 写锁导致续租报错，保留本地 token；释放锁后可正常续租。
5. 占满通用后台工作许可时，续租通道仍能执行。

原有空闲跳过存储、旧 token 不得中断后继 turn、取消保留目录 gate、存储失败不误报丢失、跨进程 claim 与恢复测试继续执行。测试使用隔离 Store 和受控阻塞，不调用真实模型、不移动用户数据。

## 边界与验收

独立调度消除了扫描、人工确认和通用工作许可带来的续租依赖，不保证任意负载下的硬实时期限。持续数据库写锁、操作系统停顿或 Tokio blocking 线程完全耗尽仍可能超过 TTL；日志报告延迟/错误，不自动延长租约或绕过其他进程的 claim。未证明线上曾发生超时，也未开展真实部署长时间压测。

当前完整候选（含前几批尚未提交的修复）本地验收：

- `cargo test --locked --bin orx lease_`：21 项租约相关定向测试通过。
- `cargo test --locked`：1328 项单元测试、18 项 CLI 集成测试通过，11 项原有忽略项，零失败。
- `cargo clippy --locked --all-targets -- -D warnings`、`cargo build --locked`、格式与 diff 检查通过。
- 产品上游基线检查及 2 项版本测试通过，没有查询官方最新更新。

短期日志位于 `/tmp/orx-heartbeat-{targeted,full,clippy,build}.log`；源码与日志 hash 保存在本地忽略目录 `.mobilesci-run/turn-lease-heartbeat/evidence.json`。这些检查不替代跨平台 CI、真实模型与部署验收。

未改 UI、数据库结构、外部 API 或 TTL；未提交、部署或重启服务。TD-05C Stop 等待问题继续单独治理。
