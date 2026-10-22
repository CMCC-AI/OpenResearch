# OpenResearch 与 Deep Literature 统一登录

原登录协议核查日期：2026-09-22。运行形态说明于 2026-10-21 统一，见[运行与部署约定](../product/runtime-and-deployment.md)。

## 产品边界

本地个人版的统一账号只负责身份与 SSO，不管理本地研究环境。服务器私人托管版还由平台按用户身份路由独立执行器并自动准备私人空间；研究数据仍不进入账号数据库。

- OpenResearch 本地版负责项目、Agent、模型凭据、Git、环境、算力和实验数据；未登录时展示产品介绍页，登录后进入产品功能区。
- Deep Literature 负责个人文库、笔记、阅读进度和兴趣数据；访问个人能力时需要统一登录。
- 账号服务负责注册、登录、改密、退出和两个产品之间的 SSO。
- 历史团队成员与邀请机制不属于当前用户流程；服务器私人托管版的专属执行器和运行环境则是现行能力，权限以[私人空间说明](../product/private-space-permissions.md)为准。

OpenResearch 的原生设置页保持不变。设置中的 OpenResearch 登录仍用于其已有的组织计算和远程资源能力，不应被解释为本地 Agent 或模型配置。

## 用户流程

1. 用户安装并启动 OpenResearch，未登录时看到产品介绍页，不需要创建空间或配置连接器。
2. 用户点击登录后进入统一账号页，可自助注册或登录。
3. 账号登录完成后，浏览器经过 Deep Literature SSO 建立同一身份的会话，再自动进入 OpenResearch `/projects`。
4. 用户进入“深度文献”浏览论文，文库和精读链接直接复用已有 Deep Literature 会话。
5. Deep Literature 使用 OpenResearch 用户 UUID 映射内部账户；论文、文库、笔记和问答不会按邮箱与旧本地账号自动合并。

本地网页通过账号服务受限的浏览器会话接口读取当前身份，但不接触 HttpOnly 会话 token，也不在本地复制账号数据库。跨产品首次登录通过标准浏览器跳转完成；后续文库和精读使用直接链接。

## SSO 协议

1. Deep Literature 生成 256 位 `state` 和 PKCE verifier，按 state 使用独立的 HttpOnly、SameSite=Lax、10 分钟 Cookie 保存流程状态，只把 challenge 发给账号服务；并发标签页互不覆盖。
2. 账号服务校验固定 client、固定回调地址、state 和 S256 challenge，签发 60 秒一次性授权码；数据库只保存授权码摘要。
3. Deep Literature 回调校验 state，再通过服务端 client secret 和 PKCE verifier 换码。
4. Deep Literature 以 `('openresearch', user_uuid)` 查找或创建内部账户，建立不超过账号根会话寿命的本地会话。

授权和会话不依赖 workspace membership。个人账号即使没有任何工作空间，也能完成 Deep Literature SSO。

## 撤权语义

统一账号根会话是 Deep Literature grant 的父级。账号页退出或修改密码会删除根会话，并通过数据库外键级联清除授权码和 grant。Deep Literature 的账户读取通过服务端 `/api/auth/sso/session` 内省；账户禁用或根会话过期会在下一次请求生效。

团队空间子会话如果仍用于内部部署，可以继续依附同一根会话，但团队成员变化不再影响个人 Deep Literature 身份。

## 配置

账号服务：

```dotenv
PLATFORM_ORIGIN=https://account.example.org
OPENRESEARCH_APP_ORIGIN=https://app.example.org
DEEPLIT_ORIGIN=https://literature.example.org
DEEPLIT_SSO_CLIENT_SECRET=<32字符以上的随机值>
```

Deep Literature：

```dotenv
DEEPLIT_AUTH_MODE=openresearch
DEEPLIT_OPENRESEARCH_URL=https://account.example.org
DEEPLIT_OPENRESEARCH_APP_ORIGIN=https://app.example.org
DEEPLIT_PUBLIC_ORIGIN=https://literature.example.org
DEEPLIT_SSO_CLIENT_SECRET=<同一个随机值>
DEEPLIT_COOKIE_MODE=same-site
DEEPLIT_SECURE_COOKIES=true
```

本地 OpenResearch 使用 `ORX_DEEP_LITERATURE_URL` 读取公开论文 API，使用 `ORX_DEEP_LITERATURE_WEB_URL` 构造浏览器入口。浏览器地址必须与 `DEEPLIT_PUBLIC_ORIGIN` 完全一致；即使都指向本机，也不能混用 `127.0.0.1` 和 `localhost`。两个线上服务必须使用 HTTPS，且 Deep Literature 服务端能访问账号服务的 SSO API。

## 上线前仍需补齐

- 邮箱验证、忘记密码与邮件送达状态。
- 账号删除和 Deep Literature 数据导出/删除联动。
- 登录设备列表、主动撤销其他会话和异常登录通知。
- 旧 Deep Literature 本地账户经人工核验后的迁移工具；不得按邮箱自动合并。
