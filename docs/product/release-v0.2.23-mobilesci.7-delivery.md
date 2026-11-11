# MobileSci 多用户稳定版五步交付

当前状态：`.7` 已发行并部署；新用户冷启动发现镜像预建空配置目录被误判为旧凭据，因此五步交付尚未关闭。`.7.1` 只修补该阻塞及数字修补版本的源码归档支持，不增加功能范围。本文将发行、部署与用户流程验收分别记录。

## 1. 冻结候选

`.7` 固定源码 `27c7ef4f1d363272188216e6e3be136f719e0440`，由 PR #28 合入产品分支 `3d62a75b73d0a1f59c0177292ff91d59dc83f483`。其标签和附件保持不可变。

`.7.1` 固定源码 `47571b04bb074703f43764d7387f98c218f2b88b`，见 [PR #29](https://github.com/CMCC-AI/OpenResearch/pull/29) 和[发布说明](../../release-notes/v0.2.23-mobilesci.7.1.md)。仅允许无迁移标记的真实空配置目录首次初始化；非空目录、旧认证、无效标记及符号链接仍拒绝自动接管，配置获取后复核并独占安装。12 项新增回归包含并发旧文件和失败重试，平台共 71 项单测通过。

本轮功能边界保持：多用户私人工作台、每月默认 200 万 Token、管理员逐用户配置、上海自然月账期、凭据隔离、个人设置及既有稳定性修补。官方 .26 仅选择 #922 图片轮播与 #935 过期计划，见[逐项评估](../ai-for-science/upstream-v0.2.26-release-scope.md)。真实上游合并祖先仍为 .19，不表示整版同步至 .26。

## 2. 核心流程验收

同一 `.7.1` 候选的[账户 API 回执](evidence/mobilesci-7.1/candidate-api-smoke.json)证明：注册默认 200 万、客户端不能覆盖角色或额度、普通用户管理接口 403、管理员配置 300 万及幂等、零额度 402、改密后旧会话 401。合成账号全部清理。

[实际 SDK 回执](evidence/mobilesci-7.1/native-sdk-verification.json)使用候选镜像内 OpenCode 与本机断连供应商：供应商仅收到一次请求，账本仅一笔 pending，未知用量保留预占，没有自动重试。只使用合成请求，不连接真实模型，临时记录与容器已清理。

[完整隔离冷启动](evidence/mobilesci-7.1/isolated-cold-start.json)在克隆平台上使用真实 provisioner 的 `reconcile`、新镜像与新卷完成首次初始化、ready、runner 认证桥接、原生健康及项目 API。Docker 操作只允许该临时 UUID，未运行通用调度器处理克隆库内的历史用户；临时账号、容器、卷和私网转发均清理，原四个执行器未动。`GET /api/projects` 按实际契约验证 `{projects: []}`，不把 CLI 的数组输出当作 HTTP 响应。

## 3. 真实数据副本升级与回退

候选目录 `/opt/mobilesci/candidates/release-7-1-47571b04`；备份 `/opt/mobilesci/backups/release-7-1-47571b04`。备份与私有配置不提交仓库，以下只提交脱敏结果。

| 项目 | 同候选证据 |
| --- | --- |
| PostgreSQL | [23 张表已有行和值保持](evidence/mobilesci-7.1/postgres-verification.json)，旧版→候选→旧版→候选，重复迁移幂等；独立库 `mobilesci_release71_47571b04` |
| SQLite | [四份在线备份验证](evidence/mobilesci-7.1/sqlite-verification.json)，升级→旧版→再升级及备份恢复；已有行摘要、完整性与外键检查通过 |
| 材料与研究读取 | 实际有材料的空间验证状态、材料列表、读取和回执定位；其余空间不虚构覆盖。原 HOME 只读挂载，无模型与实验 |
| 原生 CLI | Rust 1.93.1，amd64，`cargo build --release --locked --offline`，构建网络关闭；摘要 `842cd23f89f03221cd1f7cd0ed3947441bd930bc6c1029fc376e371fa29b9764` |
| 平台镜像 | [构建回执](evidence/mobilesci-7.1/platform-build.json)：`sha256:e6b575a7611062979a61c7050e194fb66849e3d7923b432395b3d17e8e43f582` |
| 执行器镜像 | [构建回执](evidence/mobilesci-7.1/executor-build.json)：`sha256:37511fdc1b991750af6bafbf5e1d2d3e475f1f07f49747414b39b60eecf7d287`；CLI `.7.1`、非 root 工具与 development 通道通过 |

## 4. 正式源码发行

`.7` 的 [CI 42986805544](https://github.com/CMCC-AI/OpenResearch/actions/runs/42986805544) 成功，已发布 [Release](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.23-mobilesci.7)；四个附件下载后与干净源码重建逐字节一致。它保留为首次发行记录，不能代替 `.7.1` 的验证。

`.7.1` 的 PR [CI 42997046673](https://github.com/CMCC-AI/OpenResearch/actions/runs/42997046673) 与独立发行 [CI 42999983526](https://github.com/CMCC-AI/OpenResearch/actions/runs/42999983526) 仍待全部成功；正式发布及四附件校验后补齐本节。

## 5. 生产统一交付

`.7` 已统一部署平台、provisioner、四个存量私人执行器及未来镜像引用，已有账号／额度、327 个前端资源、五个实际入口和原生数据库读取通过。备份 `/opt/mobilesci/backups/release-7-cutover-20261111t084644z` 保留。随后首次新用户验收暴露初始化阻塞，故本里程碑仍未完成。

`.7.1` 待正式发行与附件核验后切换。要求精确计划指纹、实时空闲门禁和新备份；同步六个组件、Compose、静态入口与 runtime 版本，失败恢复容器和配置，不覆盖研究数据库。本地切换模拟覆盖成功、七类阶段故障回滚、科研繁忙、未发布与过期指纹拒绝。必须在生产重复新用户供给和认证桥接，清理所有临时资源后才关闭里程碑。

## 完成标准与下一版

M7 定义为“多用户稳定版可用且可追踪交付”。五步均须有同一候选的证据，生产新用户必须可首次进入科研空间；仅有已发布标签或存量用户可访问不足以关闭。

交付包括不可变源码 Release、校验清单及元数据、对应平台／执行器镜像、数据副本与核心流程验收、生产部署回执、备份和回滚依据、准确的版本台账及分支清理记录。

PR #17 继续草稿；ACP、全后端追溯、完整环境封存、指标与跨 Run 比较、桌面签名包不阻塞本轮。额度仍采用保守预占，未知用量需核对；自带 Key／订阅不宣称已计量，历史供应商凭据轮换须先确认共享范围。下一版按现有用户问题、复现依据、最小改动与维护成本独立立项。
