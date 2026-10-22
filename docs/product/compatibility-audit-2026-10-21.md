# 兼容与过时内容核查（2026-10-21）

## 范围和结论

本次静态核查覆盖 `src/`、`ui/src/`、`packages/platform/src/`、部署脚本及产品文档，并结合当天已完成的线上容器、上传链路和静态资源验证。没有在本次核查中修改业务代码、删除数据库字段、删除容器或部署配置；没有新增生产数据统计。带有 legacy、compatibility 或“兼容”字样不等于无人使用。

项目确实保留多层历史兼容，其中最应先处理的是产品文档的适用范围和旧入口的内部调用。其余分支应先确定最低支持版本、历史数据迁移与线上使用情况，再逐项退役，不能直接整块删除。

## 发现与处理顺序

| 项目 | 代码与证据 | 判断 | 处理建议与退出条件 |
| --- | --- | --- | --- |
| 产品主线文档的范围不清 | `docs/ai-for-science/README.md`、`architecture.md`、`product-experience.md`、`startup-and-deployment.md` 将工作空间和托管执行器称为内部兼容能力；当前 MobileSci 服务器已实际使用私人空间、provisioner、executor 和原工作台 connector | 文档需要明确版本和运行形态。不能据此判断托管后端是死代码 | 优先区分本地个人版、服务器个人托管版和历史团队版，并为旧方案标明归档日期及替代文档。保留本地数据边界的说明 |
| 旧管理入口仍有内部生成方 | `ui/src/routes/cases.manage.tsx` 把 `/cases/manage` 重定向到 `/admin/cases`；`packages/platform/public/platform.js` 仍生成 `/_account/login?admin=1` 链接 | 两个入口属于不同路由链路；旧链接尚不能一概视为仅供外部书签使用 | 先统一内部生成链接，再验证根路径和 `/mobilesci`、登录回跳及项目参数；重定向保留一段迁移期，不必维护两套页面 |
| OpenCode 网页配置双后端 | `packages/platform/src/opencode-settings.mjs::opencodeSettings(file, apiUrl)` 同时支持官方 API 与直接编辑 JSON 文件；`server.mjs` 同时接受 `OPENCODE_ADMIN_URL` 和 `OPENCODE_ADMIN_CONFIG_FILE` | 属于可规划退役的旧部署适配，不是已证实的死分支。自托管文档仍明确支持文件模式 | 正式声明官方 API 为推荐配置；核查自托管安装是否仍使用文件模式，明确最低支持要求后再删除旧实现和专属测试 |
| OpenCode 初始复制和实时挂载并存 | `packages/platform/src/provisioner.mjs` 同时处理 `MANAGED_OPENCODE_CONFIG_DIR`、`MANAGED_OPENCODE_CONFIG_FILE` 和 `MANAGED_OPENCODE_LIVE_CONFIG_DIR`；`executor-entry.mjs` 保留 seed 复制 | 已迁移到 live 的部署可收敛配置，但旧部署仍可能依赖复制；认证 seed 不应与配置 seed 一起误删 | 分别核查配置目录和认证文件，迁移后再撤销配置复制参数。`MANAGED_OPENCODE_CONFIG_DIRECTORY` 是 Compose 输入变量，与旧 `...CONFIG_DIR` 不同，不应误删 |
| 原工作台专用 connector | `provisioner.mjs` 的 `MANAGED_LEGACY_WORKSPACE` 分支选择 `connector-entry.mjs`、连接原工作台；当天线上验证确认仍有一个实际运行的 connector | 当前仍使用，必须保留 | 只有把原工作台项目、会话、文件和身份完整迁入统一 executor，并验证回滚后，才可以退役该分支 |
| 图标根路径兼容跳转 | `scripts/deploy/nginx.conf`、`shared-gateway.py` 和 `fix-research-assets.py` 保留 `/research-experts/`、`/research-team/` 到 `/mobilesci/...` 的跳转；前端源码已改用 `appHref` | 有明确退出条件的临时兼容。目前线上旧前端仍依赖它 | 向所有实际提供 UI 的入口部署正确构建，确认旧页面及缓存已退出，再依据请求记录移除跳转。不能只更新本地源码就删除线上兼容 |
| 旧科研模式与无 workflow 的计划 | `ui/src/research.ts` 保留 design、diagnosis、review 的历史显示；`src/store/research.rs` 测试覆盖旧数据读取，并明确拒绝新建这三种旧模式 | 已完成“限制新写入、保留旧读取”的兼容，不应当作新模式入口 | 可在完成历史研究数据统计及可验证迁移后收敛读模型；在此之前保留历史显示与测试 |
| 旧附件协议和新材料集合 | `ui/src/materialUploads.ts`、`src/local/chat/mod.rs` 同时接受旧 data URL/base64 附件和 materialId；`ChatPanel.tsx::onComposerPaste` 当前已经调用新材料上传流程 | 新上传入口已统一，但 API 及历史附件仍有兼容契约。粘贴图片不是继续保留旧通道的充分理由 | 先统计旧请求生产方及历史附件引用，区分旧协议写入与历史只读支持；可以先停止旧写入，再保留旧记录展示，不直接删除历史文件 |
| 旧目录、路径及字段别名 | `src/local/files.rs` 迁移 artifacts 到 files；`src/local/git.rs` 迁移旧 worktree 路径；`src/commands/up.rs` 继续输出 filesDir，`ui/src/App.tsx` 仍有 artifactsDir/filesDir 回退 | 混合版本客户端和历史文件仍受保护 | 当前 UI 内部统一使用 canonical 字段，协议别名在版本窗口结束后再移除；目录迁移必须验证文件及历史链接，不能直接删除旧目录 |
| 旧 Agent 协议适配 | `src/local/harness/codex.rs` 保留低于 0.144 的 exec 路径及 `ORX_CODEX_EXEC`；`src/local/opencode_runtime.rs` 与 `opencode_v2.rs` 保留不同健康检查和 API 布局 | 可评估收敛，但仓库支持多 Agent、多版本，不能按服务器单个版本决定删除 | 建立明确的最低支持版本与协议矩阵，检测到旧版本时给出升级路径，再删除旧执行实现及旧能力分支。Codex 中“for one release”的注释应补充可核验的退役版本 |
| 旧文本案例快照 | `ui/src/product/FeaturedCases.tsx` 在缺少完整 workspace 时展示旧文本记录，并允许管理员同步原项目 | 在没有迁移现有案例前，仍是数据访问及恢复入口 | 先统计、备份并迁移案例；原项目不存在时保留真实旧记录，不补造完整项目，也不直接移除回退页 |
| 原生 CLI HOME 与隔离存储 | `src/local/native_store.rs` 区分 NativeStore::Legacy 和隔离目录，处理原生配置、认证及会话链接 | 名字带 Legacy，但原生 CLI HOME 并不因此成为过时文件 | 保留隔离和迁移逻辑；不能删除用户原生 Agent 的配置、认证、插件或会话目录 |
| 一次性迁移与补丁脚本 | `migrate-deployment.py`、`enable-personal-spaces.py`、`enable-opencode-admin.py`、两个 fix 脚本与常规 update 脚本并存 | 可以整理部署入口，但部分旧服务器仍需要迁移，补丁还承担回滚和存量 runner 更新 | 将一次性迁移明确归类，统一常规部署的默认升级能力。确认正常部署覆盖平台、存量 runner、未来镜像、静态资源和回滚后，再归档一次性工具 |

## 建议实施顺序

1. **先统一说明和入口**：明确运行形态，修正文档中的“仅内部兼容”适用范围，统一管理链接，给各项兼容记录负责入口、验证方法和退出条件。
2. **再收敛新写入与新部署**：规范唯一材料上传入口、推荐 OpenCode 配置方式、常规部署路径及 Agent 最低支持版本；旧数据保留只读支持。
3. **最后做破坏性清理**：在历史数据统计、迁移演练、备份和回滚验证之后，逐项移除旧字段、旧目录、旧执行适配及临时网关规则。

本次没有确认任何一个完整兼容子系统已同时满足“无内部调用、无历史数据依赖、无线上实例依赖、已有迁移和回滚验证”四个删除条件。可优先减少重复说明、重复入口和部署参数组合，不建议先删除历史数据兼容。

## 本轮统一进展

上述表格记录审计基线。随后已将运行形态、规范入口及推荐参数集中到[运行与部署约定](runtime-and-deployment.md)，同步文档中心、账号说明和部署指南，历史团队设计明确标注适用范围。账号页新生成的系统管理链接已改用带部署前缀的 `/admin/users`；旧链接处理继续保留。OpenCode 迁移工具将官方 API/live 配置规则复用于运行环境和持久化 Compose，同时移除被替代的旧配置来源，保留认证 seed、connector 身份和其他参数。这些变更仅在仓库实施，未执行线上迁移或删数据；其余兼容项仍按表格中的退出条件处理。
