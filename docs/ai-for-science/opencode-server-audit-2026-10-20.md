# OpenCode 模型配置与服务器检查（2026-10-20）

本次通过 SSH 只读检查 MobileSci 服务器，核对仓库代码，并在服务器现有镜像的无网络临时容器中验证 OpenCode 1.18.32。未修改生产配置、重建生产容器或发送模型请求。

## 线上确认的根因

| 环节 | 当前状态 | 结果 |
| --- | --- | --- |
| 平台进程 | 支持网页模型配置，但没有 `OPENCODE_ADMIN_CONFIG_FILE` | 管理接口返回 `enabled: false` |
| 平台挂载 | 没有 OpenCode 配置目录挂载 | 单独设置环境变量仍不能持久保存 |
| provisioner | 支持 `MANAGED_OPENCODE_LIVE_CONFIG_DIR`，但仅设置旧的 `MANAGED_OPENCODE_CONFIG_DIR` | 新空间只复制初始配置 |
| 已有私人执行器 | 共享目录挂到 `/run/orx-seed/opencode:ro` | 实际读取个人 HOME 内的副本，网页更新不会同步 |
| 原管理员工作台 | 已直接挂载 `/opt/mobilesci/state/opencode` | 配置变化可被新启动的 OpenCode 进程读取 |
| 持久化 Compose | 同样缺少管理员配置路径和 live 目录参数 | 仅临时调整运行容器不能保证重建后保持修复 |

共享目录和私人空间目前均只有 `opencode.jsonc`，该文件是可用严格 JSON 解析的内容，仅有 `$schema`、MCP 和权限配置，没有 `provider` 或默认 `model`。检查到原工作台 `auth.json` 含 Google API 认证记录；只检查了供应商 ID 和认证类型，没有读取或输出密钥值，也没有验证其有效性。

检查时原工作台和一个普通私人执行器都没有活动 Agent 或运行中的实验。该结果不是之后重启的许可条件：执行修复前仍需重新检查活动任务、待发送消息和调度租约。

## 配置链路与现有能力

1. 管理页面通过 `GET/POST /api/platform/admin/opencode` 读取和保存配置。
2. 服务端校验登录、管理员权限、请求来源和字段格式；浏览器不能指定写入路径。
3. 仅支持 `@ai-sdk/openai-compatible`、`@ai-sdk/openai`、`@ai-sdk/anthropic`。原生 Google 接入不在当前表单支持范围内；已有 Google 认证也不会自动成为此表单中的 API Key。
4. 保存会合并指定供应商、模型和默认 `provider/model`，保留其他供应商及配置。已有供应商/模型白名单、黑名单会相应调整。
5. API Key 不回显。留空保留同一供应商的旧密钥，不能用于清除旧密钥；换供应商不会继承另一供应商的密钥。
6. 保存通过目录内临时文件加 rename 原子替换，使用进程内队列串行写入。应挂载整个目录；只挂载单个文件不能可靠跟随原子替换。
7. 保存只做字段及文件校验，不检查远端可达性、鉴权、模型存在性或 SDK 是否成功加载。
8. OpenCode 启动时读取配置，OpenResearch 再叠加会话、项目和本地模型配置。已有进程和已有会话模型选择不会因保存而自动切换。

“统一配置”目前提供共享供应商和默认模型，并不是禁止用户程序访问凭据或禁止项目覆盖配置的模型网关。

## 需要处理的其他逻辑缺口

- **JSONC 覆盖风险**：网页只读取和更新指定的 JSON 文件，不检查同目录 JSONC。服务器版本实测在两个文件字段冲突时，JSONC 覆盖 JSON。目前旧 JSONC 没有模型字段，不构成现有冲突，但以后可能产生“保存成功，默认模型未改变”。迁移时宜合并为一个有效的 `opencode.json`，保留 MCP/权限内容，将旧文件备份到配置搜索目录之外。
- **本地模型与共享模型检测不一致**：`src/local/harness/opencode.rs::snapshot_config` 在存在 OpenResearch 本地模型连接、且没有 inline 配置时从空对象开始，忽略全局供应商；存在 inline 配置时也直接采用 inline 内容。服务器原版实测 inline 内容会与全局配置合并。对仅靠全局 JSON 配置、没有 auth.json 认证记录的供应商，当前检测逻辑可能遗漏其模型或默认选择。应让快照与 CLI 的合并行为一致，或在不能完整解析时走隔离的解析流程。
- **表单状态**：保存新供应商后组件没有刷新最初的 `settings`，再切换供应商时“已配置密钥”提示可能过时。后端仍按文件实际状态保存，应在保存后刷新查询或更新保存基线。
- **密钥生命周期**：没有单独的删除密钥操作，也没有多供应商管理列表。需要区分“留空保留”和“明确删除”，不能用空输入实现删除。
- **部署覆盖风险**：`scripts/deploy/server.sh` 会将部署包内配置覆盖复制到共享目录。网页启用后不能继续把本地配置当成服务器配置的唯一来源，应改为首次初始化或显式导入，避免后续全量部署覆盖管理员保存结果。

## 服务器修复配置

将以下字段合并到服务器 `/opt/mobilesci/current/compose.yaml` 的现有服务中，保留服务原有环境变量、镜像、挂载和私有空间路由设置；这不是完整 Compose 文件。

```yaml
services:
  platform:
    environment:
      OPENCODE_ADMIN_CONFIG_FILE: /run/orx-opencode/opencode.json
    volumes:
      - /opt/mobilesci/state/opencode:/run/orx-opencode:rw
  provisioner:
    environment:
      MANAGED_OPENCODE_LIVE_CONFIG_DIR: /opt/mobilesci/state/opencode
```

平台以 UID/GID `1000:1000` 运行，宿主共享目录需允许该身份读写。目录建议权限 `0700`；在保留原权限和备份的基础上确认文件可由执行器同一 UID 读取。不要把 API Key 放进 Compose、命令参数或日志。

`MANAGED_OPENCODE_CONFIG_DIR` 是旧的首次复制参数。迁移完成后可以去掉；已有 `MANAGED_OPENCODE_AUTH_FILE` 应保留，除非另行迁移认证。直接设置 live 参数不需要升级当前服务器 OpenCode 或 provisioner 代码。

普通私人执行器的目标挂载是：

```text
/opt/mobilesci/state/opencode:/home/node/.config/opencode:ro
```

现有 `orx-managed-89f6040c-2073-4c7b-b0e3-887516cae9a2` 需要重建容器才能获得此挂载；必须保留其同名 HOME 数据卷和原有镜像、环境及其他挂载。provisioner 不会自动迁移已有容器的挂载。原管理员空间使用 connector 连接老工作台，connector 不运行 OpenCode；老工作台已有共享目录挂载，无需为这项修复重建 connector。

## 执行顺序、验收和回滚

1. 再检查所有受影响空间的活动任务、排队消息和调度租约。保存当前 Compose、配置目录、容器 inspect 元数据和必要的数据库备份，备份仅当前管理员可读。
2. 校验旧 JSONC 为有效 JSON，保留 MCP、权限、插件、skills 等现有内容，整理唯一的模型配置源。保留认证文件，不从本机重新导入或覆盖线上密钥。
3. 校验合并后的 Compose。短暂停止 provisioner，防止它在私人执行器替换期间抢先创建同名容器。
4. 重建平台容器应用可写目录挂载；确认健康和管理员 GET 接口返回 `enabled: true`。字段为空是尚未填写模型，不应再显示服务器未启用。
5. 保留数据卷重建普通私人执行器，改用 live 只读目录挂载。通过原入口确认研究项目、对话仍存在及执行器连接正常。
6. 重建/启动带 live 参数的 provisioner，确认之后新建空间使用相同挂载。同步持久化 Compose，防止未来恢复旧设置。
7. 在管理员页面填写真实供应商、Base URL、模型 ID、API Key。使用 OpenAI 兼容服务时 Base URL 应是供应商要求的根路径，例如 `/v1`，不是完整的 `/chat/completions` 地址。
8. 先仅校验文件、权限、解析后供应商/模型和跨容器可见性，禁止输出密钥。真实模型调用需另行进行一条最小请求，记录成功或具体 HTTP/SDK 错误；页面保存和平台健康均不能替代该验收。现有 OpenCode 检测代码可能对 auth.json 供应商发起鉴权探测，因此不能将“重新检测”视为绝对不调用模型的检查。

回滚时先停 provisioner，恢复原 Compose 和配置目录，恢复原平台、私人执行器容器配置，再启动 provisioner。保留旧容器作为短期回滚入口，但不能同时启动两个使用同一 HOME 数据卷的执行器；不要删除或清空研究数据卷。

仓库后续需同步维护 `mobilesci.py` 的初始部署配置、`enable-personal-spaces.py` 的 live 参数、增量更新配置迁移/预检和 `server.sh` 的配置初始化策略。当前增量更新保留旧 Env/HostConfig，不会自动完成本次修复。

## 本次验证

- 平台配置及容器配置测试：8/8 通过，覆盖管理员/普通用户、来源校验、密钥隐藏与保留、原子写入失败、挂载及数据卷保留逻辑。
- 部署脚本测试：26/26 通过。现有测试没有覆盖线上旧配置迁移，测试通过不能证明部署接线完整。
- 服务器现有镜像，无网络临时容器：JSON 配置、JSONC 冲突覆盖、inline 与全局配置合并、只读目录下 `debug config --pure` 均通过。只读解析不等于所有 SDK/插件首次安装也能成功，真实运行仍需单独验收。
- 生产服务未变更；未验证实际模型 endpoint、密钥有效性、模型调用或费用。

官方配置合并说明：https://opencode.ai/docs/config/ 。本报告对当前服务器版本的优先级结论以隔离实测为准。

## 后续实施结果（2026-10-20，已部署）

用户确认实施后，已将平台接入内部 OpenCode 1.18.32 的官方 `GET/PATCH /global/config`、`GET /provider` 接口。配置服务复用既有安装镜像，监听宿主回环 `127.0.0.1:4970`，不对浏览器开放原生服务。网页通过平台管理员接口操作，只返回供应商、模型、地址及连接/密钥状态。新页面支持官方供应商目录、默认模型、内置服务地址和自定义 OpenAI 兼容服务；保留原有 Google 认证。官方预设使用按模型指定的 SDK 和地址，只有显式自定义时才覆盖，避免多 SDK 供应商路由被错误固定。

已保留 HOME 数据卷迁移现有普通私人执行器，统一只读挂载 `/opt/mobilesci/state/opencode`。原管理员工作台沿用已有目录挂载。provisioner 改为 live 配置模式，持久化 Compose 同步服务及参数。原生接口能直接更新已有 JSONC，保留 MCP/权限，无须另建一个可能被 JSONC 覆盖的 JSON 文件。保存的新配置由之后启动的 OpenCode 会话进程读取，既有进程和会话选择不被强行切换。

仓库同时修正全局/inline/本地模型配置合并检测、保存后表单凭据提示、全量部署覆盖服务器配置的问题。提供 `update-mobilesci.py --unified-opencode` 和默认只读的 `enable-opencode-admin.py` 迁移工具，包含任务检查、备份、数据卷保留、失败回滚和持久化步骤。

首次更新因历史 `006.sql` 的 CRLF 校验差异在生产容器替换前停止。核对确认 SQL 内容未变，部署工具随后仅在已部署文件哈希与数据库记录一致、且与包内文件仅有换行差异时，在临时构建目录保留原文件字节；没有修改数据库迁移记录。其他 SQL 内容变化仍会拒绝部署。

线上最终验收：

- 管理员接口返回 200、`enabled: true`、`backend: opencode`；识别 Google 的 39 个模型，兼容供应商可获得官方默认地址。
- 匿名读取 401，普通用户读写 403，跨域写入 403；响应不含上游原始 `key`、`options` 字段。测试会话均已删除。
- 配置服务、原工作台和私人执行器读取的 `opencode.jsonc` 内容完全相同；私人执行器原 HOME 卷保留且挂载只读配置，健康状态正常。
- 两个现有运行空间状态为 ready；持久化 Compose 包含配置服务、管理员 API URL、live 配置目录，平台重建镜像与当前运行镜像一致。
- 没有为验收发送真实模型请求，因此未验证现有密钥的供应商授权、可用额度或付费模型调用。

本轮验证：平台单元测试 28 项、独立临时 PostgreSQL 数据库集成测试 40 项、UI 测试 368 项、部署测试 30 项通过；Rust 测试 1172 项通过、3 项忽略，Clippy、Rust 格式检查、平台格式检查及前端构建通过。全局样式检查仍有 `ChatPanel.tsx:6322` 两处既有 raw-color 问题，该文件未在本次修改。

迁移回滚元数据：`/home/ubuntu/.mobilesci-opencode-upgrade-20261020T033722Z`。最终平台更新回滚元数据：`/home/ubuntu/.mobilesci-sidebar-upgrade-20261020T034446Z/rollback.json`。旧容器保留且停止，数据卷未删除。服务器配置、认证备份包含凭据，保持私有，不应分享。
