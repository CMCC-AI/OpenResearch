# OpenResearch + Deep Literature 完整部署指南

本文说明本地个人版的配套服务部署，覆盖下列三个运行单元。服务器私人托管版、规范入口和配置源见[运行与部署约定](../product/runtime-and-deployment.md)。

官方源码同步与产品发行包升级流程见[官方版本同步与产品升级](upstream-upgrades.md)。产品构建不会从官方仓库自动替换自身。

1. OpenResearch 本地科研工作台：本地项目、Agent、Git、实验和计算后端。
2. OpenResearch 统一账号服务：注册、登录、会话、退出和 SSO 授权。
3. Deep Literature：论文发现、精读、文库、笔记及后台 Worker。

服务器私人托管版实际使用空间与执行器，见[自托管 OpenCode](self-hosted-opencode.md)。早期团队与托管方案文档按历史设计阅读，不代表当前授权行为。

## 1. 用户访问流程

部署完成后的标准流程是：

1. 用户打开 OpenResearch；未登录时只显示产品能力介绍页。
2. 用户点击“登录”，进入统一账号页注册或登录。
3. 账号服务签发一次性授权码，Deep Literature 建立同一用户会话。
4. 浏览器自动回到 OpenResearch `/projects` 产品主页。
5. `/projects`、`/discover`、`/literature`、`/capabilities` 均要求登录。
6. “文库”和“进入 Deep Literature 精读”直接打开 Deep Literature 目标页面，复用已建立的会话，不重复发起 SSO。
7. OpenResearch 左下角显示当前账号，可统一退出。

本地研究数据不会上传到账号服务。统一账号只管理身份；OpenResearch 的项目、代码、Agent 配置和实验记录仍保存在本机。

## 2. 版本、端口和依赖

| 服务 | 本地默认地址 | 说明 |
|---|---|---|
| OpenResearch release | `http://localhost:4791` | 面向用户的科研工作台 |
| OpenResearch UI 开发服务器 | dev-slot 分配（slot-1 通常为 `http://localhost:5201`） | 仅源码开发使用 |
| 统一账号服务 | `http://localhost:5300` | 注册、登录和 SSO |
| 账号 PostgreSQL | `127.0.0.1:15439` | 仅开发环境发布到回环地址 |
| Deep Literature | `http://localhost:3000` | 论文、精读和个人文库 |
| Deep Literature PostgreSQL | `127.0.0.1:5433` | 仅开发环境发布到回环地址 |

依赖：

- Docker Desktop 或 Docker Engine，Docker Compose v2；
- Node.js 22.20 或更高版本；
- pnpm；
- Rust stable 工具链；
- macOS 本地 Agent 场景还需要用户自行安装并登录 Codex、Antigravity 等 CLI。

浏览器 origin 必须完全一致。`localhost` 与 `127.0.0.1` 是不同站点，不能混用于登录入口、回调和 Deep Literature Web 地址，否则浏览器不会携带同一 Cookie。

### 本机已有环境的快速恢复

以下命令在 OpenResearch 仓库根目录执行。已有 `.env`、数据库和构建产物时，先启动 Docker Desktop（macOS 可执行 `open -a Docker`）或 Docker Engine，再确认两组 Compose 服务：

```bash
docker info --format '{{.ServerVersion}}'
docker compose -f packages/platform/compose.yaml -f packages/platform/compose.dev.yaml \
  --project-directory packages/platform ps
docker compose --env-file ../DeepLiterature/.env.local \
  -f ../DeepLiterature/compose.yaml --project-directory ../DeepLiterature ps
```

Docker Desktop 可能自动恢复此前的 Compose 容器；若没有运行，按第 4.2、4.3 节分别启动。随后运行第 4.4 节的本地产品进程，并用第 5 节的健康检查确认。不要仅以 `docker ps` 中的 `Up` 判断登录链路可用。

开发请使用 `./start-mobilesci-dev.command`，并以 `node scripts/dev-slot.mjs status` 确认端口。账号的 `OPENRESEARCH_APP_ORIGIN` 和文献回调必须与实际前端入口一致；不再将下述历史恢复记录中的 5202 或 4791 视为所有环境的固定值。

<details>
<summary>历史本机恢复记录（2026-09-30、2026-10-10；不是当前启动步骤）</summary>

2026-09-30 本机恢复时，实际先通过 `node scripts/dev-slot.mjs start --db empty` 恢复了 `4902` 后端和 `5202` UI 开发预览；Docker Desktop 启动后，既有的账号服务与 Deep Literature Compose 项目自动恢复；最后在 `ORX_ACCOUNT_URL`、`ORX_DEEP_LITERATURE_URL`、`ORX_DEEP_LITERATURE_WEB_URL` 环境变量下，以 `/Users/levent/.local/share/openresearch-dev/cargo-target/debug/orx`（`orx 0.2.9`）运行 `up --no-browser`，让产品入口监听 `4791`。最终通过 Node.js `spawn` 的 `detached: true` 和 `unref()` 将该实例作为独立后台进程启动，日志位于 `/private/tmp/openresearch-orx-4791.log`。这是基于本机现有构建产物的快速恢复；首次部署或代码更新后应使用下文的一键脚本重新构建。

2026-10-10 本机排查：开发 slot-1（后端 `4901`、UI `5201`）仍在运行，但用户入口 `4791` 没有监听，登录回调因此出现 `ERR_CONNECTION_REFUSED`。账号服务 `5300` 和 Deep Literature `3000` 正常。已使用当前 dev-slot 构建的 `orx 0.2.17` 按上述后台恢复方式重新启动 `4791`，验证工作台与账号页 HTTP 200、后端健康检查正常，账号会话接口允许精确来源 `http://localhost:4791`。实际用户登录需在浏览器完成；开发预览地址不能代替既有登录回调入口。

`5202` 是隔离的源码开发预览，`4791` 是当前账号与 Deep Literature 配置的登录回调目标。若直接从 `5202` 测试登录，必须先将两端 App origin 都改为 `http://localhost:5202` 并重启相应服务；否则应从 `http://localhost:4791` 进入完整产品。

</details>

检查 Docker 容器归属时使用 `docker compose ls --all` 和容器的 `com.docker.compose.project.working_dir` 标签。只停止明确属于其他项目的容器，使用 `docker stop <容器名>` 或该项目目录下的 `docker compose stop`；不要执行 `docker compose down -v`，以免删除数据库卷。本机的 `cmcc-local-dev` MySQL、Redis 属于另一个项目，已停止但未删除；`openresearch-test` 执行器属于本仓库测试环境，虽非个人版必需服务，不能归类为无关项目。

| Compose 项目 | 服务 | 当前个人版用途 |
|---|---|---|
| `openresearch-platform` | `db`、`migrate`、`platform` | 统一账号与 Deep Literature SSO；迁移成功后退出 |
| `deeplit` | `db`、`migrate`、`web` | 文献服务；迁移成功后退出 |
| `deeplit` | `scheduler`、`pdf-worker`、`blog-worker` | 后台采集、解析和 Blog，可按需要启用 |
| `openresearch-platform` | `provisioner` | 既有托管空间兼容服务，个人本地场景无需部署 |
| `openresearch-test` | `executor` | 本仓库的测试执行器，个人本地场景无需部署 |
| `cmcc-local-dev` | `mysql`、`redis` | 其他项目依赖，已停止 |

## 3. 准备秘密和配置

### 本机一键启动（推荐）

在 OpenResearch 仓库根目录运行：

```bash
node scripts/start-local.mjs
```

macOS 也可在 Finder 中双击仓库根目录的 `start-local.command`。

脚本默认在相邻的 `../DeepLiterature` 查找文献仓库；其他位置可用 `--deeplit-dir /绝对路径`。它检查 Docker Compose、pnpm 和 Rust，生成或更新两个本地 `.env`，保留现有密钥与数据库密码，对变化的配置创建权限为 `0600` 的备份，然后构建前端和 Rust release，依次启动两个 Docker 服务，最后打开 `http://localhost:4791`。浏览器入口、账号服务和文献服务分别使用 `localhost:4791`、`localhost:5300`、`localhost:3000`。

未配置 `QWEN_API_KEY` 时，脚本启动 Deep Literature 的数据库、迁移和 Web，足以完成登录、文库与精读。配置真实密钥后再次运行脚本，会自动启动采集和 Blog Worker。`--with-workers` 可在缺少密钥时提前报错；`--no-open` 可禁止自动打开浏览器。脚本在当前终端运行 OpenResearch；`Ctrl+C` 停止本地进程，Docker 服务继续运行。初次构建可能需要下载依赖和镜像。

如果已有 Deep Literature 本地数据库沿用 Compose 旧默认密码，脚本会保留该密码并提示；如已有两端 SSO 密钥不一致，脚本会停止并要求先核对配置，不会改写其中任一密钥。

下面的步骤适用于手动配置、生产部署或排查启动问题。

生成两个互不相同的随机值：

```bash
openssl rand -hex 32 # PLATFORM_DB_PASSWORD
openssl rand -hex 32 # DEEPLIT_SSO_CLIENT_SECRET
```

### 3.1 统一账号服务

复制 `packages/platform/.env.example` 为 `packages/platform/.env`，本地 release 示例：

```dotenv
PLATFORM_ORIGIN=http://localhost:5300
OPENRESEARCH_APP_ORIGIN=http://localhost:4791
PLATFORM_DB_PASSWORD=<随机数据库密码>
DEEPLIT_ORIGIN=http://localhost:3000
DEEPLIT_SSO_CLIENT_SECRET=<随机 SSO 密钥>
```

源码 UI 使用端口 5202 时，将 `OPENRESEARCH_APP_ORIGIN` 改成 `http://localhost:5202`。该值决定统一登录完成后的落点和浏览器会话接口允许的精确来源。

### 3.2 Deep Literature

复制 `.env.production.example` 为 Deep Literature 仓库的 `.env.local`，本地 Docker 至少配置：

```dotenv
DEEPLIT_AUTH_MODE=openresearch
DEEPLIT_OPENRESEARCH_URL=http://host.docker.internal:5300
DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN=http://localhost:5300
DEEPLIT_OPENRESEARCH_APP_ORIGIN=http://localhost:4791
DEEPLIT_PUBLIC_ORIGIN=http://localhost:3000
DEEPLIT_SSO_CLIENT_SECRET=<与账号服务完全相同>
DEEPLIT_COOKIE_MODE=same-site
DEEPLIT_SECURE_COOKIES=false
POSTGRES_PASSWORD=<独立的文献数据库密码>
DEEPLIT_PASSWORD_PEPPER=<长期稳定的独立随机值>
```

源码 UI 使用端口 5202 时，同样把 `DEEPLIT_OPENRESEARCH_APP_ORIGIN` 改成 `http://localhost:5202`。

地址职责不能互换：

- `DEEPLIT_OPENRESEARCH_URL`：Deep Literature 容器访问账号服务的内部地址；
- `DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN`：浏览器进入账号服务的公开地址；
- `DEEPLIT_OPENRESEARCH_APP_ORIGIN`：登录完成后返回的 OpenResearch 地址；
- `DEEPLIT_PUBLIC_ORIGIN`：Deep Literature 的浏览器公开地址和固定 SSO 回调 origin。

`QWEN_API_KEY` 供 Blog Worker 使用，可能产生模型费用。`HF_TOKEN` 按所用 Hugging Face 资源决定是否必需。所有 `.env` 文件权限应为 `0600`，不得提交 Git。

### 3.3 OpenResearch 本地进程

```dotenv
ORX_ACCOUNT_URL=http://localhost:5300
ORX_DEEP_LITERATURE_URL=http://127.0.0.1:3000
ORX_DEEP_LITERATURE_WEB_URL=http://localhost:3000
```

`ORX_DEEP_LITERATURE_URL` 是服务端读取论文 API 的地址；`ORX_DEEP_LITERATURE_WEB_URL` 是写入页面链接的浏览器地址。后者必须与 `DEEPLIT_PUBLIC_ORIGIN` 完全一致。本地默认浏览器地址已固定为 `http://localhost:3000`。

## 4. 从零启动

### 4.1 构建 OpenResearch Web 资源

`ui/dist` 会被 Rust release 和账号服务 Docker 镜像嵌入，源码更新后必须重新生成：

```bash
cd /Users/levent/cmccProjects/OpenResearch/ui
pnpm install --frozen-lockfile
pnpm build
```

### 4.2 启动统一账号服务

```bash
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
chmod 600 .env
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
docker compose -f compose.yaml -f compose.dev.yaml ps -a
curl -f http://localhost:5300/healthz
```

预期状态：`db` 为 `healthy`、`migrate` 为 `Exited (0)`、`platform` 为 `Up`。`migrate` 正常退出不是故障。

### 4.3 启动 Deep Literature

```bash
cd /Users/levent/cmccProjects/DeepLiterature
chmod 600 .env.local
docker compose --env-file .env.local up -d --build
docker compose --env-file .env.local ps -a
curl -f 'http://localhost:3000/api/papers?limit=1'
```

Compose 顺序为 `db` → `migrate` → `web`、`scheduler`、`pdf-worker`、`blog-worker`。只更新 Web 时可执行：

```bash
docker compose --env-file .env.local up -d --build web
```

### 4.4 启动 OpenResearch release

```bash
cd /Users/levent/cmccProjects/OpenResearch
cargo build --release --locked
ORX_ACCOUNT_URL=http://localhost:5300 \
ORX_DEEP_LITERATURE_URL=http://127.0.0.1:3000 \
ORX_DEEP_LITERATURE_WEB_URL=http://localhost:3000 \
./target/release/orx up
```

浏览器打开 `http://localhost:4791`。若使用其他端口，必须同时更新账号服务与 Deep Literature 中的 App origin，再重启相应服务。

### 4.5 启动源码开发环境

本地实例应通过 `scripts/dev-slot.mjs` 隔离数据库、缓存和端口。若另行启动 UI 开发服务器，确保其代理指向该 slot 后端，并把两端 App origin 设置为实际 UI origin。

## 5. 完整验收

使用全新浏览器会话执行：

1. 打开 OpenResearch `/`，确认显示产品介绍页和登录按钮。
2. 直接访问 `/projects`，确认未登录时返回介绍页。
3. 点击登录，注册或登录后确认最终落到 `/projects`。
4. 确认左下角显示姓名和邮箱。
5. 打开 `/literature`，确认状态为“Deep Literature 已连接”。
6. 点击“登录并打开我的文库”，目标应是 `http://localhost:3000/library`，且不要求再次登录。
7. 点击“进入 Deep Literature 精读”，目标应是 `http://localhost:3000/abs/<论文ID>`；URL 中不应出现 `/api/auth/openresearch/start`。
8. 在 Deep Literature 打开账户页，确认身份与 OpenResearch 一致。
9. 从 OpenResearch 退出，确认受保护页面返回介绍页，Deep Literature grant 同步失效。

API 快速检查：

```bash
curl -f http://localhost:5300/healthz
curl -f 'http://localhost:3000/api/papers?limit=1'
curl -f http://127.0.0.1:4791/api/deep-literature/status
```

最后一项的 `webUrl` 必须是 `http://localhost:3000`。

## 6. 日常升级与回滚

升级前：

1. 备份两个 PostgreSQL 数据库和 Deep Literature `papers` 目录；
2. 记录两个仓库提交 SHA、镜像摘要和当前环境变量；
3. 先在预发布环境执行迁移与完整 SSO 验收。

升级顺序：

1. 构建 OpenResearch `ui/dist`；
2. 更新账号服务并执行迁移；
3. 更新 Deep Literature Web，验证统一登录；
4. 更新 OpenResearch release；
5. 最后更新 scheduler 和 Worker，观察队列、错误率和模型费用。

数据库迁移必须向前兼容旧应用版本，才能安全滚动回滚。回滚镜像前先核对迁移说明，不得直接回滚数据库文件。

## 7. 日志、停止和数据保护

一键脚本在终端前台运行，按 `Ctrl+C` 停止本地 OpenResearch。本次恢复的 `4791` 实例在后台运行，可查看日志并核对进程：

```bash
tail -n 100 /private/tmp/openresearch-orx-4791.log
lsof -nP -iTCP:4791 -sTCP:LISTEN
```

需要停止该后台实例时，在 `lsof` 输出中确认命令为 `orx`，再执行 `kill -TERM <实际PID>`。开发 slot 则在仓库根目录执行 `node scripts/dev-slot.mjs stop`；此操作保留隔离数据库。

```bash
# 账号服务
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
docker compose -f compose.yaml -f compose.dev.yaml logs -f platform migrate db

# Deep Literature
cd /Users/levent/cmccProjects/DeepLiterature
docker compose logs -f web scheduler pdf-worker blog-worker

# 停止当前目录对应的 Compose 服务，但保留数据库卷
docker compose stop
```

`docker compose down` 会删除容器和网络但保留命名卷。除非明确永久删除数据库，不要运行 `docker compose down -v`。删除账号、论文文件或托管空间数据前必须先确认备份和保留策略。

## 8. 常见故障

| 现象 | 原因与处理 |
|---|---|
| `登录流程已过期，请重新进入` | 关闭旧回调页，从 OpenResearch 重新登录；确认所有浏览器地址统一使用 `localhost`，不要把 `127.0.0.1` 与 `localhost` 混用 |
| 登录后回到错误端口 | `OPENRESEARCH_APP_ORIGIN` 与 `DEEPLIT_OPENRESEARCH_APP_ORIGIN` 不一致；改为实际 OpenResearch origin 并重启两端 |
| 精读链接再次进入 SSO | OpenResearch UI 或 `ui/dist` 未更新；重新运行 `pnpm build` 并更新 release/容器 |
| Deep Literature 显示未登录 | 核对 `DEEPLIT_PUBLIC_ORIGIN`、Cookie 模式和 SSO secret；确认主登录确实经过 Deep Literature 回调 |
| `SSO URLs must use HTTPS outside localhost` | 生产公开地址必须 HTTPS；只有本机 `localhost` 允许 HTTP |
| 平台迁移报 `28P01` | `.env` 密码与已有数据库卷初始化密码不同；应重置数据库角色密码，不能为省事删除生产卷 |
| `migrate` 显示 Exited | 退出码 0 表示迁移成功；非 0 才查看迁移日志 |
| Blog 不生成 | 检查 Blog Worker、队列、`QWEN_API_KEY`、供应商额度和超时配置 |
| Agent 未就绪 | 在运行 OpenResearch 的同一 OS 用户下执行 Agent CLI 的版本和登录检查；本地凭据不会由统一账号服务下发 |

## 9. 生产部署

建议使用同一可注册域的三个 HTTPS 子域，例如：

- `https://app.example.org`：OpenResearch Web；
- `https://account.example.org`：统一账号；
- `https://literature.example.org`：Deep Literature。

生产要求：

1. 三个公开 origin 均使用 HTTPS，反向代理保留正确的 Host 和协议；
2. PostgreSQL 仅在私网开放，使用两个独立数据库和独立密码；
3. SSO secret、数据库密码、password pepper 和模型密钥进入 Secret Manager；
4. 账号服务只允许配置的 App origin 跨源读取浏览器会话；
5. Deep Literature Web 与 Worker 分开扩缩容，Worker 配置预算和并发上限；
6. 配置数据库、论文文件和对象存储备份，并定期做恢复演练；
7. 监控登录失败率、授权码交换失败、数据库连接、队列积压、模型费用和磁盘空间；
8. 公网上线前补齐邮箱验证、找回密码、MFA/异常登录保护、账号删除和数据导出联动。

示例生产变量参见 `packages/platform/.env.example` 与 Deep Literature `.env.production.example`。生产环境不得使用 `localhost`、`host.docker.internal`、默认密码或开发 Compose 覆盖文件。
