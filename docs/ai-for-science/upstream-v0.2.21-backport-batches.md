# v0.2.21 产品回移批次

更新日期：2026-10-25。依据[逐项评估](upstream-v0.2.21-gap-2026-10-23.md)分批实施，保留 OpenCode 服务器、材料合同、研究审批、私人空间及既有性能修复。官方固定目标为 `5af82bb531a731698afc6e8e46f3e5157e20210b`，第一批基线为 `ca0fdf0`。

## 当前产品版本

产品版本更新为 **0.2.21-mobilesci.1**，Cargo.toml/Cargo.lock 同步；本机 CLI 已输出该版本。UI 的内部 npm 包版本不作为产品发行版本，本批未改 UI 源码或 ui/dist。

`product-upstream.json` 中 version/tag/commit 继续记录真实的 v0.2.19 祖先，新增 productVersion 与 backportTarget.status=partial。未合并完整 v0.2.21，不移动官方 tag，也不将本地基线伪装成目标 tag。官方更新通道继续禁用。

基线检查同时校验产品版本和上游祖先；新增 Node 回归并接入既有 CI 检查，覆盖旧元数据、产品预发布版本、版本不匹配、错误 tag/SHA 和将 partial 冒称完整版本。未来完整整合上游时需另行更新元数据和规则。

## 第一批：Stop/持久准入隔离及 #670 零隐式生成

### Stop 最初的持久化

- Active/Reserved/Draining 只在 turns 锁内完成内存状态交接，Reserved 不再在该锁内打开 Store 写 interrupted。
- 捕获 turn/message ID 后立刻创建独立 settlement 任务；首次 Store 打开、interrupted 更新、消息读取、完成标记、重试卡清理及压缩状态整理，整体移入现有 8 并发 blocking 执行池。之后才中止活动 handle，再按既有原生停止、用量和租约清理顺序继续。
- 等待者取消不取消该独立任务；Cancelling 期间不放行新 turn。消息快照与问题答案读改写共用 msg_write 锁，保留已保存答案及 native session 元数据；跨会话消息不改写。没有 durable 工作时不打开 Store。
- 首次存储失败仍沿用 best effort，随后中止活动任务并继续收尾；没有新增磁盘故障下的自动重试或事务保证。

### 持久准入事务

- `admit_chat_turn` 移入后台池，复用 setup 已打开的连接；不持有全局 turns 锁执行准入 SQL。
- cleanup 锁串行准入和 Stop，worker 拥有 cleanup guard 与 TurnGuard。即使等待者取消，仍由正在执行的 worker 持有占位直到 SQL 完成。
- 每个 Reserved 有唯一 reservation_id。准入返回后、旧 guard 释放及恢复启动均核对该标识，旧请求不能释放或启动替代占位；Existing/Conflict 保留原有幂等语义。
- 取消等待后若 SQL 已插入、却没有启动任务，guard 的独立清理会用原连接尝试将该 turn 标为 interrupted，再释放原占位；这项写入也沿用 best effort，存储故障时没有新增自动重试保证。重复请求的 pending 结果在 durable admission 成功后发布。
- TurnGuard 保存的连接使用 Box，避免放大 TurnAdmission 枚举；正常启动时 guard defuse，保留 active 槽位。释放没有 durable token 的占位不再多开一次 Store。

第一批并非整个启动路径已异步化。后续 setup 的初始 Store 打开与前置读取已由[发送入口治理](performance-submission-setup-2026-10-25.md)隔离；上下文准备、准入后的会话 touch/读取、启动用量注册、部分租约 claim/release，以及用户 Stop 历史标记继续分批处理。

### #670 第一阶段

来源：[官方 #670](https://github.com/alphaXiv/OpenResearch/pull/670)，`f1b6c2d8f0c503519115a352c8fc64f4459caa83`。

- 移除 OpenCode detect 中对 provider 首个目录模型的生成式 key probe、verdict 缓存及对应无用代码。目录不再为验证 key 发起文本生成；实际认证错误交给用户发起的请求报告。管理员配置 provider 识别与现有可用性判断保留。
- 回移取消 AI 技能筛选：发现的原生技能保留 harness 归属、显式 excluded 与上传覆盖规则，不再调用模型分类；旧 imports.json 不再控制列表，也不删除该历史文件。保留 refresh_imports=false 的兼容函数，使现有 catalog 客户端仍收到 importing=false。
- 同步官方的发现/排除/归属测试；本地已存在的 claude-code fixture 修正保留，不重复应用旧上下文。

第一批完成时 #670 尚未完整覆盖；后续常驻模型和压缩见第二批 A，one-shot 与 starter 见第二批 B。不能把第一批的验证结果当作后续实现的证据。

## 验证与边界

新增 Rust 回归覆盖：慢准入时计时器和 turns 锁可前进、取消等待后完成写入及 interrupted 清理、幂等冲突、替代槽位保留、Stop 慢存储、旧检查点拒绝、native 元数据和问题答案保留、无消息 Reserved 停止及打开失败显式重试。已有原生技能发现测试也随全量回归执行。

最终候选通过 `cargo fmt --all --check`、`cargo clippy --locked --all-targets -- -D warnings`、`git diff --check` 和上游基线检查；完整 `cargo test --locked` 退出 0，1232 项单元测试、18 项集成测试通过，11 项专用测试默认忽略，本批未复跑这些忽略项。版本/启动 Node 测试为 22 项通过；初次 dev-slot 端口检查被默认沙箱拒绝，授予本地端口权限后完整重跑通过。第一次测试编译与 Clippy 的夹具 Debug/枚举体积问题已处理，不能引用修正前日志作为最终候选证据。

日志与候选哈希保存在忽略目录 `.mobilesci-run/backport-v0.2.21/batch-1/`。`full-tests-before-prompt-lock.log` 属补强消息锁前的候选，最终以 `full-tests-final.log` 为准。不提交测试数据库或模型日志。

本批未发起真实模型请求、未运行实验、未重启既有实例或部署服务器。没有新增吞吐或端到端性能百分比测量，不代表完整跨平台 CI 或生产故障验收。

## 第二批 A：常驻模型与原生压缩一致性

来源仍为官方 #670（`f1b6c2d8f0c503519115a352c8fc64f4459caa83`），前一批已推送提交为 `74b1320`。

- 常驻进程采用非空会话模型优先、`orx up --model` 兜底的规则，云端模型不再被仅限 `orx-local-` 的过滤丢弃；模型改变会触发现有子进程替换逻辑。
- 常驻启动时为 V1 的 small_model、title/compaction agent，以及 V2 的 agents.title/compaction 写入所选模型；保留原有 provider、权限、主模型及 agent 其他字段。格式错误的配置显式报错。
- 启动、复用和原生压缩前读取 OpenCode 生效的 agent 配置，发现标题或压缩模型不一致时最多等待 30 秒后报错；启动验证失败会停止该新子进程。辅助 agent 缺席允许通过，空列表继续等待。复用验证期间释放 inner 锁，状态读取不等待这次网络检查。
- 压缩采用所选模型，未选择时允许沿用存活进程的模型；缺少有效 provider/model 或模型已切换时走既有摘要回退，避免用旧进程执行新模型的原生压缩。V2 改用 model/compact API 并轮询完成或失败，最长等待 120 秒，替代原来的 summarize 路径。

本子批只覆盖常驻进程。独立 one-shot 的显式选择、辅助配置生效核查及 starter 预热模型贯通仍待第二批 B；为保持当前 one-shot 行为，暂保留 merge_config 中本地模型的 small_model 兼容设置。未覆盖的路径不能视为已满足“全部生成均使用所选模型”。产品版本仍为 `0.2.21-mobilesci.1`，回移状态保持 partial，没有再次触发版本发行。

新增回归覆盖云端/本地选择优先级、常驻云端进程复用、切换模型后不发送原生压缩请求、沿用常驻模型压缩、V1/V2 生效配置拒绝及禁用 agent、V2 压缩完成/失败，以及辅助配置合并保留和格式错误。

本子批通过 fmt、Clippy all-targets/-D warnings、diff 检查及上游基线检查；完整 Rust 回归为 1238 项单元、18 项集成通过，11 项专用测试默认忽略。首次定向测试受沙箱回环监听限制失败，最终完整回归在获得本地端口权限后通过，日志见忽略目录 `.mobilesci-run/backport-v0.2.21/batch-2a/`。未改 UI、未调用真实模型、未重启既有实例或部署服务器；本批未测量端到端延迟，配置不一致时的等待上限属于已知行为。

## 第二批 B：one-shot 与 starter 选择贯通

更新日期：2026-10-25。以 `c021e0a` 为基线，继续选择性回移官方 #670，保留产品论文入口、材料上传、静态 starter 和中性加载界面。

- OpenCode one-shot 在解析二进制前拒绝缺失或空白模型；标题生成保留所选云端/本地模型，未选择时保留已有首行标题。V2 还在启动前校验 provider/model 结构，并将选择写入生成请求和辅助 agent 配置，核查实际生效模型后才生成。
- V1 显式传 `--model`，对同一环境先执行 `debug config --pure`，核查 small_model 和未禁用的 title/compaction。输出使用独占创建的私有文件捕获，Unix 权限为 0600；文件创建、读取和 JSON 解析在现有 8 并发后台池中执行，配置子进程使用既有检测并发限制。保留独立生成任务持有原生数据库 lease 至退出的行为。该验证增加一次配置子进程，不宣称减少独立生成延迟。
- 产品 `ProjectsHome → NewProjectDialog → NewProjectForm` 传递当前偏好；创建及防抖预热请求同时携带 starterAgent，自定义 provider 和显式 model=null 不会被旧偏好覆盖。增加可选请求字段，保留旧客户端兼容与 importing=false 的技能目录兼容响应。
- 无 OpenCode 模型且没有成功缓存时返回静态卡片，不记录失败缓存；已成功的同内容/语言推荐可以跨模型复用。旧客户端未传选择且服务端没有保存偏好时，检测兜底不再自动取 OpenCode 目录首个模型生成。
- 无模型且没有可用常驻进程时，压缩在创建进度消息前拒绝；摘要回退也先检查模型，保留原有消息、原生 ID、bootstrap、归档及上下文用量。

#670 的产品相关模型调用治理至此已完成源码回移，验证结论见下方记录；这不表示完整 v0.2.21 已整合，也不替代真实模型、跨平台或服务器验收。版本仍为 `0.2.21-mobilesci.1`，上游基线仍为 v0.2.19，整体回移保持 partial。

验证：完整 Rust 回归 1248 项单元、18 项集成通过，11 项专用测试默认忽略；UI 测试 415 项通过。fmt、最终 Clippy all-targets/-D warnings、diff、上游基线和 2 项产品版本测试通过；`pnpm build`（含类型检查）、样式检查及入口预算通过，ui/dist 已重建，入口为 2,947,856 raw / 900,069 gzip bytes。新增回归覆盖无模型零生成、V1 模型/辅助配置传递、V2 非法模型启动前拒绝、目录只读探测、无模型压缩历史保持、starter 静态回退/成功缓存复用、选择改变时替换防抖预热及产品入口传参。最初测试编译遇到上游夹具返回类型与本地 trait 的生命周期差异，已适配后完整回归通过，首次编译日志不是最终证据。

日志与源码/产物哈希在忽略目录 `.mobilesci-run/backport-v0.2.21/batch-2b/`。没有发起真实模型请求或实验，未部署服务器、未重启当前开发槽后端；运行中的 Rust 后端需后续安全重启才能加载本批代码。保留现有构建的大 chunk、CSS highlight 与 capability-card-pattern.svg 提示，不将其计为本批消除项。

## 统一治理顺序

本节把上游回移与此前技术债合并排序，避免把“#670 → #752 → 删除/回收”误读为全部技术债计划。

1. 完成本批 #670 源码回移与自动化验证。
2. 回到 TD-05：初始 Store 打开、会话/clientTurnId 读取见[发送入口治理](performance-submission-setup-2026-10-25.md)；上下文、技能工作树与准入后 touch/读取见[连续治理](performance-turn-context-2026-10-25.md)；用量注册与首次 running 写入见[启动用量治理](performance-launch-usage-2026-10-25.md)；普通发送设置/附件隔离及忙队列事务合并见[元数据治理](performance-send-metadata-2026-10-25.md)。忙队列异步隔离、其他队列入口、其余租约及 Stop 历史标记继续排期。保留有界池、取消后 worker 所有权、状态归属与消息顺序，不整体重写聊天模块。
3. 回移 #752 的 OpenCode 问答协议、once 权限及停止后失效保护；统一界面可后置。
4. 将 #689/#690/#753 与现有删除恢复保护整合，再治理 #691/#751/#755 的磁盘生命周期；先做引用核查、活进程保护和统计，再启用回收。
5. 按实际耗时和磁盘占用继续安排其余性能工作。写入失败重试与聊天 ENOSPC 恢复仍是贯穿项；若出现消息丢失或卡死证据，提升到当前批次优先处理。

TD-04/07 等剩余边界、DTO/模块治理和依赖维护仍以[既有技术债计划](technical-debt-next-steps-2026-10-22.md)及其后续状态为准，不因本批关闭。服务器部署和功能扩展继续暂缓。

## 后续批次

| 批次 | 范围 | 当前状态 |
| --- | --- | --- |
| 2 | #670 所选模型、辅助模型、starter 与压缩一致性；保留有界写入和取消边界 | A/B 源码已实施，真实模型及服务器验收不计入本批 |
| 3 | #752 OpenCode V1/V2 问答、once 权限、跳过及失效卡片；统一界面可后置 | 待实施 |
| 4 | #690/#689/#753 删除顺序与原生历史，保留产品 recovery、研究及材料保护 | 待实施 |
| 5 | #691/#751 运行/快照回收与进程组保护，#755 legacy 附件引用治理 | 待实施 |
| 6 | #672/#694/#732/#762 小型修复；#743 须先有空间证据及保留策略 | 待实施 |

#733 已有产品等效方案；#728/#754/#756 暂缓，#764 官方版本和产物不直接回移。所有批次保持真实上游元数据与 product-disabled；服务器恢复部署另行安排。
