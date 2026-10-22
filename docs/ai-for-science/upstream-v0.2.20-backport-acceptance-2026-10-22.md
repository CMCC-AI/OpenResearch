# v0.2.20 选择性回移测试验收

日期：2026-10-22。对应[回移批次](upstream-v0.2.20-backport-batches.md)。结论：本地自动化、数据库迁移及后端生命周期检查通过；侧聊浏览器生命周期、设置滚动及真实 OpenCode 首次发送/关闭重开闭环通过；窄屏导航遮挡已修正，可编辑明暗选区已验收；环境页与专家唤醒仍保留边界说明，不能据此标记服务器发布完成。

## 已通过

| 范围 | 结果 | 本地证据 |
| --- | --- | --- |
| Rust 全量 `cargo test --locked` | 1192 个单元测试通过，3 个忽略；18 个集成测试通过 | `rust-full.log` |
| 侧聊专项 | 27 个通过，包含父分支上下文恢复 | `rust-side.log` |
| UI 全量 | 413 个通过；专项 37 个通过（包含在全量中，不重复计数） | `ui-full.log`、`ui-targeted.log` |
| 启动、开发槽及发行证据辅助测试 | 20 个通过 | `helpers.log` |
| 部署脚本 | 44 个通过；部署 shell 语法检查通过 | `deploy-tests.log` |
| 图表及发布说明 | 4 个、6 个通过 | `chart-tests.log`、`release-notes-tests.log` |
| 账号平台 | 33 个单元测试、40 个 PostgreSQL 集成测试通过 | `platform-tests.log`、`platform-integration.log` |
| 上游基线、i18n、样式 | 通过；基线仍为 v0.2.19，官方 updater 禁用 | 本轮终端检查 |

上述日志位于仓库忽略目录 `.mobilesci-run/backport-v0.2.20/acceptance/`。此前第三批的 fmt、clippy、check、Rust build、UI build 与体积检查见 `batch-3/`。初轮验收仅补充脚本、证据和文档；后续布局修正涉及 App.tsx、app.css 及重新生成的 ui/dist，没有改动依赖或 Rust 运行源码；专项通过数不得与全量直接相加。未将本机 macOS 测试等同于 Linux/Windows 发行矩阵、依赖安全审计或全部 GitHub CI 已通过。

## 数据与生命周期

- 旧库迁移：从原 slot-1 通过 SQLite backup 读取一致性副本；只在副本上首次及重复打开新程序。迁移标记仅出现一次，26 张非迁移表的原有列内容摘要保持一致，SQLite 完整性检查为 `ok`。证据：`check-legacy.py`、`legacy-migration.json`。
- 回退保全：从迁移前备份恢复，27 张原有表的内容摘要全部一致。没有用旧二进制打开新库；旧版启动清理仍可能删除侧聊，安全回退必须恢复迁移前数据。
- 侧聊持久化：隔离槽创建一个父会话及 7 个侧聊，保存创建时的父分支 leaf；切换父分支后保存引用不变。重启隔离后端后，8 个会话均可读取，7 个原分支引用均保留，数据库完整性正常。证据：`check-lifecycle.py`、`fixture-state.json`、`restart-check.json`。
- 删除保护：活跃研究的父会话删除被拒绝，父会话与侧聊均保留；停止该研究后删除父会话，父子会话均返回 404。当前拒绝的 HTTP 状态为既有的 500，带“请先停止研究”说明；本次仅验证保护生效，不将其表述为理想的 4xx 错误契约。
- 早期数据/API 检查使用合成会话与消息，没有模型调用。浏览器恢复后另发起一条 OpenCode 短回复检查，详见下节；没有启动专家研究或实验。

原 slot-1 有运行中的 OpenCode 会话，因此未重启或停止它。验收使用临时工作区 `/private/tmp/mobilesci-sidechat-acceptance-20261022`，经 `scripts/dev-slot.mjs` 启动 slot-4（后端 4904、前端 5204）。仅临时工作区 Vite host 设为 `127.0.0.1`；仓库运行源码未为验收改写。独立账号服务监听 `127.0.0.1:5301`，使用随机 PostgreSQL schema 和合成测试账号，不改原账号及 CORS，不覆盖 localhost 的登录 cookie。

数据库副本和 fixture 证据只留在忽略目录，权限受限；不提交研究数据、密码或数据库文件。

## 浏览器恢复后的结果

应用重启后，浏览器访问已恢复，使用合成账号成功登录同一 slot-4。此前审批流断开、data URL 和连接拒绝属于历史阻断，当前不再以此解释剩余项目。运行源码、消息目录、测试及 Cargo 文件共 516 项与隔离副本一致。

- 侧聊菜单能列出重启后保留的 7 个侧聊；输入“侧聊 3”只保留对应条目。关闭该标签后，菜单仍列出同一会话，重新打开的 URL 中 sessionId 一致。
- 显式删除入口确实触发 JavaScript 永久删除确认；该交互结束后测试侧聊 3 已删除，列表从 7 变为 6。工具随后未获取到活动对话框，因此不把“取消删除成功”记为通过。父会话及其余 6 个测试侧聊保留，均核对数据库。
- 打开 6 个长标题标签后，标签条产生溢出，首尾选中标签均自动滚动到可见区；1440×900 下测得滚动容器 clientWidth 406、scrollWidth 1344，选中首标签时 scrollLeft 为 0。刷新后选中侧聊及其标签仍恢复。
- 768×900 下工具栏未重叠；展开导航时主聊天区域部分被遮挡，折叠导航后恢复正常双栏。此处记录的是修正前结果，P2 遮挡问题已在后续布局回归中消除，见下节。
- 设置页离开时 scrollTop 683.5，返回后为 0；深色主题确认为 `data-theme=dark`，背景 `rgb(9, 23, 37)`，之后恢复系统主题。
- 新建侧聊时 URL 的 sessionId 为 null；关闭未发送草稿没有新增数据库会话。另一次首次发送后建立唯一的新侧聊，保存当前父 leaf `fixture-user`，与早期侧聊保留的 `fixture-leaf` 区分正确；输入框清空并显示正在思考。OpenCode 最终回复“侧聊验收通过”；关闭此标签后从历史菜单重开，同一 sessionId 的用户消息和回复完整保留。此项真实闭环通过，不代表专家唤醒或实验执行已验收。

证据：`browser-check.json` 及 `wide-tabs.jpg`、`narrow-expanded.jpg`、`narrow-collapsed.jpg`、`dark-settings.jpg`、`refreshed-sidechat.jpg`、`opencode-sidechat-reopened.jpg`，均在忽略目录的 acceptance 下；不包含业务账号凭据。

## 窄屏布局修正与补充验收

修正范围：`ui/src/App.tsx`、`ui/src/app.css`。旧样式在 820px 以下把导航绝对定位到主聊天上方，同时侧面板保留固定宽度。现在展开导航在 1024px 及以下占用正常网格列，聊天与非最大化面板上下排列；导航折叠时在 740px 及以下上下排列，768px 可保留双栏。侧面板宽度经 CSS 变量提供，堆叠时由容器决定宽度，隐藏此时无作用的横向拖动柄。宽屏继续保留拖动宽度和最大化/还原行为。

- 768px 展开导航：导航右边界 280，主聊天左边界 280，侧聊位于下一行，从 y=482 开始，没有遮挡或交叠。
- 1024px 展开导航同样通过；1440px 保持左右双栏。768px 折叠导航双栏、700px 折叠导航堆叠，以及面板展开/还原均通过。验证高度为 900px，不将这些结果扩大为所有手机尺寸已适配。
- 使用临时项目内的 `fixture-project/selection-check.py`，通过无 Git ref 的文件路由打开真实可编辑 textarea。明暗主题均选中全部 164 个字符，字形没有重复，选区文字层为透明；浅色背景为 `rgba(22,22,22,0.12)`，深色为 `rgba(255,255,255,0.16)`。没有编辑或保存代码内容，结束后恢复系统主题。
- 环境变量页面：当前 `/settings/environment` 返回“不可用”，没有表格可供浏览器验收；不能将旧组件中的末行边框源码改动表述为当前产品入口已验收。此处不是权限或审批失败，没有修改路由或扩大访问边界。
- UI 全量测试再次 413/413 通过；UI build、样式、体积和 diff 检查通过，ui/dist 已按本次源码重建，Rust debug 二进制也重新构建以嵌入新资源。最终入口 index-BRcfPLsW.js 为 2,947,522 raw / 899,996 gzip bytes，低于现行预算。证据：`layout-ui-tests.log`、`layout-build.log`、`layout-rust-build.log`、`layout-check.json` 和 `layout-*-expanded.jpg`、`layout-768-collapsed.jpg`、`editor-selection-light.jpg`、`editor-selection-dark.jpg`。本次不重复运行没有源码变化的 Rust 测试，沿用此前全量结果。

## 剩余验收与运行状态

专家派发与完成唤醒已通过后续真实 OpenCode 三任务合成闭环，见[可靠性后续验收](reliability-followup-2026-10-22.md)；W1–W4 和实际实验审批不在本轮范围；环境变量末行边框因当前产品入口不可用而未做浏览器确认。其余本轮列出的侧聊回移、设置滚动、选区与半屏遮挡检查均已完成。

隔离服务保留以供继续验收，按状态文件核实进程后再停止 slot-4 与独立账号服务，服务正常退出会清理自身随机 schema。不停止原有业务服务。浏览器临时 viewport override 已清除，主题恢复为系统。验收记录形成时回移尚未提交，服务器发布未执行；后续提交状态以 Git 记录为准。
