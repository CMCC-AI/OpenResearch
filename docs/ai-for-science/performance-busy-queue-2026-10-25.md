# 忙队列入队与派发刷新隔离

基线 `2be6931`，属于 TD-05，产品版本保持 `0.2.21-mobilesci.1`。

## 改动

- `turns` 内部改为 Arc<Mutex>，忙队列分支取得 OwnedMutexGuard。做出入队决定后，将该 guard、原 Store、消息和 host 交给现有 8 并发执行池；SQL 事务、revision 更新、内存追加及通知由实际 worker 完成。
- 保留原有锁顺序：turns → queue_persistence → plan_changes → permission_changes → queued。持久化成功才追加内存队列；上一批的事务与 revision 回滚保留。释放锁后发出 queued/session 通知，等待 HTTP 请求取消不会抑制已执行入队的通知。
- 派发前的持久队列刷新改由 `reserved_store_phase` 执行，worker 持有 cleanup、Store 和 TurnGuard。请求等待被取消时，不会在实际读取/内存刷新结束前释放占位。提取行读取回调以复用原有反序列化、取消、in-flight 过滤和 suppression 规则。
- 后续发送准备可复用派发刷新保留的连接。仅复用未 admitted、没有 unstarted_usage 的 Preclaimed guard；其他情况维持独立连接，避免转移正在承担中断/计量清理责任的连接。

## 取消和剩余锁范围

等待后台池许可时尚未开始的入队工作，若请求被取消，可直接丢弃而不写入。worker 已开始时，取消等待不取消事务/内存发布；后续重试仍经既有 clientTurnId/哈希和队列查询判断。Stop、派发和其他发送等待同一 turns 序列化点，不会在事务尚未完成时越过入队。

本批只移出异步运行时上的事务和刷新工作，**没有移除忙队列事务持有的全局 turns 锁**。SQLite/队列慢操作及等待后台池许可仍可能延迟其他会话的 turns 操作；queue_persistence、queued 等 std::Mutex 的其他同步使用者也仍可能等待。缩小全局锁范围需要另行设计入队占位和取消/派发协议，不能用当前修改冒充已实现跨会话并行入队。

提交后 session 快照读取失败仍可能向请求返回错误，而消息已在持久和内存队列中；这是原有返回语义，不新增自动删除或重复插入。通知使用最新内存队列，若 Stop 已先清空队列，发送空队列快照是有效状态。

## 验证

新增单线程慢 worker 回归：异步 timer 可前进，取消等待后实际 worker 仍持有 turns；成功路径的数据库/内存队列和 session 通知仍完成，注入错误释放锁且无入队。用 host 引用计数等待真实 worker 退出后再删除测试目录。新增派发连接私有临时表回归，证明发送准备复用同一连接并保留占位释放。

最终完整 Rust 回归退出 0，1261 项单元、18 项集成测试通过，11 项专用测试默认忽略；fmt、Clippy all-targets/-D warnings、diff 与上游基线检查通过。日志与哈希位于忽略目录 `.mobilesci-run/performance-busy-queue/`；首次测试编译的队列计数接口误用已修正，最终使用 `full-tests-final.log`。不改 UI、不重建前端，不调用真实模型、不运行实验，不重启当前服务、不部署服务器；没有端到端延迟或吞吐百分比结论。

TD-05 未整体关闭：忙队列全局锁范围、派发出队与失败重排、其他队列/steering 入口、部分租约、Stop 历史标记及目标事件文件操作等继续治理；磁盘满和最终写入失败恢复边界也继续保留。
