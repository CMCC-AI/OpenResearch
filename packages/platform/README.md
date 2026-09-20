# OpenResearch 多用户平台

推荐交付：统一云端门户 + 每工作空间独立科研执行器。也可以整体私有化部署。

本 package 独立于上游 `openresearch.sh` 商业账户体系。它不会把多个工作空间的请求代理到同一个无租户的 OpenResearch 实例。主项目仍可独立运行 `orx up`。

完整说明：[多用户架构与部署](../../docs/ai-for-science/multi-user-platform.md)。

## 开发

需要 Node.js ≥22.20、PostgreSQL 17、已构建的 `ui/dist`。数据库必须是专用开发实例。

```sh
npm ci --ignore-scripts
# .env 自行填写 PLATFORM_DB_PASSWORD、PLATFORM_ORIGIN=http://localhost:5300、DATABASE_URL。
docker compose -f compose.yaml -f compose.dev.yaml up -d db
node --env-file=.env src/admin.mjs migrate
# 密码通过 stdin 输入，不作为命令参数；文件权限 0600。
node --env-file=.env src/admin.mjs create-user owner@example.org 管理员 < /secure/initial-password
node --env-file=.env src/server.mjs
```

访问 `http://localhost:5300`。工作空间通过 `<uuid>.localhost:5300` 访问；需要浏览器支持 localhost 子域名。不要把开发数据库、HTTP 入口或初始密码暴露公网。

## 检查

```sh
npm test
node --env-file=.env --test test/integration.mjs
npm audit --omit=dev --audit-level=high
```

集成测试只在指定数据库内创建随机临时 schema，使用两个模拟执行器，最后清理自身 schema；不要指向生产。覆盖匿名拒绝、CSRF、跨空间越权、邀请、只读权限、独立偏好、HTTP/SSE/WebSocket、撤权、凭据撤销和退出。

## 上线边界

这版提供邀请制团队部署，不是已经完成公开商业 SaaS 运营的系统。控制网关目前单副本；每个空间成员共享全部项目。DeepLiterature 已通过一次性授权码、PKCE 和服务端会话内省复用平台账户；尚无企业 OIDC、MFA、计费、云算力自动供给或恶意代码 VM 沙箱。

执行器轮换或撤销只断开平台连接，不保证停止已运行的实验或远端算力。停止实验必须走对应运行的取消接口并确认终态。
