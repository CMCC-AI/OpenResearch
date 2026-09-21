# OpenResearch + DeepLiterature 启动与部署

本文覆盖两个独立仓库的统一启动：OpenResearch 提供账户、科研项目与工作流，DeepLiterature 提供论文发现、阅读、文库和论文处理 Worker。统一登录要求先启动 OpenResearch，再启动 DeepLiterature。

## 本地端口与依赖

| 服务 | 地址或端口 | 用途 |
|---|---|---|
| OpenResearch | `http://localhost:5300` | 统一登录、项目和科研工作台 |
| OpenResearch PostgreSQL | `127.0.0.1:15439` | 平台数据库，仅本机 |
| DeepLiterature | `http://localhost:3000` | 论文发现、阅读和文库 |
| DeepLiterature PostgreSQL | `localhost:5433` | 文献数据库；生产环境应只绑定回环地址 |

本地运行需要 Docker Desktop、Docker Compose v2、Node.js 22.20 或更高版本以及 Rust 工具链。平台和 DeepLiterature 使用 Docker；工作空间执行器直接运行在 macOS，因而可以读取本机已安装并登录的 Antigravity、Codex 等 Agent CLI。两个仓库保持独立，不要复制数据库或 `.env` 到另一个仓库。

## 环境变量

OpenResearch 使用 `/Users/levent/cmccProjects/OpenResearch/packages/platform/.env`：

```dotenv
PLATFORM_ORIGIN=http://localhost:5300
PLATFORM_DB_PASSWORD=<随机数据库密码>
DEEPLIT_ORIGIN=http://localhost:3000
DEEPLIT_SSO_CLIENT_SECRET=<两端相同且至少32字符>
```

DeepLiterature 使用 `/Users/levent/cmccProjects/DeepLiterature/.env.local`：

```dotenv
DEEPLIT_AUTH_MODE=openresearch
DEEPLIT_OPENRESEARCH_URL=http://host.docker.internal:5300
# 可显式配置；省略时本地 Docker 会自动映射为 localhost。
DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN=http://localhost:5300
DEEPLIT_PUBLIC_ORIGIN=http://localhost:3000
DEEPLIT_SSO_CLIENT_SECRET=<与 OpenResearch 完全相同>
DEEPLIT_COOKIE_MODE=same-site
DEEPLIT_SECURE_COOKIES=false
```

`DEEPLIT_OPENRESEARCH_URL` 是容器到宿主机的服务端地址；`DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN` 是浏览器跳转地址，二者不能互换。`QWEN_API_KEY` 用于 Blog Worker，可能产生模型费用。`HF_TOKEN` 可选；未配置时只能调用不要求认证的 Hugging Face 资源。不要提交任何 `.env`。

## 第一次启动或源码更新后启动

### 1. 启动 OpenResearch

```bash
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
chmod 600 .env
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
docker compose -f compose.yaml -f compose.dev.yaml ps -a
```

等待 `db` 显示 `healthy`、`migrate` 显示 `Exited (0)`、`platform` 显示 `Up`。验证：

```bash
curl -f http://localhost:5300/healthz
```

首次部署若还没有管理员账户：

```bash
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
node --env-file=.env src/admin.mjs create-user owner@example.org 管理员 < /secure/initial-password
```

密码从标准输入读取；不要把密码直接写在命令行历史中。

### 2. 启动 DeepLiterature 全部服务

```bash
cd /Users/levent/cmccProjects/DeepLiterature
chmod 600 .env.local
docker compose up -d --build
docker compose ps -a
```

启动顺序由 Compose 保证：`db` → `migrate` → `web`、`scheduler`、`pdf-worker`、`blog-worker`。验收状态：

- `db` 和 `web` 为 `healthy`；
- `migrate` 为 `Exited (0)`，这是正常完成，不是服务退出故障；
- 三个 Worker 均为 `Up`；
- scheduler 在 `DAILY_PIPELINE_RUN_ON_STARTUP=true` 时会立即采集一次论文；
- Blog Worker 使用 Qwen，处理到队列任务时可能产生费用。

验证 Web 与统一登录跳转：

```bash
curl -f http://localhost:3000/api/papers?limit=1
curl -I 'http://localhost:3000/api/auth/openresearch/start?returnTo=%2Flibrary'
```

第二条命令应返回 `303`，`Location` 应以 `http://localhost:5300/api/auth/sso/authorize` 开头。

### 3. 在 macOS 启动本地工作空间执行器

先在团队平台的“空间管理”中签发执行器凭据，只会显示一次。将其保存到 Git 仓库外并设置权限：

```bash
mkdir -p ~/.config/openresearch/runners
chmod 700 ~/.config/openresearch/runners
chmod 600 ~/.config/openresearch/runners/test.token
```

先编译本机 `orx`。每个工作空间必须使用独立的运行目录、连接器目录和 token：

```bash
cd /Users/levent/cmccProjects/OpenResearch
cargo build --release --locked

cd packages/platform
PLATFORM_ORIGIN=http://localhost:5300 \
PLATFORM_CONNECT_URL=http://localhost:5300 \
ORX_DATA_DIR=$HOME/.local/share/openresearch/workspaces/test/orx \
RUNNER_STATE_DIR=$HOME/.local/share/openresearch/workspaces/test/connector \
RUNNER_ISOLATION_ACK=dedicated-workspace \
ORX_DEEP_LITERATURE_URL=http://localhost:3000 \
ORX_DEEP_LITERATURE_WEB_URL=http://localhost:3000 \
RUNNER_TOKEN_FILE=$HOME/.config/openresearch/runners/test.token \
npm run executor:local
```

保持这个终端运行。日志出现 `Executor connected` 后，刷新团队平台应显示“执行器在线”。工作台的“智能体工具”会检测宿主机上的 `agy`；Antigravity 仍显示未就绪时，在同一 macOS 用户下运行 `agy models` 检查登录和可用模型。

同一 token 不能同时连接 Docker 与本机执行器。若以前启动过容器执行器，先停止它：

```bash
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
PLATFORM_ORIGIN=http://localhost:5300 \
RUNNER_TOKEN_FILE=$HOME/.config/openresearch/runners/test.token \
docker compose -p openresearch-test -f compose.executor.yaml stop
```

### 4. 浏览器验收

1. 打开 `http://localhost:5300/login` 登录 OpenResearch。
2. 打开 `http://localhost:5300/projects` 检查项目工作台。
3. 从文献入口进入，或打开 `http://localhost:3000`。
4. 确认 DeepLiterature 不再要求第二次登录。
5. 收藏一篇论文后检查文库，再退出 OpenResearch，确认 DeepLiterature 会话同步失效。

## 日常启动

镜像和源码没有变化时不需要重新构建：

```bash
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
docker compose -f compose.yaml -f compose.dev.yaml up -d

cd /Users/levent/cmccProjects/DeepLiterature
docker compose up -d

cd /Users/levent/cmccProjects/OpenResearch/packages/platform
PLATFORM_ORIGIN=http://localhost:5300 \
PLATFORM_CONNECT_URL=http://localhost:5300 \
ORX_DATA_DIR=$HOME/.local/share/openresearch/workspaces/test/orx \
RUNNER_STATE_DIR=$HOME/.local/share/openresearch/workspaces/test/connector \
RUNNER_ISOLATION_ACK=dedicated-workspace \
ORX_DEEP_LITERATURE_URL=http://localhost:3000 \
ORX_DEEP_LITERATURE_WEB_URL=http://localhost:3000 \
RUNNER_TOKEN_FILE=$HOME/.config/openresearch/runners/test.token \
npm run executor:local
```

只重启 Web，不触发全部 Worker 重建：

```bash
cd /Users/levent/cmccProjects/DeepLiterature
docker compose up -d --build web
```

## 日志、停止与清理

```bash
# OpenResearch 日志
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
docker compose -f compose.yaml -f compose.dev.yaml logs -f platform migrate db

# DeepLiterature 日志
cd /Users/levent/cmccProjects/DeepLiterature
docker compose logs -f web scheduler pdf-worker blog-worker

# 先在运行 npm run executor:local 的终端按 Ctrl-C 停止工作空间执行器

# 再停 DeepLiterature 和身份控制平台
cd /Users/levent/cmccProjects/DeepLiterature
docker compose stop
cd /Users/levent/cmccProjects/OpenResearch/packages/platform
docker compose -f compose.yaml -f compose.dev.yaml stop
```

`docker compose down` 删除容器和网络但保留命名卷。不要使用 `down -v`，除非明确要永久删除数据库。论文文件还位于 DeepLiterature 的 `papers` 挂载目录，清理容器不会自动删除它。

## 常见故障

| 现象 | 处理 |
|---|---|
| OpenResearch 迁移报 `28P01` | `.env` 密码与旧数据卷初始化密码不同；保留数据并由管理员重置数据库角色密码，不能直接删卷 |
| DeepLiterature 报 `SSO URLs must use HTTPS outside localhost` | 服务端地址应为 `http://host.docker.internal:5300`，浏览器地址应为 `http://localhost:5300` |
| DeepLiterature 登录跳转后无法打开 | 先确认 `http://localhost:5300/healthz`，再核对两端 SSO secret 完全一致 |
| DeepLiterature 报“统一认证服务暂时不可用” | 确认平台已更新并重建；本地容器通过 `host.docker.internal` 调用平台，浏览器仍跳转 `localhost` |
| Antigravity 显示未安装 | 不要使用 Linux 容器执行器；在 macOS 原生执行器终端确认 `agy --version` 和 `agy models` 均成功 |
| `migrate` 显示 Exited | 退出码为 0 表示迁移完成；非 0 才需要查日志 |
| Blog 不生成 | 检查 Blog Worker、任务队列、`QWEN_API_KEY` 和供应商额度 |
| 页面正常但论文不更新 | 检查 scheduler 日志、Hugging Face 网络与数据日期；`HF_TOKEN` 不是公开数据的硬性要求 |

## 生产部署顺序

1. 准备两个独立 PostgreSQL 数据库、对象或持久文件存储、HTTPS 域名和秘密管理。
2. 备份数据库和论文文件，记录当前提交 SHA 与镜像摘要。
3. 将 `PLATFORM_ORIGIN`、`DEEPLIT_ORIGIN`、`DEEPLIT_PUBLIC_ORIGIN` 和平台公开地址全部改为精确 HTTPS origin。
4. 生成独立数据库密码、SSO secret、CRON secret 和 password pepper；两端只共享 SSO secret。
5. 先部署 OpenResearch 数据库并执行迁移，再部署平台服务并验证 `/healthz`。
6. 部署 DeepLiterature 数据库并执行迁移，再启动 Web。
7. 完成统一登录、授权码重放拒绝、跨用户数据隔离和退出联动验收。
8. 最后启动 scheduler、PDF worker 和 Blog worker，观察队列、费用与错误率。
9. 通过反向代理开放 HTTPS；数据库端口不得暴露公网。

生产环境的执行器使用 `compose.executor.yaml`，为每个工作空间部署独立容器或 VM，并在派生镜像中安装服务端选定的 Agent CLI 与凭据。生产环境不要使用 `localhost`、`host.docker.internal`、默认密码或开发 Compose 覆盖文件。发布前还应完成备份恢复演练、限流、监控告警和 Worker 费用上限配置。
