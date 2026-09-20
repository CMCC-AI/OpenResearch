# OpenResearch 与 DeepLiterature 统一登录

核查日期：2026-09-21。

## 最终边界

OpenResearch 是托管产品唯一的登录入口和会话权威。DeepLiterature 保留自己的用户主键、文库、笔记、阅读进度与兴趣数据，但只用不可变的 OpenResearch 用户 UUID 建立身份映射。旧 APP-CMCC / DockAPI 的 iframe 消息桥、换票 API、配置和文档已从 DeepLiterature 删除。

本地开发仍可把 `DEEPLIT_AUTH_MODE` 设为 `local`，使用 DeepLiterature 原有邮箱登录；生产托管模式必须为 `openresearch`。两种模式不能在同一实例中同时接受，避免本地密码会话绕过统一撤权。

## 浏览器流程

1. 用户在 OpenResearch `/literature` 点击“进入 Deep Literature 精读”。云工作空间把目标改写为 DeepLiterature `/api/auth/openresearch/start?returnTo=/abs/{paper}`。
2. DeepLiterature 生成 256 位 `state` 和 PKCE verifier，在 HttpOnly、SameSite=Lax、10 分钟 Cookie 中保存流程状态；浏览器只把 challenge 发给 OpenResearch。
3. OpenResearch 未登录时先回到门户。门户只接受同源 `/api/auth/sso/authorize?...` 作为继续路径；登录后恢复授权流程。
4. OpenResearch 校验固定 client、固定回调地址、state 和 S256 challenge，签发 60 秒一次性授权码。授权码数据库只保存 SHA-256 摘要。
5. DeepLiterature 回调同时校验 state Cookie，再通过服务端 client secret 和 PKCE verifier 换码。错误 verifier 也会消耗授权码，不能在线试探后重放。
6. DeepLiterature 以 `('openresearch', user_uuid)` 查找或创建内部账户，建立不超过 OpenResearch 根会话寿命的本地会话，再清理 URL 中的 code 并返回论文页。

## 撤权语义

OpenResearch 根会话是门户、工作空间子会话和 DeepLiterature grant 的共同父级。门户退出或修改密码会删除根会话，数据库外键级联清除授权码和 grant；工作空间连接也随之失效。

DeepLiterature 的每次账户读取都通过服务端 `/api/auth/sso/session` 内省，不做跨请求缓存。账户禁用、根会话过期和工作空间成员撤权会在下一次请求生效。DeepLiterature 退出会调用 `/api/auth/sso/logout` 删除根会话，因此也会退出门户和所有工作空间。

## 安全属性

- 授权码、launch ticket 和会话 token 均随机 256 位；数据库只存授权码与会话 token 摘要。
- 回调地址固定为配置的 DeepLiterature origin，不接受用户提供的外部跳转。
- `returnTo` 只允许单斜杠开头的本地路径，最大 2000 字符。
- client secret 使用恒定时间比较，只在服务端请求头中传递。
- 授权码 60 秒过期且一次性；PKCE、state、精确 redirect URI 三重绑定。
- SSO 授权和服务接口使用 PostgreSQL 共享限流，适用于多网关部署。
- DeepLiterature 不按邮箱合并账户。旧本地账户数据需要管理员核验身份后单独迁移。

## 配置与发布

OpenResearch：

```dotenv
PLATFORM_ORIGIN=https://research.example.org
DEEPLIT_ORIGIN=https://literature.example.org
DEEPLIT_SSO_CLIENT_SECRET=<32字符以上的随机值>
```

DeepLiterature：

```dotenv
DEEPLIT_AUTH_MODE=openresearch
DEEPLIT_OPENRESEARCH_URL=https://research.example.org
DEEPLIT_PUBLIC_ORIGIN=https://literature.example.org
DEEPLIT_SSO_CLIENT_SECRET=<同一个随机值>
DEEPLIT_COOKIE_MODE=same-site
DEEPLIT_SECURE_COOKIES=true
```

先应用 OpenResearch `packages/platform/migrations/002.sql`，再应用 DeepLiterature `db/migrations/011_openresearch_sso.sql`。之后先发布 OpenResearch，再发布 DeepLiterature。两个服务必须通过 HTTPS，且服务器之间能访问 OpenResearch 的 SSO API。

验证项目包括：错误 client secret、错误 PKCE、授权码重放、错误用户/会话绑定、平台退出后的 grant 失效、DeepLiterature 统一退出、两个 OpenResearch 用户映射到不同文库账户。当前实现不包含旧本地账户的自动合并工具。
