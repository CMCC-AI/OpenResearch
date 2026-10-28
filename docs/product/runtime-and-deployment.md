# 运行形态、入口与部署配置

本文是当前运行形态和配置约定的统一入口，更新于 2026-10-27。具体安装步骤引用下方指南；历史团队设计不作为当前私人托管版的权限或部署依据。

## 运行形态

| 形态 | 研究数据与 Agent 所在位置 | 入口与部署说明 |
| --- | --- | --- |
| 本地个人版 | 用户电脑上的 orx、SQLite、文件和 Agent；账号服务不接收本地研究数据库 | 构建版使用 `./start-mobilesci.command`；初次配套服务安装见[本地部署](../ai-for-science/startup-and-deployment.md) |
| 本地源码开发 | dev-slot 隔离的数据目录、后端和 Vite；不代表生产环境 | 使用 `./start-mobilesci-dev.command`；端口由 `scripts/dev-slot.mjs status` 确认，slot-1 通常为后端 4901、前端 5201。见[启动说明](start-mobilesci.md) |
| 服务器私人托管版 | 服务端按用户隔离的 executor、HOME 卷、SQLite、文件和 Agent | 用户登录后自动准备私人空间，无需手动配置 connector。通用部署见[自托管 OpenCode](../ai-for-science/self-hosted-opencode.md)，既有 MobileSci 服务器见[部署与升级](deploy-mobilesci.md) |
| 历史团队原型 | 旧成员、邀请和角色方案的设计与迁移资料 | [多用户平台](../ai-for-science/multi-user-platform.md)和[早期托管设计](../ai-for-science/managed-workspaces.md)按历史资料阅读；不能据此恢复已移除的邀请或成员授权 |

私人托管版的 workspace、provisioner、executor 和原工作台 connector 是实际执行链路，不是待删除的闲置代码。私人空间权限以[当前权限说明](private-space-permissions.md)为准。原工作台 connector 仍需迁移验证后才能退役。

## 统一入口

- 科研主页 `/projects`；论文发现 `/discover`；论文精读 `/literature`；系统管理 `/admin/users`；案例管理 `/admin/cases`。
- `/mobilesci` 部署使用同一组路由加前缀，例如 `/mobilesci/admin/users`。前端资源及导航通过 `appHref` 等现有基路径工具生成，不能硬编码网站根路径。
- 账号门户从 `/api/platform/capabilities` 返回的 `openResearchAppUrl` 计算管理地址，保留部署前缀，不再内部生成 `/_account/login?admin=1`。
- `/_account/login?admin=1` 和 `/cases/manage` 仅作为旧链接兼容入口；登录与管理员权限检查仍有效。新链接统一指向现行路由。
- 本地账号服务的 `OPENRESEARCH_APP_ORIGIN` 必须对应实际前端 origin。开发端口不是固定的 5202，切换入口时检查账号和文献回调配置，不放宽来源验证。

## 推荐 OpenCode 配置

| 所在层 | 推荐参数 | 用途 |
| --- | --- | --- |
| 账号平台 | `OPENCODE_ADMIN_URL` | 连接内部 OpenCode 配置服务，使用官方 global config/provider API；不向公网开放原生配置服务 |
| 通用 hosted Compose 输入 | `MANAGED_OPENCODE_CONFIG_DIRECTORY` | 宿主共享配置目录；默认 `/srv/openresearch/config`，必须与实际宿主目录一致 |
| provisioner 运行环境 | `MANAGED_OPENCODE_LIVE_CONFIG_DIR` | 由 Compose 输入或既有服务器部署路径生成，向 executor 只读挂载整个配置目录 |
| 可选认证文件 | `MANAGED_OPENCODE_AUTH_FILE` | 既有认证 seed，属于凭据链路；不能因清理配置复制参数而一并删除 |
| 执行镜像 | `MANAGED_EXECUTOR_IMAGE`；迁移中的原工作台另有 `MANAGED_CONNECTOR_IMAGE` | 同步维护现有实例、未来实例与持久化配置，保留各自数据卷 |

`compose.yaml + compose.hosted.yaml` 是通用服务器私人托管版入口；`compose.dev.yaml` 用于本地开发账号服务；`compose.managed.yaml` 是历史原型参考，不与 hosted 叠加作为新的生产基线。

`OPENCODE_ADMIN_CONFIG_FILE`、`MANAGED_OPENCODE_CONFIG_DIR`、`MANAGED_OPENCODE_CONFIG_FILE` 保留旧安装适配。它们与 Compose 的 `MANAGED_OPENCODE_CONFIG_DIRECTORY` 不是同一个变量。新部署不推荐旧文件编辑或首次复制配置；迁移到官方 API/live 模式时，迁移工具会同时移除运行环境及 Compose 中被替代的配置来源，并保留认证文件、原工作台身份和其他设置。仍依赖旧模式的安装须先迁移，兼容实现本轮不删除。

## 部署与维护流程

### 执行器工具与文件权限

`packages/platform/Dockerfile.executor` 统一预装 Python 3、`python` 别名、pip、venv、固定版本 uv/uvx、C/C++ 编译工具，以及 Git/SSH、curl/wget、rg、jq、SQLite、ZIP、进程查看和 PDF 文本提取工具。系统 Python 包含 NumPy、pandas、SciPy、Matplotlib、openpyxl、Requests、BeautifulSoup/lxml、Pillow、python-docx、PyPDF2、pyshp 和 Shapely；它们随 Debian 12 软件包维护，不替代项目自己的依赖锁文件。uv 安装在 `/usr/local/bin`，不受已有 HOME 数据卷遮挡；用户安装的命令从 `/home/node/.local/bin` 查找。

临时目录 `/tmp/opencode` 曾被构建时的 root 进程创建为 `0755`，使 UID 1000 的 Agent 无法写入。镜像在 root 安装完成后执行 `orx-prepare-executor`，将该目录及已有构建缓存归属设为 `1000:1000`，目录权限设为 `0700`；运行进程仍为非 root。其他临时脚本优先放在 worktree 或 `mktemp -d` 创建的目录。

每次镜像构建以 UID 1000 执行 `orx-check-executor-tools`，检查预装库导入、临时脚本写入、Python venv/pip 和 uv 离线建环境。部署后也可运行：

```bash
docker exec --user 1000:1000 <执行器容器名> orx-check-executor-tools
```

项目依赖安装进独立 `.venv`，不要用 pip 改写系统 Python；需要复用预装库时可用 `uv venv --system-site-packages .venv`。新依赖下载仍要求执行容器能够访问对应包源，缺少工具不代表网络不可用。

新部署重新构建执行镜像即可。MobileSci 增量更新在本地构建 `executor-packages` 阶段，把 `.deb`、uv 和安装/验证脚本一起装入更新包；服务器构建阶段无需访问 apt、PyPI 或 GitHub。已有私人空间须用包含这些文件的新包执行 `--unified-opencode` 更新，替换存量执行器并同步 provisioner 与持久化 Compose 的 `MANAGED_EXECUTOR_IMAGE`；仅更新 platform/workbench 或重启旧执行器不会补齐工具。旧包不包含此能力，必须重新准备。通用 hosted 部署也必须在空闲维护窗口替换存量执行器、保留 HOME 卷，并同步未来镜像引用。

私人执行器的 `MANAGED_EXECUTOR_MEMORY` 与 `MANAGED_EXECUTOR_MEMORY_SWAP` 均为字节数，后者表示内存与 swap 的合计上限。hosted Compose 默认使用 2.5 GiB 内存、4.5 GiB 合计上限和 `MANAGED_CAPACITY=2`；按宿主总内存、平台服务预留量与实际并发负载调整。显式配置的配额由 provisioner 同步到已有执行器，后续新建执行器使用相同值；旧 connector 保留独立的小额限制。未显式配置时，provisioner 不覆盖运维热调整的已有容器配额。

OpenCode、Claude 和 Codex 共用闲置策略。有效内存不超过 8 GiB 时，OpenCode 每 30 秒检查一次，闲置两分钟释放进程，超过一个的闲置进程在至少闲置 30 秒后按最近使用顺序释放。运行中的对话、等待权限或问题回复、上下文压缩受使用租约保护；回收同时清理进程组，下次消息从持久化原生会话恢复。Linux 按宿主物理内存与 cgroup v1/v2 配额的较小值选择策略，并重新读取配额以适应在线调整。此策略只限制闲置进程，多个同时活跃的会话仍需合理的内存和并发规划。

1. 先确定运行形态，使用对应指南。普通发布使用[现有更新入口](deploy-mobilesci.md)，需要迁移旧配置源时使用 `--unified-opencode` 流程；保留空闲检查、备份、迁移演练、健康验证与回滚。
2. 新镜像、现有 executor/connector 和 provisioner 的未来镜像引用必须一起核查；更新前端或平台并不会自动更新所有存量 runner。还须核查 Nginx 的静态文件来源：直供发布目录时同步该目录，不能仅替换执行器或平台镜像；从对外页面验证资源引用和 JS 哈希。
3. `enable-personal-spaces.py`、`enable-opencode-admin.py` 和 `migrate-deployment.py` 是明确目标的一次性迁移工具；两个 `fix-*` 工具用于存量上传和静态资源修复，不能替代完整发布。使用范围及验收见[材料约定](../ai-for-science/material-inputs.md)和[兼容审计](compatibility-audit-2026-10-21.md)。
4. 迁移工具的配置规则同时用于待启动容器和持久化 Compose，避免一次重启正常、下次重建回到旧配置。
5. 历史研究模式、附件、案例和目录继续读取；清理旧数据或协议另行安排经过验证的迁移，本轮入口和文档统一不改变已有研究。
