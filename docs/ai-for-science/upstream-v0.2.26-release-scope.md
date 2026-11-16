# 官方 v0.2.26 与 .7 冻结范围

核查时间：2026-11-11。官方[发行](https://github.com/alphaXiv/OpenResearch/releases/tag/v0.2.26)发布于上海 06:56:33；[固定比较](https://github.com/alphaXiv/OpenResearch/compare/v0.2.25...v0.2.26)从 `c9123a6f70828f8021e11f6b9a16197ce77f53f9` 到 `e737b04d0491ac7e44962f3d7765c5c242b39461`，14 个提交。本项目真实祖先及更新通道不改变。

| 官方提交／PR | 本地判断与影响 | .7 决定 |
| --- | --- | --- |
| `fabe5816` #922 | Md 的 image-carousel 在动态 components 内定义，更新后类型变化会重新挂载，重置所选图片 | P1 适配：提升至 stableComponents；实际 Markdown 渲染器测试核对两次更新的组件类型 |
| `22295d79` #926 | 修 ComposerEditor；本地仍用 textarea，无相同组件 | P2 按需，暂缓输入器重写 |
| `c29c3048` #936 | 修 groupResponseMessages 合并回答；本地 VirtualTranscript 每个 message.id 独立挂载 Message/AssistantTurn，没有该分组路径 | 不直接适配；保留现有答案分段回归，出现本地复现再处理 |
| `5c94640d` #607 | Hugging Face 提交 timeout_secs 未记录，当前实现仍有缺口 | P2，后端明确使用需求时独立修补，不阻塞托管版 |
| `f1f00dad` #928 | AppImage 启动器宿主环境及 Wayland/X11 | P2，签名桌面交付前另验；本版不承诺桌面安装包 |
| `9a86765c` #938 | Antigravity 转为 ACP，涉及常驻进程、Hook、权限与清理；本地未采用 ACP host | 暂缓成套集成 |
| `fcc8538e` #935 | 本地 pendingPlan 从全部历史反查，过期未决计划仍可能占据输入器 | P1 适配：仅最近用户轮次；共用 Shell 分类；覆盖原生／合成计划、队列、重新加载、批准后旧卡不复现 |
| `8d6fdba9` #937 | ACP 用量与遥测；不等于用户额度预占／结算／拒绝机制 | 暂缓；未来接 ACP 时按本地计量和遥测边界评审 |
| `2c62433c` #941 | 演示去 Apple Silicon 限定文案 | P3，发布后展示优化 |
| `92d6423a` #943 | steering 消息间距 | P3，不扩展本批 UI 范围 |
| `50e76752` #947 | Antigravity ACP 工具行和审批 | 随 #938 成套评估 |
| `034e4945` #948 | 修 #938 引入的 ACP 闲置清理回归；本地未引入前置变化 | 不单独移植 |
| `a139a69f` #939 | ACP 一次性标题／推荐／摘要请求；本地没有该 harness | 暂缓；不为修尚未采用的能力引入 ACP |
| `e737b04d` #951 | 官方升版 | 保留本项目 `.7` 独立版本 |

本轮只纳入 #922、#935。未选择的 .25/.26 改动不自动成为技术债或发行阻塞。冻结后仅接受有复现依据的发行阻塞修补；新功能、PR #17、全后端追溯和完整环境封存进入发布后待办，不在本轮继续设计。
