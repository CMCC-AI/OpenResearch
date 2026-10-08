# OpenResearch 统一账号服务

自有服务器多用户部署可启用 `compose.hosted.yaml`：自动私人空间、独立数据卷、共享 OpenCode 镜像及 Deep Literature SSO。部署说明见[服务器 OpenCode 模式](../../docs/ai-for-science/self-hosted-opencode.md)。本地个人版入口继续保持原行为。

当前用户主线：OpenResearch 本地版 + Deep Literature + 统一账号。此 package 的门户负责个人注册、登录、改密、退出和 Deep Literature SSO，不再向个人用户展示工作空间或执行器配置。

主项目可独立运行 `orx up`；未登录时显示产品介绍页，登录后进入项目、Agent 和设置。统一账号只提供身份，不读取或同步本地研究数据。

产品说明：[个人版产品主线](../../docs/ai-for-science/product-experience.md)；认证说明：[统一登录](../../docs/ai-for-science/unified-login.md)。

工作空间、成员角色、执行器通道和本机 Docker 托管实现暂作为内部兼容能力保留。相关 API 和部署文件不是当前个人版交付入口；需要继续内部验证时见[多用户架构与部署](../../docs/ai-for-science/multi-user-platform.md)。

## 开发

需要 Node.js ≥22.20、PostgreSQL 17、已构建的 `ui/dist`。数据库必须是专用开发实例。

```sh
npm ci --ignore-scripts
# .env 自行填写 PLATFORM_DB_PASSWORD、PLATFORM_ORIGIN、OPENRESEARCH_APP_ORIGIN、DEEPLIT_ORIGIN、DEEPLIT_SSO_CLIENT_SECRET 和 DATABASE_URL。
docker compose -f compose.yaml -f compose.dev.yaml up -d db
node --env-file=.env src/admin.mjs migrate
node --env-file=.env src/server.mjs
```

访问 `http://localhost:5300`，在页面自助注册个人账号。`OPENRESEARCH_APP_ORIGIN` 必须是实际 OpenResearch Web origin；本地 release 通常为 `http://localhost:4791`，UI 开发服务器示例为 `http://localhost:5202`。不要把开发数据库或 HTTP 入口暴露公网；公网部署必须使用 HTTPS。

## 检查

```sh
npm test
node --env-file=.env --test test/integration.mjs
npm audit --omit=dev --audit-level=high
```

集成测试只在指定数据库内创建随机临时 schema，最后清理自身 schema；不要指向生产。当前同时覆盖个人注册、无工作空间 SSO、退出撤权，以及保留的工作空间兼容接口。

## 上线边界

这版不是已经完成公开商业 SaaS 运营的账号系统。Deep Literature 已通过一次性授权码、PKCE 和服务端会话内省复用账号；公开上线前仍需邮箱验证、找回密码、MFA/异常登录保护、账号删除和数据导出联动。
