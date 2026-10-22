# v0.2.20 选择性回移批次

更新日期：2026-10-22。服务器当前使用 OpenCode，按[版本差距核查](upstream-v0.2.20-gap-2026-10-22.md)选择产品相关改动，不整体升级官方 tag，不引入 Codex/Windows 专项、ACP 或租用算力新协议。

当前前三批均已完成源码与构建。测试曾暂停；用户恢复验收后，自动化回归、旧库副本迁移及恢复、隔离后端重启持久化和删除保护均已通过。浏览器侧聊恢复、草稿及设置滚动检查通过；可编辑明暗选区与窄屏展开导航遮挡修正也已验收；环境页与专家唤醒保留边界说明，详见[本轮测试记录](upstream-v0.2.20-backport-acceptance-2026-10-22.md)。已实现不等于全部验收或服务器部署完成。版本基线仍为 v0.2.19，官方更新通道仍禁用；此前未提交的 Rust 可靠性测试保持原样。

## 第一批：低耦合界面修复（源码与构建完成）

| 来源 | 文件 | 改动 |
| --- | --- | --- |
| [#677](https://github.com/alphaXiv/OpenResearch/pull/677)，`25497c4` | `ui/src/base.css`、`theme.css` | 编辑器选区隐藏 textarea 的重复字形，以半透明背景覆盖语法高亮层；保留产品蓝色主题，使用官方明暗选区透明度，兼容旧 WebKit。 |
| #677 配套断言 | `ui/tests/textSelectionContrast.test.mjs` | 同步上游选区对比度断言，避免继续要求旧的重复绘制行为；恢复测试后随 UI 全量回归通过。 |
| [#714](https://github.com/alphaXiv/OpenResearch/pull/714)，`eefc4be` | `ui/src/components/ChatPanel.tsx` | 设置滚动容器按 mainView 设 key，切换页面不复用其他视图的滚动位置。 |
| [#695](https://github.com/alphaXiv/OpenResearch/pull/695)，`0bdbabd` | `ui/src/components/ClosableTab.tsx` | 扩大关闭点击区和图标，调整末端留白；保留预览标签、事件处理及脏文件关闭保护。 |
| [#725](https://github.com/alphaXiv/OpenResearch/pull/725)，`d226809` | `ui/src/components/SettingsPage.tsx` | 环境变量表最后一行不再叠加底边框。 |

执行 `pnpm run build` 成功，包含 i18n、Paraglide、路由生成、TypeScript 和 Vite；样式检查通过。批次入口 2,939,770 raw / 897,780 gzip bytes，预算通过。源码及生成资源的第一批补丁保存在忽略目录 `.mobilesci-run/backport-v0.2.20/batch-1/changes.patch`，构建及检查日志同目录。

## 第二批：右面板标签滚动（源码与构建完成）

来源：[#718](https://github.com/alphaXiv/OpenResearch/pull/718)，`a8d4dd8`；同时纳入 [#727](https://github.com/alphaXiv/OpenResearch/pull/727) 对滚动条悬停显示的改进。`TabStrip.tsx` 从固定 v0.2.20 tag 提取，App 按产品现有标签组合接入；不把 #727 的侧聊菜单与草稿改动算作已完成。

- `ui/src/components/TabStrip.tsx`：横向滚动、纵向滚轮转换、可拖动滚动指示条、当前标签自动显示、ResizeObserver 和计时器清理；滚动状态局限在组件内部。
- `ui/src/App.tsx`：以 `rightTabKey(rightTab)` 跟随选中标签；保留科研专家团、文件、终端、产物、实验及既有内容标签、顺序和关闭逻辑。
- 最终 `ui/dist` 已按第二批源码重新构建，未采用官方静态资源包。

第二批 `pnpm run build` 成功，样式检查、入口预算与 `git diff --check` 通过。最终入口 2,942,151 raw / 898,473 gzip bytes，低于 3.1 MB raw / 950 KB gzip 上限；日志位于 `.mobilesci-run/backport-v0.2.20/batch-2/`。构建仍提示已有的大 chunk 警告及 capability-card-pattern.svg 运行时解析提示，不将这些提示表述为本批消除。

## 第三批：持久侧边聊天（自动化及数据验收通过，界面待验收）

目标：OpenCode 侧聊在关闭标签或后端重启后仍可恢复，保留首次发送建立会话时的父分支位置。来源以 #716 为主，参考 #727 的菜单与草稿显示；采用产品现有工具栏布局，不照搬官方悬浮菜单。

已实施以下改动，不混入 ACP 或租用服务：

1. 存储：`src/store.rs` 增加 side_parent_leaf_id，通过独立 `persistent-side-chats-v1` 事务迁移，不改写已应用的 legacy-columns-v1。补齐专家派发、demo、导入和测试夹具的 StoredChatSession 构造；保留产品 parent_session_id 的列顺序和专家 chat_spawns。批量快照插入同步保留侧聊父会话与分支引用。
2. 生命周期：`src/commands/up.rs` 移除启动批量清理，`chat/mod.rs` 移除临时侧聊删除函数。显式删除父会话时传播子会话失败；存储层使用写事务检查是否仍有子会话，并在事务内重查活跃研究。ChatHost 在递归和中断前也先检查活跃研究，避免失败删除请求先清掉持久侧聊。
3. 上下文：创建侧聊时在写事务中重读父会话和当前分支；首次启动或压缩恢复通过保存的 leaf 取上下文，父会话切换分支不会改变该边界，缺失引用报错。旧 bootstrap 快照优先保留，不改专家 bootstrap 与材料/研究上下文的入口。父消息在同一 leaf 上继续更新时会读取更新内容，此实现固定的是分支边界，并非逐字冻结快照。
4. 界面与协议：空草稿用 null sessionId 表示，首次发送再创建侧聊；关闭标签只移除标签，显式删除沿用原确认流程。`SideChatMenu.tsx` 在现有“更多工具”内按父会话列出、搜索和重新打开侧聊，保留 header 正常布局、科研专家团入口、演示欢迎入口和只读案例限制。侧聊草稿的 autonomy 保持局部状态；普通对话创建研究的路径保持原有逻辑。侧聊接口仍使用既有 /api/chat/sessions/.../side，未放宽私人网关策略。
5. 同步/适配上游的父分支恢复、草稿自治设置及 workspace schema 回归源码；恢复测试后已随全量回归通过。菜单断言改为检查产品实际菜单，没有引入上游对全局 OptionPicker 的 hover/click 行为改造。

检查结果：`cargo check --locked --all-targets`、`cargo fmt --all --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo build --locked` 均通过；`pnpm run build`、样式和体积检查、`git diff --check` 通过。最终入口为 2,947,487 raw / 899,977 gzip bytes，ui/dist 已重建，新的本地 target/debug/orx 已包含该界面资源。日志和工作区源码哈希清单在 `.mobilesci-run/backport-v0.2.20/batch-3/`。首次前端编译发现产品演示入口的 prop 与上游删除冲突，已保留产品入口后重新构建通过。

恢复测试后已完成：旧库副本首次/重复迁移、迁移前备份恢复、隔离后端重启保留 7 个侧聊、父会话活跃研究删除保护、停止研究后的父子会话删除。原有开发槽未重启，另建 slot-4 验收，避免中断原槽正在执行的 OpenCode 会话。

浏览器恢复后已验收：侧聊菜单搜索、标签关闭/重开、空草稿关闭不入库、首次发送收到 OpenCode 回复并关闭重开保留内容、刷新恢复、设置滚动复位，以及宽屏标签溢出/切换定位。随后已修正窄屏导航覆盖并回归 768/1024/1440px 展开导航、768/700px 折叠导航和面板展开/还原；可编辑明暗选区也已验收。专家唤醒已通过后续真实 OpenCode 三任务合成闭环，见[可靠性后续验收](reliability-followup-2026-10-22.md)；实际科研流程与实验审批另行验收；环境设置路由当前显示不可用，末行边框仅有源码依据，不计入浏览器通过项。回退只验证迁移前备份恢复；旧二进制仍有启动清理，不能用它直接打开迁移后的数据库冒充安全回退。

## 其他能力保持单独排期

实验运行 ID/TensorBoard/Trackio、GitHub owner 与实验 lineage 依实际科研流程需求处理；ACP 和官方租约服务不纳入当前 OpenCode 服务器小批回移。验收记录形成时改动尚未提交，服务器发布未执行；原有开发槽未重启。
