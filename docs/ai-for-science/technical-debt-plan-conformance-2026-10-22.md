# 技术债改造方案一致性核查（2026-10-22）

## 核查口径与待确认信息

本次核查工作区中已完成的改造，不修改业务实现，也不以通过测试替代需求覆盖核对。

主要依据：

- `docs/ai-for-science/technical-debt-remediation-2026-10-21.md` 第 15–35 行：官方问题 11 项、产品问题 5 项的当前清单。
- `docs/ai-for-science/material-inputs.md`：材料接入、容量、读取与部署契约。
- `docs/ai-for-science/upstream-upgrades.md` 第 72–89 行：基线、产品保护、三服务验收与升级恢复约定。
- `AGENTS.md`：目录、共享上传、运行隔离、产品保护和发行检查约束。
- `docs/ai-for-science/README.md` 第 3 行及 `preset-workflows.md`：2026-10-16 的 W1–W4 定义优先于 2026-10-10 的历史会诊设计。
- 用户已明确：只修当前仓库，伴随服务计费回收依赖记录待办。

需要补充确认的关键点：

1. 未找到独立、冻结的原始 A1–A8/B1–B6 方案文件及其验收标准；当前 16 项汇总是修复记录，不能反向证明最初方案没有遗漏。若另有原始清单，应补充文件/版本后再核对映射。
2. “全部完成”指本轮源码修复，还是包含整个产品路线图、真实部署及三服务验收？本报告以本轮 16 项为主，阶段性后续项单列，未把历史路线图中的全部能力认定为本轮承诺。
3. “1 秒检查点”是否要求无新事件时也在 1 秒内持久化；4 GiB 配额是否包含清单和临时写入峰值？当前实现不能满足这两个强保证，需要确认验收口径。
4. 本轮候选提交 SHA、三服务版本/镜像摘要、历史数据升级恢复和真实浏览器验收材料尚未形成完整候选证据集。

状态定义：已符合＝检查范围内源码逻辑及组织符合约定；部分符合＝已有实现但目标或验收仅覆盖一部分；不符合＝已有实现/文档与约定存在具体矛盾；未实施＝所述能力没有落地。代码已符合不等于已经部署验收。

## 一、逐项核查

O/B 编号仅用于映射现有汇总表，不冒充缺失的原始 A/B 编号。

| 清单项 | 状态 | 核查结果及主要位置 |
| --- | --- | --- |
| O1 SSE 游标原子提交 | 已符合 | `src/commands/up/event_stream.rs:163` 复制游标，收集成功后一次提交；失败保留 baseline，重试节流；对应回归有通过记录。 |
| O2 SQLite 事务迁移 | 已符合 | `src/store/schema.rs:15` 写事务、锁后重查、仅跳过已有列、成功登记批次；`src/store.rs:789` 接入固定批次，原专家团迁移保护保留。历史数据库恢复演练另列。 |
| O3 Windows CMD / Codex 进程树 | 已符合 | `src/local/bash.rs`、`localrun.rs`、`codex.rs`、`src/jobs/localbox.rs` 按原领域组织；短路径日志包含批处理与进程树通过记录。实际 launcher 目录为 `windows/launcher`。 |
| O4 同步热点与执行池 | 部分符合 | `src/commands/up.rs:3006` 有 8 并发执行池，多个同步接口已迁入；`up/materials.rs:48`、`:64` 仍在 async handler 中同步打开 Store，后续重操作直接调用独立 spawn_blocking，不受该池统一约束。见 D5。 |
| O5 SSE 共享采集 | 已符合 | `up/event_stream.rs:194` 按数据目录缓存 500ms 实体快照，连接保留独立游标及日志 offset；没有用全局游标覆盖订阅者状态。 |
| O6 消息增量和持久化 | 部分符合 | `up/message_delta.rs:17` 与 `ui/src/chatMessageDelta.ts:36` 实现版本化增量、首帧全量、缺帧修复；但检查点只有事件触发的时间门禁，不能保证静默期间 1 秒内落盘，检查点子项为“不符合”。见 D1。 |
| O7 嵌套 HTML/Markdown 资源 | 已符合 | `FileViewer.tsx:265`、`InlineHtmlFigure.tsx:16`、`Md.tsx:438`、`markdownTarget.ts:13` 有相对路径解析、携带凭据和只读限制；浏览器真实场景验收另列。 |
| O8 SSH 诊断与显式修复 | 已符合 | `src/commands/up_remote.rs:1131` 有修复路由，`ui/src/RemoteRuntime.tsx:219` 按断连/待修复状态展示显式操作；源码没有把诊断改成自动放宽转发。真实受限主机验证另列。 |
| O9 模块拆分、命名与结构治理 | 部分符合 | SSE、增量、列迁移、材料存储已按 Rust snake_case 拆分；前端 demo 与路径 helper 独立，旧导出兼容。`up.rs` 仍 9,839 行，`chat/mod.rs` 11,864 行，`ChatPanel.tsx` 6,949 行，`api.ts` 2,355 行，领域拆分尚未覆盖剩余大模块。见 D6。 |
| O10 API 契约治理 | 部分符合 | `ui/src/apiValidation.ts:13` 起仅列出 5 类 GET 路径；`api.ts:148` 接入 GET，POST/PUT 等仍使用手工泛型。共享夹具覆盖消息增量，但全 API DTO 自动生成“未实施”。见 D6。 |
| O11 依赖及前端资源治理 | 部分符合 | Cargo/前端锁文件、Dependabot、CI 审计和体积预算均落地；`App.tsx:107`、`:128` 与 workspace 设置页实现分包。仍保留 KaTeX low、glib unsound 与 proc-macro-error 维护警告；Linux 桌面依赖迁移未完成。见 D7。 |
| B1 专家派发并发配额 | 已符合 | `src/commands/research_dispatch.rs:82` 在写事务内计数，`:196` 起将 session、研究绑定和 spawn 一起提交；网络 await 不在该事务内。 |
| B2 ZIP 内存与上传并发 | 已符合 | `src/local/materials.rs:147` 起逐项暂存、单文件检查；`up/materials.rs:6` 在缓冲 body 前准入，permit 随后台上传存活。仍有受限的请求体和单文件缓冲，未承诺零缓冲。 |
| B3 材料总量与回收 | 部分符合 | 正常原件/derived 写入受配额锁保护，GC 默认预览、保留 sealed、限制项目及保留期；但严格 root 硬上限子项“不符合”，崩溃后无有效 manifest 目录的回收覆盖不足。见 D2。 |
| B4 runner 异常退出锁恢复 | 部分符合 | `packages/platform/src/runner-lock.mjs:20` 使用 SQLite 独占事务，接入 runner 并有强杀恢复测试；分发脚本包含新模块。部署说明漏写新必需文件，文档子项“不符合”，新镜像部署仍未实施。见 D4。 |
| B5 多服务发行证据与升级回归 | 部分符合 | `scripts/check-release-evidence.mjs:9` 有版本/文件/日志哈希核查；CI 只运行该工具的单元测试，没有强制核验实际候选证据。流水线接入及真实升级恢复验收“未实施”。见 D3。 |

## 二、具体差异、原因与整改

### D1 / P1：检查点不保证静默期间按时持久化——不符合

- 差异位置：`src/local/chat/mod.rs:7836`、`:7876`；`src/local/harness/codex.rs:2877`、`:3104`；记录中的“约 1 秒崩溃丢失窗口”见修复汇总第 20、59 行。
- 原因：将写入限频条件当成周期检查点。flush 只有被调用时检查 elapsed，Codex 等适配器等待下一事件时没有检查点 timer 分支。
- 具体情形：t=0 写入后，t=0.1s 的内容已广播但未持久化；随后工具静默 30s，内容不会仅因超过 1s 自动入库。此时崩溃会丢掉 30s 前已展示的尾部内容。这里指出的是持久化延迟无 1s 上限，不是声称一定丢失超过 1s 的连续生成内容。
- 现有测试 `chat/mod.rs:11834` 验证跳过中间写入及最终/提示强制写入，没有验证“无新事件且到期”。
- 整改：为活动 turn 增加基于 dirty 状态的定时落盘，保留原有提示协调锁和最终落盘；增加可控时钟下的静默、取消、写入失败与最终写入竞争测试。若只打算做事件驱动限频，应修订并明确接受该耐久性语义。

### D2 / P1：材料总量未覆盖元数据峰值，异常目录回收不足——部分符合

- 不符合位置：`src/local/materials.rs:71` 不计预算直接写 `manifest.tmp` 再 rename；`:80` 只检查当前 remaining，创建清单前未预留空间；`:185` 将余额交给原件暂存，`:283` 最后仍不受额外清单预算约束。
- 原因：容量准入覆盖文件 payload 与 derived，但没有覆盖新清单、替换时旧清单加临时清单并存的峰值。剩余空间很少时，空包创建或满额原件写入仍可使总量超过配置值；“root 限制”与“元数据需另留余量”口径不一致。
- 整改：在同一配额锁下预算新/旧 manifest 和暂存峰值，对 create/upload/finalize 所有写路径统一准入；增加只剩少量字节、刚好到边界、多进程和磁盘写失败用例。明确这是逻辑字节配额还是文件系统已分配空间配额。
- 部分符合位置：`src/local/materials/storage.rs:91` 遇到缺失/损坏 manifest 直接跳过。创建在 manifest 写入前崩溃可能留下这种目录，它仍占容量和包数却无法被当前 GC 识别。
- 整改：增加可恢复的创建状态/归属记录，或隔离可疑目录供用户核对；不要仅凭目录年龄删除无法确认归属的数据。已有 sealed 保留规则应继续保留。

### D3 / P1：发行检查器没有成为实际发行门禁——部分符合；接入未实施

- 差异位置：`.github/workflows/ci.yml:83` 的步骤仅运行 `scripts/release-evidence.test.mjs`；`scripts/check-release-evidence.mjs:35` 才是核查实际证据的 CLI 入口。工作流/部署脚本引用检索中未找到实际调用该 CLI 的发行步骤。
- 原因：完成了检查器和自身测试，尚未接入候选打包、三个组件版本采集和发布前失败阻断。
- 整改：在产品候选发布路径生成并验证 evidence bundle，将检查结果设为发布依赖；真实运行三服务浏览器、PostgreSQL 集成和升级/恢复验收。检查器自身测试通过不能作为这九项实际验收通过的证据。

### D4 / P2：部署操作文档与分发依赖矛盾——不符合

- 差异位置：`docs/ai-for-science/material-inputs.md:26` 要求准备“仅含 runner.mjs、tunnel.mjs 和 material-upload.test.mjs”的目录；`scripts/deploy/fix-material-upload.py:122` 已强制要求第四个文件 `runner-lock.mjs`。
- 原因：新增 runtime 模块后更新了分发脚本，但未同步原有操作示例。按文档准备目录会在前置校验报 `Missing patch source: runner-lock.mjs`。
- 整改：同步文件清单、三份运行模块的表述、Node 最低版本及镜像更新说明；区分原先已部署的上传修复与本轮尚未部署的 SQLite 锁修复。

### D5 / P2：同步隔离与有界执行池只覆盖部分路径——部分符合

- 差异位置：`src/commands/up/materials.rs:48`、`:64` 调用同步 project/Store 查询，`:49`、`:65` 直接 spawn_blocking；`src/commands/up.rs:3006` 的 semaphore 仅约束走 helper 的任务。`src/local/chat/mod.rs:7877` 仍同步打开 Store 并写消息。
- 原因：采用渐进迁移，既有异步编排中的同步段、独立后台任务尚未统一治理；不是命名或目录错误。
- 整改：按真实请求链列出剩余同步段，分离网络等待与同步存储/文件段；将适合的后台工作纳入有界池，避免机械包裹持锁/await 代码；补并发与取消验证。

### D6 / P2：领域拆分和全 API 契约仍有未落地内容——部分符合 / 未实施

- 差异位置：`src/commands/up.rs:53` 等只拆出局部职责；`ui/src/apiValidation.ts:13` 起只校验有限 GET；`ui/src/api.ts:146` 和 `:159` 显示 GET 校验与写响应尚未统一。
- 原因：本轮选择了局部低风险拆分与运行时防御，没有实现完整领域服务拆分、统一 DTO 来源或生成流水线。
- 整改：为剩余领域拆分设定清单、依赖方向和完成标准；选择 Rust 导出或 schema 驱动的 DTO 生成方案，逐步覆盖研究/材料/设置等读写契约，并在 CI 检查生成物漂移。不要把有限运行时校验描述成完整 DTO 治理。

### D7 / P2：依赖风险仍有保留项——部分符合

- 差异位置：`ui/package.json:26` 的 KaTeX 仍为 0.16 系列；修复汇总第 94 行明确保留 glib 0.18 健全性及 proc-macro-error 维护警告。
- 原因：KaTeX 0.18、glib >=0.20 涉及现有渲染或 GTK3 依赖链兼容，不属于本轮已完成的安全补丁范围。
- 整改：单列责任项、适用平台、修复方案和验收条件；验证数学渲染兼容及 Linux 桌面路径。保留“15 条漏洞清零”的实际审计结果，同时不能称为所有依赖风险已清零。

### D8 / P1：全量通过的汇总超出当前归档证据——不符合

- 差异位置：修复汇总 `technical-debt-remediation-2026-10-21.md:75`；归档 `cargo-test-unrestricted.log:1283` 为 1101 passed / 12 failed / 3 ignored；`rust-short-temp-rerun.log:28` 为 24 passed。
- 实际差异：短路径 24 项中包含 local_job_lifecycle、overleaf 和 storage 三项首次失败用例，但没有首次失败的九项 demo 用例。当前日志不能推导出全部 12 项都复跑通过。其余通过记录不因此失效，也不据此断言那九项在短路径必然失败。
- 缺少复跑记录的 `local::demo::tests`：`an_install_seeded_at_the_previous_experiment_keeps_working`、`cleared_cache_restores_from_local_origin_at_experiment_commit`、`database_reset_adopts_existing_demo_without_reseeding`、`demo_seed_preserves_legacy_user_artifacts_with_the_nanochat_slug`、`every_demo_session_recovers_from_the_experiment_commit`、`moved_data_dir_repairs_the_local_origin`、`prewarmed_onboarding_seeds_full_demo`、`repository_and_snapshot_seed_are_idempotent`、`repository_commit_ids_are_deterministic`。
- 原因：复跑选择范围与“所有失败复跑”的叙述没有逐用例对账；24 项也包含既有用例，不能直接归类为“24 项全部新增/回移”。
- 整改：补交现有遗漏日志，或在短临时目录、单进程、同一候选源码下重跑上述九项/完整套件；按测试名汇总原跑与复跑结果。launcher Clippy 日志未在指定归档目录找到，若用作发行证据应一并归档并关联版本。

## 三、单列未实施与范围排除项

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 全 API DTO 自动生成及漂移门禁 | 未实施 | 已有的是少量运行时校验和消息共享夹具。 |
| 实际候选 evidence 校验接入发行流程 | 未实施 | 已有的是检查器与检查器单测。 |
| 本轮三服务浏览器、PostgreSQL 集成、真实升级恢复、受限 SSH 主机验收 | 未实施 | 没有本轮完整候选证据；历史版本验收不能自动继承为本轮通过。 |
| 包含 PDF 解析与新 runner 锁的实际镜像构建/部署验收 | 未实施 | Dockerfile/分发源码不等于部署完成。 |
| managed compute #717 伴随服务回收 | 未实施（已约定排除） | 用户选择仅修当前仓库；按约定记录待办，不计作本仓库实施遗漏。 |
| 结构化阅读覆盖、远端材料同步、跨导入去重/材料版本关系、统一解析/OCR | 未实施（材料后续阶段） | 材料文档第 70 行起已明确为后续增强，不能认定本轮违约，也不能称为已经实现。 |

## 四、命名、目录与依赖核查结论

新增 Rust 模块位于对应 commands/store/local 领域，使用 snake_case；前端业务文件位于 ui/src，采用现有 TypeScript 命名风格；demo 常量保留旧导出，运行时共享上传仍使用 materialUploads。未发现本轮新建第二套研究引擎、绕过研究审批或把本地材料转存伴随云服务的实现证据。material storage 子模块及 SQLite runner 锁的依赖方向符合当前领域划分。

product-upstream.json 保持 v0.2.19，OFFICIAL_UPDATE_CHANNEL_ENABLED 仍为 false，符合“选择性回移、保留产品更新保护”的范围；不能把未整体升级 v0.2.20 本身列成偏离。剩余大模块、部分独立 spawn_blocking 和手写 API 类型属于未完成治理，不能据此笼统判定全部目录或命名不符合。

## 五、本次检查与建议顺序

本次进行了源码/工作流引用核对、测试日志逐项对账；重新运行消息增量、API 校验和发行证据工具 9 项测试，9/9 通过；入口预算为 2,939,788 raw / 897,776 gzip bytes，检查通过；git diff --check 通过。没有重跑完整 Rust/UI/平台套件，没有改动业务源码。

整改顺序建议：先 D1 的耐久性保证与 D2 的容量边界；同步补 D8 的验收证据；发布之前落实 D3 的真实门禁与验收。D4 是低成本的文档阻断，应在下一次分发脚本使用前修正。随后推进 D5/D6 的热点、模块及契约治理，D7 按平台和兼容风险安排。伴随服务与材料后续能力保持单独排期。
