# 多用户平台：架构、部署与验收

更新：2026-09-22。代码：`packages/platform`。本方案已暂停进入个人版产品主线，仅作为内部兼容与后续团队版研究记录保留；当前用户流程见[个人版产品主线](product-experience.md)。文中的门户页面、邀请制团队版和执行器向导不再由当前前台暴露。

## 已实现的边界

平台用 PostgreSQL 管理账户、工作空间、成员、邀请、会话、执行器凭据、个人界面偏好和审计记录；研究项目、Agent、实验、Git、日志和文件仍由每个空间专属 OpenResearch 实例管理。原有 SQLite 不需要改成多人共享研究数据库。

这里的工作空间同时承担团队和权限边界，内部所有项目对成员共享。没有独立的组织→多个项目→项目级ACL；需要不同访问范围时创建不同空间。控制面不保管论文正文、模型凭据、Git仓库或实验产物。

旧团队闭环曾设计为：管理员离线引导首个账户 → 登录门户 → 创建空间 → 按接入向导连接专属执行器 → 邀请邮箱 → 接受邀请/建立账户 → 分配角色 → 进入科研工作台。当前账号门户已改为个人自助注册与 Deep Literature SSO，不再提供这些团队入口；如未来恢复团队版，应设计独立的管理员入口。

| 角色 | 权限 |
|---|---|
| 管理员 owner | 科研读写、成员/邀请、执行器凭据、审计；不能移除最后一位管理员 |
| 研究成员 editor | 空间全部项目的读写、Agent、运行与终端；意味着信任其运行代码，不能对其隐藏同一执行器中的秘密 |
| 只读成员 viewer | 明确允许的论文、项目、消息、结果和日志读取；无终端、研究写入和环境凭据读取 |

每个人的导航/布局/Agent选择保存在平台自己的 `workspace_preferences`，不会写进执行器的全局UI状态。只读成员可以修改自己的界面偏好。

管理员可以在“空间管理”的危险操作区删除工作空间，必须输入完整空间名称确认。删除会移除平台中的成员、邀请、偏好、执行器凭据和空间会话，并立即断开在线执行器；审计记录保留为无空间外键的删除事件。执行器机器上的SQLite、Git仓库和实验产物不会自动删除，管理员应在确认不再需要后单独回收。

## 请求与认证

门户域名如 `research.example.org`，每个工作空间为 `<workspace-uuid>.research.example.org`。不同子域名隔离Cookie、localStorage和前端查询缓存；不是通过浏览器传入任意 tenant ID 后直接信任它。

1. 登录密码用异步 scrypt（N=32768、r=8、p=1）加随机salt保存。平台登录尝试限流存入PostgreSQL。登录和修改均检查Origin。
2. 会话为256-bit随机token，数据库仅保存SHA-256；12小时过期。HTTPS部署Cookie使用 `__Host-`、Secure、HttpOnly、SameSite=Lax，绝不设置Domain。
3. 进入空间时，门户签发60秒一次性票据，用POST表单交换空间专属会话。票据绑定用户原始会话和空间；不出现在URL、Referer或日志。
4. 空间会话引用门户会话；门户退出级联撤销子会话。每次API重新查询账户、会话和成员；流连接每5秒复核，成员变更主动断开该空间现有通道。
5. 网关不转发浏览器Cookie、Authorization、任意代理头或上游Set-Cookie；执行器不会得到平台登录凭据。研究文件响应附加sandbox CSP，避免产物HTML在空间身份下执行脚本。

平台只接受配置的门户Host和合法空间Host，不信任X-Forwarded-Host。外部反向代理需保留Host；生产Origin必须HTTPS。登录来源限流默认使用TCP对端地址，不信任客户端可伪造的X-Forwarded-For；反向代理场景建议额外在可信网关按真实客户端地址限流。

## 执行器协议

管理员签发90天凭据，只显示一次，数据库仅存hash。一个空间一个有效凭据/在线通道；轮换或撤销关闭旧通道。执行器主动以Bearer握手连接 `wss://门户/_platform/runner`，无需开放用户机器入站端口。

门户接入向导允许管理员下载凭据文件，选择 Docker 或本机运行方式，复制完整启动命令，并自动轮询认证状态直至可以进入工作台。下载文件仍需保存在目标机器的私有位置；向导生成的命令会在启动前把权限收紧为0600。已有凭据不能重新读取，遗失时必须轮换。

协议多路复用HTTP请求、SSE与项目终端WebSocket；请求由随机ID关联，不自动重放失败写入。断线后连接器指数退避并加抖动重连。项目状态、运行记录和恢复仍由OpenResearch负责，不以HTTP成功表示实验成功。

安全限制：最多64个活动请求、8个正在读取的请求体；请求体8MiB；普通响应64MiB；分帧与发送缓冲上限；请求超时120秒，SSE最多30分钟后由客户端重连。文件较大时应后续引入授权对象存储，不任意扩大内存上限。

执行器目标固定为显式配置的 `http://127.0.0.1:端口` 或IPv6回环；不接受浏览器指定目标。仅转发受限 `/api/` 路由，拒绝内部callback、上游账户登录、升级、数据目录迁移、远程主机管理等操作。模型/工具安装由执行器管理员离线配置。

**协议通道不是恶意代码沙箱。** 必须给每个空间独立OS用户或容器/VM、HOME、数据卷、代码仓库及凭据。不要把多个空间连到同一个本地orx，也不要共享docker.sock或全局SSH目录。对于互不信任的公网用户，采用独立VM/强沙箱与网络出口策略后再开放执行。

## 云端/私有化部署

交付物包括 `Dockerfile`、`compose.yaml`、`Dockerfile.executor`、`compose.executor.yaml`。镜像未包含生产secret；`.dockerignore`排除.env、凭据和本地数据库。

1. 准备门户域名及通配符DNS，TLS证书覆盖门户和 `*.门户域名`。反向代理同时转发HTTP与WebSocket到平台5300，保留Host、Origin，关闭SSE代理缓冲；上游读超时大于30分钟。
2. 在 `packages/platform/.env` 设置强随机 `PLATFORM_DB_PASSWORD`（建议hex）、HTTPS的 `PLATFORM_ORIGIN`。生产平台通过内部网络连PostgreSQL，不发布数据库端口。
3. `docker compose up -d --build`：数据库健康后一次性迁移，再启动非root平台容器。端口5300只绑定回环，由TLS反向代理访问。不要在生产加载 `compose.dev.yaml`。
4. 创建首个账户：`docker compose exec -T platform node src/admin.mjs create-user owner@example.org 管理员 < /secure/initial-password`。密码文件权限0600，用完移入秘密管理。找回密码使用同一命令的 `reset-password EMAIL`，会撤销该账户所有会话。
5. 登录创建空间、邀请成员、签发执行器凭据。权限和空间都在数据库中，不能由前端角色字段决定。

平台目前是**单网关副本**：通道注册在内存中，不支持在负载均衡后随意扩容多个平台副本。平台重启后执行器重连；正在传输的浏览器请求会失败，不会被自动执行两次。扩容需要共享路由/连接归属设计，不能仅增加replicas。

## 执行器部署

自有电脑/服务器方式：在专属账户/VM中安装原有OpenResearch和所需Agent CLI，启动 `orx up --no-browser --no-telemetry`，随后启动连接器：

```sh
PLATFORM_ORIGIN=https://research.example.org \
RUNNER_TOKEN_FILE=/secure/runner.token \
ORX_UPSTREAM=http://127.0.0.1:4791 \
RUNNER_STATE_DIR=/private/workspace/connector \
RUNNER_ISOLATION_ACK=dedicated-workspace \
node packages/platform/src/runner.mjs
```

`RUNNER_ISOLATION_ACK`是部署者确认，不是软件提供了沙箱。连接器使用独占锁防止同目录重复启动；异常断电遗留锁时先确认进程已退出，再由管理员移除锁文件。每个空间的状态目录、上游实例必须不同。

容器方式：在 `packages/platform` 中为每个空间使用不同Compose项目名：

```sh
PLATFORM_ORIGIN=https://research.example.org \
RUNNER_TOKEN_FILE=/secure/runner.token \
docker compose -p research-team-a -f compose.executor.yaml up -d --build
```

本地 Docker 联调时，执行器容器通过宿主机访问平台：

```sh
PLATFORM_ORIGIN=http://localhost:5300 \
PLATFORM_CONNECT_URL=http://host.docker.internal:5300 \
ORX_DEEP_LITERATURE_URL=http://host.docker.internal:3000 \
ORX_DEEP_LITERATURE_WEB_URL=http://localhost:3000 \
RUNNER_TOKEN_FILE=/secure/runner.token \
docker compose -p research-team-a -f compose.executor.yaml up -d --build
```

`host.docker.internal` 只允许用于本地 HTTP 容器桥接。公网平台仍必须使用 HTTPS。

该模板不发布orx端口，使用非root用户、独立HOME卷、4CPU/8GiB/512进程限制、关闭额外capability。凭据文件须可由容器UID1000读取且不对其他用户开放。Agent CLI、Python依赖、GPU运行时和模型授权应做成受控派生镜像/环境；模板不会自动采购算力或安装所有Agent。容器共享内核且有默认出站网络，不作为公网恶意代码隔离方案。

Deep Literature 地址需要在执行器环境显式设置 `ORX_DEEP_LITERATURE_URL` 与浏览器可达的 `ORX_DEEP_LITERATURE_WEB_URL`。容器内默认 127.0.0.1 不会指向宿主文献服务，浏览器地址则必须与 Deep Literature 公开 origin 完全一致。统一登录阶段通过一次性授权码与 PKCE 建立 Deep Literature 会话；随后精读链接直接复用该会话。个人文库、笔记和问答按 OpenResearch 用户 UUID 隔离，系统不会按邮箱自动合并旧 Deep Literature 账户。

## 运维与未完成项

备份平台PostgreSQL、每个空间的执行器SQLite/Git/产物以及Deep Literature数据。恢复后校验空间→执行器映射，不把团队A的卷挂到团队B。审计不保存密码、邀请token、模型prompt或原始请求体；当前记录登录、授权变更和科研写操作入口，不代表上游操作已经成功。

撤销执行器仅关闭访问，不自动停掉已经运行的实验和远端GPU。需要取消时调用原有run cancel并确认终态、资源释放，再回收执行器。测试环境恢复、生产RPO/RTO、容量和故障演练需按部署规模完成。

后续事项：企业OIDC/MFA、旧 DeepLiterature 账户的人工核验迁移、项目级细粒度权限、托管算力自动供给、统一预算硬停、持久化调度/多网关、集中监控和对象存储。不要把本轮邀请制多用户能力描述成这些功能已经完成。

## 验证方法

`npm test`验证密码、Origin/Host和角色策略；`npm run test:integration`使用专用PostgreSQL临时schema和两个不同的上游执行器，测试跨空间IDOR、CSRF、邀请重放、最后管理员保护、个人偏好隔离、HTTP/SSE/终端、撤权和凭据失效。CI新增 `multi-user platform` 作业。

前端使用原有UI build/typecheck/tests，并通过`CloudWorkspace`显示当前成员身份、只读状态、执行器离线及访问失效提示。本地 `orx up` 不受云端包装影响。

容器烟雾测试（从仓库根目录构建镜像后，在package目录执行）：

```sh
docker run --rm -i --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1g --entrypoint node openresearch-platform-executor:dev \
  --input-type=module - < test/executor-smoke.mjs
```

该检查在一次性非root容器内启动无Agent的orx，创建空白Git项目，结束即删除容器；不挂载个人数据或调用模型。

2026-09-21本轮结果：平台5项单元测试通过，PostgreSQL/双执行器及真实OpenResearch只读联调10项通过；原前端164项、dev-slot 9项、Rust 882项通过（2项按原项目配置忽略）；类型检查、格式检查、clippy、构建通过。平台与Linux执行器镜像构建成功；非root执行器健康与空白Git项目创建通过。内置浏览器访问新端口被客户端拦截，未将页面视觉验收标记为通过。未运行付费模型/云GPU、公网TLS或Windows部署验收。

生产上线还需独立配置最低权限数据库运行账户（迁移账户与运行账户分离）、外部可信网关限流、监控告警及备份恢复演练。Compose内置数据库模板用于独立实例起步，不能替代机构数据库安全配置。
