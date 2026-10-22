# OpenResearch v0.2.20 升级影响评估

核查日期：2026-10-21。性质：源码与接口审计、临时副本合并预检及纯函数复现；未执行产品升级、生产数据库迁移、部署或真实算力实验。

## 1. 基线与结论

本项目是 OpenResearch 的源码定制产品，不是通过 Cargo/npm 引用 OpenResearch SDK 的下游应用。应合并固定上游提交并构建 MobileSci 产品包，不能仅改版本号或执行官方 `orx update`。

| 项目 | 核查结果 |
| --- | --- |
| 当前产品提交 | `4fa546bdec65aa90ee0ecfcda3892153888e74fc` |
| 当前上游基线 | v0.2.19，`1d8a285468aed5d5a1f1ea86ecf6e2f63fcaa8bd` |
| 确认方式 | `Cargo.toml`、`Cargo.lock`、`product-upstream.json` 和 Git 共同祖先一致；基线脚本通过 |
| 目标 | v0.2.20，`37a367bcdbc26ba2a492bccf12b85bddc5852567` |
| 官方发布时间 | 2026-10-21 14:27:02，Asia/Shanghai |
| 上游增量 | 24 个提交，Git 本地差异共 173 个路径，含静态产物、图片、翻译和测试 |
| 产品交叉范围 | 52 个路径同时存在上游增量与产品定制；三方合并预检报告 31 条冲突事件，包含静态产物重命名冲突，并非 31 个独立功能 |
| 更新渠道 | `product-disabled`；继续保留产品包更新策略 |

结论：可以安排升级，但应按中高风险的源码整合处理。最高风险是租用算力的新服务契约，以及数据库/聊天代码与专家团定制的冲突。ACP 和案例/网关协议也存在已证实的不兼容。普通本地、SSH、Slurm 使用者不必等待租用服务升级，但发布候选包必须明确禁用或隐藏尚未配套的新租用流程。

官方依据：[Release](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.20)、[完整差异](https://github.com/alphaXiv/OpenResearch/compare/v0.2.19...v0.2.20)。以下“必须适配”来自目标 tag 与当前产品代码的交叉核查，不代表官方把该版本声明为破坏性版本。

## 2. 变更点与新增能力

| 领域 | v0.2.20 变化 | 对本产品的价值和边界 |
| --- | --- | --- |
| Agent 扩展 | 新增可配置 ACP harness、预设、认证、模型/模式配置、原生权限选项、会话启动配置快照；注册表动态扩展 | 可接入 DeepSeek Harness、Kimi Code、MiniMax Code、ZCode、Pi、Devin、Grok Build；预设不等于 CLI/适配器已安装，也不等于专家团已完成兼容验收 |
| Codex 交互 | 异步问题转为可点击 prompt，通过 steering 回答；统一子 Agent 内容读取 | 改善专家主理人与用户的问答体验；异步问题不能误走持有中的 JSON-RPC 请求回复路径 |
| 侧边聊天 | 持久化会话、每个主会话的选择器、空草稿、标签滚动；关闭标签保留会话 | 降低上下文丢失；改变现有关闭和重启时的清理语义，涉及共享工作树和父会话删除 |
| 实验追踪 | 为运行注入 `ORX_RUN_ID`；本地/SSH/Slurm 配置 `TENSORBOARD_LOGDIR`；新增 `orx tensorboard`；Trackio 预检与运行链接 | 可把实验、指标服务、专家证据关联起来；不自动安装 Python 跟踪库，也不会自动把任意训练脚本接入指标记录 |
| 实验导航 | 实验表和详情中的 lineage；统一聊天活动、目标、计划、等待输入和实验运行状态 | 可改善 DAG 之外的实验谱系导航；应与研究任务 DAG 区分，并沿用现有工作台入口 |
| GitHub 发布 | 发布设置整合，允许逐项目选择 GitHub organization，新增组织查询 | 解决仓库总落到个人账号的问题；这里的 GitHub organization 与 MobileSci 账号组织不是同一身份体系 |
| 租用算力 | 实验机器上的独立监督器、租约心跳/激活/释放、限定回收窗口和 `lost` 终态 | 笔记本休眠/SSH 中断不再决定账单回收；必须协调配套服务，且短期日志收集窗口改变数据可用性 |
| 远程连接 | 区分远端二进制缺失与权限拒绝，返回修复命令并改善 UI | 减少“明明已安装却提示未安装”的排错；保留产品二进制来源与网关约束 |
| 文件展示 | 修复嵌套产物目录中的聊天图片、HTML 图形相对资源、文件编辑器文字选择 | 与本产品 `/mobilesci` 路径、材料下载/历史附件和图形预览一起验收 |
| 平台与体验 | Windows CMD 内建命令执行；Codex Windows Job Object 清理进程树；onboarding 按持久标记判断；设置滚动/标签样式；反馈工具告知报告提交 | Windows 需要真实平台回归；反馈行为变化要反映在技能提示中；产品新建对话和首页布局需要保留 |
| 测试与 CI | 非 UTF-8 SSH Include 用例限 Linux；主检查 runner 固定 Ubuntu 24.04；新增 ACP 和多组 UI 测试 | 本产品此前已有 macOS 夹具规避，需合并一致；保留全部产品 CI job |

重点 PR：[ACP #510](https://github.com/alphaXiv/OpenResearch/pull/510)、[租用监督 #717](https://github.com/alphaXiv/OpenResearch/pull/717)、[侧边聊天 #716](https://github.com/alphaXiv/OpenResearch/pull/716)、[运行追踪 #679](https://github.com/alphaXiv/OpenResearch/pull/679)、[TensorBoard/Trackio #680](https://github.com/alphaXiv/OpenResearch/pull/680)、[实验谱系 #570](https://github.com/alphaXiv/OpenResearch/pull/570)、[GitHub owner #566](https://github.com/alphaXiv/OpenResearch/pull/566)、[活动状态 #729](https://github.com/alphaXiv/OpenResearch/pull/729)。

## 3. 必须评估的破坏性与行为变化

### 3.1 租用算力是跨服务硬依赖，优先级 P0

目标版本 `src/local/openresearch.rs` 创建实验 sandbox 时新增：

```json
{ "rentalLease": { "version": 1, "maxActiveSeconds": 14400 } }
```

其中执行时限来自本次运行配置，四小时只是默认值。响应必须包含 `rentalLease.version == 1` 和 capability token；缺失时客户端尝试删除刚创建的 sandbox 并返回“服务不支持 rental supervision”。不能因为字段反序列化为 `Option` 就认为旧服务可继续接受新实验。

新增 `src/jobs/rental.rs` 通过 scoped token 调用 `${apiUrl}/sandboxes/{id}/lease/{heartbeat|activate|release}`，并要求远端 `orx` 支持隐藏命令 `rental-supervise`。老 descriptor 没有 lease 时保留原本地清理流程；独立 instance、其他后端生命周期不在此次切换内。

官方生命周期文档规定：30 秒心跳、5 分钟失联过期、30 分钟 bootstrap 上限；执行结束后等待本地确认最终日志/退出码或最多 60 秒，再请求释放。收集窗口计费。租约 API 的服务端必须实现相应迁移、幂等状态和持久化回收，客户端常量不能证明服务端已经实现。

影响代码：`src/client.rs`、`src/local/openresearch.rs`、`src/commands/supervise.rs`、`src/jobs/{mod,rental,openresearch,ssh}.rs`、`src/compute.rs`、`src/store.rs`、`src/plane/local_plane.rs`。

本地 `packages/platform` 是本产品账号/私人空间网关与执行器编排，不应直接视为官方 sandbox billing API 的实现。核查中未发现其实现上述 lease API。尝试通过连接器读取 `alphaXiv/openresearch.sh` 仓库返回 404；尚不能确认实际配套仓库位置、访问权限、实现和已部署服务版本。

升级决策：启用 `openresearch` 新租用实验前，必须取得配套服务实现并完成契约验证；否则在产品入口和服务端明确拒绝该后端的新建实验，保留已有 legacy run 的监督/取消。不要静默回退为旧计费/回收语义。官方远端安装器回退也要核查，避免覆盖已有定制远端 `orx`。

来源：[生命周期文档](https://github.com/alphaXiv/OpenResearch/blob/v0.2.20/docs/experiment-rental-lifecycle.md)、[客户端启动逻辑](https://github.com/alphaXiv/OpenResearch/blob/v0.2.20/src/local/openresearch.rs)、[监督器](https://github.com/alphaXiv/OpenResearch/blob/v0.2.20/src/jobs/rental.rs)。

### 3.2 数据库合并必须保全专家团，优先级 P0

本次新增 `acp_sessions(session_id, launch_json, configuration_json)`、删除会话时的清理 trigger，以及 `chat_sessions.side_parent_leaf_id`。会话创建增加 ACP 状态快照和事务处理；父会话删除改为要求先删除侧边会话。

三方合并在 `src/store.rs` 中实际冲突：

- 模块声明需要同时保留产品 `research` 与新增 `acp`。
- INSERT 列、占位符、参数以及 `CHAT_SESSION_COLS` 和 `row_to_chat_session` 必须一致。产品多出的 `parent_session_id` 不能被上游映射替换；当前产品索引 18–21 为 parent/goal/autonomy/side-parent，合并后需继续对应并加入 leaf 字段。
- 删除会话需要同时保留“活跃研究拒绝删除”的产品检查和新侧边会话约束，统一事务边界。
- 保留产品 `research::migrate`、`migrate_chat_spawns`、`product_migrations` 和专家 `chat_spawns` 数据，不把上游普通聊天语义扩展为专家会话迁移。

`StoredChatSession` 新字段会使产品专有构造器需要补齐，例如 `src/commands/research_dispatch.rs` 的真实创建和测试夹具；新建普通/专家会话通常设置 `side_parent_leaf_id: None`，侧边会话由对应分支逻辑赋值。

本次上游增量以表/字段扩展为主，没有据此发现新的删表迁移；但不能宣称“数据库可无损降级”，因为还存在下述状态、配置与旧版启动清理行为。

### 3.3 侧边聊天持久化与产品专家调度发生同区块冲突，优先级 P0

`src/local/chat/mod.rs` 的冲突把产品专家派发监督代码和旧 `delete_side_chats` 清理函数包在同一块中。整块选 ours 会留下启动清理及已移除的 `Store::side_chat_ids` 调用；整块选 theirs 会丢失专家派发/回报/唤醒实现。

正确处理是保留专家监督，移除旧的“重启统一删除侧边聊天”函数及入口；父会话主动删除仍递归删除侧边会话，且应传播子会话删除失败。同步合并 `side_parent_leaf_id`、首次上下文恢复与缺失父分支提示。

前端 `SideChatViewDef.sessionId` 和后端 `Pane::Side.session_id` 由必填 ID 改为可空草稿；关闭标签与真正删除会话需分离。`src/workspace_state.rs` 还必须保留产品的 research home pane。

特别的回退风险：当前 v0.2.19 产品启动会执行旧侧边聊天清理；新版新建的持久会话若直接交给旧二进制启动可能被删除。回退前应完整保全升级后数据，并在数据库副本上演练，必要时提供禁用该清理的兼容回退构建。

### 3.4 `lost` 是新增终态，案例接口已有确定冲突，优先级 P1

上游 `RunStatus::Lost` 表示租约已结束但无法取得最终结果。它是终态，并触发等待运行的聊天唤醒；不能当作 `done` 或科研证据成功。

本产品 `packages/platform/src/featured-cases.mjs::normalizeRuns` 只允许 `done/failed/cancelled`。直接调用已复现：同一合法文本案例中 `done` 可通过，换成 `lost` 会报“实验仍在执行，不能生成完成项目快照”。影响文本案例/含研究运行的旧数据接口；原生 workspace 快照路径需另行验收，不能把该复现泛化到所有案例入口。

必要调整：允许保存 `lost` 这一真实终态、保留“结果不可取得”说明，并检查 `ui/src/product/{featuredCasesApi,caseSnapshot,FeaturedCases}.tsx/ts` 相关展示和调用。科研交付审核继续验证日志、证据及审批，缺失结果不得自动通过。产品 `src/store/research.rs` 使用公共 `local::is_terminal`，可继承新终态识别，但需测试交付约束，不能重复维护不一致的枚举。

### 3.5 ACP 新 ID 与私人空间网关/案例协议不兼容，优先级 P1

新增 Rust harness 的 `id/name` 从 `&'static str` 改为 `&str`，前端 `HarnessId` 增加 `` `acp:${string}` ``；需要检查借用生命周期和五类 Agent 的固定枚举、标签、图标、设置映射。

纯函数复现的网关结果：

| 请求 | 当前 `security.mjs::permitted` |
| --- | --- |
| `POST /api/harnesses/acp` | 允许 |
| `POST /api/harnesses/acp/test` | 允许 |
| `PUT /api/harnesses/acp/acp%3A<uuid>` | 拒绝 |
| `DELETE /api/harnesses/acp/acp:<uuid>` | 拒绝 |
| `POST /api/chat/sessions/chat_demo/configuration` | 允许 |

原因是全局路径正则不接受 `:` 或 `%`，而 UI 使用 `encodeURIComponent(id)`。这会造成“能创建，不能维护”。应按 ACP 路由精确解析、规范化和验证 `acp:<UUID>`，统一平台 HTTP/WebSocket、runner 路径策略；不能简单全局开放任意转义字符。创建/测试可启动用户指定 executable，也要根据私人空间与管理员配置策略明确授权，避免沿用旧 Agent 设置规则时无意开放机器管理能力。

此外 `normalizeCase` 的 `session.harness` 仍只有五种固定值；使用合法新 ACP ID 的文本案例已复现“请求参数无效”。应支持严格校验的新 ID，案例只传显示/来源信息，不复制可执行配置、认证令牌或把公开案例视为启动授权。

专家调度 `src/commands/research_dispatch.rs` 基于动态 registry 接受 harness，合并后可能自然接受 ACP；但这不代表材料溯源、运行审批和专家回报已验证。建议先开放普通对话；专家模式在完成相同闸门与环境注入测试后再启用 ACP，必要时使用明确能力检查限制该入口。

### 3.6 上下文、材料与权限必须做语义合并，优先级 P0/P1

聊天输入合并新增侧边会话上下文恢复、ACP 恢复/分支逻辑；产品还包含材料集合、`materialId`、历史附件、专家启动上下文和独立审查者隔离。必须同时保留，特别是专家 bootstrap 只传材料引用，不能被侧边聊天全文快照替代。

`src/local/harness/plan_gate.rs` 真实冲突：上游增加 `tensorboard` 只读命令，产品有材料命令的分类。合并应保留双方读分类，并确保材料写入、实验执行和 `research dispatch` 不能整体获得只读豁免。

`ChatHost::resolve_stale_prompts` 从 async 改为同步；所有调用应同步去除 `.await`。`WirePrompt` 新增原生选项，需补齐产品独有构造器。`Harness::id/name` 的动态返回值、`create_project_repo` 新 organization 参数、`CreateSandboxBody`/`BackendDescriptor` 新字段也应搜索所有调用及 struct literal；无文本冲突不代表编译兼容。

### 3.7 路由、资源、设置与权限收紧，优先级 P1

- `App.tsx`、`ProjectsHome.tsx`、`routePages.tsx`、`ChatPanel.tsx`、`WorkspaceTools.tsx`、Markdown/图形组件与产品定制直接冲突。保留统一 workspace header、工作模式/研究入口、共享上传组件、文件夹/ZIP、多尺寸布局、starter fallback 和中性 loading shell，不恢复上游默认全局聊天首页。
- `SettingsPage.tsx` 文本自动合并成功仍需检查产品账号设置、官方更新禁用、GitHub 发布整合和 ACP 设置是否都可达。
- 文件/HTML/图片 URL 应沿用产品 `appHref` 等基路径工具；测试 `/`、`/mobilesci`、嵌套产物和历史附件，避免上游相对资源修复覆盖现有产品路径修复。
- `Store::open` 在 Unix 把已有数据目录权限收紧为 `0700`；submission handle 文件按 `0600` 写入。私人执行器通常由 node 用户独占，符合隔离方向，但备份/原工作台 connector/挂载卷若依赖其他 UID 或组读取会受影响；需核对运行用户，不能通过放宽所有用户权限规避。
- 新租约 capability 存入 backend descriptor，上游 `public_backend` 在 `StoredRun` 序列化、运行响应等处移除 `rentalLease`。检查产品研究包、案例快照、日志和导出，不输出 token；原生 workspace 快照的数据库、恢复文件扫描同样需要覆盖，不能仅依靠一个 serde hook。
- `settings.json` 新增 `acpHarnesses`，旧版 settings 的重新保存会忽略并丢弃未知字段；回退需保全配置副本。

## 4. 弃用与移除清单

官方发布说明未声明统一弃用清单或全局 CLI 参数重命名；本次应区分真实移除、行为替换与仍保留的兼容项：

| 项目 | 结论与行动 |
| --- | --- |
| 启动时删除所有侧边聊天、`delete_side_chats`、`Store::side_chat_ids` | 新版移除；产品残留调用必须移除，不能继续当临时聊天处理 |
| 关闭侧边标签即删除会话 | 被持久化语义替代；删除动作要显式处理 |
| Side pane 必须有 session ID | 扩展为 nullable draft；恢复/序列化/标签 key 同步适配 |
| `resolve_stale_prompts(...).await` | 签名变更，改为同步调用 |
| `create_project_repo(repo)` | Rust 内部签名增加 organization；补齐调用；HTTP GitHub enable 请求保持可选组织参数 |
| 固定五种 harness 的类型/校验 | 扩展为动态 ACP ID；仍保留五种原生 harness |
| 旧租用 descriptor 的本地清理 | 仍保留兼容，仅新建租用实验强制新版服务 |
| Codex `<0.144` exec 与 `ORX_CODEX_EXEC` | v0.2.20 仍存在，不是本次删除项；旧注释“for one release”不能当作已经移除 |
| 历史材料/附件、专家 chat_spawns、旧研究模式只读显示 | 产品仍依赖；本次不能借升级顺手删除 |

## 5. 依赖与构建调整

1. Rust 包版本改为 `0.2.20`，`Cargo.lock` 中本包版本同步；新增 `agent-client-protocol = "2.2"`，目标 lock 固定 `2.2.0`，新增 `tokio-util` 的 `compat` feature。协议 schema lock 为 `1.9.1`，并引入相应异步进程/序列化依赖。
2. 上游 lock 的既有 `serde_json` 从 `1.0.150` 到 `1.0.151`；base64/indexmap/hashbrown 出现额外并存版本，不应误读为替换本产品直接版本。保留产品 `rusqlite` 的 `backup` feature。合并目标 lock 后核对依赖图，不执行无差别 `cargo update`。
3. 此区间 `ui/package.json` 与 `ui/pnpm-lock.yaml` 没有上游变化；不需要为该升级强制升级 React、Vite、Tailwind 或 PDF.js。`ui/tsconfig.json` 有变化且与产品冲突，应合并配置。平台 package 与 lock 也没有上游要求更新；其代码适配是产品协议需要。
4. ACP presets 依赖对应 CLI、必要 adapter/Node 运行时和实际认证。执行器现有 OpenCode 安装不能自动满足这些条件。按需安装、固定验证版本，不把全部 preset 当默认镜像依赖。
5. TensorBoard 命令仅打印查看命令，不启动服务、不下载日志；支持 local/tinker、Slurm、非容器 SSH，其他/临时后端返回不支持。Trackio 需要独立服务和 `TRACKIO_SERVER_URL`、可选 `TRACKIO_PROJECT`、写 token；训练代码需主动用 `ORX_RUN_ID` 命名并记录指标。
6. 重新执行 `pnpm -C ui build`，提交产品生成的 `ui/dist`；不选用官方 bundle 作为冲突解决。打包新的 Rust 二进制、执行器镜像及所需 CJS/agent skill 资源，验证 embedded include 和容器构建上下文。
7. 当前 CI 用 stable Rust，没有声明此次新的统一最低工具链；需实际构建确认新增 crates 的要求，不能推断旧离线工具链仍然可用。Node/pnpm 延用产品现有要求。

## 6. 分步升级方案

### 第一步：冻结候选基线与保全数据

- 完整保存现有产品提交、配置、产品 UI、二进制/镜像版本；当前还有用户已有的未跟踪 `docs/product/compatibility-audit-2026-10-21.md`，不得被升级清理覆盖。
- 建立 `codex/upgrade-v0.2.20` 和升级前备份分支，在隔离工作树执行合并；从官方 URL 取固定 tag，核对完整 SHA。保留上游祖先关系，不只 cherry-pick 版本号。
- 真实切换前确认无活跃研究、派发租约、运行或队列写入；数据库用 SQLite 在线 backup 或停写后完整备份，不能直接复制运行中的主 db 而忽略 WAL。
- 同时备份项目/工作树、材料原件与 manifests、logs、native sessions、settings、synced env、submission handles。数据库与运行目录、凭据一起按相应权限保护。

交付物：产品/上游 SHA 清单、候选分支、可校验备份和当前行为测试基准。

### 第二步：先解决协议门禁

- 明确发布范围：本地/SSH/Slurm 与普通对话可先行；租用后端须完成配套服务审查和部署，否则显式禁用新建；ACP 专家模式延后到闸门验收完成。
- 平台先兼容 `lost` 与 ACP 文本案例来源字段；在私人空间完成 ACP 精确路由校验、CRUD/test/配置的授权策略和 runner 同步。
- 为新增字段采用兼容读取，旧案例、旧 Agent 和旧 descriptor 继续可读。账号服务与 Deep Literature 本次没有已证实必须升级的上游契约；它们仍需联调，不能臆造 PostgreSQL 迁移。

交付物：协议适配与负向测试；若启用租用，包含服务版本、lease API/迁移和远端二进制兼容证据。

### 第三步：合并 Rust 核心与持久化

- 先合并 `Cargo.toml/lock` 和新模块，再处理 `store.rs` 的 research/acp、SQL、索引、迁移与删除约束。
- 分拆解决聊天冲突：保留专家监督与材料上下文，去除重启清理，加入 ACP host/session snapshot、侧边上下文恢复和失效权限处理。
- 搜索并调整所有 struct literal、签名调用、终态判断；补上产品专有构造器和测试夹具的新字段。
- 合并 `run_env`、TensorBoard/Trackio、supervisor/lost 和租约脱敏；保持现有 G2/G3 资源审批绑定，不让重试、恢复和后端切换绕过契约。
- 保留 `src/updates.rs` 的官方更新关闭，以及产品统一账号、OpenAlex/Deep Literature 的客户端边界。

交付物：可编译、核心回归通过的产品后端；数据库副本首次/重复迁移报告。

### 第四步：合并工作台与构建产物

- 先同步 `api.ts`、query/event cache 和 workspace schemas，再合并 ChatPanel、侧边标签/草稿、等待输入、活动实验、lineage 与设置页。
- 保留 research 路由、统一 workspace header、材料多入口共享上传、账号设置、案例和产品主题；九种语言 catalog 同时保留产品与上游 key。
- 将图片/HTML 修复适配到 `/mobilesci` 基路径；检查中文输入法、空响应 fallback、窄屏与折叠侧栏。
- 重建 `ui/dist` 和产品包；将 `product-upstream.json` 更新为目标 tag/SHA/version，`updateChannel` 保持 `product-disabled`。

交付物：源码与嵌入静态资源一致、产品路由和视觉验收通过的候选包。

### 第五步：验证与灰度

按下一节门禁执行，先隔离 slot、再三服务预发布、再少量内部安装。服务器既有 executor/legacy connector 和未来 provisioner 镜像分别更新，避免只发布镜像而遗漏存量容器。记录三服务、客户端、执行器与迁移版本后再扩大分发。

### 第六步：回退演练

停止新版写入后，在副本上验证旧产品读写；重点检查 `lost`、ACP 会话、nullable pane、settings 未知字段及旧版侧边清理。必要时用兼容回退构建，不把“旧二进制能打开数据库”当作数据保全成功。

普通故障先回退匹配的后端/UI/镜像，同时保全新版数据。确需恢复快照时先导出升级后新增记录。已有新 lease 运行必须继续保留能够完成回收的监督进程/服务，不能通过回滚客户端取消其账单/清理责任。

## 7. 验证门禁与验收标准

| 验证层 | 关键场景与通过标准 |
| --- | --- |
| 数据迁移 | 用代表性旧库副本：首次迁移、重复打开、失败回滚；项目/材料/专家派发记录逐表摘要对比，新增表/字段单列；`integrity_check` 为 ok |
| 侧边聊天 | 草稿关闭不落库；首次发送持久化；关闭标签/重启可恢复；父分支变化仍使用创建时上下文；删父先删子，活跃研究仍拒绝删除 |
| 专家团 | pending/starting/admitted/running/waking/done、重试与首消息去重；专家回报与主理人唤醒；独立审查者无作者会话快照；G2/G3 改资源须重批 |
| 材料 | 无材料普通对话、多文件/ZIP/文件夹、路径保全、hash/原件/reading 状态；专家 `orx materials` 按需读取；PDF、错误提取和历史附件均明确呈现 |
| ACP | fixture 验证流式/tool/config、原生 permission 一次回复、取消、崩溃/重启恢复、删除定义后旧会话快照、fork/side；私人网关 CRUD 全通，越权/非法路径被拒绝；专家模式单独验收 |
| Codex/Windows | async question steering 与 held question/permission 分开；中断/过期 prompt 不重复处理；CMD 内建命令；Job Object 退出无孤儿进程 |
| 实验后端 | local、SSH、Slurm 的运行 ID/日志目录；旧 descriptor 可监督/取消；Trackio 预检错误/无 token/失权有明确反馈，token 不在 URL/日志/响应中 |
| 租用后端 | 缺 lease/版本不符明确失败；激活、心跳过期、SSH 断线、休眠、取消竞态、重试不重复启动；最终日志 fsync/确认；回收后未取结果为 lost 并唤醒；服务回收/计费幂等 |
| 案例与导出 | done/lost/ACP 文本案例与 native workspace 均可表达来源；丢失结果不作成功；所有公开导出均无 lease/认证能力；旧案例继续可读 |
| 三服务/布局 | 未登录首页、登录 `/projects`、私人空间、Deep Literature SSO/精读/退出；`/` 与 `/mobilesci`；宽屏、半屏、折叠侧栏；推荐 loading/empty/error 不空白闪旧控件 |
| 发行/回退 | debug/release 的 telemetry 为 development；产品 updater 关闭；对应 OS 构建/安装/升级；旧版启动不误删新版持久侧聊，存量执行器与新建镜像一致 |

先遵循 `.github/workflows/ci.yml` 的原有完整门禁，以下为核心命令入口，不替代平台和 OS jobs：

```sh
node scripts/check-upstream-base.mjs
cargo fmt --all --check
cargo fmt --manifest-path windows/launcher/Cargo.toml --check
cargo clippy --all-targets -- -D warnings
cargo build --locked
cargo test --locked
pnpm -C ui install --frozen-lockfile
pnpm -C ui exec paraglide-js compile --silent --emit-ts-declarations
pnpm -C ui typecheck
pnpm -C ui test
pnpm -C ui lint:styles
pnpm -C ui build
```

CI 还包含 dev-slot/启动脚本、部署 Python、chart/release-note、平台 format/unit/独立 PostgreSQL integration/audit、debug/release telemetry、Windows launcher、Linux desktop/打包测试。保留 `version sanity`、`linked issue` 和 release 的共享 CI 门禁；版本号上调会关联发行触发流程，应在候选分支检查发布目标/签名/来源后再合入主线。

ACP 隔离验收可在先检查 slot 状态、通过 `scripts/dev-slot.mjs` 启动空数据库后使用上游 `python3 scripts/test_acp.py <slot-url>`，其仅接受 localhost:49xx。需要三服务时仍须保持账号服务 `OPENRESEARCH_APP_ORIGIN` 匹配实际前端，不放宽 CORS。

## 8. 本次已验证与尚未验证

已完成：官方 release/固定 tag 内容核对；24 提交源码差异；产品调用与结构交叉检索；临时共享 clone 中的 `git merge-tree --write-tree` 合并预检；当前基线脚本；网关 ACP 路径与案例 done/lost/ACP 的纯函数复现。

未完成且不应视为通过：真正合并后的编译/测试、代表性旧库迁移与降级、配套 lease 服务源码/部署契约、真实租用/账单行为、实际 ACP provider 登录和模型调用、三服务浏览器验收、各操作系统安装包验证。此次只新增本评估文档，没有调整依赖、业务代码、当前版本或运行服务。
