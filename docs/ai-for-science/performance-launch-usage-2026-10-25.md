# 启动用量注册与首次运行状态隔离

基线 `680f9f4`，继续 TD-05，产品版本保持 `0.2.21-mobilesci.1`。

## 本批改动

- 普通发送和显式恢复都在后台池完成用量 execution 注册，再复查预占位并同步交接至 Active。普通发送复用已有连接；恢复入口按需打开连接。全局 turns 锁内不再打开 Store 或执行 begin_usage_execution。
- `prepare_launch_usage` 由 worker 持有 cleanup 锁、TurnGuard 和连接；把 turn ID 绑定到 Reserved，Stop 可以捕获正确目标。注册成功后 guard 记录本次 unstarted_usage execution_id；直到同步交接 Active 才 defuse。
- 请求取消、启动前失去占位或删除拒绝时，独立 guard 清理按 execution_id 结算尚未启动且无样本的记录。即使原占位已经移交或被替代，也会清理这条旧 execution；中断 turn 和释放占位仍要求 reservation_id 匹配，不影响后继占位。
- Store 新增内部 `cancel_unstarted_usage_execution`，只更新 outcome=NULL 且不存在样本的指定 execution。重复清理无效，已结束或带样本的 execution 不处理；不按整个 turn 结算，从而保留同 turn 的其他 execution。无样本不生成模型用量报告。
- Active 任务的第一次 running/attempt=1 写入也移入有界池，执行前核查 session/message/turn 归属，worker 持有 cleanup 锁到写入结束。Stop 等待该阶段后再中断，不会先完成中断再被迟到的启动写入覆盖；失效任务不继续调用 harness，存储错误仍沿用原来的 best effort。
- 恢复启动遇到删除拒绝时复用 guard 的后台清理，不再同步另开 Store 中断。

## 顺序与边界

正常发送的 user/session/busy 广播现在在注册成功后发出，三类广播之间的顺序不变；注册失败时 durable 用户消息仍在数据库，不能把未广播说成未保存。恢复入口既有消息广播顺序保留。注册成功到 Active 的交接没有新增 await；成功启动后本次 execution 保持未结算，由既有完成、失败或 Stop 路径计量。

cleanup 锁覆盖实际 worker，而非仅覆盖异步等待者。取消等待不取消已开始的 SQLite 操作，Stop 可能等待它完成；清理仍为 best effort，没有新增磁盘故障自动重试或跨进程 exactly-once 保证。

## 验证

新增四项回归，覆盖单线程慢注册期间调度可前进、取消后占位与 cleanup 保留、替代占位下精确 execution 清理、同 turn 其他 execution 保留、连接复用与成功交接、样本记录保护、SQL 注册失败清理，以及首次 progress 与 Stop 的串行和失效消息拒绝。

完整 `cargo test --locked` 退出 0，1257 项单元、18 项集成测试通过，11 项专用测试默认忽略；fmt、Clippy all-targets/-D warnings、diff 与上游基线检查通过。最终日志与哈希保存在忽略目录 `.mobilesci-run/performance-launch-usage/`。不改 UI，不重建前端；未发起真实模型调用或实验，未重启当前服务或部署服务器。没有端到端速度或吞吐百分比结论。

TD-05 未整体关闭：设置/排队写入、附件保存、steering 其他同步工作、部分租约、Stop 历史标记、目标事件文件操作及聊天磁盘满恢复仍需后续治理。
