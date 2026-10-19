# 自有服务器：私人科研空间与 OpenCode

本部署模式在同一服务器上共享运行镜像和 OpenCode 安装，每个账户自动获得独立容器和持久卷。复用原有 OpenCode 发现、版本检测和按对话启动机制，不搭建全局共享的 OpenCode 会话服务器。

## 服务拓扑

平台 HTTPS 入口为 `https://research.example.org`，空间入口为 `https://<workspace UUID>.research.example.org`，Deep Literature 为 `https://literature.example.org`。配置根域及通配符 DNS 指向服务器，TLS 证书同时覆盖根域和 `*.research.example.org`。反向代理向平台 `127.0.0.1:5300` 转发，保留原始 Host，支持 WebSocket Upgrade，流式接口关闭代理缓冲。PostgreSQL、orx 和 OpenCode 不发布公网端口。

运行环境管理器独占 Docker socket，公网平台进程不挂载该 socket。各用户容器共享只读镜像层；HOME、XDG 目录、OpenResearch/OpenCode 数据库、Git 和研究产物位于各自数据卷。同一 Linux UID 在不同容器内不代表共享文件；必须保持卷和挂载隔离。

## 管理员部署

先准备 OpenCode 共享配置目录 `/srv/openresearch/config`，目录归容器 UID/GID `1000:1000` 所有且可读写（建议权限 `0700`）。可沿用已有的 `opencode.json`，也可在部署后由系统管理员进入「系统管理 → OpenCode 模型接入」，填写接口类型、供应商 ID、服务地址、API Key 和模型 ID，点击「保存模型接入」。支持 OpenAI 兼容、OpenAI 和 Anthropic 接口。API Key 不回显，留空保留同一供应商已有密钥；无需认证的服务可留空。

平台将配置原子保存到该目录中的 `opencode.json`，保留其他供应商、权限等已有配置，仅更新所填供应商及默认模型。已有文件必须是有效的 JSON 对象；含注释的 JSON/JSONC 需先由管理员转换。保存只校验配置字段，不发送模型请求，也不代表供应商鉴权已成功。不能使用登录在管理员 HOME 下的个人 auth.json 作为所有用户的授权。

平台可写入共享目录，科研空间将其只读挂载到 XDG 全局配置目录，保留 OpenResearch 原有项目及会话配置合并机制。新启动的 OpenCode 进程读取新配置；已有进程不会被强制重启。回到工作台重新检测 OpenCode 以刷新可用模型，已有对话中的模型选择仍然保留。

共享配置中的模型凭据可被空间里的程序读取，因此不要填写供应商主密钥。推荐连接公司内部模型代理，由代理保管主密钥和控制费用。本版没有实现逐用户模型代理凭据签发或用量账本；要求精确用户计量时需后续接入。

在 `packages/platform/.env` 配置以下参数，实际密码和 SSO secret 由管理员生成，不提交 Git：

```dotenv
PLATFORM_ORIGIN=https://research.example.org
OPENRESEARCH_APP_ORIGIN=https://research.example.org
PLATFORM_DB_PASSWORD=<数据库密码>
DEEPLIT_ORIGIN=https://literature.example.org
DEEPLIT_SSO_CLIENT_SECRET=<至少32字符的随机秘密>
MANAGED_OPENCODE_CONFIG_DIRECTORY=/srv/openresearch/config
MANAGED_EXECUTOR_IMAGE=openresearch-managed-executor:hosted
MANAGED_CAPACITY=4
```

仓库根目录构建统一镜像，固定 OpenCode 版本，升级时重新构建并验证兼容性：

```sh
docker build -f packages/platform/Dockerfile.executor --build-arg OPENCODE_VERSION=1.18.33 -t openresearch-managed-executor:hosted .
cd packages/platform
docker compose -f compose.yaml -f compose.hosted.yaml up -d --build
```

从旧部署升级时，将 `MANAGED_OPENCODE_CONFIG_FILE` 改为 `MANAGED_OPENCODE_CONFIG_DIRECTORY`，值为原文件所在目录。已有科研空间容器的挂载不会随平台重建改变，需在维护窗口由管理员重建这些执行器容器并保留 `orx-managed-<workspace UUID>` 数据卷，再由 provisioner 恢复连接；仅重启旧容器不能更新挂载。部署配置中的目录必须与 Docker 宿主机上的绝对路径一致。该目录将整体只读挂载到科研空间，请仅放置需要共享的 OpenCode 配置文件。

运行容器需要能够通过 HTTPS 访问平台根域和文献域。注意公司网络的域名解析、可信 CA 和回环访问条件。不要在服务器使用本机开发用的 `compose.managed.yaml` 或发布 PostgreSQL 的 `compose.dev.yaml`。

默认每个空间限制 1 CPU、1 GiB 内存和 256 个进程；容量上限默认 4。此配置用于小规模内部试运行，需按实际 Agent/实验负载调整 `runtimeConfig` 资源限制。环境健康表示 orx 在线，不代表模型已授权；进入工作台后使用原生 Agent 检测和一条真实对话验证 OpenCode 与模型。

## Deep Literature 统一登录

沿用已有 SSO 服务，无须改造 Deep Literature 代码。在其部署环境配置：

```dotenv
DEEPLIT_AUTH_MODE=openresearch
DEEPLIT_OPENRESEARCH_URL=https://research.example.org
DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN=https://research.example.org
DEEPLIT_OPENRESEARCH_APP_ORIGIN=https://research.example.org
DEEPLIT_PUBLIC_ORIGIN=https://literature.example.org
DEEPLIT_SSO_CLIENT_SECRET=<与平台相同的秘密>
DEEPLIT_COOKIE_MODE=same-site
DEEPLIT_SECURE_COOKIES=true
```

Deep Literature 点击个人文库或精读时建立同一平台 UUID 的本地会话，用户不再输入密码。保留授权码、PKCE 和会话内省；退出、改密、禁用账号按现有协议撤权。其“返回 OpenResearch”回调进入平台首页，再打开自己的空间。公共论文共享，个人文库、笔记、阅读状态按用户隔离。部署与备份 Deep Literature 自身数据库和论文存储，不能只备份平台 PostgreSQL。

## 使用流程与权限

用户注册/登录后进入私人空间首页，平台幂等创建一个托管空间，后台准备容器并自动连接。用户点击“进入科研工作台”，通过一次性票据取得绑定空间子域的 HttpOnly 会话。无需签发 runner token 或配置连接器。

`PRIVATE_USER_SPACES=true` 时，空间列表和全部访问检查同时验证 `created_by`，旧共享 membership 也不能让用户访问别人的空间。关闭邀请接受、成员管理、外部执行器配置和手工空间创建。平台数据库保留兼容的团队表结构，普通本地版模式不变。

离开网页不会停止运行中的任务。容器重启保留对话和项目数据；禁用账户阻止新访问，但不是任务取消。删除接口保留数据卷供管理员恢复，不会永久删除研究文件。当前 runner 凭据有效期仍是 90 天，需管理员在到期前维护，自动续期尚未实现。

## 验收与运行边界

2026-09-30 本机验证：平台 9 项单元测试、16 项 PostgreSQL 集成测试、UI 200 项测试通过；UI 类型检查与构建通过，提交的 `ui/dist` 已重新生成。Linux ARM64 执行器镜像构建成功，固定安装 OpenCode 1.18.33；两个真实容器完成连接、项目隔离、现有 harness 自动发现 OpenCode 和删除保留卷验证。测试清理了自己的临时容器、卷及 schema。没有执行收费模型对话、真实服务器 TLS/DNS 部署或 AMD64 镜像验收。样式检查仍报告现有 `ProductNav.tsx` 的 `text-[11px]`，不属于本轮改动。

- 两个账户各自打开私人空间，创建不同项目/对话；列表、文件、日志和实时流不能跨空间访问。
- 同一账户并发首次打开只创建一个环境；失败可重试，容量满提示管理员处理。
- OpenCode 被原生发现，真实模型调用成功；平台主页也能进入 Deep Literature 个人文库。
- 从科研空间退出后，其子会话及 Deep Literature SSO grant 一并失效。
- 重启环境后项目/对话仍存在，备份恢复覆盖 SQLite、OpenCode 数据和 Git 文件。

受限 Docker 适合可信内部试运行；对外部不可信用户需更强执行隔离。本次配置不自动提供 GPU、供应商授权、模型预算、邮件验证、忘记密码或故障恢复高可用。远端服务器地址、SSH 权限和实际模型 endpoint 未提供时，只能交付可部署代码并在本机开发环境验证。
