# MobileSci 版本发布

## 版本总览（2026-11-17）

- **当前生产服务器运行与最新不可变源码发行**：[v0.2.24-mobilesci.1](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.24-mobilesci.1)（固定提交 `bcb90af4fd3dd3250d52f23b94dcbb12d87f8bbb`，`release/mobilesci-0.2.24-mobilesci.1` 完整发行 [CI 44041868978](https://github.com/CMCC-AI/OpenResearch/actions/runs/44041868978) 全绿通过，发布于 `2026-11-17T08:08:48Z`；四附件已核验逐字节一致，发布说明见 [`release-notes/v0.2.24-mobilesci.1.md`](../../release-notes/v0.2.24-mobilesci.1.md)）。**已于 2026-11-17 完成 `10.7.0.18` Gate 1.3 受控生产切换，完整交付与验证见[`.24-mobilesci.1` 交付记录](release-v0.2.24-mobilesci.1-delivery.md)**。
- **上一代生产归档基线**：[v0.2.23-mobilesci.7.1](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.23-mobilesci.7.1)（固定提交 `47571b04bb074703f43764d7387f98c218f2b88b`，自身完整发行 [CI 42999983526](https://github.com/CMCC-AI/OpenResearch/actions/runs/42999983526) 成功，见[发行回执](evidence/mobilesci-7.1/release-gate.json)）。`.6`、`.7`、`.7.1` 与 `.24-mobilesci.1` 标签及附件保持不可变。

真实上游合并祖先仍为 `v0.2.19`（`1d8a285468aed5d5a1f1ea86ecf6e2f63fcaa8bd`）；[.23](../ai-for-science/upstream-v0.2.23-backports.md)、[.24](../ai-for-science/upstream-v0.2.24-backports.md)、[.25](../ai-for-science/upstream-v0.2.25-review-2026-11-09.md)、[.26](../ai-for-science/upstream-v0.2.26-release-scope.md)均按具体需求选择评估或适配，不表示整版同步。`product-upstream.json` 的 `backportTarget` 已推进至 `v0.2.24`（`status: "partial"`），官方自动更新保持禁用（`product-disabled`）。下一阶段规划与技术债边界见[下一阶段计划](next-cycle-plan.md)。

## `0.2.24-mobilesci.1` 锁定范围与在研收敛

1. **版本锁定边界**：不等待高风险重型重构（如 `#862 orx-host`、`#885`、`#886`、`#891`、`#938 ACP`），在 `.7.1` 之后收敛高确定性的功能增量与稳定性加固；`8d59f3e8` 锁定 `Cargo.toml`、`Cargo.lock`、`product-upstream.json` 与发布说明。
2. **核心新增与修复（`47571b04..edb38792`）**：
   - 管理员大模型接入重构为“供应商连接 + 模型开关 + 在线探测”模式，支持空模型清单首连供应商、同源私人空间 `shared-origin` 静态托管与 SHA-256 CSP（`d4a449d9`、`473c8671`、`4f271b47`、`9fc673d6`）。
   - 精选案例按主对话公开成果、64 MiB 快照与 `\u0000` 清洗、128 MiB 慢速下载逐块流控、工作区 `tasks` 字段兼容及只读 `/file` 回退产物预览；执行器 `/opt/opencode-npm-cache` 离线预热与超时调整（`352f3e47`～`8ad6954a`）。
   - 存储/会话/锁稳定性加固：`#985` WAL 初始化、`#952` 活跃租约保护、`#981` 排空抢占收敛、`#990` + `SourceFile`/`FileLock` 显式解锁、`#962` 代理 `ORX_DATA_DIR` 统一与只读/管道退出、`#923` 原子 `0700` 目录、`#730` 源码归档 LF、`#786` 百分号路径解码、`#734` 跳过无关云端占位仓库（`45d5c6aa`、`19f75bcc`、`68f41ff7`、`96133c90`）。
   - 安全、局部模块化与本地调试：`#909` 外链 Markdown 图片转链接、`#747` OpenAlex 配置、`#903` Claude 插件清单技能目录、`chat`/`store`/`up` 模块化拆出，以及 `scripts/hosted-local.mjs`（含 `--with-quotas` 与 `apt-get` 重试，`21dced48`、`68f41ff7`、`c89fdda4`、`edb38792`）。
3. **已通过发行与生产交付门禁（`bcb90af4`）**：
   - `bcb90af4` 已补充 `quinn-udp 0.5.16`（修复 `RUSTSEC-2026-0538`）、Windows 测试条件导入、`checkpoint_tests` 显式释放异步句柄及同步新版供应商/开关 UI 的 Playwright 额度管理验收，[CI 44041868978](https://github.com/CMCC-AI/OpenResearch/actions/runs/44041868978) 全部 13 项检查及 `publish` 通过并生成不可变 Release [v0.2.24-mobilesci.1](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.24-mobilesci.1)。
   - **Gate 1.3 生产切换已完成**：`10.7.0.18` 已完成离线编译/镜像构建、58 项隔离 PG 集成校验、PostgreSQL 与 5 份私人 SQLite 备份、全组件统一切换及公网/管理员接口/OpenCode 离线缓存验收，详见[`.24-mobilesci.1` 交付记录](release-v0.2.24-mobilesci.1-delivery.md)。

## `.7.1` 生产稳定版交付（2026-11-11）

2026-11-11 已完成 M7 多用户稳定版的五步交付：候选冻结、核心流程、真实数据副本升级回退、独立源码发行及生产统一切换。平台、provisioner、四个存量私人执行器和未来镜像引用已对齐 `.7.1`，实际生产新用户冷启动及认证桥接通过，原研究数据与既有额度保留。完整证据见[交付记录](release-v0.2.23-mobilesci.7-delivery.md)；[原发布计划](release-v0.2.23-mobilesci.7-plan.md)保留历史范围与完成节点。源码及生产交付不等于签名桌面安装包已就绪。

## 源码版本

`MobileSci source release` 工作流从 `release/mobilesci-<版本>` 分支的固定提交发布。版本须与 Cargo.toml、Cargo.lock、product-upstream.json 一致，并有同名发布说明。

流程依次为：候选校验 → 调用完整 CI → 生成源码归档及校验清单 → 创建 Git 标签 → 发布 GitHub Release。三系统同提交归档摘要必须一致，发布 job 重新生成的校验清单也须与 CI 保存的清单一致。CI 或发布摘要比对失败时不创建新标签或 Release；修正发布候选后须重新通过 CI。已存在的标签不得移到其他提交。

附件包括源码 tar.gz、zip、SHA256SUMS 和 source-release.json，后者记录产品版本、标签及完整提交 SHA。源码归档直接取自该提交，构建要求干净工作区，并拒绝覆盖已有输出文件。发布任务仅在 CI 成功后获得当前仓库的 contents:write 权限。

这是源码发行路径。它不调用安装包签名流程，不更新产品的官方升级通道，不执行生产部署。部署仍遵循 [运行与部署约定](runtime-and-deployment.md) 中的备份、固定镜像、升级与恢复验收。既有多平台安装包发行流程保留独立门禁。

## `.5` 历史集成范围（已完成）

- 工作区恢复、材料读取范围界面和只读案例快照，旧未知记录不补造，窄屏结果可滚动查看。
- 历史归档保留、操作员显式受保护回收及有界续页；总配额和材料/Run 删除不在本批范围。
- 科学指标文件的 Run/代码/数据身份检查基础；持久证据、运行时使用证明和图表后续实施。
- 环境/遥测测试子进程隔离、官方原生测试夹具及 .24 工作区适配。
- 保留三系统源码摘要一致性与 ARM 原生门禁，纯归档任务改用 macOS Intel。

五个原候选及依赖已由 PR #12 统一验证合入并发行 `.5`，随后纳入 `.6`，详见[历史集成证据](../ai-for-science/followup-integration-2026-11-07.md)。该节只记录当时范围，不再是待合入列表；当前后续安排以收尾里程碑为准。

## `.4` 历史发布状态（2026-11-06）

[`.4` 源码](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.23-mobilesci.4) 已发布，固定提交 `d959cf82`，[发行 CI 42205071962](https://github.com/CMCC-AI/OpenResearch/actions/runs/42205071962) 成功；四个实际附件摘要、清单和本地字节重现性已核验。本版服务器隔离构建与备份恢复也已独立通过，尚未切换生产，详见[执行台账](../ai-for-science/followup-execution-2026-11-06.md)。
