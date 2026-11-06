# 环境变量测试的进程隔离

## 依据与影响范围

会话归属四项测试原先通过模块私有 Mutex 和 EnvGuard 改写 ORX 会话环境。该锁不能约束其他模块的读取方，并行运行时可能短暂改变实验归属、可信端口或调用身份。恢复环境值只能保护测试结束后的状态，不能消除期间的竞争。

同类问题还存在于 `src/jobs/localbox.rs::local_job_lifecycle` 的 ORX_DATA_DIR，以及 `src/commands/mcp_gate.rs::bypass_env_var_allows_immediately` 的 ORX_AGY_GATE。其他并行测试可能在期间读到临时目录或审批 bypass，测试失败时原来的手工清理也不能保证执行。

本批仅重构测试，六项真实回归统一使用仅在 cfg(test) 编译的 `src/test_support.rs::run_isolated`：父测试使用当前测试二进制精确重执行自身，子进程清空该组受测环境变量，再执行原来的真实函数断言。会话组清空 CHAT_HARNESS、CHAT_SESSION、LOCAL_SESSION、UP_PORT 和 ORX_INVOCATION_CONTEXT；本地任务和 MCP 各清空其专用变量。环境改写只发生在单测试子进程；父进程不修改环境。父测试同时要求成功退出与实际执行一项测试，防止过滤名称漂移导致零测试假通过。子进程失败保留 stdout/stderr 供诊断。

生产代码、实验授权、审批规则、任务生命周期以及原有断言保持不变。共享工具避免每个模块重复维护子进程过滤、退出检查和环境清理协议。

## 验证与边界

最终共享工具版本的聊天模块八线程并行回归通过 205 项、5 项既有忽略；本地任务 4 项、MCP 4 项并行通过。整套 Rust 以八线程运行通过 1467 项单元和 27 项普通 CLI 集成测试，13 项单元及 1 项外部 PDF 既有忽略没有计入通过；PDF 由 Linux/macOS 的独立门禁验证。全目标 Clippy 零警告，格式和 diff 检查通过。完整跨平台 CI 另行记录。

这是 P2 测试治理的三组具体隔离，不代表全部进程全局状态已隔离。Telemetry 的 XDG_CONFIG_HOME/遥测环境、工具探测与全局缓存仍需逐项审计；`updates/windows.rs` 清理重启标记属于生产路径，不能当作测试竞争机械迁移。保留 macOS 既有运行策略，不能凭本批移除全套串行保护。
