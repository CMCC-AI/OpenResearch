# 技术债续查（2026-10-28）

> 后续实施：[本日修复记录](technical-debt-remediation-2026-10-28.md)。本文保留修复前的问题与复现证据，当前行为和验证以修复记录为准。

基线：本地 `9d537b1`，开始检查时工作区干净。接续 [10 月 26 日清单](technical-debt-progress-2026-10-26.md)，复核当前源码以及新增的科研自动编排。本文只做分析与隔离复现，没有实施业务修复、重启服务、调用模型或部署。没有查询远端版本、漏洞公告或 GitHub 保护设置。

## 结论与优先级

此前队列缓存读锁、Stop 后台收尾和派发结算的治理仍有效，不能重复列为未实施。但 TD-05 的全局锁和同步入口仍未关闭；新增自动编排也需要补齐产物归属、巡检成本与失败可见性。

| 优先级 | 编号 | 当前问题 | 证据级别 |
| --- | --- | --- | --- |
| P1 | TD-11 | `forceRerun` 后可将未重新写入的旧产物自动验收给新会话 | 隔离 Store 复现 |
| P1 | TD-05A | 全局 turn/revision 锁跨后台池等待与 SQL，跨会话发送、状态和 Stop 仍互相等待 | 源码及现有真实 SQLite 锁回归 |
| P1 | TD-05B | 科研确认、spawn 巡检、出队和 guard Drop 仍在异步路径执行同步存储或等锁 | 源码确认；未测线上延迟 |
| P2 | TD-12 | 已批准交付的研究仍每轮读取产物/日志并无条件更新聚合文档 | 隔离 Store 与 SQL 触发器复现 |
| P2 | TD-13 | 自动派发吞掉错误，阻塞任务缺少可见原因，单个错误中断本轮后续派发 | 依赖产物变化复现及源码 |

## TD-11：强制重做缺少本轮产物归属证明

位置：`src/store/research.rs:600`、`:986`、`:1217`；`src/commands/research_dispatch.rs:280` 附近。

`research_set_plan` 对 `forceRerun` 任务建立新的 pending 状态，但产物仍共用 study 根目录；`research_retry_task` 也不隔离旧文件。后续 `research_finish` 仅读取声明路径，检查非空并生成当前 SHA-256。`on_research_spawn_finished` 在会话正常结束时自动调用这个验收，即使该轮没有写过文件。

隔离复现步骤：

1. v1 的 design 任务写入 `design.md` 并完成验收。
2. v2 对 design 设置 `forceRerun=true`，批准新 G1 并绑定新会话。
3. 新会话完全不写产物，以正常结束结果进入自动收尾。
4. 实际状态变为 completed，记录的 session 是新会话，而 artifact hash 仍为旧文件的 hash。

这不是“SHA-256 能否证明学术正确”的问题，而是未证明产物属于本次强制重做。相同字节也可能是有效重做结果，因此不能简单要求新旧 hash 必须不同。

建议：为 plan/task/attempt 建立产物归属，保存旧版本，显式登记本轮产生或经本轮确认复用的输出；自动验收应验证该归属。优先评估分代产物目录或产物 manifest，兼容当前相对路径和历史下载。不要直接删除旧科研文件，也不要仅用 mtime 或字节变化判断是否执行过。

验收门槛：强制重做、失败重试、审稿/引用审计节点、只生成部分输出、同字节重新生成及重启恢复；未登记本轮输出时不得自动完成。

## TD-05A：后台隔离尚未消除全局锁等待

位置：`src/local/chat/mod.rs:3359`、`:5732` 附近、`:5922`、`:5952`、`:6423`、`:6747`。

- `claim_locked_with_store` 将全局 turns 的 OwnedMutexGuard 移入后台闭包；获取共享 8 并发池 permit 前已经持有该 guard，随后继续持有它打开 Store 和 claim lease。
- 忙入队的 `persist_busy_submission` 同样携带全局 turns guard，且在 SQL 期间持有全局 plan/permission revision mutex。
- settings 阶段也存在 revision mutex 跨 Store 读写；其他会话的 revision 操作仍可能同步等锁。
- `busy_sessions`、`is_busy`、其他会话准入和 `interrupt_with_lease` 都依赖全局 turns。调度线程能继续执行不代表这些操作能及时完成。

现有 `busy_enqueue_sql_wait_keeps_queue_readers_available_after_waiter_cancel` 回归在真实 SQLite 写锁等待期间明确断言：queued 可读，但 turns 的 try_lock 失败。本轮重跑通过。claim 的调度器回归也通过；它证明 timer/token-map 可前进，没有证明全局 turns 在存储等待时可获取。

建议：先补 session A 慢 claim/入队时 session B 准入、busy 与 Stop 的等待基线，再按 session 收敛互斥范围。保留 reservation_id、lease token、revision 回滚、client-turn 去重、等待者取消及目录迁移保护，不能直接在提交前释放锁或提前发布。

## TD-05B：新编排路径仍有同步阻塞

位置：`src/commands/up/research.rs:71`；`src/local/chat/mod.rs:4719`、`:2593`、`:9874`、`:10035` 附近。

人工确认 `decide` 在 async handler 内直接执行 Store 打开、决策事务、自动派发和 study 读取。交付确认还会经 `research_package_scope` 读取并 hash 产物和完整实验日志。相邻的研究状态 GET 已使用 `blocking_api`，确认 POST 尚未复用。

`watch_runs` 的 lease heartbeat 已在后台执行，但返回后的 Store 打开、`process_chat_spawns`、`reconcile_active_studies`、自动验收仍在异步路径同步运行。该循环也负责下一轮 lease heartbeat，慢扫描不仅影响 UI，还会推迟后续心跳；是否达到租约过期阈值需要故障注入，不能据源码断言已经发生。

`drain_queue` 的出队阶段与 `QueueDispatchGuard::drop` 仍同步获取 queue-persistence；后台 worker 持有该 mutex 执行 SQL 时，这些入口仍可能阻塞调度线程。默认单次 SQLite busy timeout 为 5 秒，不是整个请求的总超时。

建议：按“确认的同步阶段”“巡检的同步阶段”“出队/取消清理”分别治理，复用现有有界后台池。worker 应持有所需的数据目录保护和完整收尾责任。仅对 SQL offload、把 Store 引用跨 await 搬运，或新增一个执行池，都不足以解决取消与状态发布问题。

验收门槛：单线程 runtime 的慢 Store/真实写锁、取消 HTTP 等待者、心跳可前进、目录迁移拒绝、决策仅持久化一次且派发可恢复。决策已提交后的恢复通知还需单独核查：当前 commit 后才发送消息，拒绝决策等路径不能只靠请求继续存活。

## TD-12：交付完成后的轮询持续读写

位置：`src/store/research.rs:504`、`:511`、`:1114`、`:1324`；`src/commands/research_dispatch.rs:230`。

`research_active_studies` 读取所有研究 JSON，再在 Rust 中筛 active；交付批准不会让 study 离开 active。对任务全部 completed 的研究，每轮 reconcile 都重新构建 package scope，读取并 hash 所有已登记产物及各 Run 的完整日志。

即使同范围的交付决策已经 approved，`request_gate` 只在内存逻辑上返回无变化；外层 `research_update` 仍刷新 updated_at 并无条件 UPDATE 整个聚合 JSON。交付校验失败时的 supersede 分支也无条件进入更新。

隔离复现：完成 design/review/audit，生成并批准 G4；安装 TEMP UPDATE 触发器后连续调用两次 reconcile，触发器记录两次 UPDATE，study 仍 active，G4 仍 approved。watcher 每轮 sleep 3 秒，因此这里的实际周期是 3 秒加本轮工作耗时，不能视为精确固定 3 秒。

影响：历史已交付研究会持续加入扫描，增加 I/O、hash CPU 和 SQLite 写竞争；日志读取使用 `std::fs::read`，没有与产物相同的 32 MiB 限制，单个大型日志也会增加内存峰值。没有测量当前用户数据量或线上资源占用。

建议：先消除无变化 UPDATE；再定义交付后的调度状态、事件驱动脏标记或较低频率的完整性复核。不能为了跳过扫描而取消交付确认时的最终 hash 校验，也不能忽略已交付文件变化。后续考虑查询级 active 筛选、流式日志 hash 与聚合文档增长。

验收门槛：同范围连续 reconcile 不写库；文件变化使相关批准失效；重启和新计划能恢复调度；大量已交付研究不会挤占活动研究的派发与心跳。

## TD-13：派发失败被压成“没有任务”

位置：`src/commands/research_dispatch.rs:219`、`:232`、`:245`。

派发循环对所有 `Err(_)` 直接 break，最后仍返回 `Ok(dispatched)`。reconcile 又忽略自动派发和 gate 更新错误。容量不足、依赖产物变化、存储失败因此缺少明确区分；外层 watcher 的错误日志接收不到被吞掉的原因。

隔离复现：design 验收后改变其文件，review 在 DAG 层面仍 ready；派发时 `research_bind_task` 正确拒绝变化的依赖产物，但 `auto_dispatch_sync` 返回 `Ok([])`，review 保持 pending。完整性拒绝是正确的，欠缺的是阻塞原因与恢复入口。单个任务错误还会跳过本轮后续独立 ready 任务，是否继续应按错误类型决定。

建议：返回结构化派发结果或持久化阻塞原因，至少包含 study/task、失败阶段、是否可重试；容量等待、需要人工修订和存储故障应分开处理。UI 应能说明为什么仍 pending。保留对篡改产物的拒绝，避免每 3 秒重复记录相同错误造成日志风暴。

验收门槛：坏依赖产物、容量已满、SQLite 拒绝、单个坏任务与其他独立任务并存；错误对用户/运维可见，且不把整个 DAG 永久标为失败。

## 本轮验证及保留项

- 3 个临时行为探针全部通过，含义是上述问题已复现，并非修复后回归通过。
- 已有队列读锁 3 项、派发结算 5 项、claim 调度器 1 项通过；research 测试组 23 项通过，其中包含这 3 个临时探针，即原有领域测试 20 项通过。
- 前端 research/flowNodes 相关测试 49 项通过。
- 已提交 UI 主入口为 2,931,367 bytes，gzip 901,199 bytes；当前预算 3,100,000 / 950,000 bytes，剩余约 5%。大模块与入口体积应继续跟踪，但不应先于上面的正确性和阻塞问题机械拆分。

临时探针在本地测试模块内运行后已移除，业务源码恢复原状。临时源码 `/tmp/orx-technical-debt-probes.rs`，日志 `/tmp/orx-technical-debt-{probes,lock-tests,ui-tests}.log`；这些路径是本机短期证据，不是持久发布验收。本文记录了复现步骤，实施修复时应补入正式回归。

未运行全量 CI、依赖在线审计、登录/真实模型、服务器、浏览器与跨平台验收；不沿用旧文档的通过数量或验收结论。TD-04 材料故障恢复、删除/磁盘生命周期、TD-07 固定候选验收及 DTO 契约继续保留，本轮没有重新关闭这些事项。

建议实施顺序：先补产物归属及失败可见性，随后用跨会话故障回归约束锁治理；同步入口隔离与巡检无变化写入可分别收敛。最后以固定候选验证登录、原生问答/Stop、材料、重连及完整科研流程。
