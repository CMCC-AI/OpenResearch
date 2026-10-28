# Steering 持久回执与跨通道去重

## 解决的问题

原实现 `steer_message` 只向内存 channel 发送 `display/text`，随后返回成功；HTTP 回包丢失后无持久回执可查。原生拒绝时 `park_steer` 又生成新的 client ID 和默认设置，无法证明后续队列与最初请求是同一次提交。普通 turn／队列已有各自幂等记录，但不能阻止与 steering 重复投递。

本批从 `a421c09` 后的后续开发分支实施。产品版本、已发布标签和发布资产保持原样；不是重新发布或部署。

## 请求身份与持久化

- `chat_steering_requests` 保存 `(session_id, client_turn_id)` 唯一键、原始 request hash、原始队列兼容 payload、登记时间及交接状态。已有数据库通过建表获得此能力，不重写旧 turn／queue 数据；删除会话／项目时一并清理其 steering 记录。
- `src/store/steering.rs` 在 `BEGIN IMMEDIATE` 中检查 turn、queue、steer 三种登记后再准入。普通 turn 的持久准入和普通队列插入也检查 steering；SQLite 写边界对多个 Store 连接／进程生效，不依赖单个 ChatHost 的内存 mutex。
- 同 ID 同 hash 返回原登记，异 hash 拒绝，不投递第二次。不同会话允许相同 client ID；不同 ID 的相似正文仍是不同请求，不做正文相似去重。
- `SteerMessage` 携带原始队列 payload。明确未发送／原生明确拒绝时，将原 ID、hash、正文和 settings 原子地转入队列，并只在提交后发布内存队列。排队晋升沿原身份生成 turn；重复回退不会产生第二个队列条目。
- Stop／手动删除队列只清除待执行条目，保留 steering 登记。即使原队列已不存在，旧 ID 的重试也不能重新执行。此记录随会话存在，不能按 TTL 随意回收，否则会缩短去重承诺。

## 回执和原生交接的含义

`GET /api/chat/sessions/{id}/submissions/{clientId}` 保留会话／项目边界，返回 `{kind: turn|queued|steer, id}`，优先 turn，其次 queue，再其次 steering 登记。接口不返回正文、settings、hash 或内部交接状态；缺少回执仍不是拒绝凭据。

跨进程竞争可能在普通入队的预检之后才登记 steering。此时禁止普通队列插入：异 hash 使用明确的 409 冲突类型；同 hash 的入队失败保持可核实状态，前端按既有 400 非明确拒绝规则查询原登记，不用 busy 推断本次请求归属。

回执只证明服务端已经登记请求。steering 登记的内部状态为：

| 状态 | 依据及行为 |
| --- | --- |
| `registered` | 已登记、尚未记录原生交接结果；崩溃或存储失败后可能停留于此，不自动重放。 |
| `handed_off` | Codex 原生 ACK 或 Claude stdin 写入成功；都不是模型已完成任务的证明。 |
| `uncertain` | 原生超时或传输／写入失败；可能已经送达，保留会话中的原文和错误，不自动回退排队。 |
| `queued` | 明确可安全回退，已原子登记队列；实际队列以后可能晋升或被用户清除，不能仅用此字段推断当前仍在等待。 |

Codex 维持明确拒绝才排队的策略。Claude 的 write/flush 错误可能发生在内容已写入之后，本批改为未知状态，避免直接排队重复执行。用户应检查会话再决定是否提交新指令。

HTTP 等待者取消后，已开始的后台登记／channel 交接 worker 仍持有提交锁直到结束。原生交接状态和会话记录通过有界后台存储池落盘，使用活跃 turn 的 checkpoint 保护，不在原生事件循环中新增同步 SQLite 等待。会话中的 steering part 使用稳定的原始 client ID，重复记录不会新增一份展示。

前端恢复丢回包时也查询 steering 登记，不再直接报“没有 steering 回执”。重试回包的 `turn` 结果可以包含 `steered: true`，其 `turnId` 此时是登记 ID，不是新执行的 turn；`existing: true` 保证当前界面重读会话。首次原生交接仍保持 `{ok: true, steered: true}` 的响应形式。

## 验证与剩余边界

回归覆盖同 ID 异 payload、跨会话隔离、数据库重开、旧库建表、steer 与 turn／queue 的跨连接竞争、原参数回退、队列晋升、Stop 后不复活、回退事务失败回滚、HTTP 等待者取消，以及稳定 steering 展示与交接落盘。HTTP 回归验证 steering 回执不泄露正文／hash；前端执行实际发送错误恢复回调并验证匹配回执。

仍不承诺数据库与外部模型之间的 exactly-once：进程可能在登记后、原生交接前后崩溃。此时保留原始请求与不确定登记，以阻止自动重复执行；尚未提供独立的人工恢复界面或自动恢复交付。浏览器 pending 身份／草稿跨刷新恢复属于下一批，不以服务端持久化代替它。

部署时同一数据目录的写入进程应使用本批实现；旧二进制不知道新表，混用或回滚不能承诺相同的跨通道去重。测试不调用真实模型，不重启开发槽，不代表真实弱网或跨平台生产验收。

本次最终验证：

- `cargo test --locked`：1,358 个单元测试及 18 个 CLI 集成测试通过，11 个既有忽略；包含新增持久化／原生 channel／HTTP 回执回归。
- `cargo clippy --all-targets --locked -- -D warnings`、Rust 格式及 diff 空白检查通过。
- 前端全量 501 个测试、类型检查、i18n、样式、生产构建及资源预算通过，`ui/dist` 已重建。
- 产品版本／真实上游祖先检查及 4 项版本／源码发行测试通过；未修改依赖或发行配置。
- 验证中曾将 UI 重建与 Rust 嵌入资源编译并行，造成短暂的资源文件缺失；改为 UI 构建结束后再做 Rust 检查，最终 Clippy 和全量回归均通过。后续这两类构建保持顺序执行。

最终 Rust 日志 `/tmp/mobilesci-steering-rust-final.log`，Clippy 日志 `/tmp/mobilesci-steering-clippy-final.log`，前端日志 `/tmp/mobilesci-steering-ui-all.log`、`/tmp/mobilesci-steering-ui-build.log`。未复跑 Windows、Linux 桌面打包、PostgreSQL 平台集成、在线审计或远端 CI；本批未改变这些平台的专用实现，也不将本地结果当作远端发布验收。
