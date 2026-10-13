# 现有 DeepLiterature 复用检查

检查日期：2026-10-13。使用用户授权的 `ssh ubuntu@81.70.174.140` 进行只读检查，没有修改服务器配置、镜像、容器、账号或数据库。

## 已确认的部署

- 公开地址：`http://81.70.174.140:3000/`。
- Web：`deeplit-web-1`，容器服务端口 3000，镜像 `deeplit:local`。
- 另有 `deeplit-cmcc-web-1` 使用相同镜像，外部端口 3004。
- 主服务 Compose 目录：`/home/ubuntu/deeplit/current`，实际发布目录为 `/home/ubuntu/deeplit/releases/20260901T084008Z-3c4d976fa349`。
- PDF 存储：`/home/ubuntu/deeplit/shared/papers`，两个 Web 入口共享挂载。
- PostgreSQL：`deeplit-db-1`，使用既有 `deeplit_postgres_data` 持久卷；数据库端口只绑定 `127.0.0.1:5433`。
- scheduler、pdf-worker、blog-worker 正在运行，复用方案不得停止或覆盖这些既有服务。

## 兼容性结论

公开论文 API 返回 HTTP 200，`paginated=1` 支持 `papers`、`viewerStates`、`authenticated`、`total`、`hasMore`；本次检查返回总数 1,886。这一响应结构与 SONA 当前公共文献读取接口兼容。

现有认证模式为 `dockapi`。源码与已构建路由中没有 `/api/auth/openresearch/start`；公开请求返回 404。已构建认证路由包括本地登录/注册/退出/身份与 `/api/auth/sso/exchange`，不能将这个旧交换接口视为 OpenResearch PKCE 授权协议的替代品。

SONA 当前平台会在登录后进入 OpenResearch SSO 流程。因此只把文献 URL 改成现有服务、继续启用自动 SSO，将导致登录回跳失败。当前完整部署包的新建 DeepXiv 模式也不会自动复用此服务器数据库。

## 方案一：复用公开服务，保留原登录

SONA 后端通过现有公共论文 API 读取、搜索、分页，精读与文库打开现有服务；文库使用原 DockAPI 账号。

这一模式需要关闭平台对该文献服务的自动 OpenResearch SSO 跳转，并明确区分“论文服务已连接”和“统一身份已建立”。保留 SONA 自身登录，不将另一个系统的账号或会话当作 SONA 身份。不修改现有 DeepLiterature 服务、数据库或用户资产。

## 方案二：保留 SONA 同步登录，新增专用文献入口

建议保留现有两个 Web 入口、DockAPI 配置及后台 Worker，在文献服务器新增 SONA 专用 Web 实例。它运行支持 OpenResearch PKCE/授权码与会话内省的版本，通过 SONA 的 20281 网关提供访问；其公共 origin 与 SONA 网关保持一致，登录完成回到 `/sona/projects`。

复用既有论文数据和 PDF 存储，但 SONA 身份使用独立 `openresearch` provider 映射，不按邮箱自动合并旧 DockAPI 文库。现有账号的收藏、笔记、会话仍保留；如果要求 SONA 用户直接获得旧文库，必须核验身份并设计显式迁移。

实施前需要备份现有数据库与 PDF，使用数据库副本验证新应用所需的 schema 迁移与旧 DockAPI 服务兼容性。未经这一验证，不在共享生产数据库执行迁移。新增入口的网络访问范围、应用角色权限及 SSO 密钥要单独配置，不暴露现有数据库公网端口，不复制主数据库到科研服务器。

当前只完成只读评估；两种方案的选择待确认，尚未安装新入口、修改认证模式或重新生成复用版部署包。
