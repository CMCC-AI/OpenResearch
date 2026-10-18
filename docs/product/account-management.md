# 账号注册、密码恢复与系统管理

## 登录和注册

账号入口为本机 `http://localhost:5300/`；同域部署沿用 `/_account/login`。
注册接口在同一事务内创建用户、会话与审计记录，注册完成后自动登录。
普通用户直接进入科研主页，不再把文献 SSO 作为进入主页的前置条件。
明确携带的受支持 SSO `continue` 仍按原流程执行；托管私人空间仍先准备用户自己的环境。

登录、注册、修改密码和重置密码输入框均提供“显示/隐藏”按钮。它只改变输入框类型，
不会读取服务器上的密码。密码仍按原有 scrypt 方案存储，页面不会回显已存密码。

## 邮件找回密码

在登录页选择“忘记密码”。发送接口对存在、不存在和停用的邮箱返回同样的提示，
按 IP 和邮箱限流。邮件链接有效期为 20 分钟，令牌只存 SHA-256 摘要，
通过 URL fragment 传递，页面读取后立即清除地址栏中的令牌。
新申请使旧链接失效；重置后撤销该用户的全部平台会话和关联 SSO 授权。
已登录修改密码、管理员离线重置密码也会使待用找回链接失效。

邮件服务使用 Nodemailer SMTP。把以下字段填入未受版本管理的
`packages/platform/.env`，不要在聊天、代码或日志中填写凭据：

```dotenv
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_FROM=MobileSci <accounts@example.org>
SMTP_USER=accounts@example.org
SMTP_PASSWORD=
```

端口 465 使用 TLS，其他端口强制 STARTTLS，不关闭证书验证。
SMTP_HOST 留空时明确禁用邮件找回，页面提示联系管理员；不会声称邮件已发送。
本机已配置 SMTP 并通过宿主机和账号容器内的 TLS 连接、认证验证；未发送测试邮件。
其他部署环境仍需独立填写发信配置，并验证实际收信。

在 `packages/platform/` 中，用该环境原有 Compose 文件重建环境变量，例如本机：

```bash
docker compose -f compose.yaml -f compose.dev.yaml -f compose.managed.yaml up -d --no-deps platform
```

配置恢复功能后，应使用自己可收信的测试邮箱进行一次申请、收信和重置验收。

参考：[Nodemailer SMTP 配置](https://nodemailer.com/smtp)。

## 系统管理员

后台入口为 `http://localhost:5300/_account/login?admin=1`。
管理员登录默认进入后台，普通用户不能访问后台 API，也不能通过注册参数自授管理员。
后台展示注册用户总数、正常/停用账号数、管理员数量，以及可搜索、分页的姓名、邮箱、
角色、状态、注册时间、最近登录时间和空间数量。不展示密码摘要、令牌或科研内容；
目前只提供用户概况查看，不提供网页提权、删除或停用功能。

管理员是独立的系统权限，不等同于某个研究空间的 owner。
只能使用受控维护命令创建，密码从标准输入读取：

```bash
node --env-file=.env src/admin.mjs create-admin admin@example.org admin < /path/to/protected-password-file
```

命令不会覆盖已有账号。正式环境应填写真实邮箱；本机引导管理员使用
`admin@mobilesci.local`，初始密码保存在 `.mobilesci-run/admin-login.txt`，权限为 0600。
该本机地址不能收邮件，忘记密码时由维护者使用现有 `reset-password` CLI 恢复。
登录后可在“修改密码”中更换初始密码。

## 迁移与验证

`004.sql` 只增补用户元数据和密码重置令牌表；不重置已有密码，不授予现有账号管理员权限。
切换前已将本机 PostgreSQL 数据库和旧镜像备份，位置记录在忽略文件
`.mobilesci-run/account-update.json`。迁移为向前兼容，旧程序忽略新增字段；
回退镜像不能撤销已发生的密码更换或会话撤销，不应直接覆盖升级后的数据库。

验证包括注册自动会话、前端直接跳转、密码显隐、普通用户越权拒绝、管理员只读分页、
邮件配置缺失提示、邮件发送失败、令牌摘要存储、重置并发单次使用、过期、旧链接失效、
会话撤销和 CSRF 检查。所有集成用例使用独立 PostgreSQL schema 和模拟邮件，不发送真实邮件。

## 系统管理统一入口

系统管理员登录后进入 `/admin/users`（MobileSci 子路径部署为 `/mobilesci/admin/users`），侧栏在“用户管理”和“精选案例管理”之间切换。用户管理提供注册统计、姓名或邮箱搜索、账号角色与状态、登录时间及空间数量的只读查看；精选案例管理复用已有快照审核发布流程。科研账号菜单提供“系统管理”入口，项目“添加到精选案例”会直接打开后台案例栏目并选中项目。旧 `/_account/login?admin=1` 和 `/cases/manage` 链接继续兼容。
