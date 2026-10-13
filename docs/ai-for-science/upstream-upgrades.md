# 官方版本同步与产品升级方案

## 当前基线

本产品源码已合并官方 [OpenResearch v0.2.18](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.18)，固定提交为 `0d3d376dae7ba22373d34fd9e9090b5a88efc148`。`product-upstream.json` 记录该基线，`scripts/check-upstream-base.mjs` 在 CI 中核对 Cargo 版本、提交祖先关系和更新通道状态。

产品仍由三部分组成：本地 `orx`（内嵌 `ui/dist`）、独立账号服务、Deep Literature。官方升级只提供第一部分的上游源码；统一登录、产品页面、文献服务、部署配置与跨系统数据契约仍由本项目维护。不能把官方安装包覆盖在产品安装目录上。

## 2026-10-13 升级记录

从官方 v0.2.17 升级到 v0.2.18；升级前产品提交为 `4ccb0f3`，备份分支为 `codex/backup-before-v0.2.18`。在独立工作树合并官方 release tag，保留完整上游提交祖先关系。

- 同步上游图表与 HTML 图形预览、图片缩放、运行日志事件、执行器和 Agent 适配改进；合并后重新构建产品 `ui/dist`。
- 保留 SONA 蓝色主题、统一导航、新建项目和新对话、工作模式选择、专家团 DAG 与审批、账号服务及 DeepXiv 对接；官方更新通道仍为 `product-disabled`。
- 研究停止接口适配新的 `Store::request_cancel`，记录 `dashboard:research-stop` 原因，避免调用已移除的方法；CI 同时保留产品启动检查与上游图表检查。
- SQLite 新增 `runs.cancel_reason`。使用运行中数据库的备份副本验证迁移，完整性检查通过；项目、会话、消息及专家团研究记录逐表内容摘要保持一致。

验证：UI 268 项测试、Rust 1,094 项单元测试和 18 项集成测试通过（3 项上游单元测试忽略）；Clippy、Rust/Windows launcher 格式、UI 样式与构建、基线检查通过。启动脚本 16 项、图表 Python 4 项、发行说明 Python 6 项、账号平台单元与 16 项独立 PostgreSQL 集成测试、DeepXiv 14 项 SSO/Cookie 测试通过，平台依赖审计无漏洞。

通过 `scripts/dev-slot.mjs` 使用空数据库启动隔离实例，验证介绍页可访问；账号平台生产 CORS 不允许该隔离端口，因此未以生产账号登录隔离实例。账号与文献服务通过独立测试验收，不替换其运行服务或改动生产认证配置。本次为本机源码升级，不代表 Windows、Linux 桌面、签名发行包或远端执行器镜像已经重新发布；这些环境仍需单独构建验收。

回滚代码基准为 `4ccb0f3`；数据库仅作向前兼容的字段扩展，回滚时先恢复匹配的二进制及 UI，不直接覆盖已有数据库。升级前本机数据库备份保存在忽略目录 `.sona-run/backups/`。

## 2026-10-09 升级记录

从官方 v0.2.9 升级到 v0.2.17；升级前产品提交为 `aa9aa36`，本地备份分支为 `codex/backup-before-v0.2.17`。本次合并包括原生桌面窗口、PDF 预览、Agent 协议与使用量、SSH 执行恢复、日志完整性和韩日语支持。

产品兼容处理：

- 保留 AI for Science 首页、新建项目及论文参数、统一账号、私人服务器空间和 Deep Literature 公开接口；产品项目首页继续使用研究入口，不改为上游的全局会话自动恢复页。
- 保留 OpenAlex 服务端密钥、请求超时和页大小限制，并采用上游的公共请求重试机制。文献服务使用上游统一 HTTP 客户端入口，回环请求绕过代理。
- 适配更新状态新增的 release tag 字段，保持 `product-disabled`；自动重启集成测试验证官方更新记录不能替换产品后端。
- 服务器网关拒绝新增的 Git 安装管理接口；执行器构建上下文包含新的 Linux 桌面资源。开发脚本在已登记的 main 工作树目录缺失时使用当前检出的启动注册文件。

本机验证：Rust 1,055 项单元测试和 18 项 CLI 集成测试通过，3 项单元测试按上游设置忽略；Clippy、Rust 和 Windows launcher 格式检查通过。UI 219 项测试、启动脚本 12 项测试、平台 9 项单元测试和独立 PostgreSQL 的 16 项集成测试通过；平台生产依赖审计无漏洞。UI 类型检查、国际化和样式检查、完整构建与重复打包一致性检查通过，`ui/dist` 已重新生成。macOS 调试和 release 构建的 telemetry channel 均为 development。

通过 `scripts/dev-slot.mjs --db empty` 启动隔离实例，确认介绍页以及文献连接、分页、单字搜索、隐私字段和输入边界。临时开发实例与测试数据库在验收后清理；没有迁移现有研究数据、调用付费模型或替换运行中的账号/文献服务。Linux ARM64 执行器的 Rust release 阶段构建通过；将新版二进制与平台源码叠加到现有 hosted 基础镜像后，版本、健康接口、空数据库和产品更新策略验收通过。完整执行器从 Node 基础镜像重新构建时，Debian 包下载两次返回 HTTP 500，尚未完成全新运行镜像验收。Windows 安装包、Linux 桌面 AppImage、签名发行与真实升级回滚仍需对应环境验收。

## 当前发行策略

定制构建暂不提供自动安装更新：`src/updates.rs` 关闭官方更新发现和后台安装，`orx update` 明确拒绝把产品版本替换为官方安装包，设置页显示由产品发行包更新。源码构建仍可通过 `scripts/start-local.mjs` 重建。关闭官方更新是过渡保护，不代表已经具备自己的自动更新服务。

发布自己的安装包之前，需完成以下工作：

1. 独立的产品版本号和发布源。推荐区分“上游基线 v0.2.18”和“产品发行号”；不能仅用上游版本判断产品构建的新旧。
2. 自有 CI 构建 macOS/Windows/Linux 包，生成带平台、架构、SHA-256、产品版本、上游基线和最低兼容协议版本的更新清单。
3. 使用自己的签名与校验策略；macOS App 更新代码目前校验官方 Apple Team ID，启用自有自动更新前必须替换并验证完整签名链。
4. 确认安装路径、升级锁、原子替换、失败回滚、重启恢复和发布灰度。账号服务与 Deep Literature 分别版本化，不随本地客户端二进制无条件替换。

这些条件完成并经过实际安装包升级与回滚演练后，才可启用产品自动更新通道。`OFFICIAL_UPDATE_CHANNEL_ENABLED` 不得直接改为 `true` 来发布产品：那会恢复官方更新源。

## 每次同步官方版本

1. 在干净分支记录当前产品提交、数据库备份与目标官方 tag 的完整 SHA；只从 `https://github.com/alphaXiv/OpenResearch` 获取明确的 release tag，不跟随浮动的 `main`。
2. 比较从上一上游基线到目标 tag 的改动，重点审查 `src/commands/up.rs`、`src/config.rs`、`src/updates.rs`、`ui/src`、SQLite schema、Agent 适配、消息协议和 `Cargo.lock`。
3. 合并上游提交，保留产品路由、统一登录、Deep Literature API 和配置边界。不要复制官方预编译 `ui/dist` 作为最终产物；合并源码后运行 `pnpm -C ui build`，把新的 `ui/dist` 与 Rust 构建一起交付。
4. 更新 `product-upstream.json`，并运行 `node scripts/check-upstream-base.mjs`、`cargo fmt --all --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --locked`、UI 类型检查/测试/构建和平台测试。
5. 在隔离的三服务环境验证：未登录介绍页、登录后 `/projects`、Deep Literature 同步登录、论文精读直达、退出登录、项目/实验/Agent、旧数据迁移和已有安装升级。Deep Literature 仓库的 SSO 测试也必须通过。
6. 先发布候选包到内部测试，记录三个服务版本与数据库迁移版本；通过安装、升级、回滚演练后，再分批发布产品包。

本仓库 CI 已自动执行上游基线校验和现有单仓库测试。三服务浏览器验收、Deep Literature 仓库测试以及真实安装包升级仍是发布门禁，尚未被单仓库 CI 自动覆盖。

## 兼容和回滚

- 本地项目、SQLite、Git 工作树、Agent 凭据及日志仍由本地 `orx` 管理。更新前备份这些数据；升级后用已有项目执行读取、写入和运行检查。
- 账号服务和 Deep Literature 的 PostgreSQL 迁移应向前兼容一个客户端发布周期。需要破坏性迁移时，先做兼容字段/双读写，再切换客户端，最后清理旧字段。
- 发现问题时，先停止分发新客户端并回退产品二进制及静态资源；数据库不能盲目回退文件，按迁移说明和备份恢复演练执行。
- 任何官方上游更新只在产品分支通过上述门禁后进入产品发行版；终端用户只接收产品发行通道的更新。
