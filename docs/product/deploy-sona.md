# SONA 一键服务器部署

入口：仓库根目录 `deploy-sona.command`。目标固定为 `ssh -p 20280 ubuntu@61.136.101.179`，部署到 `/opt/sona`。本方案部署当前个人研究版本，包含 SONA 0.2.18、账号平台、DeepXiv 和 OpenCode；不启用多用户私人执行器模式。服务器上的科研进程与实验共享专用研究空间，适用于可信人员使用。

## 开始前

本地需要 Python 3、Git、pnpm、当前已安装的 OpenCode、Docker Desktop/Buildx，并存在相邻的 `DeepLiterature` 源码仓库。Docker 必须运行。首次 Linux release 构建耗时较长，Apple Silicon 构建 amd64 使用模拟，建议为 Docker 分配至少 6 GB 内存、预留约 30 GB 构建磁盘空间。打包不上传本地项目、聊天数据库、论文文件、SSH 私钥、账号密码或两个仓库的 `.env`。

目标需要 Ubuntu、systemd、Python 3、SSH 登录权限及 `sudo -n` 权限。默认服务器为 amd64；ARM64 用 `--arch arm64`。脚本会在上传前核对实际 CPU 架构并拒绝不匹配包。服务器若尚未安装 Docker，使用随包交付的 Docker 28.5.1 静态包和 Compose 2.39.4；如果缺少主机 `iptables`，安装阶段通过 Ubuntu apt 安装 `iptables` 和 CA 证书，因此此首次系统依赖步骤仍需访问 Ubuntu 软件源。既有 Docker 安装会被复用，不卸载已有服务。

服务和 PostgreSQL 均仅绑定服务器回环地址，通过 SSH 隧道访问。没有提供 HTTP 公网 IP 入口；需要域名 HTTPS 上线时应另行配置三个公开 origin、证书和代理，不能直接开放当前端口。第一次 SSH 仍需确认正常的主机密钥指纹；不关闭主机密钥检查，不保存 SSH 密码。

## 一个命令完成两阶段

切到可访问服务器的热点网络后，在仓库根目录运行：

```bash
./deploy-sona.command
```

脚本会先询问是否授权把当前 OpenCode 配置和模型凭据发到该服务器。输入 `YES` 后执行：构建前端 → 构建固定版本 Linux 应用镜像 → 打包配置及 Docker 工具 → SCP → 服务器安装 → 数据库迁移 → 服务启动 → 版本与健康检查。SCP 大包可能需要较长时间，终端会显示传输进度。失败时返回非零退出码，不宣称完成。

已明确授权传输当前模型凭据时，可免交互运行：

```bash
./deploy-sona.command --sync-auth
```

不传模型凭据时，使用脱敏配置目录（同时包含 `package.json` 和 `package-lock.json`）：

```bash
./deploy-sona.command --without-auth --opencode-config-dir /path/to/sanitized-opencode
```

不要用管理员供应商主密钥作为多人共享授权。OpenCode 模型凭据位于研究服务的独立持久目录，容器内研究程序可以读取；只上传已授权的该服务专用模型凭据。平台用户账号在服务器重新注册，独立于本地账号，不同步现有数据库。

## 推荐：提前本地准备，切热点后只上传

第一阶段，在当前可下载依赖的网络运行：

```bash
./deploy-sona.command --prepare-only --sync-auth
```

末尾输出完整包路径，例如 `.sona-run/deploy/20261013T120000Z-aabbcc.tgz`。该目录及包是私密文件，权限限制为当前用户，且被 Git 与 Docker 构建上下文忽略。包含模型凭据时不要分享部署包。

第二阶段，切热点后执行：

```bash
./deploy-sona.command --bundle .sona-run/deploy/20261013T120000Z-aabbcc.tgz --sync-auth
```

服务器只导入已完成的 Linux 镜像，不执行 Cargo、pnpm 或 npm 下载。Rust、Node、OpenCode、CodeGraph、OpenCode 配置依赖和 DeepXiv 依赖在本地镜像阶段安装。若首次包因网络问题未完成，重新执行准备阶段；服务阶段失败可以用同一包重试。新版本请生成新发布包。

## 访问和首次登录

部署结束会输出隧道命令。在另一个终端执行并保持连接：

```bash
ssh -p 20280 -N -o ExitOnForwardFailure=yes \
  -L 4791:127.0.0.1:4791 \
  -L 5300:127.0.0.1:5300 \
  -L 3000:127.0.0.1:3000 ubuntu@61.136.101.179
```

打开 `http://localhost:4791`，在账号页注册服务器账号。三个转发端口不能更换或混用 `127.0.0.1` 页面地址，否则登录 origin 和 SSO Cookie 不一致。

**本机正在运行的 SONA、账号服务和 DeepXiv 占用相同端口时，需要先停止本地三个服务，或在另一台电脑建立隧道。**脚本不会自动停止当前电脑的研究进程。停止本地服务前先确认任务结束；Docker 服务可按各自 Compose 项目执行 `stop`，不要使用 `down -v`。这三个本地端口空闲后再建立隧道。

## OpenCode 一致性范围

准备时读取本地 `opencode --version` 并固定到 Linux 镜像，本机当前版本为 1.18.32。同步全局 JSON/JSONC、AGENTS、skills、agents、commands、plugins 与锁定的配置依赖；同步当前本地 CodeGraph MCP 所需的 Linux CLI 1.6.0。配置依赖在 Linux 上重新安装，不复制 macOS 的 `node_modules` 或可执行文件。

可选同步 `~/.local/share/opencode/auth.json`；不同步 `service.json` 的本机服务口令，也不复制 OpenCode 聊天数据库、缓存、SSH agent 或浏览器登录会话。SONA 会照常发现 OpenCode、展示模型并在每个研究会话启动 Agent，专家团与原工作模式保持当前实现。

配置中的 macOS 绝对路径、未打包的本地 MCP 命令、环境变量/文件引用、回环 MCP 地址会提前报错，不能保证其在 Linux 直接工作。当前两个远程 tradingagents MCP 地址原样保留，需服务器可访问这些远程服务；OAuth/供应商凭据可能需要服务器重新登录。模型调用、付费实验和论文采集 Worker 不在安装阶段自动执行，默认只启动 DeepXiv Web；现有文库和采集数据不迁移，新的论文数据需后续导入或启用采集配置。

## 服务器运维

```bash
# 状态和日志
ssh -p 20280 ubuntu@61.136.101.179 \
  'sudo systemctl status sona.service; sudo /opt/sona/compose --project-directory /opt/sona/current --env-file /opt/sona/state/.env -p sona-remote ps'

# 重新检查并启动
ssh -p 20280 ubuntu@61.136.101.179 'sudo /opt/sona/current/start.sh'

# 查看服务日志
ssh -p 20280 ubuntu@61.136.101.179 \
  'sudo /opt/sona/compose --project-directory /opt/sona/current --env-file /opt/sona/state/.env -p sona-remote logs --tail 100'
```

`systemd` 和容器 `unless-stopped` 负责服务器重启恢复。镜像、配置和服务被放在专用 `sona-remote` Compose 项目，PostgreSQL 使用独立命名卷，研究与模型配置在 `/opt/sona/state`。每次升级保留密钥，备份账号数据库、文献数据库、SQLite 与配置到 `/opt/sona/backups`，存在运行任务或排队消息时拒绝停止研究服务。论文文件及研究产物应另行纳入定期备份。

发布标识、两仓库提交、CPU 架构和 OpenCode 版本记录在发布包 `manifest.json`，所有包内文件记录 SHA-256，外层传输包也单独校验。日志不输出模型凭据。失败时保留数据和旧发布目录，查明原因后重试；迁移后不要直接回滚旧数据库，代码回滚必须与数据库兼容性一同验证。

## 验证范围

脚本单元测试、Bash 语法检查和 Docker Compose 配置校验可在本地执行；CI 已加入部署脚本检查：

```bash
python3 scripts/deploy/test_sona.py
bash -n scripts/deploy/server.sh scripts/deploy/start.sh deploy-sona.command
```

此交付没有在指定服务器执行真实安装，也没有完成此次部署镜像的跨架构全量构建；服务器登录、真实 SSO、模型调用及重新启动后的恢复需在目标网络可访问后验收。安装脚本本身会检查三服务健康与 SONA 版本，模型授权是否有效须在页面发起一个实际研究对话后验证。

参考：[Docker Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)、[OpenCode 配置](https://opencode.ai/docs/config/)、[OpenCode 模型凭据](https://opencode.ai/docs/providers/)。
