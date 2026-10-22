# 技术债修复记录（2026-10-21）

## 范围与状态

本轮以改造仓库初始 HEAD `4fa546b` 为起点。官方对比基线为 v0.2.19（`1d8a285468aed5d5a1f1ea86ecf6e2f63fcaa8bd`），核对版本为 [v0.2.20](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.20)（`37a367bcdbc26ba2a492bccf12b85bddc5852567`）。下面区分官方已有债务与产品改造引入的债务；风险级别与修复优先级分别记录。P0 为发布前必须处理的数据一致性或资源失控问题，P1 为可靠性和性能，P2 为渐进治理。

本轮选择性回移官方补丁，**不是完整升级 v0.2.20**；产品 upstream 基线和版本号仍保持 v0.2.19。用户明确限定只修当前仓库，伴随服务 `openresearch.sh` 不在范围内。本轮未提交、未部署，也未执行真实材料清理。

“已实现”仅表示源码改动已经落地；是否经过编译、运行测试或真实部署验证须以文末验证表为准。通用的巨型模块治理、全 API DTO 生成和三服务验收仍有后续项，不能视为全部技术债已消除。

## 一、官方代码已有问题：修复清单

| 顺序 / 优先级 | 问题、影响与严重程度 | 文件与实际改动 | 理由、验证及剩余风险 |
| --- | --- | --- | --- |
| 1 / P0 | SSE 收集中途失败会提前推进游标，遗漏项目、实验或更新提示；高 | `src/commands/up/event_stream.rs`：复制游标收集，完整成功后统一提交；首次失败保留 baseline 状态，失败重试也遵守 500ms 间隔 | 防止数据暂时不可读变成永久漏事件；失败注入与重试测试已通过 Rust 运行验证 |
| 2 / P0 | 兼容 ALTER 忽略所有 SQL 错误，可能带缺列运行；高 | `src/store/schema.rs`、`src/store.rs`：写事务内检查列；只跳过已存在列；其余错误回滚；成功记录迁移批次 | 增加幂等、保留已有行、失败回滚和重试测试；旧数据库升级/恢复仍需演练；已应用批次不得改写，应新增迁移名；保留现有产品专家团迁移保护 |
| 3 / P1 | Windows CMD 调用路径转换和子进程退出清理不可靠；高 | `src/local/bash.rs`、`src/local/localrun.rs`、`src/jobs/localbox.rs` 回移 #674；`src/local/codex.rs` 回移 #635，使用 Job Object 回收进程树 | 官方 v0.2.20 已提供修复，本仓库原基线未包含；Windows 原生编译、`local_job_lifecycle` 批处理回归及 `codex::tests::terminate_kills_the_native_child_behind_a_wrapper` 进程树清理测试均已通过 |
| 4 / P1 | 同步 SQLite、文件和 Git 操作占用 Tokio worker，影响并发请求；高 | `src/commands/up.rs` 增加最多 8 个并行任务的 blocking 执行池，将纯同步 API 与 SSE 收集移入；`up/research.rs`、`up/materials.rs`、`up/compute_settings.rs` 处理对应热点 | 取消请求时由执行中的闭包持有 permit，避免提前放行；增加 timer 不被慢同步任务阻塞测试；async 编排和聊天适配器仍有同步访问，未声称全仓消除 |
| 5 / P1 | 每条 SSE 连接独立扫描数据库和文件，成本随连接数增长；中高 | `up/event_stream.rs`：按数据目录缓存 500ms 的共享实体快照；每连接仍有独立游标和日志偏移 | 测试缓存复用、到期、失败、换目录；读取窗口可能增加最多约 500ms 的可见延迟；运行日志仍按连接读取 |
| 6 / P1 | 流式消息重复发送、持久化整个内容，长工具输出放大 CPU、网络及磁盘成本；中高 | `up/message_delta.rs`、`ui/src/chatMessageDelta.ts`、`ui/src/events.ts`：客户端 opt-in 版本增量，首次/重连发完整帧；缺帧重连修复；`src/local/chat/mod.rs`：广播仍约 75ms，普通持久化检查点约 1s，最终和提示卡立即写入 | 共享 wire fixture、客户端不可变更新/越序/危险路径测试；限制缓存、深度和操作数；保留旧客户端全量协议。**进程崩溃时普通流内容可能丢失约 1s**，需要中断、权限响应、分支和最终落盘回归 |
| 7 / P1 | 嵌套 HTML/Markdown 图片资源不能正确定位；中 | `FileViewer.tsx`、`HtmlPreview.tsx`、`InlineHtmlFigure.tsx`、`Md.tsx`、`markdownTarget.ts` 回移 #709 | 官方 v0.2.20 已修复；保留产品 credentials 与只读案例限制；UI 回归通过，仍需实际嵌套 artifact 浏览器验收 |
| 8 / P1 | SSH 禁用转发时错误诊断不足，修复路径不清晰；中 | `src/commands/up_remote.rs`、`compute.rs`、`up.rs`、`src/jobs/ssh.rs` 与 `RemoteRuntime.tsx`、`SshConnectTerminal.tsx`、`api.ts` 及消息目录回移 #631 | 官方 v0.2.20 提供诊断和显式修复操作；没有自动放宽拒绝策略；UI 测试通过，需真实受限 SSH 主机验证 |
| 9 / P2 | API、服务入口和聊天模块职责混杂；中 | SSE、增量编码、迁移分别拆为独立模块；`ui/src/demo.ts` 拆 demo 常量，原 API re-export 保持兼容；设置路径 helper 拆至 `harnessSetupPath.ts` | 先拆纯职责避免大规模行为改写；ChatPanel、聊天核心和其余 API 领域仍需分批治理，未完成全仓重构 |
| 10 / P2 | 编译期类型不能保护运行时 JSON，手工客户端契约可能漂移；中 | `ui/src/apiValidation.ts` 校验项目、run 和聊天消息核心 GET；`api.ts` 接入；共享 Rust/TS 流夹具 | 对额外字段保持兼容，核心坏数据不进入缓存；客户端契约测试通过。全 API DTO 自动生成、其他写入/响应契约仍是后续项 |
| 11 / P1–P2 | 依赖与资源体积缺乏持续治理；中高 | `.github/dependabot.yml`、`.github/workflows/ci.yml` 增加定期更新及审计；`scripts/check-ui-budget.mjs` 增加入口 raw 3.1MB / gzip 950KB 门禁；App 与 workspace 设置页延迟加载 | 入口 raw 从 3,245,272 降至约 2,939,788 bytes，gzip 从 990,714 降至约 897,776 bytes；构建通过。新增 ui/pnpm-workspace.yaml 的同主版本安全覆盖、更新 package.json 的 Vite 下限及 pnpm-lock.yaml；修复 Vite/PostCSS/nanoid/browserslist/source-map-js/baseline-browser-mapping 公告。KaTeX low 需 >=0.18.2，现有 rehype-katex 仍依赖 0.16，保留为后续兼容升级项 |

## 二、产品改造引入的问题：修复清单

| 顺序 / 优先级 | 问题、影响与严重程度 | 文件与实际改动 | 理由、验证及剩余风险 |
| --- | --- | --- | --- |
| 1 / P0 | 专家派发先计数后插入，两个请求可能抢占最后一个名额；高 | `src/commands/research_dispatch.rs`：`BEGIN IMMEDIATE` 后检查配额，事务内同时创建 session、research binding 和 spawn；网络 await 均在事务外 | 防止并发突破上限和孤立会话；双线程、双 Store 竞争末位名额测试已通过 Rust 运行验证 |
| 2 / P0 | ZIP 全量展开保存在内存，多请求放大峰值；高 | `src/local/materials.rs`：RAII 暂存目录、逐文件流式落盘；校验一次最多读 32MiB；全部校验前不发布清单；`up/materials.rs` 与路由：读取 body 前限制同时上传 1 个 | 取消请求后后台任务仍持有名额；ZIP 错误路径/容量失败清理测试已补；仍有 32MiB 请求体、单文件检查缓冲及 ZIP 元数据，未声称恒定内存；上传高峰可能收到 429 |
| 3 / P1 | 材料包累计占满执行器磁盘，未完成上传无回收入口；高 | 新 `src/local/materials/storage.rs`：执行器 root 默认 4GiB，总量跨进程锁；包数上限 4096；写入前检查剩余容量；`src/commands/materials.rs` 增加 gc 预览/显式 apply | GC 仅处理指定项目、超过保留期且未 sealed 的包，最少 24h；sealed 永不删除；Agent 会话不能 apply。新增保留 sealed/其他项目/近期包的测试；需磁盘满、并发上传/回收和崩溃恢复验证 |
| 4 / P1 | runner 的存在性锁在异常退出后残留，重启失败；高 | 新 `packages/platform/src/runner-lock.mjs`：SQLite 独占事务持有 OS 锁；`runner.mjs` 使用幂等释放闭包；`scripts/deploy/fix-material-upload.py` 包含新模块 | 互斥、重复释放和进程被杀后重获锁测试通过。旧版 connector.lock 存在时拒绝混用，需停旧 runner 后人工清旧锁；新镜像需要重新构建部署，本次未部署 |
| 5 / P1 | 多服务发布缺少绑定同一候选版本的证据，升级回归难追溯；高 | 新 `scripts/check-release-evidence.mjs` 与测试：绑定 workbench/platform/literature 版本、revision、artifact 哈希及 9 项验证日志；拒绝失败、跳过、陈旧或变化的证据；CLI 要求干净候选 checkout | 两项工具回归通过；**尚未接入实际产品发行系统，也未完成三服务浏览器和升级恢复演练**；工具成功不等于产品验收通过 |

## 三、v0.2.20 核对依据与服务端待办

官方依据来自 release、PR 文件列表与对应补丁的逐文件核对，不依据版本号推测行为。

| 官方问题 | v0.2.20 核对 | 当前仓库结果 |
| --- | --- | --- |
| CMD 路径及退出码 | [#674](https://github.com/alphaXiv/OpenResearch/pull/674) | 已选择性回移，Windows 原生编译与 `local_job_lifecycle` 回归通过 |
| Windows Codex 后代进程清理 | [#635](https://github.com/alphaXiv/OpenResearch/pull/635) | 已选择性回移，Windows 原生编译与进程树清理测试通过 |
| 嵌套 artifact 相对资源 | [#709](https://github.com/alphaXiv/OpenResearch/pull/709) | 已选择性回移，UI 测试通过 |
| SSH 转发诊断及显式修复 | [#631](https://github.com/alphaXiv/OpenResearch/pull/631) | 已选择性回移，UI 测试通过，待真实主机 |
| managed compute 计费租约回收 | [#717](https://github.com/alphaXiv/OpenResearch/pull/717)，依赖伴随服务 PR #657 与数据库迁移 | **用户排除伴随仓库范围，未实现**。下一轮需单独纳入服务端、迁移及双方兼容性验收；单改本 CLI 不能修复服务端计费回收 |
| 安全依赖公告 | 官方 [Cargo.lock](https://github.com/alphaXiv/OpenResearch/blob/v0.2.20/Cargo.lock) 仍为 h2 0.4.14、rustls 0.23.40、webpki 0.103.13、roots 1.0.7、quinn-proto 0.11.14、zip 2.4.2；[UI 锁文件](https://github.com/alphaXiv/OpenResearch/blob/v0.2.20/ui/pnpm-lock.yaml) 仍为 Vite 6.4.3、PostCSS 8.5.16、nanoid 3.3.15 等受影响版本 | 本轮审计发现的对应公告在 v0.2.20 锁文件中仍未修复；当前仓库已锁定安全补丁，低危/维护警告另列 |
| SSE 游标、兼容 ALTER、每连接采集、同步热点及巨型模块 | 比较上述两个官方基线及对应源码，未找到可覆盖本轮问题的完整修复 | 按本轮实现和剩余项记录，不能因 v0.2.20 发布便认为自动解决 |

没有整体移植 #675 等其余版本改动。产品自更新禁用、专家团迁移保护、材料读取与授权边界保持原有约束。

## 四、运维接口与兼容影响

- `ORX_MATERIAL_STORAGE_BYTES`：每个执行器材料 root 的容量，默认 4GiB，至少 32MiB；需在执行器进程配置，已存材料不会自动删除。暂存、原件、derived 与已有文件均计入扫描量，清单/元数据仍需留磁盘余量。
- `orx materials --project <id> gc --days 7` 只预览；用户核对后加 `--apply` 才删除未封存过期包。可指定已删除项目 ID 处理其未完成上传；不会删除 sealed 研究证据；当前未提供 sealed 自动归档。
- 新旧 runner 升级先停止旧进程，再核实 connector.lock 为陈旧锁；不得删除活跃进程持有的锁。SQLite 锁文件可复用，无需每次启动删除。
- SSE 增量仅在 `/api/events?deltas=true` 启用；旧客户端继续全量。前端与后端可独立回滚；缺帧时丢弃连接基线并重新拉取快照。
- 普通流持久化间隔约 1s；若业务不能接受该崩溃丢失窗口，应恢复每次持久化或另设计追加式日志后再发布。

## 五、验证结果与下一步顺序

验证命令和结果以本次实际执行为准，完整本地日志保存在忽略目录 `.mobilesci-run/technical-debt/`。

| 验证 | 当前结果 |
| --- | --- |
| UI 完整单元测试 | 410/410 通过（隔离目录，使用修复后锁定依赖及实际源码） |
| UI TypeScript、i18n、主题样式 | 通过 |
| UI 生产构建、入口预算 | 安全补丁依赖下生产构建通过；已同步最终 `ui/dist`，入口 2,939,788 raw / 897,776 gzip bytes |
| runner 锁新增回归 | 2/2 通过 |
| 平台单元测试 | 32/32 通过（获准使用临时回环服务的隔离副本）；受限环境原有 4 项 EACCES/配置服务失败已排除，PostgreSQL 集成仍未完成 |
| 平台 Prettier | 通过 |
| 发布证据工具 | 2/2 通过；未运行真实三服务验收 |
| Rust 全仓格式与语法解析 | 便携 rustfmt 1.93.0 检查通过；不代表类型/借用/测试通过 |
| Rust 编译、clippy、测试 | 既有记录显示根项目 Clippy 通过；归档全量单测为 1,101 passed / 12 failed / 3 ignored，短路径复跑 24 项通过，但仅覆盖其中 3 项失败用例，仍缺 9 项 demo 复跑证据；不能据此认定 1,113/1,113 全通过。集成日志 9/9 通过；launcher Clippy 需补归档。详见 2026-10-22 一致性报告 D8 |
| 依赖审计 | 首次 UI 审计 7 high / 4 moderate / 1 low；兼容补丁后 0 critical / 0 high / 0 moderate / 1 low（KaTeX）。Rust 根锁文件 15 条漏洞经安全升级后清零，launcher 审计也通过；仍有 proc-macro-error unmaintained 与 glib 0.18 unsound 警告 |
| 浏览器登录/材料/重连、PostgreSQL 集成、升级恢复、真实 SSH/Windows 生命周期 | 尚未完成 |
| 发行说明与图表 Python 回归 | 6/6、4/4 通过；图表测试指定 UTF-8 和任务临时目录 |
| 启动/dev-slot/部署辅助回归 | 未全绿：Windows 不支持 dev-slot advisory lock、路径格式差异，部署脚本依赖 fcntl；需 Linux CI 复核 |
| git diff --check | 通过 |

后续重点为真实历史数据库升级/恢复演练、材料大包并发与磁盘满压测、PostgreSQL 集成测试、三服务浏览器验收及真实受限 SSH 主机验证，之后接入发行证据门禁、扩展 DTO 与巨型模块分批治理。伴随服务计费回收应单独安排，不能被本仓库修复替代。

## 六、发行证据工具使用

2026-10-22 补充：旧记录的缺失证据已通过当前候选全量复跑补齐。Windows 1,116 项单测与 9 项集成通过，Linux 1,182 项单测与 18 项集成通过，两平台各保留原定义的 3 项忽略；数量因功能集不同而不同。新增周期检查点、配额峰值、上传恢复及部署范围保护，详见 `technical-debt-critical-remediation-2026-10-22.md`；不能据此将 10-21 的旧日志反向改写为当时全绿。

在干净的候选 revision checkout 运行 `node scripts/check-release-evidence.mjs <evidence.json> <40位候选SHA>`。证据目录须包含三个组件实际 artifact 和全部验证日志；JSON 的 `formatVersion` 为 1，`revision` 为候选 SHA。`components.workbench/platform/literature` 各记录 `version`、`revision`、`artifact`（目录内相对路径）、`artifactSha256`。本仓库两个组件 revision 必须与候选相同，literature 单独固定其 commit。

`checks` 中每项唯一记录 `name`、`revision`、`command`、`exitCode`、`log`、`sha256`，九项名称见脚本 required 列表；失败、跳过、缺失、错版本、路径逃逸或内容哈希变化均拒绝。此工具检查证据完整性，不能代替真实执行与可信 CI 日志。尚未接入产品发布流水线，须在接入后进行实际演练。

## 七、安全依赖补充核查

根 `Cargo.toml` 将 anyhow 最低版本提高至 1.0.103、ZIP 升至 9；`Cargo.lock` 锁定 anyhow 1.0.104、h2 0.4.20、quinn-proto 0.11.19、rustls 0.23.46、rustls-webpki 0.103.16、webpki-roots 1.0.10、zip 9.0.5。ZIP 9 文件名读取返回 Result，材料解压明确传播解码失败。公告依据为此次 cargo-audit 0.22.2 拉取的 RustSec 数据库：RUSTSEC-2026-0258、0185、0338/0339/0340/0342、0285、0346/0348/0349、0381/0382、0367/0368/0369；不使用 ignore 绕过漏洞门禁。

仍保留两条警告：proc-macro-error 的维护状态（RUSTSEC-2024-0370），以及 Linux GTK3 桌面依赖 glib 0.18 的 VariantStrIter 健全性问题（RUSTSEC-2024-0429）。glib 的修复要求 >=0.20，与当前 GTK3 依赖链不兼容，应安排上游修复/经审查的回移或桌面依赖迁移，发布 Linux 桌面前需单独评估；不能用 Windows 默认目标通过代表 Linux 桌面已验证。
