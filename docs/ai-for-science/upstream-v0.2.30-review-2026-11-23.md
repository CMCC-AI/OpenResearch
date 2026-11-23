# 官方 v0.2.28 ~ v0.2.30 差异分析与选择性回移台账（2026-11-23）

## 一、固定来源与判断边界

- **核查上游标签范围**：`v0.2.27`（`9a2949cf`）→ `v0.2.28`（`340ef6e4`，66 个提交）→ `v0.2.29`（`20007e31`，59 个提交）→ `v0.2.30`（`b7427582`，5 个提交），累计 **130 个上游提交**（`git diff --shortstat v0.2.27 v0.2.30`：601 文件，+138,650 / -11,877 行）。
- **当前仓库基线**：`feat/ai4s-product`（基线 `4405f18e` + 本轮 7 项回移补丁）；真实 Git 共同祖先仍保持 `v0.2.19`（`1d8a2854`），`product-upstream.json` 保持 `productVersion = 0.2.24-mobilesci.1`、`backportTarget = v0.2.24`（`partial`）、`updateChannel = product-disabled`。
- **架构与红线边界**：
  - **OpenCode 主线与自研快速对话**：`2ce09321`、`59d17fdf`、`7a606290` 已先行落地 OpenCode 2.3.2 运行时升级与 Auto 权限评审（涵盖 `#1015`、`#1057`、`#1071`、`#1080`）；`6d394ae9` 已通过 `QUICK_CHAT_PROJECT_ID`（`quick-chats/repo` + 每会话独立 worktree）实现“快速对话”，替代上游 `#1086`/`#1145`/`#1168` 的 `scratch/<project>` 升级路径。
  - **阶段 C 红线排除**：不整批引入 `crates/orx-host` / `src/engine/` 新实验引擎体系及其实验实时监控可视化（`#1031` 等）、非 OpenCode 编码 Agent（Claude Code / Codex / ACP / Rapid-MLX / oh-my-pi / fx）专属改动、`alphaXiv` 登录/自更新/遥测上报、官方托管 Agent 安装向导（`#1050`/`#1052`/`#1065`/`#1076`~`#1083`）及 `No project` / `Inbox` / CodeMirror 输入器等前端大改。

---

## 二、`v0.2.30`（`v0.2.29..v0.2.30`）全量 5 项逐项判定

| # | 官方提交 / PR | 摘要 | 规模 | 终局判定 | 依据与处理边界 |
| --- | --- | --- | --- | --- | --- |
| 1 | `ac6a81bc` / `#1168` | `make chat-to-project moves crash-safe` | 23 文件，+2,874/-341 | **排除（架构不同）** | 强依赖 `.28 #1086` `scratch/<project>`、`chat_project_moves` 日志表与 `ProjectProposalCard`；MobileSci 已使用 `QUICK_CHAT_PROJECT_ID` 独立会话工作树 |
| 2 | `48f42c45` / `#1165` | `give each project its own settings` | 60 文件，+2,165/-337 | **暂不整包回移（按需借鉴）** | 强依赖 `.28 bd2af182`（`SettingsPage` 分栏重写与 `src/local/resolve.rs`）；其中“按项目/对话记录文献检索源、Slurm 默认参数”理念可作为后续按需扩展参考 |
| 3 | `e14c82fd` / `#1176` | `turn telemetry off for alphaXiv sign-ins` | 2 文件，+18/-3 | **排除** | 面向 `@alphaxiv.org` 登录用户的官方遥测免除；MobileSci 不启用 `alphaXiv` 账号及遥测上传 |
| 4 | `e66745c7` / `#1175` | `stop re-counting Claude usage on resume` | 5 文件，+141/-156 | **排除** | 针对 Claude Code 会话恢复时的官方遥测用量去重；MobileSci token 计量由平台 `model-gateway` 承担 |
| 5 | `b7427582` / `#1177` | `chore: bump version to 0.2.30` | 2 文件，+2/-2 | **排除** | 保持 MobileSci 独立产品版本号与 `product-upstream.json` 台账 |

---

## 三、`v0.2.28` ~ `v0.2.29` 已落地、本批回移与按需候选汇总

### 1. 本轮已回移（P1 + P2 共 7 项）

| 类别 | 官方提交 / PR | 所在版本 | 解决的问题与本地适配文件 |
| --- | --- | --- | --- |
| **P1-1 并发竞态** | `a6690c69` / `#1130` | `v0.2.29` | 修复 `src/local/chat/mod.rs` 回合槽位释放（`release_finished_turn_with_store`、`TurnGuard::spawn_release`、`finish_turn`）先解锁后广播 `chat.busy` 导致新回合被误判为空闲的竞态，改为持有 `turns` 锁时同步发送 `chat.session` 与 `chat.busy` |
| **P1-2 文献解析** | `0de1cac8` / `#1138` | `v0.2.29` | 修复 `src/client.rs` `strip_openalex_prefix` 对带末尾斜杠、查询参数或锚点的 OpenAlex URL（如 `https://openalex.org/W2919115771/`）截出空 ID 导致静默请求 `/works/` 的问题，并补单测 |
| **P1-3 文献诊断** | `3718a5ea` / `#1141` | `v0.2.29` | 在 `src/client.rs` 新增 `discover_pubmed_with_feedback` 解析 PubMed `esearch` 返回的 `errorlist`/`warninglist`（同时保留 `discover_pubmed` 原签名兼容 `src/commands/up.rs`），在 `src/commands/discover.rs` 将未命中词项输出到 `stderr`，并更新 `agent-skills/orx-lit-review/SKILL.md` 与单元测试 |
| **P1-4 远程保活** | `1fd56d2c` / `#1170`（含 `#1091` `8399fa70` 基础错误语义） | `v0.2.29` | `src/store.rs` 新增不抢占 WAL 写锁的 `Store::open_read_only` 供 `src/commands/remote_host.rs` `stop_preview` 使用；`live_descriptor` 与 `control_exchange` 区分控制面超时（`HOST_NOT_RESPONDING`）与进程缺失；`src/commands/up_remote.rs` 对控制面超时与健康检查超时执行重试，并补齐单测 |
| **P2-1 编辑器对齐** | `bbc4e3d0` / `#1159` | `v0.2.29` | 修复 `ui/src/components/CodeEditor.tsx` 在 WebKit/Safari 下高亮遮罩层忽略 `[scrollbar-gutter:stable]` 导致自动折行后光标选区与复制行错位的问题，改为通过 `ResizeObserver` 实测 `ta.offsetWidth - ta.clientWidth` 动态设置 `insetInlineEnd` |
| **P2-2 滚动防拉回** | `824006ed` / `#1020` | `v0.2.28` | 修复 `ui/src/components/ChatPanel.tsx` 在 60px 底部吸附带内触控板向上微滚时被流式输出/行高重测拽回底部的 Bug：增加 `programmaticScroll` 精确校验与 `lastTranscriptTop` 上滑检测，并在 `ui/tests/transcriptVirtualization.test.mjs` 补齐 AST 单测 |
| **P2-3 工具行交互** | `fc794f00` / `#1105` | `v0.2.29` | 支持点击 `ToolRow` 错误行与 `ToolGroup` 摘要行任意位置展开/收起（通过 `toggleUnlessControl` 保留内部文件链接独立点击），同步调整 `ui/src/app.css` 图标悬停高亮过渡 |

### 2. 已在先期提交覆盖的重合项（`.28` OpenCode 主线）

| 官方提交 / PR | 摘要 | 本地对应落地提交 |
| --- | --- | --- |
| `22f8d80c` / `#1015` | `terminate opencode process groups and stop active turns on shutdown` | `2ce09321`（已适配整合） |
| `3b912e54` / `#1057` | `run OpenCode 2 only, add Auto mode` | `2ce09321`、`59d17fdf`、`7a606290`（已适配 OpenCode 2.3.2 与后台配置） |
| `64c88fc7` / `#1071` | `stream OpenCode from its event stream` | `2ce09321`（已适配整合） |
| `48c35db6` / `#1080` | `end a declined OpenCode request cleanly` | `2ce09321`（已适配整合） |

### 3. 保留作为按需评估（P3 / 触发即办）

| 官方提交 / PR | 摘要 | 触发评估条件 |
| --- | --- | --- |
| `f8850d29` / `#1043` | `run queued messages after Stop`（停止当前回合后保留并继续执行排队消息） | 需先明确产品交互预期（Stop 是“清空当前及排队消息”还是“仅中止当前回合”），适配时跳过 `#1085` Claude steer 逻辑 |
| `22f85e90` / `#1108` | `resume chat turns after a quit`（正常重启 `orx up` 自动恢复未完成回合） | 若服务端滚动升级或桌面启停频繁出现需手动点 Continue 的中断回合时，可按 OpenCode 恢复路径适配 |
| `9eee033a` / `#1017` | `swap OpenCode copies only between turns`（无活跃回合时才切换托管 OpenCode 二进制） | 当前容器使用固定镜像版 `2.3.2`；若未来引入运行时在线热切换再按需引入 |
| `3000e68f` / `#1112` | `add a chat width setting`（聊天阅读列宽 Balanced / Wide / Full 切换） | 若宽屏用户提出阅读列过窄诉求时可低成本引入 |
| `48f42c45` / `#1165` | 项目级默认设置覆盖（特别是项目/对话维度的文献源偏好、Slurm 参数默认项） | 当出现同机多项目需分别记忆不同 Slurm 分区/QoS 或文献源开关需求时，在 `LocalProject` 上做轻量扩展 |

### 4. 按主题排除项（`v0.2.28` ~ `v0.2.29` 其余提交）

- **新实验引擎、`orx-host` 与进度监控可视化（阶段 C 红线）**：`#1031`（`412f5bc4`）及关联提交 `#1102`、`#1115`、`#1116`、`#1118`、`#1119`、`#1120`、`#1121`、`#1123`、`#1124`、`#1125`、`#1127`、`#1131`、`#1132`、`#1133`、`#1136`、`#1139`、`#1142`、`#1144`、`#1147`、`#1148`、`#1149`、`#1152`、`#1094` 等。
- **非 OpenCode Agent（Claude / Codex / ACP / Rapid-MLX / oh-my-pi / fx）**：`#1003`、`#998`、`#1019`、`#1021`、`#1039`、`#1046`、`#1085`、`#1106`、`#1156`、Claude permission bypass（`6a3f3aae`）。
- **官方托管 Agent 安装/登录/诊断与配额/模型面板冲突**：`#1025`、`#1026`、`#1030`、`#1047`、`#1050`、`#1052`、`#1053`、`#1054`、`#1065`、`#1072`、`#1076`、`#1077`、`#1078`、`#1081`、`#1082`、`#1083`、`#1100`、`#1107`、`bd2af182`。
- **`No project` / `Inbox` / CodeMirror 输入器重写与高耦合前端重构**：`#1086`、`#1088`、`#1089`、`#1094`、`#1129`、`#1145`、`#1160`（依赖 `FileReference.tsx`）、`#1162`（依赖 `ComposerEditor.tsx`）、`#1169`（依赖 `ImageMenu.tsx`）、`#1029`、`#1037`、`#1049`、`#1067`（MobileSci 沿用独立审批交互路径）、`#1068`、`#1084`（依赖 `QuestionDock.tsx`）、`#1103`、`#1114`、`#1117`、`#1140`、`#1161`、`#1163`、`#1164`、`#1166`。
- **上游 CI / 打包 / `openresearch.sh` / 遥测 / 非中英文语言包**：`#1011`、`#1028`、`#1033`、`#1048`、`#1051`、`#1063`、`#1070`、`#1095`、`#1113`、`#1126`、`#1135`、`#1143`、`#1146`、`#1154`、`#1155`、`#1158`、`#1171`、`#1087`、`#1172`。
