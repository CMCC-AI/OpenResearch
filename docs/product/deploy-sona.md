# SONA 一键部署：公网 IP / Nginx 20281

入口为仓库根目录 `deploy-sona.command`。SSH 目标固定为 `ubuntu@61.136.101.179:20280`，部署后浏览器访问 **http://61.136.101.179:20281**，无需 SSH 隧道。已确认同步本地 OpenCode 配置及模型登录凭据，并明确授权该公网 HTTP 入口；其他部署继续默认要求 HTTPS。

## 一键执行

本地需要 Python 3、Git、pnpm、当前 OpenCode、运行中的 Docker Desktop/Buildx，以及相邻的 `DeepLiterature` 源码仓库。默认构建 Linux amd64；若目标为 ARM64，使用 `--arch arm64`。目标需要 Ubuntu、systemd、Python 3 和 `ubuntu` 的免密码 sudo 权限，并在云侧安全组/网络防火墙放通 TCP 20281。脚本不修改云控制台或整体防火墙策略。

切热点并能够 SSH 到服务器后，在仓库根目录执行：

```bash
./deploy-sona.command
```

入口脚本默认同步已授权的模型凭据，不再询问。第一次 OpenSSH 主机密钥确认仍由正常 SSH 流程处理，不关闭主机密钥检查。首次构建 Linux release 镜像耗时较长，Apple Silicon 构建 amd64 使用模拟，建议 Docker 至少 6 GB 内存、本地预留约 30 GB 磁盘。

流程：构建 SONA 前端 → 构建 Linux 应用镜像与依赖 → 打包 OpenCode 配置、Docker 工具和校验清单 → SCP 上传 → 服务器安装 Docker → 数据库迁移 → 启动应用 → 创建研究管理员 → 启动 Nginx → 校验入口及未登录访问保护 → 设置开机恢复。

不传凭据时使用：

```bash
./deploy-sona.command --without-auth --opencode-config-dir /path/to/sanitized-opencode
```

脱敏目录必须包括 OpenCode 配置和 `package.json`、`package-lock.json`。直接执行 Python 工具且未传授权参数时，仍保留凭据传输确认。

## 两阶段执行

**阶段一：本地准备。** 可以在切热点前完成依赖下载和镜像构建：

```bash
./deploy-sona.command --prepare-only
```

末尾输出私密包路径，例如 `.sona-run/deploy/20261013T120000Z-aabbcc.tgz`。

**阶段二：上传并在服务器执行。** 切热点后运行：

```bash
./deploy-sona.command --bundle .sona-run/deploy/20261013T120000Z-aabbcc.tgz
```

上传前核对 CPU 架构和 sudo 权限；SCP 使用 `-P 20280`。包内文件和外层传输包分别校验 SHA-256。非法路径、符号链接或架构不匹配会拒绝安装。失败返回非零退出码，可以使用同一个包重试；新代码版本应重新生成包。

## 打包和安装内容

本地准备 Linux SONA 0.2.18、账号平台、DeepXiv、PostgreSQL 17、Nginx 1.28.0 镜像，以及 Docker 28.5.1 静态包和 Compose 2.39.4。Rust、Node、OpenCode、CodeGraph、配置插件和 DeepXiv 应用依赖在镜像构建阶段安装，服务器不执行 Cargo、pnpm 或 npm 下载。若主机缺少 iptables，安装器需通过 Ubuntu apt 安装 iptables 和 CA 证书，此首次系统依赖步骤仍需服务器能访问 Ubuntu 软件源。已有 Docker 被复用，不卸载已有服务。

读取本地 `opencode --version` 固定 Linux 安装版本，目前为 **1.18.32**；同步 JSON/JSONC、AGENTS、skills、agents、commands、plugins 及配置依赖锁文件。CodeGraph MCP 的 Linux CLI 固定为 1.6.0，不初始化项目索引。不会复制 macOS node_modules、可执行文件、service.json、本地聊天/研究数据库、SSH 私钥、缓存、账号密码或仓库 `.env`。

模型凭据来自 `~/.local/share/opencode/auth.json`，保存在服务器独立的持久目录。部署包包含凭据，位于 Git 与 Docker 构建上下文均忽略的 `.sona-run/deploy` 中，权限限制为当前用户。不要分享该包，也不要使用多人共享的供应商主密钥。服务器模型程序可以读取其服务凭据；模型调用及付费研究不在安装阶段自动执行。

配置中的 macOS 路径、环境/文件引用、本机回环 MCP 地址或未打包的本地 MCP 命令会提前报错。当前远程 tradingagents MCP 地址保持不变，需要服务器能访问这些服务；OAuth 或供应商凭据可能仍需重新登录。默认只启动 DeepXiv Web，不自动采集论文或启动付费模型 Worker；既有论文数据不迁移。

## Nginx 单入口和登录

只有 Nginx 的 **20281** 面向外部；SONA 4791、平台 5300、DeepXiv 3000 及数据库端口仅监听服务器回环地址。Nginx 同时分流 SONA 页面与 API、`/_account/login`、平台/SSO API、DeepXiv `/library`、`/abs`、Next 静态资源和文献 API，支持 WebSocket、长任务流及上传。无需另行开放 3000/4791/5300，也不需要占用当前电脑端口。

科研 API 在反向代理中通过平台会话鉴权，仅部署研究管理员能够访问共享研究空间。写请求校验指定 Origin；内部回调、远程管理及官方更新等 API 不向公网提供。平台注册的新账号不能因此访问研究管理员的数据。本方案为当前个人研究空间部署，不等价于每用户独立空间的多租户版本。

安装器首次创建 `owner@research.local`，使用随机新密码，**不复制或重置本地账号密码**。登录信息保存在服务器 `/opt/sona/state/admin-login.txt`；上传入口完成后通过 SSH 取回到本地 `.sona-run/deploy/server-login.txt`，不输出密码到日志。打开该私密文件读取首次登录信息。重复部署保留账号和密码，登录后可在账号设置更改密码。如果目标已有同名账号且没有对应部署凭据文件，创建会失败，需管理员检查，不能自动覆盖已有账号。

HTTP 支持仅在显式配置的 `http://61.136.101.179:20281` origin 生效，不放宽其他 URL 或绕过密码、Host、Origin、SSO 密钥、PKCE 和会话权限检查。HTTP 会明文传输登录与研究内容；已按用户明确选择实施。DeepXiv 的 HTTP 例外仅写入临时部署源码副本，原伴随仓库文件不修改。

Nginx 使用专用容器，不覆盖主机已有 Nginx 站点。**若服务器已有服务实际占用 20281，网关启动将失败**；需先调整原占用服务或将该站点迁到新的 SONA 网关，脚本不会强行停止其他产品。

## 启动、升级和恢复

安装目录 `/opt/sona/releases/<发布号>`，当前版本链接为 `/opt/sona/current`，状态位于 `/opt/sona/state`。独立 Compose 项目名为 `sona-remote`；数据库使用持久卷，配置、模型凭据、研究和论文文件持久保存。systemd 和 `unless-stopped` 负责开机恢复。

```bash
# 状态
ssh -p 20280 ubuntu@61.136.101.179 \
  'sudo systemctl status sona.service; sudo /opt/sona/compose --project-directory /opt/sona/current --env-file /opt/sona/state/.env -p sona-remote ps'

# 启动 / 重新健康检查
ssh -p 20280 ubuntu@61.136.101.179 'sudo /opt/sona/current/start.sh'

# 日志
ssh -p 20280 ubuntu@61.136.101.179 \
  'sudo /opt/sona/compose --project-directory /opt/sona/current --env-file /opt/sona/state/.env -p sona-remote logs --tail 100'
```

升级保留数据库密钥与账号，备份数据库、研究 SQLite 和配置到 `/opt/sona/backups`；有运行研究或排队消息时拒绝停止研究服务。论文文件及研究产物应另外纳入定期备份。失败时保留数据与旧发布目录，不自动删除数据卷、不直接回滚迁移后的数据库。两仓库提交、Linux 架构、OpenCode 版本记录于包内 `manifest.json`。

## 验证范围

部署脚本测试、Bash 语法、Compose 配置、Nginx 配置与 HTTP 精确 origin 授权均在本地验证；安装器还会检查应用版本、三服务健康、Nginx 入口及匿名科研 API 拒绝访问。目标服务器的真实安装、登录/SSO、模型调用和重启恢复仍须在目标网络可访问后验证。

参考：[Docker Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)、[OpenCode 配置](https://opencode.ai/docs/config/)、[OpenCode 模型凭据](https://opencode.ai/docs/providers/)。
