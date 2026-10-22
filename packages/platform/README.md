# OpenResearch 统一账号服务

自有服务器多用户部署可启用 `compose.hosted.yaml`：自动私人空间、独立数据卷、共享 OpenCode 镜像及 Deep Literature SSO。部署说明见[服务器 OpenCode 模式](../../docs/ai-for-science/self-hosted-opencode.md)。本地个人版入口继续保持原行为。

支持本地个人版与服务器私人托管版，运行形态和推荐配置见[统一约定](../../docs/product/runtime-and-deployment.md)。本地版由门户提供账号和 SSO；托管版还提供私人空间路由与自动执行环境，普通用户不需手工配置连接器。

主项目可独立运行 `orx up`；未登录时显示产品介绍页，登录后进入项目、Agent 和设置。统一账号只提供身份，不读取或同步本地研究数据。

产品说明：[个人版产品主线](../../docs/ai-for-science/product-experience.md)；认证说明：[统一登录](../../docs/ai-for-science/unified-login.md)。

团队邀请、成员管理和 Owner/Editor/Viewer 授权已经移除。工作空间仅作为私人研究环境的隔离单位，所有访问统一验证 `workspaces.created_by` 与当前用户 ID；系统管理员也没有其他用户私人空间的访问特权。执行器通道和 Docker 托管仍用于私人空间运行。旧成员和邀请表只保留历史记录及回滚兼容，不再授予权限。详见[私人空间权限](../../docs/product/private-space-permissions.md)。

## 开发

需要 Node.js ≥22.20、PostgreSQL 17、已构建的 `ui/dist`。数据库必须是专用开发实例。

```sh
npm ci --ignore-scripts
# .env 自行填写 PLATFORM_DB_PASSWORD、PLATFORM_ORIGIN、OPENRESEARCH_APP_ORIGIN、DEEPLIT_ORIGIN、DEEPLIT_SSO_CLIENT_SECRET 和 DATABASE_URL。
docker compose -f compose.yaml -f compose.dev.yaml up -d db
node --env-file=.env src/admin.mjs migrate
node --env-file=.env src/server.mjs
```

访问 `http://localhost:5300`，在页面自助注册个人账号。`OPENRESEARCH_APP_ORIGIN` 必须是实际 OpenResearch Web origin；本地 release 通常为 `http://localhost:4791`，UI 开发服务器示例为 dev-slot 实际分配的地址（slot-1 通常为 `http://localhost:5201`）。不要把开发数据库或 HTTP 入口暴露公网；公网部署必须使用 HTTPS。

## 检查

```sh
npm test
node --env-file=.env --test test/integration.mjs
npm audit --omit=dev --audit-level=high
```

集成测试只在指定数据库内创建随机临时 schema，最后清理自身 schema；不要指向生产。当前同时覆盖个人注册、无工作空间 SSO、退出撤权，以及私人空间归属、旧成员失权和团队接口不可访问。

## 上线边界

这版不是已经完成公开商业 SaaS 运营的账号系统。Deep Literature 已通过一次性授权码、PKCE 和服务端会话内省复用账号；公开上线前仍需邮箱验证、找回密码、MFA/异常登录保护、账号删除和数据导出联动。

## 账号管理

注册自动登录、邮件找回密码、密码显隐和系统管理员用户概况见 [账号管理说明](../../docs/product/account-management.md)。SMTP 凭据仅写入本地 `.env`；未配置时邮件找回明确禁用。

## 精选案例

系统管理员可以从有权访问的已有项目生成研究对话与成果文件快照，经审核后供所有登录用户只读浏览。草稿与下架内容保持私有，案例权限不开放原科研空间。追加迁移 `005.sql` 保存副本，不修改原项目、账号或密码；无需新增环境变量。入口、限额与接口见 [精选案例说明](../../docs/product/featured-cases.md)。`npm run test:integration` 包含案例发布、文件下载和权限回归测试，仍只允许使用独立测试数据库。
