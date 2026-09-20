# AI for Science 产品层

本产品直接扩展 OpenResearch，不再依赖原 `ai4s` 或 Deep Literature 仓库。OpenResearch 继续负责项目、Agent、实验、运行、代码、数据和产物；`ui/src/product` 提供面向科研用户的产品入口与能力导航。

## 页面结构

- `/`：产品介绍和科研闭环说明。
- `/projects`：开始研究、创建项目、继续已有项目，并进入原生 OpenResearch 工作区。
- `/discover`：统一检索 alphaXiv、bioRxiv 和 OpenAlex；单个来源失败时保留其他来源结果。
- `/capabilities`：按发现、构思、设计、验证和表达五个阶段展示科研能力。

## 论文来源

`GET /api/papers/discover` 复用 `src/client.rs` 的论文客户端，返回统一的 `LitHit` 数据：

- alphaXiv 提供 arXiv 论文、社区评价和全文片段；
- bioRxiv 通过 OpenAlex 的 bioRxiv source id 检索生命科学预印本；
- OpenAlex 提供跨学科论文和引用数据。

Deep Literature 暂不参与当前实现。后续接入时应实现同一 `LitHit` 契约，并在服务端增加渠道适配器，不把 Deep Literature 代码复制进 OpenResearch 核心模块。

## 边界

- 产品页面只组织入口，不另建一套任务或实验数据模型。
- 研究是否执行、执行状态、日志和指标仍以 OpenResearch 的真实记录为准。
- 新的论文渠道应由服务端调用，前端不保存渠道密钥，也不直接拼接第三方私有接口。
