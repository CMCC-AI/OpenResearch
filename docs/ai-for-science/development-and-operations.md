# 开发、接口与运维手册

## 目录与职责

OpenResearch 仓库：`/Users/levent/cmccProjects/OpenResearch`，当前产品分支为 `feat/ai4s-product`。
DeepLiterature 仓库：`/Users/levent/cmccProjects/DeepLiterature`，当前统一登录分支为 `codex/unified-login`。
旧 `/Users/levent/cmccProjects/ai4s` 已暂停开发。发布必须从正式仓库的提交 SHA 构建，不能依赖临时 worktree。

两套系统的 Docker 环境配置、完整启动顺序、验收和生产发布流程见[启动与部署](startup-and-deployment.md)。

## 开发启动

安装以各自 lockfile 为准，Rust使用 --locked，UI使用 pnpm install --frozen-lockfile。使用 scripts/dev-slot.mjs 分配隔离端口与数据库：

```sh
ORX_DEEP_LITERATURE_URL=http://127.0.0.1:3000 \
ORX_DEEP_LITERATURE_WEB_URL=http://127.0.0.1:3000 \
node scripts/dev-slot.mjs start --db empty --worktree /private/tmp/openresearch-ai4s
node scripts/dev-slot.mjs status --worktree /private/tmp/openresearch-ai4s
```

不要在有研究数据的环境盲目使用 --db empty；不要从生产数据库复制测试数据。当前slot惯例为backend4901、UI5201，真实端口以status输出为准。Rust修改要重启后端；Vite只热更新前端。

文献服务按自己的README配置。只联调公开文献读取时启动 web 与依赖即可：

```sh
cd /Users/levent/cmccProjects/DeepLiterature
docker compose up -d web
docker compose ps
```

web依赖db/migrate；首次执行会迁移所连接数据库，因此必须使用专用开发实例。不要为了读接口验证启动整个scheduler/blog-worker：后者可能使用真实Qwen Key生成收费产物。已有后台worker需运维确认用途后管理，本轮不擅自删除或重置数据。

## 配置契约

| 变量 | 所在服务 | 含义 |
|---|---|---|
| ORX_DEEP_LITERATURE_URL | OpenResearch | 服务端HTTP(S) origin，默认127.0.0.1:3000，不接受路径/查询/账号密码 |
| ORX_DEEP_LITERATURE_WEB_URL | OpenResearch | 浏览器origin，缺省复用服务端地址；远程部署不能把容器名当公开域名 |
| OPENALEX_API_KEY | OpenResearch | 本轮支持的服务端Bearer key，不放入前端变量 |
| OPENALEX_MAILTO | OpenResearch | 运营联系人；旧默认是上游项目地址，部署者应改为自己联系人；mailto不是API Key |
| ALPHAXIV_API_URL / ALPHAXIV_WEB_URL | OpenResearch | alphaXiv接口/Markdown地址，仅管理员配置 |
| OPENALEX_API_URL / BIORXIV_API_URL | OpenResearch | 来源端点，仅管理员配置 |
| ORX_DATA_DIR | OpenResearch | SQLite与本地运行状态位置；配合Git项目路径管理 |
| DATABASE_URL / PAPER_STORAGE_DIR | Deep Literature | PostgreSQL及PDF持久目录 |
| HF_TOKEN / HUGGING_FACE_ENDPOINT | Deep Literature | 采集身份与端点 |
| QWEN_API_KEY / QWEN_BASE_URL / QWEN_MODEL / QWEN_BLOG_MODEL | Deep Literature | 付费模型与区域 |
| CRON_SECRET | Deep Literature | 内部采集/worker API验证，不是用户登录 |

生产secret走秘密管理或权限0600的服务环境文件；不提交.env，不在诊断输出原始配置，不在浏览器query中传key。OpenResearch 与 DeepLiterature 使用独立服务端 SSO secret；浏览器只接触一次性授权码、state 与 PKCE challenge。

## 适配 API

GET /api/deep-literature/status → connected、webUrl（断开null）、用户可读message。这是依赖readiness；服务离线返回200+connected=false。

GET /api/deep-literature/papers?q=&tab=hot&limit=18&offset=0 → papers、webUrl、total、hasMore、offset。tab为hot/new。输入超界400；上游不可达、格式不兼容、并发超限或响应过大502。暂未提供标准Retry-After和区分429/503的完整错误协议。

适配器请求上游 /api/papers?paginated=1，只接受papers/total/hasMore契约，不返回用户文库状态。limit最多50，offset最多10000，响应4MiB；每进程4并发，不是分布式全局限流。offset分页遇到采集并发更新可能漂移，未来改cursor/snapshot。

GET /api/papers/discover?q=...&source=all&limit=8 → papers和sourceErrors。all分别调用alphaXiv、OpenAlex和带bioRxiv来源过滤的OpenAlex。单渠道失败降级；不同source同篇论文尚未归并。

## 必要验证

```sh
cd ui
pnpm lint:styles
pnpm build
pnpm test
cd ..
node --test scripts/dev-slot.test.mjs
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo build --locked
cargo test --locked
# 启动隔离的两个服务后，执行只读契约检查（不调用模型/运行实验）：
ORX_TEST_URL=http://127.0.0.1:4901 node scripts/check-literature-integration.mjs
```

ui/dist被嵌入Rust发布产物并提交，改UI后必须重建。CI还包含Windows构建、版本一致性和源码build telemetry检查；本机macOS验证不能代替Windows CI。

集成验收：在隔离实例验证status，取第0和18偏移页，比对total/hasMore；搜索单汉字/500边界；断开文献依赖后检查重试；确认项目创建表单预填但未自动运行实验；不要在联调中克隆和执行不明仓库。

## 备份与恢复

- SQLite：使用SQLite backup API或停写后备份，不直接复制正在写入的单个.db而忽略WAL。
- 同步备份Git仓库（包含实验分支）、运行日志、产物和必要配置。只有SQLite不能恢复实验源代码。
- PostgreSQL：使用一致性逻辑备份或托管PITR；PDF目录/对象存储另行备份并保存hash清单。
- 恢复到隔离主机/数据库，先检查schema与文件引用，再抽样论文PDF、笔记、实验提交和终态日志；最后才切换入口。
- 密钥备份单独加密与授权，数据库恢复不能导致后台worker自动大量调用模型。

尚未执行生产恢复演练，不承诺数据恢复SLA。迁移发布前保存备份；回滚应用用上一镜像/提交，schema回滚按兼容性方案处理，不能直接用git回退代替数据库恢复。

## 故障定位

| 现象 | 排查 |
|---|---|
| 深度文献未连接 | server URL、DNS/网络、web健康、Postgres连接、paginated契约；不要把DB错误原文返用户 |
| 空列表但已连接 | 采集是否执行、日期/查询、真实库是否为空；空列表是合法结果 |
| 浏览论文正常但建项目失败 | alphaXiv解析独立故障、仓库缺失、Git网络或路径权限 |
| Blog缺失 | processing_jobs pending/dead、模型凭据/配额、源Markdown缺失、输入校验 |
| PDF失败 | arXiv限制、容量、挂载权限、下载队列与hash，不立刻无限重试 |
| 运行一直starting | supervisor/后端供给、凭据、队列与日志；先确认远端是否已启动避免重复提交 |
| 浏览器正常curl失败 | 检查运行环境网络权限；上次即是shell沙箱阻止本机请求，不是后端退出 |

## 变更记录

2026-09-20 本轮验证：macOS Rust build/fmt/clippy通过；Rust测试882通过、2忽略（真实Slurm集群与发布telemetry门禁）；UI类型检查、构建、样式/i18n检查及164项测试通过；dev-slot 9项测试通过。只读接口脚本验证真实分页、单字符搜索、私有字段不透出及参数拒绝；浏览器确认72篇文献的第1页切换到第2页。沙箱下部分端口/进程测试受限，放开测试所需权限后重跑通过。未执行Windows CI、生产恢复、真实GPU任务或收费模型端到端测试。

- 5d09afe：产品介绍/科研首页/能力地图/多渠道发现。
- fdb7022：Deep Literature公开feed与精读链接、从论文创建项目。
- 本轮：分页、恢复交互、资源边界、OpenAlex认证与兼容性、生产文档。最终SHA以git log为准。
