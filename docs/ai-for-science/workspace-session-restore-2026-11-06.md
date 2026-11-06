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
