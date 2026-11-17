# Phase 3 技术债与回移遗留问题收口报告（2026-11-17）

- **基线提交与分支**：`feat/ai4s-product`，代码与测试闭环提交 `0b350267567f7af027171a01d73688b71ead9976`；线上生产运行 [`v0.2.24-mobilesci.1`](release-v0.2.24-mobilesci.1-delivery.md)（`bcb90af4`）。
- **既定红线确认**：`Cargo.toml`、`Cargo.lock`、`product-upstream.json` 版本号未修改；未创建新 tag 或 `release/*` 分支；真实上游祖先保持 `v0.2.19`、`backportTarget = v0.2.24`（`partial`）、官方自更新保持 `product-disabled`；未执行任何 `ssh root@10.7.0.18` 或生产写操作；PR `#17` 保持关闭。

---

## 一、A 类：立即执行项（已完成并闭环）

| 编号 | 改动内容与文件路径 | 验证与前后对比 |
| --- | --- | --- |
| **A1：慢单测超时参数化** | 在 [`src/local/opencode.rs`](../../src/local/opencode.rs#L517-L591) 拆出 `verify_generation_models_with_timeouts(..., initialization_timeout, mismatch_timeout)` 内部 helper；生产入口 `verify_generation_models`（`120s` / `30s`）及 `verify_generation_models_with_timeout`（`30s` mismatch）保持完全不变；单测 `effective_agent_models_reject_overrides_but_allow_disabled_agents` 改为传入 `500ms` / `50ms` 短超时。 | 单独运行该单测由优化前 **`60.71s`**（`1:01.56 total`）降至 **`0.93s`**；全量 `cargo test --locked --bin orx` 总耗时由 `86.28s` 降至 **`34.18s`**（1,524 passed, 0 failed, 13 ignored）。 |
| **A2：chat 内联测试搬家** | 将 [`src/local/chat/mod.rs`](../../src/local/chat/mod.rs) 剩余 4 组内联测试模块（`shell_command_tests`、`initial_message_tests`、`slash_skill_tests`、`persisted_queue_delay_tests`）纯搬迁至独立模块 [`src/local/chat/helper_tests.rs`](../../src/local/chat/helper_tests.rs)（389 行），不改生产逻辑。 | `chat/mod.rs` 由 **9,874 行** 缩减至 **9,483 行**；`helper_tests` 15 项全过（`0.09s`）；`fmt` 与 `clippy --all-targets -- -D warnings` 零警告通过。 |
| **A3：feat 分支完整 CI 闭环** | 推送 `0b350267` 至 `origin/feat/ai4s-product` 并以 `workflow_dispatch` 触发 [CI Run `44056763009`](https://github.com/CMCC-AI/OpenResearch/actions/runs/44056763009)（含 `0d9e220c` 三项 B3 安全修补、`87cbbce9` `quinn-udp 0.5.16` 及 A1/A2）。 | 全部 **11 项执行 Job 全绿 `success`**（`fmt, clippy, test`、`windows build, test`、`macOS build, test`、`linux app (x86_64/aarch64)`、`multi-user platform`、`executor tools and permissions`、三平台 `source archive` 及 `source archive reproducibility`）；仅 `version sanity` 按非 PR 条件跳过（本地 `check-upstream-base.mjs` 已核验通过）。 |

---

## 二、B 类：只评估、未落地代码

### B1：聚焦 OpenCode 与核心基座的 B3 后备补丁四要素评估

| 候选补丁 | 结论 | 四要素依据 | 最小改动方案（采纳/备选参考） |
| --- | --- | --- | --- |
| **`#953`（`ecec283e`）**：`ORX_LOCAL_SESSION` 子进程遥测交由 `orx up` | **暂缓（条件采纳）** | **用户**：`orx up` 会话内部署代理沙箱中通过 OpenCode 调用 `orx` CLI 的用户。<br>**复现证据**：源码核验 [`src/telemetry.rs`](../../src/telemetry.rs#L893-L947) 当前在 `retry_outbox()`/`spawn_event()` 未跳过 `in_local_session()`；但 [`src/telemetry.rs`](../../src/telemetry.rs#L559-L575) 非 `production` 通道已全量短路，且产品关闭官方自更新，**当前暂无生产代理故障复现**。<br>**最小改动**：约 20 行。<br>**长期成本**：极低，复用 `in_local_session()` 与 `Store::stage_telemetry`。 | 若后续开启 `production` 遥测或复现子 CLI 代理中断报错：在 `retry_outbox()` 入口增加 `\|\| crate::local::chat::in_local_session()`，并在 `spawn_event()` 中对 `in_local_session()` 分支转调 `store.stage_telemetry(...)` 返回 `None`；补 1 个 `in_test_child` 单测。 |
| **`#996`（`0b77b8e1`）**：仅非 `orx-host` 的 `up` PTY 测试去抖 | **采纳** | **用户**：跨平台 CI 与执行 Rust 单测的开发者。<br>**复现证据**：[`src/commands/up/tests.rs`](../../src/commands/up/tests.rs#L570-L585) `pty_relays_input_output_resize_exit_and_cancel` 在收到 `PtyEvent::Exit` 后直接 `break`，而 `Exit` 与最后 `Output` 来自两个独立线程，高负载 runner 下存在退出竞态隐患。<br>**最小改动**：仅改 1 个单测约 10 行，**零生产改动**（跳过 `crates/orx-host` 与 `engine/transport`）。<br>**长期成本**：零。 | 下一 B3 小批次将 `pty_relays_input_output_resize_exit_and_cancel` 改为缓存 `exit = Some(status)` 并等待事件通道完全读尽关闭后再断言退出状态与 `reply:hello`。 |
| **`#977`（`2613102a`）**：单测禁止访问真实 `$HOME` | **暂缓** | **用户**：本地开发与共享 CI 宿主机。<br>**复现证据**：`rg "dirs::" src/` 查得 29 处直接读取真实主目录（含 [`src/config.rs`](../../src/config.rs#L399-L430)、[`src/local/opencode.rs`](../../src/local/opencode.rs#L52)、[`src/commands/ssh_key.rs`](../../src/commands/ssh_key.rs) 等），但当前现存单测尚未复现误删开发者目录故障；且上游实现涉及 56 文件大面积迁移及三平台验证。<br>**最小改动**：即便跳过 Claude/Codex/`orx-host` 仍需改造十余文件并补 `clippy.toml`。<br>**长期成本**：中等，需持续维护 `cfg(test)` 与子进程白名单。 | 暂不专开大批次；作为前置纪律约束保留：后续修改具体模块（如 `config.rs` / `ssh_key.rs` / `opencode.rs`）涉及其路径逻辑时，再按该模块范围逐步收口至隔离 `home_dir()`。 |
| **`#995`（`711f7fc6`）**：单 Agent 模型选择器隐藏冗余标签 | **暂缓（当前不适用）** | **用户**：模型选择器使用者。<br>**复现证据**：[`ui/src/components/ModelPicker.tsx`](../../ui/src/components/ModelPicker.tsx#L149) **已固定过滤只保留 `opencode`**，且上游改动目标文件 `ui/src/components/ModelList.tsx` 在本仓库不存在；现行界面不存在每行重复显示多 Agent 标签问题。<br>**最小改动 / 长期成本**：不适用。 | 保持现状，不引入基于未采用多 Agent 选择器的补丁。 |

### B2：核心大文件增量拆解触发点清单（仅登记、不主动重命名）

以下文件不以行数归零为目标，仅在下次因实际功能或缺陷修改到对应业务块时顺带抽离为独立子模块：

1. [`src/local/chat/mod.rs`](../../src/local/chat/mod.rs)（9,483 行）：
   - **权限桥接策略与卡片决议**（约 `L1774–1920`、`respond()` 等）：修改 OpenCode/审批卡交互时拆出 `permission_bridge.rs`；
   - **回合租约与持久化队列调度**（`claim_durable_turn_with_store`、`watch_turn_leases_with_store`、`drain_queue`、`settle_queue_dispatch_with_store`，约 `L3580–4625`）：修改排队/租约回收逻辑时拆出 `queue_scheduler.rs`；
   - **回合发射、中断与收尾元数据**（`steer_message`、`send_message`、`recover_turn`、`fork_turn`、`interrupt*`，约 `L4629–6850`）：修改 OpenCode turn 生命周期或分叉/恢复逻辑时拆出 `turn_lifecycle.rs`。
2. [`src/commands/up.rs`](../../src/commands/up.rs)（9,009 行）：
   - **文献检索与 Deep Literature 代理**（约 `L1497–1850`）、**Diff/产物/Overleaf/Git HTTP 路由组**（约 `L3053–5350`）、**PTY 与 SSH 终端管理**（`start_pty_with_env` 等，约 `L6338–7255`）：仅在调整对应路由族或终端转发行为时按区段移入 `up/` 子模块。
3. [`src/store.rs`](../../src/store.rs)（3,962 行）：
   - **`run_wakeup` 调度状态机**（约 `L1477–1689`）与 **local_projects / chat_sessions DAO**（`L1968+`、`L2307+`）：沿既有 `store/{research,steering,telemetry}.rs` 模式在修改表结构或 SQL 时顺带拆出。
4. [`packages/platform/src/server.mjs`](../../packages/platform/src/server.mjs)（1,621 行）：当前路由分发清晰可读，暂无拆分触发条件。

### B3：依赖安全审计现状

在提交 `0b350267` 上实测 `cargo audit --file Cargo.lock` 与 `cargo audit --file windows/launcher/Cargo.lock`：
- **被禁漏洞（Vulnerabilities / `deny`）**：**0 项**（`quinn-udp 0.5.16` 升级已修复原 `RUSTSEC-2026-0538`；`windows/launcher/Cargo.lock` 40 个依赖 **0 警告**）。
- **允许通过的传递依赖提醒（4 项 `warning`）**：`proc-macro-error 1.0.4`（`RUSTSEC-2024-0370`, `unmaintained`）、`glib 0.18.5`（`RUSTSEC-2024-0429`, `unsound`）、`rustix 1.1.4`（`RUSTSEC-2026-0486`, `unsound`）、`tokio 1.52.3`（`RUSTSEC-2026-0386`, `unsound`）。
- **处置原则**：保持现状，不强升不兼容主版本以消除传递 `warning`。

---

## 三、C 类：明确不做项确认（零触碰）

- **版本号与标签/分支**：未修改 `Cargo.toml`、`Cargo.lock`、`product-upstream.json` 的任何版本/基线字段；未打 tag、未建 `release/*` 分支；确认不单独发 `0.2.25` / `0.2.26`，下次大版本发版时再一次性把 `backportTarget` 从 `.24` 推进到已落地最高基线。
- **生产环境（`10.7.0.18`）**：本轮收口任务未执行 `ssh root@10.7.0.18` 及任何生产写操作，亦未做历史 50+ 回滚容器与 `staging/` 清理（继续按稳定观察期后保留最近 2 次发行切换备份原则记录待清）。
- **阶段 B1 体验优化**：依赖 `.24-mobilesci.1` 线上实际反馈收集，当前不启动。
- **阶段 C 重型项与非 OpenCode Agent**：`#862 orx-host`、`#950` 新引擎、`#938 ACP`、`#885`、`#886`、`#891`、`#873`、`#877`、`#978/#979/#1000`、`#954` 乐观 UI，以及 Claude/Codex 专属改动（`#964`/`#972`/`#887`）均未评估扩写、未引入。
- **PR `#17` 与安全边界**：PR `#17` 保持关闭状态；官方自更新保持 `product-disabled`，Origin 校验与默认本地监听均未放宽。

---

## 四、遗留风险与信息边界

1. **非 PR `workflow_dispatch` CI 中的 `version sanity`**：CI Run `44056763009` 中该 job 因触发事件类型按预期跳过，但本地已复跑 `node scripts/check-upstream-base.mjs` 通过，且本次未触碰版本元数据。
2. **线上 `.24-mobilesci.1` 真实用户使用期反馈与磁盘清理时机**：尚待一段真实运行窗口积累 OpenCode 首连、配额提示反馈并触发历史容器保留策略清理。
3. **`windows/launcher` 宿主本地测试**：未在本地 macOS 上实跑 Windows 桌面安装器本身，已通过 `44056763009` 的 `windows build, test` GitHub Runner 实际编译与测试全绿验证。
