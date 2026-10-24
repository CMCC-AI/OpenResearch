# 发送设置、附件与队列事务连续治理

基线 `3587c95`，继续 TD-05，产品版本仍为 `0.2.21-mobilesci.1`。

## 本批范围

- 普通发送的模型/速度/权限/Plan/推理设置持久化、历史消息及项目读取、取消归档，移入既有 `reserved_store_phase`。保留恢复设置、清除 Codex 原生模型判断和权限/Plan revision 规则，继续复用同一连接。
- 附件保存、显示文本与注释组装、首行或附件标题 fallback 也在同一有界 worker 执行。材料原件与读取约定、服务端生成文件名、旧附件和 replayed 文件规则不变；用户消息仍在随后 durable admission 时插入。
- worker 持有 cleanup 锁、TurnGuard 与 Store 到实际结束。Stop 等待此阶段后再交接，取消请求不提前释放正在工作的预占位；阶段失效则不执行设置/附件操作。设置或文件已经写入时不会因请求取消而自动回滚，沿用原有语义；附件孤儿生命周期仍属于后续治理。
- 忙队列的 Plan/权限更新和 payload 插入经 `persist_busy_queued_message` 在一个 BEGIN IMMEDIATE 事务内提交，提交后才追加内存队列。`persist_busy_queue_with_revisions` 在原有锁内保存 revision 快照，失败时同时恢复 Plan/权限内存 revision 和 SQLite 设置/入队，避免设置已变但消息未排入或内存模式残留；其他会话的 revision 不变。请求 payload 仍去除已应用的 Plan/权限 override，模型等其他设置继续随排队消息保留。

## 性能口径与剩余锁

普通发送的上述同步 Store/文件工作不再直接运行在异步工作线程。忙队列最多三次独立提交合并为一次事务；没有 Plan/权限变化时本来就只有一次写提交，不能将所有排队请求都算作减少三倍提交。

忙队列仍在原有 turns/queue_persistence/plan_changes/permission_changes/queued 锁保护下执行同步事务，本批**没有完成忙队列异步隔离或移除全局锁**。普通设置阶段的 revision std::Mutex 也仍跨对应读取/写入持有，其他使用者可能等待这些锁；取消不会强杀正在执行的同步操作。下一步需要连同队列 dispatch、重复请求、取消及内存/SQLite 一致性一起改造，而不是先释放锁再让持久化和派发竞态。

## 验证

新增队列事务回归验证成功提交后的持久 payload、override 归一化，以及用 SQLite trigger 强制插入失败后的设置、队列和内存 revision 回滚。新增隔离子进程发送回归走真实 `send_message_showing`：强制 admission 插入失败，确认模型偏好、归档恢复与首行标题保留、未插入新 turn、占位释放，且不调用 harness。已有 reserved phase 取消、故障和 Stop 回归随全量执行。

定向 metadata 回归 13 项通过；最终完整 Rust 回归退出 0，1259 项单元、18 项集成测试通过，11 项专用测试默认忽略。fmt、Clippy all-targets/-D warnings、diff 与上游基线检查通过。最终候选日志与哈希在忽略目录 `.mobilesci-run/performance-send-metadata/`；`full-tests.log` 属补强内存 revision 回滚前的候选，最终使用 `full-tests-final.log`。不改 UI、不重建前端，不发起真实模型调用或实验，不重启当前服务、不部署服务器。没有新增端到端延迟、吞吐或生产压力结论。

TD-05 仍未整体关闭：忙队列/其他队列入口、部分 steering、租约、Stop 历史标记和目标事件文件操作等继续排期；磁盘满恢复与最终写入失败边界也未因本批关闭。
