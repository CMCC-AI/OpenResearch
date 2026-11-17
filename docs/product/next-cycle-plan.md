# v0.2.24 发布收敛与下一阶段工作计划（2026-11-17）

本文承接 2026-11-11 [多用户稳定版 M7 交付](release-v0.2.23-mobilesci.7-delivery.md) 之后的迭代进展，明确当前状态台账、版本收敛目标以及后续分阶段工作计划。真实上游祖先仍保持 `v0.2.19`，产品版本与上游演进各自独立评估，未采用的官方能力不自动计作技术债。

## 一、当前项目状态台账

| 维度 | 当前状态 | 依据与边界 |
| --- | --- | --- |
| 生产在线基线（Gate 1.3 已完成） | [`v0.2.24-mobilesci.1`](release-v0.2.24-mobilesci.1-delivery.md)（`bcb90af4`）运行中 | 已于 2026-11-17 完成 `10.7.0.18` 受控切换：PostgreSQL 与 5 份私人 SQLite 在线备份、58 项隔离集成通过、5 个执行器与平台/gateway/nginx 统一、`/opt/opencode-npm-cache` 与 `opencode 1.18.33` 补齐，详见[交付记录](release-v0.2.24-mobilesci.1-delivery.md)；上一代归档基线为 `v0.2.23-mobilesci.7.1`（`47571b04`） |
| 不可变源码发行（Gate 1.2 已完成） | [`v0.2.24-mobilesci.1`](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.24-mobilesci.1)（`bcb90af4`）已正式发布 | [CI 44041868978](https://github.com/CMCC-AI/OpenResearch/actions/runs/44041868978) 全平台通过并由 `publish` 自动打标发布，4 份源码附件与干净重建逐字节一致 |
| 上游选择性回移台账 | `.23` 已收敛；`.24` 16 项适配 3 项；`.25` 45 项 P1/条件 7 项已落地；`.26` 2 项已交付；`.27` 47 项全量评估完成并落地 B3 首批 3 项 | 见 [`upstream-v0.2.24-backports.md`](../ai-for-science/upstream-v0.2.24-backports.md)、[`upstream-v0.2.25-review-2026-11-09.md`](../ai-for-science/upstream-v0.2.25-review-2026-11-09.md) 与 [`upstream-v0.2.27-review-2026-11-17.md`](../ai-for-science/upstream-v0.2.27-review-2026-11-17.md)；分支头 `f6d65eaa` 已含 `.27` 首批修补（`#924`/`#984`/`aa2a2935`） |
| 本地与 CI 回归基线 | 发行基线全量通过 + Phase 3 B3 第一批全量校验通过 | `.24-mobilesci.1` 完成 [CI 44041868978](https://github.com/CMCC-AI/OpenResearch/actions/runs/44041868978)；`feat/ai4s-product` 完成 `fmt/clippy` + `1,524` Rust 单元 + `636` UI 单元 + `ui/dist` 重建并已推送 `origin/feat/ai4s-product` |
| 遗留模块与技术债观察 | `src/local/chat/mod.rs`（9,874 行）、`src/commands/up.rs`（9,009 行）、`src/store.rs`（3,962 行）、`src/local/opencode.rs`（1,985 行）、`packages/platform/src/server.mjs`（1,621 行） | `chat/mod.rs` 尚余 4 组内联测试与约 4,593 行 `ChatHost` 核心流程；`opencode.rs` 存在单测 >60s 超时等待；`cargo audit` 0 高危阻断项；`10.7.0.18` 历史回滚容器待周期清理 |

---

## 二、下一步工作计划（分三阶段推进）

### 阶段 A：Gate 1 — `0.2.24-mobilesci.1` 本地验收、源码发版与生产切换（已全部闭环）

1. **恢复本地容器环境并完成端到端交互验收（已完成）**
   - 已确认 Docker Desktop、平台 58 项 PG 集成、`slot-1`（`5201`/`4901`）、`hosted-local`（`5400`、`shared-origin` + `--with-quotas` + `orx-check-executor-tools`）全链路回归通过，并在 `5400` 实测发布案例无异常。
2. **执行跨平台发行门禁与打标发布（已完成）**
   - `release/mobilesci-0.2.24-mobilesci.1`（`bcb90af4`）通过 [CI 44041868978](https://github.com/CMCC-AI/OpenResearch/actions/runs/44041868978) 并发布不可变 GitHub Release [`v0.2.24-mobilesci.1`](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.24-mobilesci.1)。
3. **生产受控升级切换（`ssh root@10.7.0.18`，已完成）**
   - 2026-11-17 完成 `10.7.0.18` 隔离 PG 58 项复核、PostgreSQL 与 5 份 SQLite 备份、离线编译器/平台/执行器镜像统一切换（同步 `opencode 1.18.33` 与 `/opt/opencode-npm-cache`）、`/opt/mobilesci/current/ui`（327 文件）与 `nginx.conf` `/_orx/runtime` 更新，以及公网入口、管理员模型开关幂等读写与执行器离线缓存验收（见[`.24-mobilesci.1` 交付记录](release-v0.2.24-mobilesci.1-delivery.md)）。

### 阶段 B：Phase 3 — 以 OpenCode 为中心的体验打磨、技术债治理与按需回移（当前主线）

| 批次 | 工作主题 | 触发依据与实施边界 |
| --- | --- | --- |
| B1（体验优化） | 配额提示、OpenCode 首连冷启动、本地/托管开发流、研究交付流打磨 | 基于线上 `.24-mobilesci.1` 真实反馈，优化额度预占提示、`opencode` 模型探测报错可读性、`hosted-local` 代理构建与多模型切换引导；不放宽计量与来源校验 |
| B2（结构与测试债治理） | 核心大文件增量解耦、`opencode.rs` 慢单测治理、`10.7.0.18` 历史回滚清理 | 先抽离 `chat/mod.rs` 剩余 4 组内联测试与 `opencode.rs` `verify_generation_models` >60s 单测超时参数化；结合 OpenCode 轮次/队列需求增量拆出 `ChatHost` 子模块；稳定周期后制定 `10.7.0.18` 历史 `-before-*` 容器清理策略 |
| B3（上游仅聚焦 OpenCode 与核心基座） | 跳过 Claude/Codex 专属提交，评估 `v0.2.27+` 与 `v0.2.25` 中对 OpenCode 与平台共性有价值的补丁 | 第一批 `#924`/`#984`/`aa2a2935` 已落地（`0d9e220c`）；明确排除 `#964`/`#972`/`#887`；下一批重点评估 `#953`（代理子进程遥测交由 `orx up`）、`#996`（PTY/调度去抖）、`#977`（测试禁用真实 `$HOME`）与 `#995`（单 Agent 模型选择器简洁展示），按需备选 `#994`/`#961`/`#968`/`#897`/`#890` |

### 阶段 C：重型架构与高成本能力准入边界（保持按需立项）

以下方向继续执行**四要素准入**（明确受影响用户、真实复现/使用证据、最小交付改动、长期维护成本评审），未满足前不进入常规迭代：

- **上游大型架构重写**：`#862 orx-host` / `#950` 新实验引擎体系、`#938` ACP 常驻代理体系、`#885` 新子代理协议、`#886` CodeMirror 输入器重写、`#891` 多机工作区切换、`#873` `.orx` 项目分享、`#877` `openresearch.sh` 云发布、`#978`/`#979` 官方托管 Agent 向导、`#954` 乐观 UI。
- **产品扩展专题**：固定数据复跑（原 PR `#17` 已清理关闭，后续若重提需明确冻结输入集删除保护语义）、跨 Run 指标趋势对比、完整环境镜像封存、签名桌面安装包（macOS/Windows/Linux 自有更新通道与签名链）。

---

## 三、版本号确定规则与 `0.2.25` 发版可能性分析

### 1. 当前“大版本 / 小版本”的确定规则

由 `product-upstream.json` 与 [`scripts/product-version.mjs`](../../scripts/product-version.mjs)（`validateProductVersion`）及 `scripts/check-upstream-base.mjs` 强制约束：

1. **基础游标（`tag` / `version` / `commit`）**：记录最近一次**完整三路合并**的官方上游版本，当前固定为 `v0.2.19`（`1d8a285`），CI 校验 `HEAD` 必须以该提交为真实 Git 祖先。
2. **主干前缀 `X.Y.Z`（对齐 `backportTarget.tag`）**：自 `.19` 改用选择性回移后，前置 `X.Y.Z`（如 `0.2.23` → `0.2.24`）取决于 `product-upstream.json` 中 **`backportTarget.tag` 追踪到哪一官方版本的增量台账**，且规则强制 `status` 为 `"partial"`、`productVersion` 必须以 `${backportTarget.tag.slice(1)}-` 开头，同时 `Cargo.toml` 必须与 `productVersion` 完全一致——避免外界把本地产品版本误认为整版合并上游。
3. **产品小版本与热修后缀 `-mobilesci.<N>[.<M>]`**：
   - `-mobilesci.<N>`（如 `.1` ~ `.7`）：随同一上游回移基线下的产品功能/稳定性迭代递增，每次正式发版保持标签与附件不可变；
   - `.<M>`（如 `.7.1`）：对已发布版本执行紧急最小热修时追加数字补丁位。

### 2. 发版 `0.2.25`（`0.2.25-mobilesci.1`）的可行性评估

- **技术机制上完全可行**：仓库已拉取官方 `v0.2.25` 标签（`c9123a6f`）并完成全部 45 项逐提交核查，且 `.25` 中安全高价值的 **7 项核心修复（`#923`/`#730`/`#786`/`#909`/`#747`/`#903`/`#734`）已实际合入当前分支**，与 `.24` 后半段加固（`#952`/`#962`/`#981`/`#985`/`#990`）和自主产品特性一起处于同一可用基线。只要同步更新 `product-upstream.json`（将 `backportTarget` 指到 `v0.2.25`）、`Cargo.toml`/`Cargo.lock`、`backportLedger` 及对应 `release-notes/v0.2.25-mobilesci.1.md`，CI 门禁即原生支持发布 `0.2.25-mobilesci.1`。
- **发版节奏建议（先发 `.24` 或直接切 `.25` 的取舍）**：
  - **推荐稳健路径：先按已锁定基线完成 `0.2.24-mobilesci.1` 验收与发版，再开启 `.25` 周期**。原因在于 `0.2.24-mobilesci.1` 的版本锁、台账与发布说明已就绪，且产品层面主交付内容（供应商模型开关、案例按对话发布、本地多用户托管启动器、WAL/租约/文件锁加固）独立成章；先发 `.24` 可避免为了凑 `.25` 编号而把尚未经过完整联调验证的更多改动塞进同一次发布。
  - **直接升标 `.25-mobilesci.1` 的前提条件**：若团队希望发布版本号与“已落地 `.25` 全部高价值小修”的事实保持一致、且不打算再单独维护 `.24` 正式 tag，可在恢复 Docker Desktop 并完成一次完整端到端验收后，直接把 `backportTarget` 推进到 `v0.2.25`（`c9123a6f`，`status: "partial"`），明确声明“选择性吸收 `.25` 稳定与安全补丁，刻意排除 `#862 orx-host`、`#885`、`#886`、`#891`、`#938` 等重型架构重写”，再一次性通过 `release/mobilesci-0.2.25-mobilesci.1` CI 发版。但不论选 `.24` 还是 `.25`，**前提都不依赖强行整版合并 `.25` 重构**。

每项需求提交四个要点：解决谁的现有问题、复现或使用证据、最小交付改动、长期维护成本。未明确的项保留待评估，不先扩展实现。官方版本号与本项目产品版本分别记录，不因官方升版自动变更本地功能范围。
