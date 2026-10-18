# MobileSci 一键部署：公网 IP / Nginx 20281

入口为仓库根目录 `deploy-mobilesci.command`。SSH 目标固定为 `ubuntu@61.136.101.179:20280`，部署后浏览器访问 **http://61.136.101.179:20281/mobilesci**，无需手动建立 SSH 隧道。已确认同步本地 OpenCode 配置及模型登录凭据，并明确授权该公网 HTTP 入口；其他部署继续默认要求 HTTPS。

## 一键执行

本地需要 Python 3、Git、pnpm、当前 OpenCode、运行中的 Docker Desktop/Buildx，以及相邻的 `DeepLiterature` 源码仓库。默认构建 Linux amd64；若目标为 ARM64，使用 `--arch arm64`。目标需要 Ubuntu、systemd、Python 3 和 `ubuntu` 的免密码 sudo 权限，并在云侧安全组/网络防火墙放通 TCP 20281。脚本不修改云控制台或整体防火墙策略。

切热点并能够 SSH 到服务器后，在仓库根目录执行：

```bash
./deploy-mobilesci.command
```

入口脚本默认同步已授权的模型凭据，不再询问。第一次 OpenSSH 主机密钥确认仍由正常 SSH 流程处理，不关闭主机密钥检查。首次构建 Linux release 镜像耗时较长，Apple Silicon 构建 amd64 使用模拟，建议 Docker 至少 6 GB 内存、本地预留约 30 GB 磁盘。

流程：构建 MobileSci 前端 → 构建 Linux 应用镜像与依赖 → 打包 OpenCode 配置、Docker 工具和校验清单 → SCP 上传 → 服务器安装 Docker → 数据库迁移 → 启动应用 → 创建研究管理员 → 启动 Nginx → 校验入口及未登录访问保护 → 设置开机恢复。

不传凭据时使用：

```bash
./deploy-mobilesci.command --without-auth --opencode-config-dir /path/to/sanitized-opencode
```

脱敏目录必须包括 OpenCode 配置和 `package.json`、`package-lock.json`。直接执行 Python 工具且未传授权参数时，仍保留凭据传输确认。

## 两阶段执行

**阶段一：本地准备。** 可以在切热点前完成依赖下载和镜像构建：

```bash
./deploy-mobilesci.command --prepare-only
```

末尾输出私密包路径，例如 `.mobilesci-run/deploy/20261013T120000Z-aabbcc.tgz`。

**阶段二：上传并在服务器执行。** 切热点后运行：

```bash
./deploy-mobilesci.command --bundle .mobilesci-run/deploy/20261013T120000Z-aabbcc.tgz
```

此前根路径版本的部署包不能直接用于 `/mobilesci`，脚本会拒绝旧包格式，请重新准备。上传前核对 CPU 架构和 sudo 权限；SCP 使用 `-P 20280`。包内文件和外层传输包分别校验 SHA-256。非法路径、符号链接或架构不匹配会拒绝安装。失败返回非零退出码，可以使用同一个包重试；新代码版本应重新生成包。

## 打包和安装内容

本地准备 Linux MobileSci 0.2.18、账号平台、DeepXiv、PostgreSQL 17、Nginx 1.28.0 镜像，以及 Docker 28.5.1 静态包和 Compose 2.39.4。Rust、Node、OpenCode、CodeGraph、配置插件和 DeepXiv 应用依赖在镜像构建阶段安装，两台服务器不执行 Cargo、pnpm 或 npm 下载；科研服务器仅创建账号数据库，文献数据库复用现有部署。若主机缺少 iptables，安装器需通过 Ubuntu apt 安装 iptables 和 CA 证书，此首次系统依赖步骤仍需服务器能访问 Ubuntu 软件源。已有 Docker 被复用，不卸载已有服务。

读取本地 `opencode --version` 固定 Linux 安装版本，目前为 **1.18.32**；同步 JSON/JSONC、AGENTS、skills、agents、commands、plugins 及配置依赖锁文件。CodeGraph MCP 的 Linux CLI 固定为 1.6.0，不初始化项目索引。不会复制 macOS node_modules、可执行文件、service.json、本地聊天/研究数据库、SSH 私钥、缓存、账号密码或仓库 `.env`。

模型凭据来自 `~/.local/share/opencode/auth.json`，保存在服务器独立的持久目录。部署包包含凭据，位于 Git 与 Docker 构建上下文均忽略的 `.mobilesci-run/deploy` 中，权限限制为当前用户。不要分享该包，也不要使用多人共享的供应商主密钥。服务器模型程序可以读取其服务凭据；模型调用及付费研究不在安装阶段自动执行。

配置中的 macOS 路径、环境/文件引用、本机回环 MCP 地址或未打包的本地 MCP 命令会提前报错。当前远程 tradingagents MCP 地址保持不变，需要服务器能访问这些服务；OAuth 或供应商凭据可能仍需重新登录。默认只启动 DeepXiv Web，不自动采集论文或启动付费模型 Worker；既有论文数据不迁移。

## Nginx 单入口和登录

MobileSci 新增公网入口只有 Nginx 的 **20281**；原文献服务的 3000/3004 入口保持现状。MobileSci 4791、平台 5300、新 DeepXiv 3005 及数据库端口仅监听服务器回环地址。Nginx 同时分流 MobileSci 页面与 API、`/_account/login`、平台/SSO API、DeepXiv `/library`、`/abs`、Next 静态资源和文献 API，支持 WebSocket、长任务流及上传。MobileSci 页面和静态资源位于 `/mobilesci`；科研与登录/SSO API、DeepXiv 页面继续使用同域现有路径。文献首页使用根地址 `/`，科研首页使用 `/mobilesci/projects`；账号登录完成后回到 `/mobilesci/projects`，深层路由可以直接刷新。子路径科研 API 同样执行登录保护，不构成鉴权绕过。无需另行开放 3000/4791/5300，也不需要占用当前电脑端口。

科研 API 在反向代理中通过平台会话鉴权，仅部署研究管理员能够访问共享研究空间。写请求校验指定 Origin；内部回调、远程管理及官方更新等 API 不向公网提供。平台注册的新账号不能因此访问研究管理员的数据。本方案为当前个人研究空间部署，不等价于每用户独立空间的多租户版本。

安装器首次创建 `owner@research.local`，使用随机新密码，**不复制或重置本地账号密码**。登录信息保存在服务器 `/opt/mobilesci/state/admin-login.txt`；上传入口完成后通过 SSH 取回到本地 `.mobilesci-run/deploy/server-login.txt`，不输出密码到日志。打开该私密文件读取首次登录信息。重复部署保留账号和密码，登录后可在账号设置更改密码。如果目标已有同名账号且没有对应部署凭据文件，创建会失败，需管理员检查，不能自动覆盖已有账号。

HTTP 支持仅在显式配置的 `http://61.136.101.179:20281` origin 生效，不放宽其他 URL 或绕过密码、Host、Origin、SSO 密钥、PKCE 和会话权限检查。HTTP 会明文传输登录与研究内容；已按用户明确选择实施。DeepXiv 的 HTTP 例外仅写入临时部署源码副本，原伴随仓库文件不修改。

Nginx 使用专用容器，不覆盖主机已有 Nginx 站点。**若服务器已有服务实际占用 20281，网关启动将失败**；需先调整原占用服务或将该站点迁到新的 MobileSci 网关，脚本不会强行停止其他产品。

## 启动、升级和恢复

安装目录 `/opt/mobilesci/releases/<发布号>`，当前版本链接为 `/opt/mobilesci/current`，状态位于 `/opt/mobilesci/state`。独立 Compose 项目名为 `mobilesci-remote`；账号数据库使用持久卷，配置、模型凭据和研究持久保存；论文数据库与 PDF 保留在现有文献服务器。systemd 和 `unless-stopped` 负责开机恢复。

```bash
# 状态
ssh -p 20280 ubuntu@61.136.101.179 \
  'sudo systemctl status mobilesci.service; sudo /opt/mobilesci/compose --project-directory /opt/mobilesci/current --env-file /opt/mobilesci/state/.env -p mobilesci-remote ps'

# 启动 / 重新健康检查
ssh -p 20280 ubuntu@61.136.101.179 'sudo /opt/mobilesci/current/start.sh'

# 日志
ssh -p 20280 ubuntu@61.136.101.179 \
  'sudo /opt/mobilesci/compose --project-directory /opt/mobilesci/current --env-file /opt/mobilesci/state/.env -p mobilesci-remote logs --tail 100'
```

升级保留数据库密钥与账号，备份数据库、研究 SQLite 和配置到 `/opt/mobilesci/backups`；有运行研究或排队消息时拒绝停止研究服务。论文文件及研究产物应另外纳入定期备份。失败时保留数据与旧发布目录，不自动删除数据卷、不直接回滚迁移后的数据库。两仓库提交、Linux 架构、OpenCode 版本记录于包内 `manifest.json`。

## 验证范围

部署脚本测试、Bash 语法、Compose 配置、Nginx 配置与 HTTP 精确 origin 授权均在本地验证；安装器还会检查应用版本、三服务健康、Nginx 入口及匿名科研 API 拒绝访问。目标服务器安装与登录/SSO 已通过本次实际部署验证；模型调用和整机重启恢复未执行。

参考：[Docker Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)、[OpenCode 配置](https://opencode.ai/docs/config/)、[OpenCode 模型凭据](https://opencode.ai/docs/providers/)。

## 已选择的现有文献服务器复用模式

当前入口已默认切换为两台服务器部署，不再在科研服务器新建文献数据库：

- MobileSci：`ssh -p 20280 ubuntu@61.136.101.179`；浏览器入口 `/mobilesci`。
- 文献数据与新 MobileSci Web：`ssh ubuntu@81.70.174.140`；原 `3000`、`3004`、数据库和 Worker 保持运行。
- 新 Web 仅绑定文献服务器 `127.0.0.1:3005`，PDF 挂载只读。它通过独立数据库角色连接现有数据库；身份使用 `openresearch` provider，不合并旧 DockAPI 用户或文库。
- 自动生成专用 SSH 通道密钥，私钥留在 MobileSci 服务器。文献服务器仅登记限定来源、禁止 Shell、只允许两个指定回环转发的公钥。主机密钥从已验证的 SSH 连接获取并严格校验。
- 通道双向提供文献读取和 SSO 后端访问，无需额外开放公网端口，也不要求浏览器或用户手动启动隧道。

完整流程为：准备 MobileSci 核心与稳定密钥 → 上传仅含文献镜像/迁移/安装器的子包 → 在文献服务器备份数据库并验证临时副本 → 检查新旧 Web 与迁移兼容 → 执行已验证的追加迁移 → 启动新 Web → 配置受限通道 → 启动主网关并检查公网入口。

新 Web 的模型设置可在文献服务器继承现有 Qwen 配置，不复制到科研服务器；不启动新的采集或解析 Worker。SSO 授权与科研 API 都限定部署管理员，其他注册账号不会获得该入口的模型使用权限。

`/opt/mobilesci-literature/backups` 保存数据库备份与副本验证报告。每次安装都先验证副本，检查旧身份和会话内容不变；旧版公共查询和新版公共查询/SSO 路由都必须通过。副本测试失败时不对生产数据库执行迁移。不存在自动删除旧数据、重置旧密码或覆盖原 DockAPI 配置的步骤。

此次文献服务器副本验证已通过旧身份/会话保持、旧版论文查询、新版论文查询与 SSO 路由检查。验证报告为 `/opt/mobilesci-literature/backups/20261013T073158Z.json`，准备阶段生产数据库未迁移；本次实际部署已通过再次验证并执行追加迁移，原服务继续运行。由于改为复用模式，早期独立文献库部署包不再接受，必须重新准备格式 3 的部署包。

## 已准备的复用部署包

当前完整包为 `.mobilesci-run/deploy/20261013T072430Z-bc63f1.tgz`（格式 3，Linux amd64，功能源码提交 `a2b9d16`）。切换网络后执行：

```bash
./deploy-mobilesci.command --bundle .mobilesci-run/deploy/20261013T072430Z-bc63f1.tgz
```

该命令需要同时连接两台服务器。本次实际部署已通过跨服务器登录验证并执行生产追加迁移；模型调用及整机重启恢复未执行，原文献服务未切换。

## 现有 CMCC 网关分流

若公网 20281 已映射到 `cmcc-apps-gateway-1` 的 80 端口，部署器会核验已知配置挂载和网络后，为 `/mobilesci`、登录和文献接口补充到 MobileSci 网关的转发。保留原 `/doclens`、`/research`、`/trading` 和 `/shopper` 路由；先备份配置，通过 `nginx -t` 后平滑重载，失败则恢复原文件。未知网关结构停止自动改写。

## 2026-10-13 实际部署验收

复用包已部署到两台服务器。公网 `/mobilesci/`、管理员登录、科研 API 授权、双服务器文献 SSO、回到 MobileSci 以及共享论文查询均通过。`mobilesci.service` 与文献通道均为 active/enabled，文献容器配置自动恢复；未为验收重启整台服务器或调用付费模型。原 `deeplit-web-1`、`deeplit-cmcc-web-1` 和 `deeplit-db-1` 保持健康，CMCC 原应用入口检查返回 200。现有 CMCC 网关备份：`/opt/cmcc-apps/config/gateway-nginx.conf.mobilesci-backup-20261013T080031Z`。

文献退出会撤销关联的平台会话；首次登录信息仅保存在私密登录文件中，不写入提交。验收后撤销本次 `/etc/sudoers.d/mobilesci-deploy` 临时免密权限，后续执行系统升级前需重新取得管理员权限。

## 浏览器登录回跳修复

2026-10-13 已在线修复账号平台：浏览器同源 GET 通常不携带 Origin，原 `browser-session` 错误要求该头，导致管理员通过 SSO 后再次被送回登录页。现在仅允许 Host 匹配、非跨站的无 Origin GET，写操作继续要求指定 Origin。无 Origin 的公网会话、科研 API、文献 SSO 和返回 MobileSci 的完整链路验证通过。原管理员账号与密码不变，新注册账号仍没有共享空间权限。

服务器更新了平台镜像及容器，保留只读文件系统和原环境/资源限制；数据库、执行器和文献服务未重启。早期 `.mobilesci-run/deploy/20261013T072430Z-bc63f1.tgz` 不含此修复，当前脚本会拒绝重新安装它。后续升级应运行 `./deploy-mobilesci.command --prepare-only` 生成带 `browserSessionReadVersion: 1` 的新包。

## 文献首页根路径修复

2026-10-13，DeepXiv 顶栏首页链接使用 `/`，此前被共享网关误送到 CMCC 应用目录。现按 `61.136.101.179:20281` Host 将根地址转发给 MobileSci 文献首页，其余 Host 的 CMCC 目录与原应用路径保留。带签名登录继续参数的根地址仍转到账号登录页；SSO 完成入口继续回到 `/mobilesci/projects`。文献 favicon 同步转发。

线上 MobileSci 网关配置保存在 `/home/ubuntu/.mobilesci-root-fix-20261013/nginx.conf` 并只读挂载；原网关配置及容器元数据留作回滚。共享网关备份为 `/home/ubuntu/.mobilesci-root-fix-20261013/gateway-nginx-20261013T085850Z.conf`。后续新包包含该路由，正常启动保持现有网关配置。

## 2026-10-14：文献入口迁移到 /deepxiv

最终入口为 `http://61.136.101.179:20281/deepxiv/`，裸 `/deepxiv` 自动补斜杠。根地址 `/` 返回 MobileSci `/mobilesci/`。DeepXiv 使用构建时的 Next.js basePath，页面导航、资源、浏览器 API、PDF 链接与 SSO 回调使用 `/deepxiv`；完成科研登录后仍回到 `/mobilesci/projects`。旧论文详情和文库地址会转入新前缀。原科研后端读取论文的私有 `/api` 地址由文献容器内的轻量代理兼容，避免改变原生执行器。

部署位置保持两台服务器：61 上运行 MobileSci、账号平台、Nginx 和受限 SSH 通道；81 上运行 MobileSci 专用文献 Web。专用 Web 与原 DeepLiterature 共用现有 PostgreSQL 论文数据和 `/home/ubuntu/deeplit/shared/papers` PDF，原 DockAPI Web、数据库及 Worker 均保留。新 Web 使用 MobileSci 身份和独立数据库角色，旧用户收藏与笔记不自动合并。

此次镜像只在临时源码副本中适配；原 DeepLiterature checkout 不改动。切换前在数据库副本验证新旧查询和身份保持，通过后仅替换 MobileSci 文献与账号容器。保留环境、数据卷、只读 PDF 挂载和资源限制，没有复制数据库或启动新采集 Worker。文献内部 Next 监听 127.0.0.1:3006，由同容器代理在 3005 提供原受限通道入口；不新增公网端口。

账号平台增加 `DEEPLIT_WEB_PATH=/deepxiv`。新部署包标记 `deepxivBasePath: /deepxiv`，旧包会被拒绝，需重新准备。线上新网关配置继续只读挂载 `/home/ubuntu/.mobilesci-root-fix-20261013/nginx.conf`；更换前的备份与共享网关备份保存在 `/home/ubuntu/.mobilesci-prefix-20261014`。账号和文献容器元数据保存在各服务器用户私有 `.mobilesci-service-rollbacks` 目录。

验收通过：带前缀的首页、JS/CSS、favicon、匿名论文目录、MobileSci 登录、文献 SSO、文献会话、共享目录以及返回 MobileSci；未调用付费模型。原 3000/3004 文献 Web 与其他 CMCC 应用继续保持原入口。Next.js 子路径规范参考：https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath。

## 科研与侧栏修复的一键更新

已有上述双服务器部署时，在仓库根目录执行：

```bash
./update-mobilesci.command
```

该入口更新 61 服务器的科研后端、前端以及账号平台代码和依赖；不替换文献服务或网关。保留当前容器的环境变量、数据挂载、权限、网络和重启策略，不重新同步模型凭据。更新前检查活跃智能体、运行实验、排队消息、会话租约和未完成派发；任一非零则停止更新。使用科研 SQLite 副本演练新版迁移，验证完整性与原有表记录数；备份科研 SQLite 和账号 PostgreSQL 后，执行账号平台的向前兼容迁移，不重置已有账号或密码。保留旧镜像和旧容器，启动与入口验证失败时恢复旧容器。

本地已准备的包会自动复用。切换热点后执行同一命令即可上传；SSH 保持正常主机密钥校验并设置连接超时。上传 SHA-256 校验通过后，服务器在后台更新，电脑网络再次断开也不会中断容器切换。重新执行同一命令会查看同一包的更新结果，成功的包不会重复切换。

需为后续代码改动重新构建时，本地需要 pnpm、Git、Python 3 和 Docker Desktop。Linux 后端及锁定的账号生产依赖在本地构建，服务器无需访问 Cargo 或 npm 下载源。可以提前准备，无需连接服务器：

```bash
./update-mobilesci.command --prepare-only
```

产物位于 `.mobilesci-run/updates/`，不包含账号密码、模型凭据或研究数据。指定某个包时使用 `./update-mobilesci.command --bundle /完整路径/更新包.tgz`；默认按本地源码与资源指纹复用最新包，源码变化后会重新准备。服务器需已有两个 MobileSci 容器、Docker、Python 3，以及 `ubuntu` 用户的 Docker 操作权限，无需重新开启 sudo。

服务器更新日志位于 `/home/ubuntu/.mobilesci-updates/<包哈希前缀>/deploy.log`。回滚元数据位于用户私有 `.mobilesci-sidebar-upgrade-<时间>/rollback.json`，其中可能包含容器环境变量，勿分享；同目录 `platform.dump` 是已验证格式的账号数据库备份。科研备份保存在现有研究数据挂载的 `state/backups/sidebar-<时间>.db`，迁移演练副本保存在 `state/backups/rehearsal-<时间>/`。本次更新不会清理备份、旧镜像或回滚容器。脚本会验证新版后端版本、新资源、服务健康和匿名科研 API 拒绝访问，并同步开机启动脚本的版本检查；原启动脚本保存在发布目录 `start.sh.before-<时间>`。脚本不会创建线上测试会话或调用模型。数据库迁移不通过镜像回退自动撤销。

### 2026-10-14 科研与侧栏修复部署验收

已通过一键增量更新完成科研后端和前端切换，发布号为 `20261014T025901Z`。修复空项目自动创建研究、HTTP 研究停止、两入口侧栏布局以及“展开”按钮字重、颜色和行高。服务健康、新资源路径和匿名科研 API 拒绝访问检查通过；更新时活跃任务、运行实验和排队消息均为零。科研 SQLite 备份及旧容器保留，容器环境和数据挂载保持现有配置。

一键脚本同时修正了两个部署问题：本地镜像 ID 先打标签再供 Dockerfile 使用，避免错误尝试从 Docker Hub 拉取 `sha256` 名称；科研健康探针使用回环 Host，账号平台使用已配置的公网 Host。一次健康探针误判已验证自动恢复旧容器，修正后的重试成功。回滚元数据为 `/home/ubuntu/.mobilesci-sidebar-upgrade-20261014T025901Z/rollback.json`，其中包含部署环境信息，勿分享。

### 2026-10-18：0.2.19 与账号、工作流更新

从 `feat/ai4s-product` 拉取源码提交 `632296a9f3dc7561a8d9c315a1b29360aabd40f6`，部署发布号 `20261018T073838Z`。更新科研后端、内嵌前端、预设科研工作流及账号管理代码，执行追加账号迁移 `004.sql`。服务器原有 env、挂载和 HostConfig 逐项核对完全一致，账号与密码保留；服务器未配置 SMTP，邮件找回仍明确禁用。文献、账号数据库容器、网关和其他 CMCC 服务未替换。

本次修复 Linux 构建阶段缺少科研工作流 JSON、Docker 构建参数错误、Windows 归档路径及可执行权限丢失。账号生产依赖在本地 Linux 容器按 npm 锁文件准备，随代码包上传，线上构建不需要依赖下载源。维护命令使用程序绝对路径。容器记录源码提交与包指纹，启动脚本的健康检查更新为 0.2.19，并保留原文件。

更新包 `.mobilesci-run/updates/20261018T073756Z-ce0e95c8c84f.tgz`，SHA-256 为 `b0744bd264bc7716c9975ad8326e57f6241208ef3564e9f6d8adfdcc0f8795e9`。线上日志：`/home/ubuntu/.mobilesci-updates/b0744bd264bc7716/deploy.log`。账号备份与回滚元数据：`/home/ubuntu/.mobilesci-sidebar-upgrade-20261018T073838Z/`；科研备份：`/opt/mobilesci/state/research/state/backups/sidebar-20261018T073838Z.db`。旧容器和旧镜像保留，数据库不随容器恢复自动回退。

验证：Rust 格式、Clippy、Linux release 构建、1,147 项单元测试与 18 项 CLI 集成测试通过，3 项单元测试按项目配置忽略。单元测试使用有正常主目录和可写程序目录的非 root Linux 用户，避免权限夹具受 root 影响。前端类型检查、342 项 UI 测试、国际化、样式及重新构建通过，`ui/dist` 与已提交资源一致；平台 15 项单元测试、27 项独立数据库集成测试、23 项部署测试、16 项启动测试、图表 4 项和发行说明 6 项测试通过。

线上数据库副本迁移完整性与原有表记录数检查通过；后端二进制与平台 629 个文件校验一致。公网版本为 0.2.19，科研和文献入口返回 200，匿名科研 API 返回 401。使用服务器私密登录文件验证原账号登录、会话读取和授权科研 API，随后退出测试会话；没有输出或下载凭据。systemd 仍为 active/enabled，开机脚本版本检查已核对；未重启整台服务器、执行付费模型调用或再次验收完整文献 SSO 链路。

### 2026-10-18：移除团队模式、精选案例与托管存储

团队邀请、成员管理与 Owner/Editor/Viewer 授权逻辑已移除；私人空间改为统一按创建者用户 ID 校验，系统管理员也不能读取其他用户的研究空间。旧成员表和邀请表保留作历史及回滚资料，不再授予权限。精选案例以管理员审核发布的独立快照提供给登录用户，托管存储通过账号服务返回适合用户身份的只读信息，不再展示网关的 HTML 错误。

本次按用户要求提交当前全部代码及构建资源，使用增量升级流程复用服务器原 env 和数据；不自动改变个人托管实例开关、不重置密码、不发布现有研究项目。当前单实例部署的指定研究账号限制继续生效，不能据此宣称所有注册用户均已获得独立托管实例。权限定义见 [私人空间权限](private-space-permissions.md)。

部署前验证：355 项 UI 测试、19 项平台单元测试、34 项独立数据库集成测试、23 项 Linux 部署测试与 16 项 Linux 启动测试通过；UI 类型检查、国际化、样式检查、平台格式检查和生产前端构建通过。Rust 源码沿用先前全量验证版本，本次重新构建包含新前端的 Linux 发布二进制。

用户明确指定将已有 `owner@research.local` 授予系统管理员；部署后使用离线 `grant-admin` 命令执行，保持密码与研究入口账号不变。

部署已完成：代码提交 `499a6c53274a1c5618def1220d5801fcdd6ac191`，发布号 `20261018T102218Z`。更新包 `.mobilesci-run/updates/20261018T102114Z-6a072109a6fe.tgz`，SHA-256 为 `dd6ed07df06b2705df02d91c2258fd15dccaa7aa73304c237a33c804abec0528`。服务器日志 `/home/ubuntu/.mobilesci-updates/dd6ed07df06b2705/deploy.log`；账号备份与回滚元数据 `/home/ubuntu/.mobilesci-sidebar-upgrade-20261018T102218Z/`；科研备份 `/opt/mobilesci/state/research/state/backups/sidebar-20261018T102218Z.db`。

线上切换前活跃任务、实验、队列、会话租约与派发均为零；SQLite 副本迁移及原表记录数验证通过，PostgreSQL 备份格式验证通过并应用 `005.sql`。两服务 env、Mounts、HostConfig 与更新前完全一致，运行容器源码标签、后端二进制及 632 个平台文件 SHA-256 与发布包一致。`owner@research.local` 已通过离线命令授予系统管理员，授权前后密码哈希和密码版本完全一致；原密码登录成功，验证会话已退出撤销。

管理员身份、原研究访问、案例管理及公共案例列表、托管存储 JSON 和旧团队接口 404 验证通过。匿名研究、案例、案例管理和存储接口均返回 401；公共精选案例仍为 0 个，没有发布真实研究内容或调用模型。`/mobilesci/` 与 `/deepxiv/` 返回 200；`mobilesci.service` 为 active/enabled。当前部署继续使用原指定账号研究实例，自动每用户托管实例仍未启用。

### 2026-10-18：统一系统管理后台

用户管理与精选案例管理统一为 `/admin/users` 和 `/admin/cases`，共用后台导航；MobileSci 子路径为 `/mobilesci/admin/users` 与 `/mobilesci/admin/cases`。管理员通过账号平台登录后默认进入统一用户管理，科研账号菜单提供“系统管理”，项目快捷入口直接进入案例管理并携带项目参数。原 `/_account/login?admin=1` 及 `/cases/manage` 入口保持兼容。后台布局不再混入私人项目导航，普通用户不能挂载后台内容。

用户管理沿用账号服务已有只读元数据接口；本地应用仅可从明确配置的应用 origin 读取，私有空间管理请求仍先校验空间归属。管理员角色被撤销后，现有会话调用管理接口立即被拒绝。没有新增数据库表、公开案例或私人研究内容访问权限。

验证：358 项 UI 测试、19 项平台单元测试和 35 项独立 PostgreSQL 集成测试通过，类型检查、国际化、样式、平台格式及前端生产构建通过。重新构建嵌入新后台页面的 Linux 发布二进制，后续按既有增量流程保留服务器 env、数据与账号权限。

统一后台已部署：源码提交 `4c0116f43b0b581e5aa8ce1c4d7cd22de8442f8f`，发布号 `20261018T114733Z`。更新包 `.mobilesci-run/updates/20261018T114605Z-53e06a91b597.tgz`，SHA-256 `7fc365f009a68bf4d9af09f030714f7254fdf7064a7da7cf27b0cf30375ecb94`。日志 `/home/ubuntu/.mobilesci-updates/7fc365f009a68bf4/deploy.log`；账号备份及回滚元数据 `/home/ubuntu/.mobilesci-sidebar-upgrade-20261018T114733Z/`；科研备份 `/opt/mobilesci/state/research/state/backups/sidebar-20261018T114733Z.db`。

线上任务检查均为零，数据库副本完整性、记录数与备份验证通过。两服务 env、挂载和 HostConfig 与更新前一致，源码标签、研究二进制及 632 个平台文件校验通过。原管理员账号登录、用户元数据接口、两个新后台页面、原案例管理链接、案例及存储接口验收通过；匿名管理接口返回 401，验证会话已退出。科研和文献入口返回 200，`mobilesci.service` 保持 active/enabled；公共案例数仍为 0，没有新增案例或执行模型调用。

### 2026-10-18：注册即有个人空间与管理员设置密码

追加 `006.sql` 建立用户到个人空间的一对一映射；注册事务创建逻辑空间，首次研究访问才准备独立运行环境。管理员用户表移除空间数量并提供设置密码操作，验证管理员当前密码后更新目标密码、撤销会话与找回令牌。新密码不进入日志或审计。

先按常规增量更新部署代码，再运行发布包内 `enable-personal-spaces.py --package <服务器发布包目录>`：补齐已有账号空间，原研究账号通过专属连接器保留原数据，新账号使用独立容器与数据卷；把 API 和终端从直连单实例切换到服务端按当前账号路由。该脚本备份账号数据库、原平台容器和网关/Compose，持久化私人模式及供给服务，失败恢复原配置。首次切换后仍需验收原账号项目、普通用户独立空间和管理员改密；仅发布代码不代表切换已完成。后续更新准入检查同时检查私人执行器的活跃任务与队列。

本地验证：359 项 UI 测试、20 项平台单元测试、38 项 PostgreSQL 集成测试、25 项 Linux 部署脚本测试通过；类型、国际化、样式、格式及前端构建通过。覆盖同 origin 双用户 HTTP/终端隔离、注册不分配计算、容量不足保留空间、管理员改密撤销子会话和 SSO、错误管理员密码与普通用户拒绝访问。
