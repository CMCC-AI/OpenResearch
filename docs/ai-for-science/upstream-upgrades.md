# 官方版本同步与产品升级方案

## 当前基线

本产品源码已合并官方 [OpenResearch v0.2.9](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.9)，固定提交为 `678f47798231de3db6afe3dc19e3ed128b6799a0`。`product-upstream.json` 记录该基线，`scripts/check-upstream-base.mjs` 在 CI 中核对 Cargo 版本、提交祖先关系和更新通道状态。

产品仍由三部分组成：本地 `orx`（内嵌 `ui/dist`）、独立账号服务、Deep Literature。官方升级只提供第一部分的上游源码；统一登录、产品页面、文献服务、部署配置与跨系统数据契约仍由本项目维护。不能把官方安装包覆盖在产品安装目录上。

## 当前发行策略

定制构建暂不提供自动安装更新：`src/updates.rs` 关闭官方更新发现和后台安装，`orx update` 明确拒绝把产品版本替换为官方安装包，设置页显示由产品发行包更新。源码构建仍可通过 `scripts/start-local.mjs` 重建。关闭官方更新是过渡保护，不代表已经具备自己的自动更新服务。

发布自己的安装包之前，需完成以下工作：

1. 独立的产品版本号和发布源。推荐区分“上游基线 v0.2.9”和“产品发行号”；不能仅用上游版本判断产品构建的新旧。
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
