# OpenResearch + Deep Literature 完整部署指南

本文是当前个人版本的部署基线，覆盖三个运行单元：

官方源码同步与产品发行包升级流程见[官方版本同步与产品升级](upstream-upgrades.md)。产品构建不会从官方仓库自动替换自身。

1. OpenResearch 本地科研工作台：本地项目、Agent、Git、实验和计算后端。
2. OpenResearch 统一账号服务：注册、登录、会话、退出和 SSO 授权。
3. Deep Literature：论文发现、精读、文库、笔记及后台 Worker。

团队空间和托管执行器仍作为内部兼容能力保留，不是个人版的默认部署路径。相关部署见[平台托管空间](managed-workspaces.md)和[多用户平台](multi-user-platform.md)。

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
| OpenResearch UI 开发服务器 | `http://localhost:5202` | 仅源码开发使用 |
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

## 3. 准备秘密和配置

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
docker compose up -d --build
docker compose ps -a
curl -f 'http://localhost:3000/api/papers?limit=1'
```

Compose 顺序为 `db` → `migrate` → `web`、`scheduler`、`pdf-worker`、`blog-worker`。只更新 Web 时可执行：

```bash
docker compose up -d --build web
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
