# 技术债修复（2026-10-28）

> 后续分析：[下一批优先级与正确性复核](technical-debt-next-priorities-2026-10-28.md)。新增输入变更继承问题，并细化心跳、用户 Stop、研究结束和日志边界；下文验证仅对应本批修复。

> 后续修复：[TD-14 任务继承修复](research-plan-inheritance-2026-10-28.md)，补齐简报与实际流程变化的失效规则。

> 后续修复：[TD-15 独立租约续租](turn-lease-heartbeat-2026-10-28.md)，解除长扫描、人工确认与通用后台许可对续租的阻塞。

> 后续修复：[TD-05C Stop 运行时取消](user-stop-interruption-2026-10-28.md)，先阻止派发并触发取消，再完成队列和历史持久化。

接续 [本日复核](technical-debt-review-2026-10-28.md)，基于 `9d537b1` 实施。版本与上游 partial 状态不变。仅修改后端、回归与文档，没有更新 UI 资源、重启服务、调用模型或部署。

## 本批行为

| 项目 | 修复结果 | 保留的边界 |
| --- | --- | --- |
| TD-11：旧产物自动验收 | 任务绑定时持久化已有输出的路径、hash 和大小；自动收尾拒绝未变化的旧输出，允许通过当前任务的 `research finish` 显式核查登记同字节结果 | 快照是工作流归属检查，不是恶意本地进程的文件写入审计；不删除或移动旧产物，也不新增历史文件归档 |
| TD-05A：全局 turn/revision 锁 | claim 先发布带 reservation_id 的占位，再释放全局 turns 进入存储；busy 写入移交会话 cleanup/submission 保护；revision 改为会话级异步锁 | 同会话、SQLite 写入和 queue-persistence 仍串行；用户 Stop 的清队列阶段仍可能等待全局队列写入，不宣称所有跨会话等待已消除 |
| TD-05B：同步入口 | 科研确认、run/spawn 巡检的同步阶段、出队和争用中的 dispatch Drop 进入既有有界后台池；Plan/permission 设置也隔离存储 | 本批不宣称所有历史 Store 入口均已异步化；压缩等低频旧入口仍按原清单治理 |
| TD-12：交付巡检重复读写 | 聚合内容无变化时不写 UPDATE、不刷新 updated_at；已完成研究的全量包校验按 study/version 最多每分钟一次；日志流式 hash | 文件变化的后台发现延迟最多约一分钟加巡检耗时；人工交付确认始终重新校验文件和日志，不使用后台缓存 |
| TD-13：派发失败不可见 | 失败原因写入 pending 任务现有 summary，现有任务详情可直接显示；失败后继续尝试其他独立 ready 任务；底层存储错误向外报告 | 容量等待与其他阻塞仍使用现有任务状态，无新状态表、无限重试或全新通知协议 |

## 关键实现与兼容

- `src/store/research.rs`：新增可选 `outputBaseline`。缺少该字段的历史任务仍可读取，但自动验收需显式 finish；新任务记录空基线或已有文件快照。失败重试重新绑定时采集本轮基线，强制重做同样执行检查。显式 finish 仍保留文件非空、路径限制、Run 终态与当前任务身份等既有验证。
- `src/commands/research_dispatch.rs`：自动完成调用独立的受基线约束入口；失败原因使用既有 summary 展示，派发成功时清除旧阻塞说明。相同原因的重试不反复改写 study。每分钟校验缓存仅存于 watcher 内存，新进程重新完整核查，新 plan version 立即失效。
- `src/local/chat/mod.rs`：SQL claim 的 worker 持有 session cleanup gate，而非全局 turns；claim 失败按 reservation_id 清除自己的临时占位，不发伪空闲事件。忙入队的请求串行保护随实际 worker 转移，等待者取消不会让下一请求提前越过正在落盘的提交。提交前再次检查 Stop/删除标记与会话存在性；提交完成后触发既有队列派发，避免自然完成与忙入队交错时遗留队列。
- revision 保持原来的版本分配和事务失败回滚算法，改为每会话一个 map/锁；其他会话的 stamp、权限查询与 Stop 无需等待该会话的 revision SQL。出队由 queue-persistence 和 queued 保护，不再获取无关的 revision 锁。
- `src/commands/up/research.rs`：确认全过程由独立任务执行，同步事务和派发进入后台池，并由 worker 持有数据目录 gate。浏览器断开不会取消其进程内收尾；决策提交后的恢复失败仍通过 `resumeError` 返回。进程崩溃下的完整通知 outbox 不在本批新增。
- run/spawn watcher 按读快照、异步发送、写结算分阶段使用同一 Store；每个后台阶段持有共享的数据目录 gate 所有权。取消等待者后，正在执行的阶段仍会完成，目录迁移不得越过它。保留已有 claim token、租约巡检与恢复逻辑，不新增执行池或 watcher。

## 回归范围

新增独立文件 `src/store/research_debt_tests.rs` 和 `src/local/chat/debt_tests.rs`，覆盖：

1. 强制重做与进程重开后拒绝旧产物、显式登记同字节结果；失败重试中部分新产物不足以自动完成，所有产物变化后可以完成。
2. SQL 触发器验证已批准交付的无变化巡检不写库；文件变化会使交付批准失效。节流期间人工确认仍拒绝旧 hash，超时后后台重新核查。
3. 一个任务依赖产物变化时保留 pending 并显示原因，同时不饿死独立任务。
4. 单线程调度下慢存储与取消阶段等待者，timer/状态仍前进，实际 worker 继续落盘且保留目录保护。
5. dispatch Drop 遇到 queue-persistence 争用时不阻塞调度；Stop 先清队列后，迟到的忙入队不得恢复已取消消息。

既有 claim/真实 SQLite 慢入队回归增加跨会话状态、内部 interrupt、revision 可用性断言；claim 慢打开时另一会话可完成独立 claim/release。该断言不包含用户 Stop 的清队列阶段。保留取消、失败回滚、租约归属、去重和旧占位拒绝测试。

## 验证记录

验证通过：`cargo test --locked` 的 **1,319 项单元、18 项集成**，11 项专用测试按原规则忽略；其中新增 8 项回归。前端完整 465 项测试、2 项产品版本测试、上游基线核查、i18n/样式及资源预算检查通过。`cargo fmt --all --check`、独立 include 测试文件的 rustfmt 检查、`cargo clippy --all-targets -- -D warnings`、`cargo build --locked`、`git diff --check` 通过。

完整回归日志为 `/tmp/orx-debt-final.log`，Clippy 为 `/tmp/orx-debt-clippy-verified.log`，构建与前端测试为 `/tmp/orx-debt-{build,ui-full}.log`。源码与日志 hash 保存在被 Git 忽略的 `.mobilesci-run/technical-debt-2026-10-28/evidence.json`；这些仅为本机证据，不是发布验收。

首轮磁盘不足通过 `cargo clean --package openresearch-cli` 清理可生成的编译产物后恢复。沙箱内回环监听/进程检查失败的测试在获准的测试权限下重跑；初期 claim 失败后的伪空闲事件回归失败已修正并由最终完整回归覆盖，不将中间失败记录为通过。

仍需固定候选的真实登录、原生模型、浏览器、服务器与跨平台验收。没有整体关闭 TD-05：`while_idle` 的全局锁及其存储/回调、压缩读取、全局 queue-persistence 和池满载等待仍需独立治理。材料故障恢复、删除/磁盘引用保护及其余技术债也保持原状态；不以自动化通过替代发布或真实科研流程验收。
