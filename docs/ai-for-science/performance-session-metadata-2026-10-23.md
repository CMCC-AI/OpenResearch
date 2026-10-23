# 性能治理第十批：会话元数据收尾（2026-10-23）

基线 `cce2c53`。本批继续处理共享聊天收尾的同步存储；功能扩展和服务器部署暂缓。

## 实施范围

- `finish_turn` 中 Store 打开、会话 touch、spawn 完成标记及会话快照读取，整体移入现有 8 并发 blocking 执行池。返回后仍等待持久队列刷新，再重新核对槽位归属，按原规则进入 Draining 或后台释放租约。
- 新增每会话 cleanup 锁，元数据操作取得锁后核对 Active 的 message ID，或确认是 Cancelling 收尾；失去归属时不打开 Store。压缩使用 Active 消息标识，不依赖 chat_turns 行，因此同样适用。
- `interrupt` 在改变槽位前取得同一个 cleanup 锁。等待期间不持有全局 turns 锁；不同会话使用独立锁。存储闭包持有 owned guard，等待者取消后，已经运行的写入仍与同会话中断交接串行，不能在 Stop 放行新 turn 后继续写旧元数据。
- 锁注册表保存弱引用，并在获取锁时清理失效项，避免为已结束会话永久保留锁对象。原有会话更新时间、spawn 完成语义、事件和队列派发规则不变。

锁顺序为 cleanup → turns。仅在核对和交接槽位时短暂取得 turns，实际 Store 打开和 SQL 操作均不持有该全局锁。Stop 可能等待同会话正在执行的元数据存储；不会等待其他会话的 cleanup 锁，也没有强行取消 SQLite 写入。

本批沿用原有 best effort：touch 或 spawn 标记失败后仍尝试读取会话，整体失败时继续收尾；没有新增自动重试或跨步骤事务。cleanup 锁只协调当前 ChatHost，跨进程仍依赖既有 durable lease 协议。

## 验证

新增四项回归，使用独立临时数据库：

1. 普通 Active、压缩 Active 和 Cancelling 三种收尾均只打开一次 Store，正常更新会话时间、写入 spawn 完成标记并返回会话快照。
2. 在 cleanup 锁上等待的旧任务，取得锁后发现已进入 Cancelling，跳过 Store 打开，不误更新会话；当前停止收尾仍可正常写入。
3. 注入慢打开并取消外层等待者，后台任务继续持锁。同会话的实际 interrupt 调用等待，异步计时器、全局 turns 锁和另一会话的 interrupt 仍可推进；存储结束后中断检查才返回。
4. 注入 Store 打开失败后，锁正常释放、会话时间不变；显式再次调用可成功。本批不将该测试解释为生产自动重试保证。

最终验证通过：`cargo fmt --all --check`、`cargo clippy --locked --all-targets -- -D warnings`、`git diff --check` 均通过；完整 `cargo test --locked` 退出 0，1224 项单元测试及 18 项集成测试通过，8 项专用测试默认忽略，本轮未复跑这些忽略项。最初四项针对性测试通过后补强了旧任务排队前的 Active 状态夹具，最终完整回归覆盖该补强。

日志和源码哈希保存在忽略目录 `.mobilesci-run/backport-v0.2.20/acceptance/performance-metadata-*`，不提交测试数据库和模型会话日志。

## 仍需处理

- 中断、turn 启动和其他队列入口仍有同步 Store；目标事件文件清理、部分 harness 路径及遥测 outbox 扫描也尚未整体隔离，TD-05 不整体关闭。
- 本批证明调度、归属检查及取消时的交接边界，未新增吞吐、CPU/RSS 或尾延迟测量，不声明具体提速百分比。
- 未改 UI、依赖或平台服务，未重启本地已有实例或部署服务器；本地 Rust 回归不代替生产压力与完整跨平台 CI。
