# OpenResearch v0.2.24 对比与回移建议

核验日期：2026-11-06。官方 [v0.2.24](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.24) 固定为 `23a4d67bb5ce3cf9051f8d62b2cd52e93116e16d`，前一目标 v0.2.23 为 `a92fd471aba91e9bdd14a88e2322ec42f9dfdbdb`。本次逐个阅读两标签间全部 16 个提交；增量涉及 140 个文件（含本地化、文档、工具和生成记录），不是 140 项功能。

本项目对照点为产品分支 `05bcc66ab296a97bbe24f0e6f4d362fb0f683793`，另列阅读治理候选 `59be492b7b9a40578deca18c34daf8221b87b319`。与 v0.2.24 的真实共同祖先仍为 v0.2.19 `1d8a285468aed5d5a1f1ea86ecf6e2f63fcaa8bd`。产品标签不能证明完整同步；`product-upstream.json` 仍记录 .23 部分回移及关闭官方自动更新。根工作区的 AGENTS、论文来源图标和 ui/dist 有用户未提交内容，未纳入本次对比实现。

## 一、有价值、可考虑回移的官方改动

| 优先级 | 官方改动与依据 | 本地适配及影响范围 | 建议验收 |
| --- | --- | --- | --- |
| P1 | [#872 / `59acdeb0`](https://github.com/alphaXiv/OpenResearch/pull/872)：跨项目打开会话统一走 `onActiveSessionChange`，恢复保存的侧聊工作区 | 本地 ChatPanel 仍对跨项目直接 navigate，App 的统一处理器已支持 projectId 和已保存 pane；目标代码直接存在。应适配这一调用点，并核验从 ResearchNavigation 首页入口切换的恢复行为；保留 MobileSci 的路由前缀、研究/材料 pane 和只读案例规则 | 两项目来回切换后主会话/侧聊、活动 pane 和草稿恢复；冷刷新与未保存文件阻止离开仍有效 |
| P2，优先 | [#698 / `38070ed5`](https://github.com/alphaXiv/OpenResearch/pull/698)：SSH 取消测试的 poll/read 正确处理 EINTR，保留原 deadline | 本地仍直接断言 poll/read 返回 1，存在同一信号竞争窗口。仅移植测试夹具重试及原期限计算，不改变生产 SSH 取消或握手超时；这不是完整进程状态隔离 | Unix 实际 fork/信号/取消回归，失败仍触发 kill 验证；重试不延长原截止时间 |
| P2 | [#860 / `390ae1ab`](https://github.com/alphaXiv/OpenResearch/pull/860)：local_job_lifecycle 的终止等待改为明确 60 秒期限 | 本地仍为 100×100ms；适合缓解繁忙 Windows runner 的测试启动延迟。只调整夹具等待，不能用它掩盖退出标记从未写出或生产卡死 | Windows 原生生命周期/进程回收用例；超时仍失败，保留状态断言与耗时证据 |
| P2，需先验证适用性 | [#869 / `ece1a929`](https://github.com/alphaXiv/OpenResearch/pull/869)：唤醒续轮中用户插入消息保持可见 | 官方补丁改 `splitResponseParts`；本地只有逐轮 `splitTurnParts`，AssistantTurn 也逐轮渲染，缺少该函数及对应跨轮归并。不能宣称同一 bug 已存在，也不能机械应用 6 行补丁。先用实际自动唤醒+steer 夹具验证，再取“用户输入不折叠”的规则适配 | 运行期间和结束后的用户插入消息、回复、未答问题可见，旧最终答复及流式 commentary 的折叠边界不回退 |
| P2 | [#858 / `8ff520ba`](https://github.com/alphaXiv/OpenResearch/pull/858)：上传技能的 SKILL.md 原地编辑 | 本地已有上传/镜像/配额基础，但缺 read/update 接口。可取原子替换、frontmatter 名称不变、保留 companion 文件、只读镜像约束；需补私人执行器权限及路径/符号链接/大小限制，不能把普通上传材料升级成指令 | 已有技能编辑/失败回滚、名称拒绝、目录预算、镜像只读、跨私人空间拒绝；前端类型、本地化、构建与实际入口 |
| P2/P3，局限本地 | [#856 / `5f38e938`](https://github.com/alphaXiv/OpenResearch/pull/856)：文件与产物在系统文件管理器定位；[#870 / `a27cc959`](https://github.com/alphaXiv/OpenResearch/pull/870)：Linux 桌面 SSH 打开与连接进度 | 适合本地桌面用户。#856 的 SSH 屏蔽规则不足以证明本项目私人托管版安全；当前网关只拒绝部分机器动作，必须同时检查服务端路由和能力。#870 需 Linux desktop、浏览器前台切换与连接状态整体适配 | 本地正常定位/打开；SSH 和私人服务器均拒绝宿主机动作；Linux 真机失败/重连/取消，而非只跑前端单元 |

建议第一批仅取跨项目侧聊恢复、SSH 测试 EINTR 和 Windows 生命周期夹具；它们边界小且能直接对应现有代码。技能编辑与唤醒显示分别设计验收，不与新账号/计算后端捆绑。这里是回移建议，不是已实现声明。

## 二、本项目残留技术债及 v0.2.24 暴露的差距

| 优先级 | 事实与依据 | 影响范围及处理 |
| --- | --- | --- |
| P1 | `.3` 已发布但生产仍为 `3ad51016` / CLI `0.2.22-mobilesci.1`；一个私人空间仍有有效任务租约 | 截至本次验收未切换。精确 `.3` 候选已离线构建，服务器真实 PDF 自检/回执定位、两套 SQLite 备份升级/回退/恢复、PostgreSQL 实际恢复及候选迁移已通过；账号入口、静态资源/隧道重连、配置一致性及空闲切换仍需完成。不能用候选验收冒充部署 |
| P1，发布门禁 | 阅读治理 `59be492b` 的完整 CI 42169575328 第 2 次通过，已合入 `b07eb4ae`；首次审计失败保留记录，日志下载接口 404 | 首次候选 `9e2106de` 的 Windows Unix 夹具导入问题已修正；首次审计失败尚无原因证据；同候选重跑审计及全部门禁已成功，未放宽检查。后续 `.4` 包含容量观测与版本变更，仍须自己的完整发行 CI 成功 |
| P2 | 官方渲染/工作区数据模型已向前演进，本地基于 v0.2.19 且有 MobileSci 改造 | 同名文件或产品版本接近不等于可 cherry-pick。#869 缺前置函数，#871 改的是本地已替换的 SideChatPicker；按触发路径和运行模型验差异，避免重装旧头部/聊天入口 |
| P2 | 阅读回执已有来源/选区和实际任务，解析身份/去重范围在 PR #2，尚未发布 | 新候选绑定完整视图、PDF 观测工具身份，按任务/计划/来源/页码去重；旧未知不补造，written 不代表理解。共享库/字体未固定，网页汇总未实现。保留这条科学来源链，官方 .24 没有替代实现 |
| P2 | 容量、历史归档保留和测试全局状态隔离未完整闭合 | 只读占用观测正在独立实现；不能从当前 deliverySnapshot 推断全部历史 ZIP 无引用。先测字节/JSON增长/查询时间并登记保留关系，再做预览/受保护回收；EINTR/60 秒仅解决特定夹具，不代表全局 env/原生进程隔离完成 |
| P2 | 账号和远程边界与官方不同 | 官方 .24 扩展 alphaXiv OAuth/MCP、SSH 身份和计算目录，本地同时有账号平台、私人 executor、文献 SSO 和 OpenCode 接入。继续沿用 runtime-and-deployment.md，不从官方登录 UI 推导本地权限，更不开放 CORS 或搬运凭据 |
| P2/P3 | 科学指标来源仍待建立 | token/耗时是用量，不能冒充 loss/accuracy 等科学指标；继续绑定真实 Run、代码/数据版本、指标定义和提取回执。Vercel 新后端不会自动解决这一问题 |

此前已完成首批五组 .23 回移、日志范围、声明修订、来源定位与封存导出，详见[初始计划对照](implementation-progress-vs-plan-2026-11-04.md)。这些能力不重复计为 .24 成果；.24 没有直接改动本地的 materials、research、platform 扩展，不能用整版覆盖来“同步”这些自研能力。

## 三、优化方向与全部 16 个提交的处理建议

| 官方提交 / PR | 处理建议 | 主要原因与影响范围 |
| --- | --- | --- |
| `60b83075` / [#650](https://github.com/alphaXiv/OpenResearch/pull/650) | P3：按俄语用户需求接入 | 需补 MobileSci 新文案和现有 7 语言策略；不是只加入 ru.json 就完成产品本地化 |
| `664c5ee0` / [#833](https://github.com/alphaXiv/OpenResearch/pull/833) | 暂不回移默认更新链 | 桌面重启前暂存更新有价值，但本地 product-disabled、独立源码发布与部署备份门禁必须保留；不能拉官方安装包覆盖私人执行器 |
| `64c793e6` / [#859](https://github.com/alphaXiv/OpenResearch/pull/859) | 取架构文档拆分思想，暂不换开发启动链 | 官方以 dev.ts 替换 dev-slot 并重写 AGENTS/侧栏；本地启动器、数据隔离、端口、服务 ownership 和提交规范已定制，整体替换会破坏现有约定 |
| `5f38e938` / [#856](https://github.com/alphaXiv/OpenResearch/pull/856) | 本地桌面专项，P2/P3 | 文件定位能力需与 SSH/私人托管两种远端边界一并实现 |
| `109a8c45` / [#851](https://github.com/alphaXiv/OpenResearch/pull/851) | P3，可选 fx ACP 预设 | 仅在实际部署工具/版本兼容且用户主动选择时开放；不替换主 OpenCode 链路，不扩大实验权限 |
| `390ae1ab` / [#860](https://github.com/alphaXiv/OpenResearch/pull/860) | 优先回移测试夹具 | Windows 慢启动的明确有限等待，生产时限不变 |
| `38070ed5` / [#698](https://github.com/alphaXiv/OpenResearch/pull/698) | 优先回移测试夹具 | 修正 Unix 原生信号引发 EINTR 的测试误判，保留原期限 |
| `720d3b1b` / [#832](https://github.com/alphaXiv/OpenResearch/pull/832) | 暂不引入 Vercel Sandbox 后端 | 新任务后端、凭据、计费和伴随服务目录变更很大；目前无明确用户场景。先完善现有私人执行器和真实 Run 指标，不引入另一套资源生命周期 |
| `8ff520ba` / [#858](https://github.com/alphaXiv/OpenResearch/pull/858) | P2：独立技能编辑批次 | 原子写、配额、镜像只读和权限/路径回归必须同时到位 |
| `ece1a929` / [#869](https://github.com/alphaXiv/OpenResearch/pull/869) | 先验证触发模型，再适配可见性规则 | 本地无 splitResponseParts；不能对不存在的逻辑宣称直接修复 |
| `a27cc959` / [#870](https://github.com/alphaXiv/OpenResearch/pull/870) | Linux 桌面专项 | 主工作流为本地浏览器/私人托管，桌面浏览器 handoff 需独立环境验收 |
| `bb1ec22d` / [#871](https://github.com/alphaXiv/OpenResearch/pull/871) | 不直接套用；保留本地 SideChatMenu | 本地旧 Picker 已替换，菜单显式区分“新侧聊”和保存记录；不要恢复旧组件或复制按钮 |
| `59acdeb0` / [#872](https://github.com/alphaXiv/OpenResearch/pull/872) | P1：优先适配 | 现有跨项目入口绕过工作区恢复处理器，调用点直接对应 |
| `fe71f129` / [#861](https://github.com/alphaXiv/OpenResearch/pull/861) | 拆分评估，暂不接管本地认证 | alphaXiv 论文选择与工具可作未来可选文献源；整批涉及登录/令牌/MCP/SSH/Agent 配置和 61 个文件，会与本地账号、文献 SSO、来源图标改造交叉。账号/计算 API 实施前必须检查 companion，伴随仓库不在当前编辑范围 |
| `10f6deaa` / [#875](https://github.com/alphaXiv/OpenResearch/pull/875) | 随俄语专项 | 是 #650 的后续翻译修订，不单独计成新产品能力 |
| `23a4d67b` / [#874](https://github.com/alphaXiv/OpenResearch/pull/874) | 不照搬版本文件 | 保持真实上游祖先、选择性回移台账和独立 MobileSci 版本，已存在的产品标签不可移动 |

实施顺序：先完成当前阅读候选审计与源码发布、生产空闲准入和入口验收；独立推进只读容量观测；.24 首批采用 #872 + 两项原生测试修正，并重建隔离工作树的 ui/dist、执行项目切换/原生回归；随后按实际场景选择技能编辑及其他专项。其余没有宣布永远无价值，而是不混入当前可独立验收的回移批次。

本页依据为已获取的固定 Git 标签/逐提交 diff 和本地实现，官方发行说明仅用于核验版本与提交范围；当前结论不表示上述建议已经回移、发布或部署。
