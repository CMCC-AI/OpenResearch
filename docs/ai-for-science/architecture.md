# 实现与数据流

## 系统边界与代码导航

| 层 | 现有实现 | 代码位置 |
|---|---|---|
| 产品入口 | 介绍、开始研究、能力地图、多渠道发现、深度文献 | OpenResearch ui/src/product、ui/src/routes |
| 本地 API | Rust Axum，REST、SSE、终端 WebSocket、静态 UI | src/commands/up.rs |
| 研究状态 | SQLite WAL，项目、实验、运行、会话、消息、队列、唤醒记录 | src/store.rs |
| Agent 适配 | Claude Code、Codex、OpenCode、Cursor、Antigravity 各自进程/协议适配 | src/local/harness、src/local/chat.rs |
| 代码与实验 | Git 仓库/分支/worktree、记录 revision、运行源快照 | src/local/experiments.rs、src/local/localrun.rs、src/commands/exp.rs |
| 执行与监督 | 本地或远端任务、独立 supervise 进程、日志、退出码、取消 | src/commands/supervise.rs、src/jobs |
| 文献产品 | Next.js 16 / React 19，Feed、PDF 阅读、Blog、个人文库 | DeepLiterature src/app、src/components |
| 文献存储 | PostgreSQL、论文/来源/产物/队列/账户/笔记；本地 PDF 文件 | DeepLiterature db/migrations、src/lib/papers |
| 商业伴随平台 | 登录、组织、托管算力目录与供应 | openresearch.sh 外部服务，本仓库只有客户端 |

## 论文从哪里来

OpenResearch 的论文发现是按需联网查询，不会自动把全部结果保存为本地文献库。

- alphaXiv：keyword/embedding 检索，fast 标题检索，论文元数据和关联仓库解析；orx paper 可读取 overview Markdown，再按实现回退全文。
- OpenAlex：/works 搜索，抽象倒排索引重建摘要，读取日期与引用数；在相关结果页内重排。
- bioRxiv 搜索：实际走 OpenAlex，加 source S4306402567 过滤。因此点击“全部渠道”会对 OpenAlex 产生两次查询。bioRxiv DOI 详情则调用 api.biorxiv.org；不是三个完全独立的检索引擎。
- Deep Literature：读取自建库。该库当前主采集源是 Hugging Face Daily Papers，不是 alphaXiv API 的镜像，也不是 arXiv 全量库。视觉参考 alphaXiv 与数据来源是两回事。

Deep Literature 的内容链路：

Hugging Face /api/daily_papers → 元数据归一化 → PostgreSQL papers + paper_source_occurrences → processing_jobs → PDF Worker / Blog Worker → paper_assets / paper_blog_artifacts → 页面及公开 API。

Daily Papers 用 arXiv ID 关联。正文 Markdown 来自 Hugging Face /papers/{id}.md；PDF 来自 arXiv，成功缓存后读本地文件。GitHub 元信息由来源字段、摘要或 PDF 中发现的链接补充，再获取 stars。

## 原有采集与理解逻辑

采集器支持按日期分页，单页最多 100、默认最多 10 页且硬上限 20 页。HF 请求 20 秒超时，最多 3 次尝试，429/5xx 或网络错误后短退避；当前不是分布式速率限制，也未完整遵循 Retry-After。

采集事务写论文主数据、来源原始记录和处理任务。唯一键支持幂等；Worker 用数据库队列领任务，15 分钟旧锁可回收，失败按指数退避，最终进入 dead 状态。具体重试上限以 processing_jobs.max_attempts 为准。

Blog Worker 将正文前 36,000 字符交给 Qwen 生成结构化 JSON，校验后保存 current artifact，同时保留输入 hash、模型和产物版本。它是有输入长度上限的生成式解读，不是已经通过事实审核的论文证据。

PDF 下载包含最大大小、PDF 签名、SHA-256 和临时文件原子落盘；文件路径与存储 key 分离。Compose 当前把主机 papers 目录绑定到 /data/papers，数据库使用命名卷。旧文档提到 paper_files 命名卷的描述与当前 Compose 不一致，以 compose.yaml 为准。

个人文库、笔记、阅读进度和评论在 Deep Literature 登录域内。公开 feed 不携带这些个人数据。聊天 /api/chat 检查登录和 Origin，再把客户端提供的标题、摘要、历史消息传给 Qwen SSE；没有服务端按 paper ID 检索章节的完整 RAG 链路。界面 PDF 选区能补充用户消息，也不能替代完整的检索和引用校验。

## OpenResearch 原有科研执行逻辑

1. 新建或导入本地 Git 项目；从论文创建时先解析 arXiv 元数据/仓库，再展示项目创建表单。仓库克隆和实验运行是后续动作。
2. 项目会话选择 Agent harness 与模型。会话、消息、分支和待处理队列保存在 SQLite，UI 通过实时事件显示工具与状态。
3. 实验对应项目内的变更方向，通过 Git 分支/worktree 保留差异；运行绑定提交 revision 的源快照。
4. 运行通过后端适配器提交到本机、SSH、Slurm、Kubernetes、Ray、HF Jobs、Modal、Tinker 或 OpenResearch managed compute。存在适配器不表示部署方已配置其凭据、集群或预算。
5. supervise 跟踪进程/任务、记录日志和终态，并唤醒需要结果的 Agent 会话。Run 有 starting/running/done/failed/cancelled 与 cancelRequested；请求取消不等于已停止。
6. Agent 读取结果与文件后继续分析或写作。LaTeX/Overleaf 有各自编译/同步入口。算法正确性和科学有效性仍需评估，退出码 0 不等于研究结论成立。

## 我们新增的整合实际做了什么

/literature → OpenResearch /api/deep-literature/papers → Deep Literature /api/papers?paginated=1。服务端选取公开字段，忽略 viewerStates，不转发 Cookie。前端展示论文并在新标签页打开 /abs/{id}。创建研究项目仍走原来的 alphaXiv 解析链路：Deep Literature 在线不保证 alphaXiv 在线。

当前没有项目多篇文献关联表、双向跳转状态、跨系统笔记同步、统一登录或研究证据包。因此按钮已改为准确的“从此论文创建项目”，避免误认为已收藏到现有项目。

## 下一阶段的数据契约（待建设）

- PaperIdentity：内部 UUID，arXiv ID + version、DOI、OpenAlex ID，多源 alias 去重。
- PaperSource：provider、source URL、fetchedAt、license、contentHash，保留来源冲突。
- ProjectLiterature：projectId、paperId、addedBy、purpose、snapshotVersion，支持多篇。
- Evidence：paperVersion、页码/章节、引文范围、原文 hash、产物与生成模型版本。
- ResearchRun：代码 commit、环境/数据版本、算力、参数、指标、失败类型与成本。

先建立这些关系及鉴权，再做向量索引与知识图谱；否则页面整合无法变成可追溯的科研系统。

