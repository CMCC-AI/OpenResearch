# OpenResearch v0.2.23 选择性回移台账

核查与实施日期：2026-11-02。产品版本 `0.2.23-mobilesci.1`；官方目标固定为 `a92fd471aba91e9bdd14a88e2322ec42f9dfdbdb`。真实合并祖先仍为 v0.2.19（`1d8a285468aed5d5a1f1ea86ecf6e2f63fcaa8bd`），不是完整同步 v0.2.23。此前 v0.2.22 回移见[分批记录](upstream-backport-plan-2026-10-28.md)。

后续产品修补：`0.2.23-mobilesci.2` 的[研究交付日志范围](research-delivery-scope-2026-11-02.md)独立于本页官方回移批次。下文保留 .1 的实施快照。

## 本次范围与边界

- 修正聊天文件引用的保留字符解码与 NUL 拒绝，保留材料、产物、部署子路径及文件权限边界。
- 规范 OpenAI 引用显示：保留 URL，隐藏无法解析的内部标记；不把显示转换当作科学证据核验。
- 增强现有 CSV/TSV 阅读器：筛选、数值排序、原始行号与虚拟行，可关闭首行标题；保留 16 MiB、1000 行、100 列及单元格大小限制。排序只作用于预览，完整数据下载不变，Office、Notebook 和压缩包保持原有实现。
- 适配 Codex 探测、Claude 调用方标识、Git Bash shim、远端 POSIX 路径，以及现有 macOS 打包维护。
- 源码清单包含真实上游祖先、回移目标和本台账；官方自动更新仍禁用。发布由现有源码 Release 工作流调用完整 CI，成功后才创建产品标签及附件。

本次没有改变研究 schema、账号协议、实验授权或部署环境。研究引用闭包、结构化阅读追溯、实验指标、容量治理、移动工作区、统一对话框与 ACP 接入留待独立设计和验收。原工作台 connector、配置 seed、认证 seed 和历史读取兼容不在删除范围。

## 官方 v0.2.22 → v0.2.23 全部提交

“未回移”不代表无价值或不兼容；表示本产品尚未接入，不能用产品版本号推断能力已具备。

| 官方固定提交 | 官方改动 | 本地处理 |
| --- | --- | --- |
| [`d06949ce`](https://github.com/alphaXiv/OpenResearch/commit/d06949cea09557c3c9923cd8e72b4d6c678bdaff) | docs: replace README screenshot with a demo GIF (#806) | 未回移：本次独立发布批次不包含此项。 |
| [`7bfa16db`](https://github.com/alphaXiv/OpenResearch/commit/7bfa16dbc2d3e1bd8e76f5157678a1fd925cb2d8) | fix: keep macOS traffic lights aligned when resizing (#812) | 未回移：本次独立发布批次不包含此项。 |
| [`f1eaafed`](https://github.com/alphaXiv/OpenResearch/commit/f1eaafed9838f158179a113fdf02034fbde037e8) | fix: polish desktop development and workspace controls (#813) | 未回移：本次独立发布批次不包含此项。 |
| [`2acbbaca`](https://github.com/alphaXiv/OpenResearch/commit/2acbbaca459560c298e2e46809abf2119ce81666) | fix: use the standard folder picker on windows (#814) | 未回移：本次独立发布批次不包含此项。 |
| [`30a04186`](https://github.com/alphaXiv/OpenResearch/commit/30a04186d5313b5205c4a5df4d9bfd31a2903b32) | Make the dev-slot lifecycle lock test pass on Windows (#374) | 未回移：本次独立发布批次不包含此项。 |
| [`14d3244a`](https://github.com/alphaXiv/OpenResearch/commit/14d3244a1dc2862c943d5be116c884e5a8a1dec6) | fix: normalize OpenAI citation markers (#815) | 已适配：URL 引用、内部标记与流式尾部处理，保留代码区域。 |
| [`0cfb2d78`](https://github.com/alphaXiv/OpenResearch/commit/0cfb2d78e543a12dc9dcd6c5f66cac11adbf921c) | fix: use POSIX path rules on the remote and trust user private groups (#816) | 部分适配：仅远端 POSIX 路径规则与回归；保留本地 login shell、SSH 传输及原有二进制信任策略。 |
| [`160d2eba`](https://github.com/alphaXiv/OpenResearch/commit/160d2eba482bad2a430b256c0a07a76bdd5723d0) | OR-418 Detect the Codex CLI bundled inside ChatGPT.app (#548) | 已适配：macOS ChatGPT.app 内置 Codex 探测及回归。 |
| [`f10b3f33`](https://github.com/alphaXiv/OpenResearch/commit/f10b3f33718058eb9ff5775a853d78afeb7a4031) | fix(ui): decode reserved characters in chat file links (#595) | 已适配：本地聊天回退路径完整解码并拒绝 NUL；保留既有材料与产物解析。 |
| [`ea41b76e`](https://github.com/alphaXiv/OpenResearch/commit/ea41b76ee197fa0aae9bb7461fc015de75b7ed03) | feat: adapt dashboard workspace for mobile (#818) | 未回移：本次独立发布批次不包含此项。 |
| [`70dce414`](https://github.com/alphaXiv/OpenResearch/commit/70dce41469c30e2f6c071cafdd7581039408173a) | chore: update pnpm (#817) | 未回移：本次独立发布批次不包含此项。 |
| [`0658211b`](https://github.com/alphaXiv/OpenResearch/commit/0658211b7db5a303151671ed216d42447d65ed45) | fix: disable macOS writing tools (#819) | 未回移：本次独立发布批次不包含此项。 |
| [`0242a201`](https://github.com/alphaXiv/OpenResearch/commit/0242a20150295881ea412f9cfe90abcaa0b8a10d) | feat: streamline harness setup and account display (#820) | 未回移：本次独立发布批次不包含此项。 |
| [`5b74409a`](https://github.com/alphaXiv/OpenResearch/commit/5b74409aab95c4e8f9ec14c4f73aea301467e375) | feat: add keyboard navigation and application menus (#822) | 未回移：本次独立发布批次不包含此项。 |
| [`cbe099df`](https://github.com/alphaXiv/OpenResearch/commit/cbe099dfa97466ea17c6c695388c83f1cddfbf76) | Use native skill discovery for all OpenResearch agents (#826) | 未回移：本次独立发布批次不包含此项。 |
| [`bf39495f`](https://github.com/alphaXiv/OpenResearch/commit/bf39495f06d5512f7e78962439ddeb4287c13ea1) | Open openresearch:// links in the Windows and Linux apps (#825) | 未回移：本次独立发布批次不包含此项。 |
| [`e3cbba2e`](https://github.com/alphaXiv/OpenResearch/commit/e3cbba2e7680ab67b85bf5f575c4715c129c0734) | feat(ui): shared imperative dialog system on Base UI (#828) | 未回移：本次独立发布批次不包含此项。 |
| [`703fd4bb`](https://github.com/alphaXiv/OpenResearch/commit/703fd4bba66311625cf7e0b0776a0f949d3f4c73) | fix: identify Claude subprocesses as openresearch (#827) | 已适配：Claude 会话与辅助调用显式标记调用方。 |
| [`01695af2`](https://github.com/alphaXiv/OpenResearch/commit/01695af2375e99c60e8e72d0bdb3163665ccb591) | feat(acp): add oh-my-pi to the preconfigured coding agents (#784) | 未回移：本次独立发布批次不包含此项。 |
| [`4265dffd`](https://github.com/alphaXiv/OpenResearch/commit/4265dffd85fc974c8472cee176e8fe19d21bf106) | feat: colored markdown, verified file references, healed KaTeX (#835) | 未回移：本次独立发布批次不包含此项。 |
| [`89ba83f9`](https://github.com/alphaXiv/OpenResearch/commit/89ba83f9d00f9beecb0529b0646e0f5a2e63f005) | fix(ui): drop regex lookbehind from email autolink for Safari 12 (#837) | 未回移：本次独立发布批次不包含此项。 |
| [`d6ecb73b`](https://github.com/alphaXiv/OpenResearch/commit/d6ecb73bc6c2d2755c413db7449e0646ad66abe5) | fix: align macOS traffic lights once the dashboard has loaded (#838) | 未回移：本次独立发布批次不包含此项。 |
| [`8ad700f2`](https://github.com/alphaXiv/OpenResearch/commit/8ad700f29a33c03bde0cebaa028f941c9bd3a5ef) | feat(app): macOS sidebar material and resizable sidebar (#842) | 未回移：本次独立发布批次不包含此项。 |
| [`c6e15694`](https://github.com/alphaXiv/OpenResearch/commit/c6e156948d4bf5fdeadfbfeb22a65f7380ca692f) | Find Git for Windows' bash behind a git shim (OR-599) (#779) | 已适配：Git shim 后的 Git Bash 定位与既有工具链共用。 |
| [`999fe3b1`](https://github.com/alphaXiv/OpenResearch/commit/999fe3b197e3581b440608448cf052bd08c6a752) | ci: build macOS on macos-latest with a pinned deployment target (#844) | 部分适配：现有 macOS 应用工作流 runner 与最低系统目标；本地没有 canary 工作流。 |
| [`d96ff6cc`](https://github.com/alphaXiv/OpenResearch/commit/d96ff6cc063e449457a8b84bdea643973967de69) | Simplify the run log view (#845) | 未回移：本次独立发布批次不包含此项。 |
| [`ca857ee8`](https://github.com/alphaXiv/OpenResearch/commit/ca857ee80ebc66b704b349eeadc5ad8d08a18e1d) | feat(ui): render CSV/TSV files as a virtualized, sortable table (#847) | 能力适配：现有有界共享阅读器增加筛选、数值排序和虚拟行；复用本地解析器，不引入 TanStack Table 或改变 Office 预览。 |
| [`5f4a4330`](https://github.com/alphaXiv/OpenResearch/commit/5f4a4330e8ccf716e8171892bf85c27d94b1675a) | ci: retry DMG creation when macOS runners report "Resource busy" (#848) | 已适配：DMG 创建遇到临时故障时有界重试。 |
| [`62db3ac6`](https://github.com/alphaXiv/OpenResearch/commit/62db3ac64e3774ca5aff470305b79b54f46e4be3) | fix(app): macOS sidebar veil over the Sidebar material (#846) | 未回移：本次独立发布批次不包含此项。 |
| [`ab8583ca`](https://github.com/alphaXiv/OpenResearch/commit/ab8583ca321b84dd22a3cac48fd23e22a9f14ec4) | chore: bump version to 0.2.23 (#841) | 主动排除：使用独立产品版本，不覆盖真实上游祖先。 |
| [`115e5d5c`](https://github.com/alphaXiv/OpenResearch/commit/115e5d5cd85cf6135c116d14a6f9978eea4df744) | Fix inherited PowerShell module paths in Windows SSH ACL setup (#840) | 未回移：依赖本地尚无的 SSH service 层；不为单行修正引入整套远端服务。 |
| [`a92fd471`](https://github.com/alphaXiv/OpenResearch/commit/a92fd471aba91e9bdd14a88e2322ec42f9dfdbdb) | ci: build arm64 macOS release CLI on macos-latest, not retiring macos-14 (#849) | 已适配：macOS CLI 签名 runner 与 cargo-dist runner 配置。 |

## 验证

执行记录见[本版发布说明](../../release-notes/v0.2.23-mobilesci.1.md)。单元回归、源码构建与远端 CI 分别记录，不代替真实模型、Windows 桌面、macOS 签名包或生产部署验收。

本地已完成：前端首轮 530 项测试、类型/i18n/样式/生产构建与体积预算，Rust 1400 项单元及 18 项 CLI 集成测试（13 项既有忽略），启动/发行脚本 24 项、部署 Python 46 项、图表 4 项、发行说明 6 项，平台单元 38 项及格式检查。首轮沙箱禁止本机端口导致的失败，在允许本机夹具监听后复跑通过。

浏览器使用纯合成的 1000 行 CSV 组件夹具，验证数值排序、原始行号、筛选、多行中文、390px 窄屏和滚动末尾；未使用用户数据库、真实材料或模型。此验证不替代整个私人托管版和三服务 SSO 验收。

发布审计发现路由间接依赖 seroval 的高危项，约束至 1.6.11 后前端高危审计通过，平台高危审计通过；仍有低/中危公告，未声称依赖零风险。依赖变更后重新执行前端测试与构建。macOS runner/DMG 与 Windows 专项由对应环境 CI/签名打包验证，本地仅执行适用检查。
