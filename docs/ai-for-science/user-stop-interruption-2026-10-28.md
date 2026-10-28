# Stop 运行时取消与持久化收尾（2026-10-28）

本批处理 [TD-05C](technical-debt-next-priorities-2026-10-28.md) 中“慢存储推迟实际中断”的问题。原来用户 Stop 先等待全局队列持久化锁和数据库删除，然后进入中断；中断内部又先写历史、读会话，再 abort 运行任务和调用原生客户端。

## 改动

- 用户 Stop 的独立收尾任务先持有内存取消计数，再并行执行中断与持久队列清理。建立该计数不等待全局队列持久化锁，重复 Stop 各自拥有计数；HTTP 等待者取消不终止收尾。
- 中断在全局 turn 锁内核对 token 并把当前状态转成 `Cancelling`，随后立刻 abort 运行任务、取消待答权限卡。原生中断与历史持久化并行，后者仍等同会话 cleanup gate。`Cancelling` 保持到完整收尾结束，旧 worker 可完成，但不能放行后继 turn。
- `ActiveTurn` 保存原生中断目标，`TurnCtx` 与之共享 native session ID。原生 ID 创建/轮换时更新缓存，中断无需打开 Store 查询目标。Codex 保留原生 interrupt 与最终 items 核对，Claude 保留 kill，OpenCode 用当前 native ID 发 abort；无 ID 或 abort 失败/超时则退回终止该会话的 serve 子进程，历史文件不删除。原生收尾保留整体 10 秒超时，OpenCode abort 使用其中 3 秒窗口。
- 所有队列取消读取都检查取消计数与原有标记，旧派发收尾即使移除自己的标记，也不能越过另一个尚未完成的 Stop。claim 与最终 launch 也检查此保护；重启空闲判断及目录迁移忙检查包含尚未落盘的 Stop。
- 队列清理和中断都完成后才释放本次取消计数；队列删除失败仍向调用方报告，不能发布虚假的空队列。历史标记仍按实际持久化的分支发布。

实现位于 `src/local/chat/mod.rs`，没有数据库结构或客户端协议变更。移除了原生中断前读取会话的旧 helper 及其单独读取测试；原生目标改由运行时提供。

## 回归

在 `src/local/chat/debt_tests.rs` 新增两项测试：

1. 子进程隔离四种场景：全局队列锁与真实 SQLite 写锁、单独 SQLite 写锁、同会话 cleanup gate、重复 Stop。在释放阻塞前，观察运行任务的 Drop 确认已经 abort；确认仍为 Cancelling、取消保护与迁移忙检查有效；释放后检查队列删除、租约释放和 interrupted 历史。重复 Stop 不能清除前一个 Stop 的计数。
2. 没有运行 turn 时，仅剩 Stop 计数仍须拒绝新 claim，且不得打开 Store；也不得判为空闲重启或允许迁移。释放计数后能正常 claim 并释放租约。

原有用户请求取消、清队列失败、标记失败、重叠持有、迟到入队、租约归属及会话收尾测试继续保留。上述新增测试观察受控任务取消，不是对真实模型响应时间的测量。

首轮完整回归发现旧元数据测试仍要求重复中断等待 cleanup gate。该断言调整为重复中断不重复执行，并继续验证真实 worker 持有的 gate、Cancelling 状态和新 claim 拒绝，随后释放 worker 核对写入完成；四项元数据测试通过。初次结果保留于 `/tmp/orx-stop-full-initial.log`，完整候选重新验收。

## 保留的边界

HTTP Stop 仍等待持久队列清理与必要收尾，清队列仍通过既有全局持久化锁串行；本批改变的是实际取消的触发顺序，不承诺请求立即返回。取消后的历史、用量、队列落盘可能继续等待数据库；保护会在完成前保留。

数据库删除失败会返回错误并保留可重试队列。进程若在删除提交前崩溃，内存取消计数不会跨重启保留，磁盘队列仍按既有恢复策略处理；本批没有新增持久取消 journal。原生客户端、操作系统或调度线程卡死也不具备硬实时保证。真实模型、浏览器 Escape 和部署验收仍需在加载该候选后进行。

当前完整候选（含前几批尚未提交的修复）本地验收：

- 6 项用户 Stop 定向测试及 4 项元数据收尾定向测试通过。
- `cargo test --locked`：1329 项单元测试、18 项 CLI 集成测试通过，11 项原有忽略项，零失败。
- `cargo clippy --locked --all-targets -- -D warnings`、`cargo build --locked`、格式和 diff 检查通过。
- 产品上游基线检查及 2 项版本测试通过，未查询官方最新更新。

最终日志位于 `/tmp/orx-stop-{targeted,metadata,full,clippy,build}.log`。源码与日志 hash 保存在本地忽略目录 `.mobilesci-run/user-stop-interruption/evidence.json`。本地检查不替代跨平台 CI、真实模型或部署验收。

未改 UI、部署或重启服务，未提交当前工作区。
