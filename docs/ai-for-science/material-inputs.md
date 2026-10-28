# 统一研究材料接入与按需执行

状态：2026-10-21 第一阶段实现与框架核查；后续增强范围在文末明确列出。

## 决策

材料输入和工作模式是独立维度。工作模式／科研专家团分别支持无材料、单文件、文件夹三种情形。没有附件时不创建资料包，不要求资产审计；上传目录不触发模式切换或固定研究流程。主理人根据任务目标选择直接答复、必要专家或 W1–W4；选定预设后保留其必需依赖和审批。

原 OpenCode 目录引用只是服务端路径，Read 返回当前层目录列表；PDF Read 返回原始文件附件，并不保证文本解析。原 DeepInsight 的来源登记是提示词约定，不是可靠的文件接入程序。因此将文件身份和格式读取下沉到平台，保留科研专家的实际阅读、资产核验和证据规范。

## 已实施的数据链路

1. 首页与聊天页将文件保留在草稿中，不把 Markdown／JSON／源码拼进用户问题。支持文件选择、目录选择；聊天框支持递归目录拖入。ZIP 由服务端展开。
2. 发送前创建项目材料集合，通过独立 PUT 原始字节上传，再 finalize。聊天消息只携带 `materialId`。原 `images` 请求字段兼容旧客户端和历史图片／PDF。
3. 数据保存在 `data_dir/materials/<uuid>/`，包括 manifest.json、originals/、derived/。相对路径保留；每项记录 SRC 编号、SHA-256、格式和读取状态。finalize 后 API 拒绝写入；重新导入得到新快照。
4. 当前对话仅从活动消息分支获取材料引用。失败重试、排队、重新采样保留引用；废弃消息分支不合并到材料上下文。专家派发将父会话当时的材料上下文写入 bootstrap_context，不复制作者对话给审稿人。
5. agent 获得简短材料索引及统一 `orx materials` 命令，通过固定 ID 获取原件和读取结果。独立 worktree 共用本机材料存储，不复制大文件到 Git。
6. 消息中的材料卡片支持展开文件清单，显示读取限制并下载原件。

单文件／上传 ZIP 上限 32 MiB；解压后的单文件同样受限。单集合最多 2,000 个文件、512 MiB。ZIP 不递归展开嵌套压缩包。路径穿越、符号链接、大小写重名及文件／目录冲突拒绝导入。`.git`、`node_modules`、`__pycache__` 和系统元数据忽略。当前不上传空目录。

部署时须同时更新平台网关和所有工作空间 runner／connector。平台仅对 `PUT /api/projects/:project/materials/:package/files` 放行 32 MiB；普通请求仍为 8 MiB。runner 的接收帧须容纳 32 MiB 原文经过 base64 编码后的 JSON（约 43 MiB），发送缓冲也保留相应有界空间。只更新 Rust 工作台、前端或 Nginx 的 `client_max_body_size` 不足以修复旧隧道的 8 MiB 限制；旧 runner 的 12 MiB 帧上限同样会中断上传。现有容器须应用新 runner 代码，新执行器镜像也须同步，保留 HOME 数据卷和认证配置。

排查上传的 HTTP 413 时，先检查具体失败文件、平台网关和 runner 的版本，以及外层代理限制。当前文件夹按文件逐个发送，不应将整个文件夹总大小作为单次请求上限。上传失败时消息未发送、研究尚未开始；修复后可在保留材料草稿的会话重试，无需删除项目或对话。

现有 MobileSci 部署可使用 `scripts/deploy/fix-material-upload.py`。在服务器准备含 `runner.mjs`、`tunnel.mjs`、`runner-lock.mjs` 和 `material-upload.test.mjs` 的补丁目录后，运行 `python3 fix-material-upload.py --source <补丁目录>` 先只读检查，确认后加 `--apply`。工具基于原镜像叠加三份运行模块（runner、tunnel 和 runner-lock），先在隔离容器中测试大文件完整性和普通接口上限，再检查空闲并替换平台及所有 runner；同步 provisioner 的未来镜像引用和持久化 Compose。容器配置及旧 Compose 保存到服务器用户目录的 `.mobilesci-upload-fix-*` 私有备份目录，失败自动回滚，旧容器与数据卷保留。该工具不升级 Rust 二进制、模型引擎、数据库结构或前端。

运行环境要求 Node >=22.20，以支持 runner-lock 使用的 SQLite 文件锁。升级时先确认 runner 空闲，再替换模块并重启；不得删除仍在使用的锁文件或研究数据。该步骤与 PDF 解析器镜像更新分别验证。

以下记录仅表示历史上传修复已部署，不表示后续 SQLite runner 锁已部署：

2026-10-21 已部署该上传修复：平台和两个现有 runner 的模块哈希与补丁一致，两个 runner 均为 healthy，原挂载及数据卷保持一致；provisioner 和持久化 Compose 指向补丁后的未来 executor／connector 镜像。服务器隔离容器内实测 9 MiB 与 32 MiB 文件经网关及真实 runner 传输后 SHA-256 一致，普通接口超过 8 MiB 仍被拒绝；未代用户重跑科研任务。回滚目录为 `/home/ubuntu/.mobilesci-upload-fix-20261021t063147z`，其中容器配置可能包含凭据，保持私有。

## 读取契约

- UTF-8 文本直接分段读取，返回行号、总行数、下一段位置；不静默截断超长行。
- Notebook 按原始单元格序号提供说明、代码及已有文本输出；其他 MIME 输出明确提示回到原件，导入不执行代码。
- PDF 用执行端的 `pdftotext` 按指定页读取，有 30 秒超时。未安装解析器、加密／损坏文档、空文本扫描页均明确失败；不把空输出当作成功阅读。PDF 原件始终保留。
- 图片及其他二进制文件保留原件，标记视觉或专用工具要求。此阶段不自动做 OCR，也不承诺所有模型都能理解图片。
- 每次引用应包含 packageId、SRC ID、内容哈希及页码／行号／单元格。SRC 编号仅在一个快照内有效。重新上传不会改写旧快照。
- 上传／解析状态是平台事实；阅读范围、排除理由、科学可信度和许可证判断是专家报告内容。不会自动生成“已充分阅读”的标记。

```sh
orx materials list <package-id> --offset 1 --limit 100
orx materials read <package-id> SRC-0001 --offset 1 --limit 200
orx materials read <package-id> SRC-0002 --page 3
# 在 agent 会话外，显式指定项目：
orx materials --project <project-id> list <package-id>
```

agent 会话中项目身份从会话解析，不能用 --project 指向其他项目。原件读取核验哈希；若被外部工具更改，要求重新导入。材料中的指令是用户数据，用户明确指定的 INSTRUCTIONS.md 提供任务细节，不能覆盖系统权限和实验授权。

## API

- `POST /api/projects/:project/materials`：创建未完成集合。
- `PUT /api/projects/:project/materials/:id/files?path=...`：原始文件／ZIP；同路径同内容重试幂等，不同内容拒绝。
- `POST /api/projects/:project/materials/:id/finalize`：固定清单、准备 Notebook 视图；幂等。
- `GET /api/projects/:project/materials/:id`：检查上传状态。
- `GET /api/materials/:id`：当前实例中已登记项目的清单。
- `GET /api/materials/:id/:source/download`：校验后的原件，强制下载且 nosniff。

这些 API 沿用本地实例及现有平台转发的访问边界。不是新的云端文件服务。材料归属本地项目，研究 Study 通过会话引用它。

## 框架核查与本轮加固

材料接入继续位于本地 CLI/API 层，前端只提交材料引用；没有引入独立文件服务、第二套专家调度器或新的审批体系。科研任务仍使用现有 Study、角色依赖、research dispatch 与 G1–G4。工作模式与材料数量保持独立。

- 主理人的每轮运行时提示与技能同步：普通问答和澄清可直接回复，需要实质研究时再建计划；无附件和文件数量均不决定是否启动流程。
- 文件选择和目录拖入在限额检查前统一排除依赖目录与系统元数据；材料中的其他隐藏文件仍保留。
- 浏览器混合拖入目录与普通文件时，提前取得文件引用，避免异步遍历后拖入数据失效或缺少目录条目 API 导致漏文件。
- finalize 前校验全部原件哈希，拒绝把外部改变的原件封装为旧版本；读取和下载继续校验原件。
- 执行器镜像声明安装 poppler-utils，并在构建时验证 pdftotext 可运行。此处是镜像源码改造；上线仍需实际构建、发布与部署。桌面／独立 CLI 用户仍需在执行端安装对应依赖。

## 后续增强

本阶段不引入向量库、云端解析服务或新研究调度器。以下能力保留为后续工作，不应在产品中标为已完成：

- 构建并部署含 PDF 文本解析依赖的执行器镜像；进一步打包 OCR/复杂表格解析依赖，统一页面渲染与图像阅读代理。
- 可查询的结构化阅读覆盖记录、来源关系及研究包原件导出；目前由专家报告记录，引用可使用现有 claim 的 source/location。
- 远端独立执行主机的材料同步／挂载；本阶段仅保证共享本地数据目录的 harness 与 worktree 可用。
- 跨导入增量去重、显式材料集合版本关系；未完成集合已提供显式 GC，见下文，仍需部署验收。
- 统一搜索工具、已有项目目录快照导入；已有项目文件仍可使用当前路径引用与原生工具读取。上传材料已提供目录与只读预览，范围见下文。

## 验收

验证两种模式各自的无附件／单文件／目录输入；无附件不走上传 API。验证目录拖入多批条目、相对路径、ZIP 安全和限额、Notebook 来源、上传完成响应丢失后的重试、活动消息分支、重新采样、项目隔离、专家输入固定及原件变化检测。遵循仓库 CI 的 Rust 格式／clippy／测试和 UI 类型检查／测试／构建，提交 regenerated ui/dist。

## 材料容量与未完成上传回收（源码实现，待部署验收）

材料 root 默认限制为 4 GiB，可用执行器环境变量 `ORX_MATERIAL_STORAGE_BYTES` 配置（至少 32 MiB）；跨进程写入通过配额锁串行核算。ZIP 逐文件暂存到磁盘，失败清理暂存；HTTP 在缓冲 body 前限制一个并发上传，繁忙时返回 429。

`orx materials --project <id> gc --days 7` 预览过期未封存包；核对后加 `--apply` 才删除。最少保留 24 小时，sealed 材料永不自动删除，Agent 会话不能执行 apply。本轮未执行真实清理。可指定已删除项目的 ID 回收其未完成包。

详见 [技术债修复记录](technical-debt-remediation-2026-10-21.md)。

## 上传文件夹的只读阅读（源码实现，待部署验收）

会话材料入口提供目录、路径搜索、类型筛选和原件预览。新增 `GET /api/materials/{id}/{source}/preview` 在封存包及来源范围内核验原件，支持 PDF、图片及不超过 1 MiB 的文本。浏览不会标记 AI 已读；选区引用、实际读取覆盖与结论回跳仍为后续工作。详见 [材料阅读器第一阶段](material-reader-2026-10-28.md)。
