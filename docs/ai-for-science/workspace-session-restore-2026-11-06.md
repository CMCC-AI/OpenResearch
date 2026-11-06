# 跨项目会话工作区恢复

本批适配官方 v0.2.24 的 [#872 / `59acdeb02d1869edfc37d0725dd98b87d3c1bf1c`](https://github.com/alphaXiv/OpenResearch/commit/59acdeb02d1869edfc37d0725dd98b87d3c1bf1c)。原补丁统一 ChatPanel 的 SessionRow.onOpen，本地另有首页 ResearchProjectNavigation 入口，以及私人空间/只读案例 API、研究和材料 pane，需一并适配。

## 行为与依据

- ChatPanel 的同项目/跨项目点击都进入 App.onActiveSessionChange；首页 SessionRow 也通过共享恢复器打开会话。目标保存的 side、research、materials、文件等 pane 继续使用原 taskLocation 和工作区还原协议，显式关闭 active:null 保持关闭。
- 缓存命中同步恢复；冷入口先读取目标项目 UI state，再导航。读取成功前显示现有本地化加载提示；失败停留当前页面并显示错误，用户可再次点击重试。成功结果写入正确查询范围，目标 App 的正常水合可以复用。
- 每个导航意图持有 AbortController。后续点击、路由加载、账号/执行端 workspace 切换或卸载取消前一请求；即使响应忽略取消，版本号、工作区 epoch、查询范围和当前路由比较仍拒绝过期导航及缓存写入。
- 首页使用 personal=true 的真实项目 UI-state GET 和个人 generation 查询键。在案例页，即使私人项目与案例源项目 ID 相同，也不读取案例内存缓存、不覆盖案例查询缓存。案例内普通读取仍走副本 API，缺少资源不会回退私人实例。
- 新会话 replace 仍先捕获并迁移草稿工作区；同项目 preservePane 保留当前 pane，跨项目从目标读取且不沿用 replace。仍通过 router.navigate，保留原 useBlocker/未保存文件保护；案例路由继续携带 caseId/preview。

本批只扩展客户端现有读取接口的 personal 选择及查询键，不改变后端/账号/组织/计算 API、实验授权、上传或权限策略。真实上游祖先仍为 v0.2.19，产品发行仍为 `.23-mobilesci.4`，不是完整合并 .24。

## 验证与状态

新增 25 项回归，全部 UI 580 项通过。覆盖共享恢复器的暖/冷入口、显式关闭、连续点击、过期账号/路由/epoch、取消失败、读取重试及同步传输错误；实际加载 API/query/hook 与案例适配器，验证同名项目隔离和无私人回退；执行源文件中的真实 ChatPanel/App 回调以及首页 SessionRow，验证跨项目、replace、preservePane、草稿迁移和 case/preview 路由。现有工作区、路由、草稿和案例测试保持通过。

类型检查、语言/样式检查及 pnpm build 完成，ui/dist 已从隔离工作树重建。入口为 2,956,162 字节，gzip 909,436，预算通过；未包含用户主工作区的来源图标和未提交资源。首次离线 Paraglide 因 CDN 插件受网络限制生成空声明，允许联网重新生成后通过；该次失败未计成功。

本轮已通过 dev-slot 启动自己的 slot-6 空数据库服务（4906/5206），没有复制用户数据或调用模型。实际浏览器验收仍缺失：工具重连确认 Mac 锁屏且浏览器连接不可用；源回调/SSR/单元测试不能替代真实浏览器的点击、前进后退、冷刷新与未保存离开体验。候选保持待浏览器验收状态，完整模拟合并 CI 及合入/发行结果另行记录。


## 2026-11-07 浏览器 CI 验收批次

PR #6 增加独立 Chromium 验收：CI 通过 `scripts/dev-slot.mjs` 启动专用空库，生成四个合成项目，使用真实后端 API 和 `captureNativeProject` 构造只读案例。账号服务仅由本地合成响应提供，不访问用户账号和生产数据。浏览器运行真实 Vite 应用与原生后端，覆盖暖/冷入口、跨项目 pane、历史前进后退与刷新、慢请求取消、读取失败重试、案例/私人同名 ID 隔离、未保存文件取消离开、窄屏与折叠导航。

脚本拒绝复用已有开发 slot 或非空数据库；退出时仅停止本批拥有的 slot。成功后检查 Run、消息、排队消息、子会话调用和材料阅读事件均为零，保存 revision、截图、失败 trace 与服务日志。流程纳入原有 `fmt, clippy, test` 作业，不改变模拟合并 checkout 或发布门禁。实现参照 [Playwright 官方 CI 文档](https://playwright.dev/docs/ci)。

本地仅验证脚本语法和两项浏览器场景发现，没有启动替代浏览器；580 项 UI 测试、类型检查、构建和样式检查通过，重建的 ui/dist 无变化。离线 frozen 安装因缺少缓存包失败，随后联网 frozen 安装成功。浏览器执行结果尚待 CI，不能记为已验收；真实账号登录、生产上传和重连仍需生产环境验证。

原 CI 42246514813 的 Linux、Windows、平台测试成功，但 macOS 作业因托管 runner 未能分配而取消，整体 failure。PR #7 的同类取消由 GitHub 注解确认 arm64 容量约束，已重试其受影响检查；不得以其他平台通过代替完整 CI。


独立后端准备烟测已完成，未运行 Chromium：专用 slot-7 的真实 API、四项目/五会话、原生案例捕获、查询检查和 finally 停止服务均通过，Run/消息/队列/派生调用/材料阅读事件全部为零。首次运行发现活跃 WAL 的 mode=ro 连接无法打开，改为 mode=rw（数据库必须存在）并启用 PRAGMA query_only=ON 后通过；仅此测试库的准备阶段使用显式写入事务。该结果证明夹具可准备和清理，不替代浏览器验收。


首轮 Chromium 已真实运行但未通过（CI 42257382378）：宽屏会话行被 Vite 默认展开的 Query Devtools 截获点击；窄屏在账号/导航尚未就绪时检查展开按钮，漏掉稍后出现的入口。已下载并检查失败截图和错误上下文，修正脚本为等待实际会话/展开入口就绪，并通过真实关闭按钮收起 Devtools，不强制点击、不改业务代码。后续重跑结果待记录，这轮失败不计作工作区行为已验收。


第二轮 Chromium（CI 42259488345）中窄屏/折叠导航通过。宽屏流程已执行暖/冷切换、历史/刷新、慢读取消、失败重试、关闭/研究 pane、同名案例隔离及未保存取消离开的全部步骤，截图和 JSON 步骤报告无业务步骤错误，但整体测试因释放被拦截的 PUT 后立即卸载拦截器/结束测试发生 Route is already handled 而失败；不能记作宽屏整项通过。

已检查宽屏未保存截图、窄屏材料截图及回调实现。清理改为释放屏障后使用 [unrouteAll 的 wait 行为](https://playwright.dev/docs/api/class-page#page-unroute-all)，等待在途回调结束，保留真实错误；随后确认保存状态清空再允许测试退出。慢读/失败重试的拦截清理也统一等待，不用 ignoreErrors 吞掉异常。新候选仍需真实 CI 重跑通过。


第三轮 CI 42263417663 的窄屏继续通过，宽屏在“取消慢读”步骤超时。下载并检查 trace 后确认：客户端取消的 GET 被 request.failure 条件跳过，没有调用 Route 的 continue/abort/fulfill/fallback，Playwright 的处理承诺始终未完成，因而 unrouteAll(wait) 一直等待。修正为屏障释放后始终结束路由回调；继续等待清理、保留错误及未保存/保存完成断言，不放宽 120 秒验收超时。

同轮 Windows 在 lease_heartbeat_worker_retains_gate_after_waiter_cancellation 的三秒门禁释放断言超时。测试原先把 Store::open_at 的迁移/连接准备也放在屏障释放之后；现提前准备工作连接，屏障仍控制真实租约续期和门禁生命周期，三秒断言及生产心跳逻辑不变。该修正只调整夹具，不声称已证明 Windows 恢复。

本地八线程心跳回归 8 项、检查点回归 65 项通过（4 项既有 ignored 不计入通过），UI 580 项通过；脚本语法和两场景发现、格式及 diff 检查通过。最终跨平台和真实 Chromium 重跑仍是合入门禁，不能以前序局部结果替代。
