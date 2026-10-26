# MobileSci 公开介绍页

页面迁自 `git@github.com:CMCC-AI/mobilesci-landing-page.git`，参考版本为 `c2d078b70fb53247bc881b7d317fafce8e41add7`。

- `ui/src/product/LandingPage.tsx` 保留蓝色 M 首屏、产品截图轮播、五阶段科研流程、技术优势、三位一体、能力验证和 24 项任务卡片。
- 所有主要研究入口复用现有账户登录与 `/projects?new=true` 路由。登录用户访问首页时仍沿用账户模块的自动跳转。
- 页面样式与动画限定在 `.product-landing` 内，配色集中在 `ui/src/theme.css`。压缩的响应式 WebP 位于 `ui/src/assets/landing/showcase/`，由 Vite 生成带哈希的资源 URL，兼容 `/mobilesci/` 部署前缀。
- 技术优势插画仅为能力示意，不代表实际实验数据。首屏轮播的四张产品截图已于 2026-10-26 替换为用户提供的 5120 × 2880 截图，保留完整画面与原始比例，并导出 960px、1800px 两档 WebP；共享这些资源的流程展示和放大预览同步更新。
- 截图对应关系：`project` 为新建项目首页，`capabilities` 为科研能力全景，`conversation` 为新对话工作区，`experts` 为科研专家团 DAG。分析与表达阶段的 `start` 截图仍沿用参考仓库素材。

## 成绩内容来源

ResearchClawBench 的「综合第一」「5 个学科第一」沿用参考仓库 README 的历史核验记录：2026-10-13，参评名 `jiutian-DeepInsight`，五个学科为天文、化学、能源、信息科学、物理。这些内容不是实时排名；本次迁移未重新核验榜单。参考仓库记录的官方主页为 <https://internscience.github.io/ResearchClawBench-Home/>。
