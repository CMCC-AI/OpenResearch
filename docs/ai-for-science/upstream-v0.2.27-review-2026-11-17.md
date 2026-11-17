# 官方 v0.2.27 逐项回移评估（2026-11-17）

## 固定来源与判断边界

- 核查上游标签范围：`v0.2.26`（`e737b04d0491ac7e44962f3d7765c5c242b39461`）→ `v0.2.27`（`9a2949cfe2b7e9336169fcf6ab0c1ba6d4bc24a3`）。
- 本地 Git 统计：`git rev-list --count v0.2.26..v0.2.27` 为 **47** 个提交；`git diff --shortstat v0.2.26 v0.2.27` 为 **447 个文件、42,456 增行、16,549 删行**。
- 当前产品基线：已完成 [`v0.2.24-mobilesci.1`](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.24-mobilesci.1) 不可变发行（`bcb90af4`）及 **`10.7.0.18` Gate 1.3 受控生产切换**（见[交付记录](../product/release-v0.2.24-mobilesci.1-delivery.md)）；`feat/ai4s-product` 已推进 Phase 3 **B3 第一批（`#924`/`#984`/`aa2a2935`）**。
- 排除与红线边界：
  - **OpenCode 主线原则**：本项目主要以 **OpenCode** 为核心编码 Agent，非 OpenCode 的编码 Agent（如 Claude Code、Codex）专属改动不再列入回移候选（故原列待评的 `#964` 与 `#972` 均调整为**不回移**）。
  - **阶段 C 红线 / 不采用基座**：不整批引入 `.25/.26` 未选入的新实验引擎/host 体系（`#862 orx-host`、`#891`、`#950` 删除旧执行路径等）、`alphaXiv` 登录与更新体系、OpenCode/Server 解析或官方托管 Agent 安装向导（与 MobileSci 平台模型/配额管理冲突）、乐观 UI / `react-mutation` 大改与上游版本/CI 规则文件。
  - **已在 `.24-mobilesci.1` 覆盖或等效完成（6 项）**：`#952`、`#962`、`#981`、`#985`、`#990`，以及 `#986` 的同等大项目/超时传输加固（`0e763eee` 等提交已落地）。

## 一、本批执行结论

1. **B3 第一批安全 bugfix 已落地 `feat/ai4s-product`（3 项，提交 `0d9e220c`）**：
   - **`50e7a803` / `#924`**：修复 `src/remote.rs` 中 `ssh -N -L` 手动转发示例错误将 `<user@host>[:PORT]` 当主机名的问题，改为 `[-p PORT] <host>` 并补全单测。
   - **`6d789043` / `#984`**：修复 `src/commands/up.rs` 中 ConPTY 客户端先断开时未响应 `b"\x1b[6n"` 光标查询导致关闭阻塞的问题，并移植 `closing_a_pty_whose_client_left_returns_promptly`。
   - **`aa2a2935`**：修复 `ui/src/App.tsx` 全屏右侧面板 `[&.max]:z-60` 遮挡 `option-menu`（`z-50`）的层叠 Bug，改为 `[&.max]:z-40` 并重建 `ui/dist`。
2. **明确剔除的非 OpenCode Agent 提交（2 项，原错列待评现正式排除）**：
   - **`61aa9bec` / `#964`（965+ / 58-）**：仅针对 Claude 后台任务/子代理回写，**不回移**。
   - **`1d9dff32` / `#972`（808+ / 71-）**：仅针对 Claude `--resume-session-at` 会话分叉，**不回移**。
3. **后续基于 OpenCode 与平台核心的 B3 优先候选（按价值/风险排序）**：
   - **`ecec283e` / `#953`（P1/P2，3 文件 +60/-4）**：在 `ORX_LOCAL_SESSION` 对话子进程（含 OpenCode 沙箱调用 `orx` CLI）中不直接发起短生命周期遥测/更新 HTTP 请求，改为写入本地库由 `orx up` 异步补发，消除代理中断误报与子进程重连延迟。
   - **`0b77b8e1` / `#996`（P2，仅非 `orx-host` 部分）**：修复 `src/commands/up.rs` PTY relay EOF 读取竞态及调度测试宽限计时（跳过 `crates/orx-host`）。
   - **`2613102a` / `#977`（P2，仅非 `orx-host` 测试隔离参考）**：约束单元测试不触碰真实用户 `$HOME` 目录，降低宿主机状态污染风险。
   - **`711f7fc6` / `#995`（P3 UX，2 文件 +9/-6）**：当某模型仅由单一 Agent（即 OpenCode）提供时隐藏冗余 Agent 前缀标签，非常契合 MobileSci 当前产品形态。
   - **其余运维/基础设施按需项**：`33acf6ae`（`#961` Slurm QoS/placement）、`65d7824f`（`#994` 断线重连 SSH 工作区，需按 `Ui` 本地适配，跳过 `WorkspaceConnection.tsx`）、`76d28089`（`#968` 防休眠需剥离 `orx-host` 依赖）、`61bc7233`（`#969`）、`e1fc9282`（`#970`）、`9ebcd2c3`（`#965`）、`6f2dc9e2`（`#966`）、`a62fde75`（`#983`）、`35f54226`（`#942` 退出确认，26 文件大改按需评估）、`7770ac63`（`#1008`）、`1684fdf0`（`#1007`）。

## 二、v0.2.26..v0.2.27 全量 47 提交逐项判定

| # | 官方提交 / PR | 摘要 | 影响范围 | 分类与处理结论 |
| --- | --- | --- | --- | --- |
| 1 | `250944f6` / `#952` | keep chat turns through a stale turn lease | `chat` 租约（3 文件，109+/42-） | **已在 `.24-mobilesci.1` 合入**（`45d5c6aa` / 租约防误回收） |
| 2 | `50e7a803` / `#924` | show valid SSH port syntax for manual forwarding | `src/remote.rs`（1 文件，18+/14-） | **P1 本批已落地**：改为 `[-p PORT] <host>` |
| 3 | `35f54226` / `#942` | ask before quitting or restarting mid-work | 桌面退出弹窗（26 文件，1682+/149-） | **P2 按需求**：体量较大，涉及关闭确认与桌面状态 |
| 4 | `b3bb8b53` / `#950` | run every experiment on the new engine | 删旧实验引擎（74 文件，323+/8297-） | **排除（阶段 C 红线）**：依赖未采用的 `orx-engine` 体系 |
| 5 | `0d20849b` / `#954` | apply UI writes optimistically | 前端乐观更新（67 文件，2421+/1330-） | **排除 / 暂缓**：重构 React 状态流，风险高且不契合当前稳定性基线 |
| 6 | `ecec283e` / `#953` | leave chat telemetry sends to orx up | `src/telemetry.rs`、`src/updates.rs`（3 文件，60+/4-） | **P2 候选**：减少短生命周期 CLI 退出时遥测竞争 |
| 7 | `aa2a2935` | show model picker over fullscreen chats | `ui/src/App.tsx` 等（3 文件，3+/3-） | **P1 本批已落地**：`[&.max]:z-40` |
| 8 | `61aa9bec` / `#964` | record Claude's work after background tasks | `src/local/chat` 等（5 文件，965+/58-） | **不回移（仅 Claude Agent）**：本项目基于 OpenCode，不引入 Claude 专属调度改动 |
| 9 | `9ebcd2c3` / `#965` | Summarize oversized files excluded from project sharing | UI i18n 与提示（13 文件，30+/14-） | **P3 可选**：若启用项目共享超限提示可同步 |
| 10 | `6f2dc9e2` / `#966` | Ship Unix CLI release archives as gzip | `.github/workflows`、`dist-workspace.toml`（2 文件，4+/2-） | **P3 参考**：仅在调整 `cargo-dist` Unix 打包格式时评估 |
| 11 | `5b8795e6` / `#955` | sign in to alphaXiv from SSH hosts | SSH alphaXiv 登录（30 文件，1715+/265-） | **排除**：与 MobileSci 本地/统一登录体系不兼容 |
| 12 | `e1fc9282` / `#970` | move chat search into the toolbar | UI 工具栏搜索（5 文件，27+/13-） | **P3 暂缓**：需与 MobileSci 全局头部布局及半屏规则对齐 |
| 13 | `61bc7233` / `#969` | report the chat's model with orx feedback | `feedback.rs`、`telemetry.rs`（3 文件，126+/2-） | **P3 可选**：仅反馈附加字段 |
| 14 | `cd2cae9d` / `#973` | upgrade react-mutation to 4.0.0 | `ui/package.json` 等（3 文件，47+/7-） | **排除**：对应 `#954` 乐观更新栈 |
| 15 | `1d9dff32` / `#972` | branch Claude's session on fork switches | `src/local/chat` 等（12 文件，808+/71-） | **不回移（仅 Claude Agent）**：仅适配 Claude `--resume-session-at`，OpenCode 无需引入 |
| 16 | `397e3e68` / `#974` | unblock sign-in on Windows | 桌面 alphaXiv 登录（2 文件，33+/2-） | **排除**：alphaXiv 伴随登录通道 |
| 17 | `33acf6ae` / `#961` | Slurm QoS, placement and sbatch options | `jobs/slurm.rs`、`local/slurm.rs`（27 文件，1161+/89-） | **P2 按需**：若交付 Slurm 集群高级调度需求时拆分引入 |
| 18 | `f9ef5ca5` / `#963` | explain OpenResearch boxes that never run | 云箱启动超时诊断（14 文件，1469+/280-） | **排除**：依赖 `openresearch.sh` / 新 `orx-host` 启动流 |
| 19 | `2613102a` / `#977` | keep tests out of the user's home | `clippy.toml` + `src/`（56 文件，946+/295-） | **P2 参考（仅非 `orx-host` 部分）**：禁止单测直连用户 `$HOME` |
| 20 | `a62fde75` / `#983` | Mica sidebar on Windows | `app.rs` + CSS（6 文件，77+/18-） | **P3 桌面增强**：仅桌面端外观 |
| 21 | `ba432b8c` / `#981` | stop idle queue checks refusing forks | `chat` 队列状态判断（1 文件，14+/25-） | **已在 `.24-mobilesci.1` 合入**（`45d5c6aa`） |
| 22 | `e7590691` / `#978` | managed agent installs | 托管安装 Agent（33 文件，1456+/284-） | **排除**：MobileSci 使用自有环境与平台模型管理 |
| 23 | `a79987b8` / `#979` | agents section and add-agent wizard | 199 文件，15,021+/2,604- | **排除**：与 MobileSci 设置/平台配额面板路线冲突 |
| 24 | `47e4e6c0` / `#987` | parse model names once, on the server | 模型列表/命名收敛（24 文件，791+/321-） | **排除**：MobileSci 已由平台与本地目录统一解析模型配额 |
| 25 | `36f0b02c` / `#986` | keep slow shared-project transfers alive | 传输/锁超时加固（24 文件，1106+/128-） | **已在 `.24-mobilesci.1` 等效覆盖**（`0e763eee`、`68f41ff7` 等） |
| 26 | `0f1cf637` / `#993` | skip update checks for signed-out agents | 官方更新检查（6 文件，145+/30-） | **排除**：MobileSci 保持 `product-disabled` 更新策略 |
| 27 | `711f7fc6` / `#995` | hide the agent when only one runs a model | `ModelList.tsx`、`ModelPicker.tsx`（2 文件，9+/6-） | **P3 可选**：需结合 MobileSci 模型展示习惯确认是否隐藏 Agent 标签 |
| 28 | `f96041f4` / `#999` | clarify commit rules | `AGENTS.md`（1 文件，1+/1-） | **排除**：本项目执行 `AGENTS.md` 简体中文提交规范 |
| 29 | `0b77b8e1` / `#996` | CI flakes and Rust 1.100 clippy | `up.rs`、`transport/tests.rs` 等（4 文件，24+/22-） | **P2 参考**：`src/commands/up.rs` 与 `transport/tests.rs` 去抖及新 clippy 适配可拆入 |
| 30 | `6d789043` / `#984` | answer ConPTY when a terminal client leaves | `src/commands/up.rs`（1 文件，41+/1-） | **P1 本批已落地**：已移植修复及单元测试 |
| 31 | `0e50e454` / `#990` | CI flakes and a Windows agent-stop hang | 锁与退出挂起（45 文件，438+/249-） | **已在 `.24-mobilesci.1` 合入**（`45d5c6aa` / `68f41ff7` `unlock`） |
| 32 | `8792c150` / `#967` | name the host and path when staging fails | 新引擎 staging 错误（6 文件，184+/45-） | **排除**：新 `engine` / `orx-host` 路径 |
| 33 | `ee9d6ca3` / `#959` | make Modal and HF readiness match launches | Modal/HF 云端（33 文件，1438+/154-） | **排除**：MobileSci 当前不启用 Modal/HF 托管通道 |
| 34 | `4f1a02df` / `#960` | keep waiting Kubernetes runs queued | 新引擎 K8s 队列（25 文件，1140+/271-） | **排除**：`engine/adapters` 体系 |
| 35 | `1952bafb` / `#958` | resume HF and Modal logs exactly | HF/Modal 日志（12 文件，1108+/165-） | **排除**：同 `#959` |
| 36 | `de1a9fcb` / `#985` | shorten PR check latency | SQLite WAL 建表（21 文件，853+/121-） | **已在 `.24-mobilesci.1` 合入**（`45d5c6aa`） |
| 37 | `18e8cecf` / `#1000` | set up agents in onboarding as Settings does | 新手引导（38 文件，1595+/932-） | **排除**：对应 `#979` 上游 Agent 引导 |
| 38 | `65d7824f` / `#994` | reconnect detached SSH workspaces | `Machines.tsx`、`RemoteRuntime.tsx` 等（4 文件，75+/6-） | **P2 按需**：若遇到远端 SSH 工作区重连状态卡住可单独适配（无 `WorkspaceConnection.tsx`） |
| 39 | `68822a1e` / `#1001` | install the laptop's own build on remotes | 新远程安装链（28 文件，635+/78-） | **排除**：属 `orx-host` / 新托管通道 |
| 40 | `5fe4bd05` / `#975` | show why a starting run is waiting | 新引擎等待态（28 文件，414+/51-） | **排除**：属 `engine/adapters` UI 契约 |
| 41 | `cad9f2d0` / `#962` | CLI failures in sandboxes and closed pipes | `chat` 环境与只读降级（33 文件，756+/198-） | **已在 `.24-mobilesci.1` 合入**（`19f75bcc`） |
| 42 | `76d28089` / `#968` | keep this machine awake for local runs | 防休眠（9 文件，300+/9-） | **P2 按需**：需从 `crates/orx-host` 剥离为本地进程适配 |
| 43 | `0233ec4f` / `#982` | refuse box launches only on proof | 新 box 校验（3 文件，220+/56-） | **排除**：新 `orx-host`/box 路径 |
| 44 | `e16c4971` / `#1002` | stop cancels and launches from getting stuck | 新引擎取消/启动状态机（78 文件，3630+/835-） | **排除**：全面围绕 `orx-engine`/`orx-host` |
| 45 | `7770ac63` / `#1008` | prefix agent messages with "from" | `AgentMessageCard.tsx` + i18n（12 文件，13+/2-） | **P3 可选**：需核对中文版 Agent 卡片文案兼容性 |
| 46 | `1684fdf0` / `#1007` | run every test on PRs, not on canaries | CI 工作流（12 文件，157+/132-） | **P3 CI 参考**：可借鉴 PR 全测拆分思路，但不覆盖 MobileSci 发行流 |
| 47 | `9a2949cf` / `#1009` | bump version to 0.2.27 | 版本文件（2 文件，2+/2-） | **排除**：MobileSci 保持独立版本号与 `product-upstream.json` 台账 |

> 注：`v0.2.27` 上游 47 个提交中，**6 项已在 `0.2.24-mobilesci.1` 覆盖/等效完成**，**3 项安全故障修补（`#924`、`#984`、`aa2a2935`）已在 `feat/ai4s-product` 落地（`0d9e220c`）**；按项目聚焦 **OpenCode** 原则，Claude/Codex 专属提交（如 `#964`、`#972`）不再纳入回移，下一批重点聚焦 `#953`、`#996`、`#977` 与 `#995`，不改变 `product-upstream.json` 的 `.24` 锁定目标与 `.19` Git 共同祖先。
