# AI for Science 产品层

完整说明见 [开发文档中心](ai-for-science/README.md)：包含原有实现、真实数据来源、费用限制、生产缺口与运维流程。

本产品直接扩展 OpenResearch，不再依赖原 `ai4s` 仓库。OpenResearch 继续负责项目、Agent、实验、运行、代码、数据和产物；Deep Literature 通过稳定的公开接口提供文献理解能力；`ui/src/product` 提供面向科研用户的产品入口与能力导航。

## 页面结构

- `/`：产品介绍和科研闭环说明。
- `/projects`：开始研究、创建项目、继续已有项目，并进入原生 OpenResearch 工作区。
- `/discover`：统一检索 alphaXiv、bioRxiv 和 OpenAlex；单个来源失败时保留其他来源结果。
- `/literature`：读取 Deep Literature 论文流，进入精读页面或将论文加入研究项目。
- `/capabilities`：按发现、构思、设计、验证和表达五个阶段展示科研能力。

## 论文来源

`GET /api/papers/discover` 复用 `src/client.rs` 的论文客户端，返回统一的 `LitHit` 数据：

- alphaXiv 提供 arXiv 论文、社区评价和全文片段；
- bioRxiv 通过 OpenAlex 的 bioRxiv source id 检索生命科学预印本；
- OpenAlex 提供跨学科论文和引用数据。

Deep Literature 作为文献理解与知识层接入。OpenResearch 通过服务端适配器读取其公开论文流，并提供独立的 `/literature` 工作区；用户可以进入 Deep Literature 完成精读、解读、问答和笔记，再将 arXiv 论文带回 OpenResearch 创建研究项目。两边保留各自的数据和登录边界，不复制代码，也不使用 iframe。

本地默认连接 `http://127.0.0.1:3000`。部署或端口不同时设置：

```bash
ORX_DEEP_LITERATURE_URL=https://literature.example.com orx up
```

容器部署中，服务端 API 地址与浏览器地址不同时分别配置：

```bash
ORX_DEEP_LITERATURE_URL=http://deep-literature:3000 \
ORX_DEEP_LITERATURE_WEB_URL=https://literature.example.com \
orx up
```

OpenResearch 暴露两个只读适配接口：`GET /api/deep-literature/status` 用于连接状态，`GET /api/deep-literature/papers` 用于经过校验和字段归一化的论文列表。适配器不转发 Cookie 或用户凭据；个人笔记、收藏与 AI 对话仍在 Deep Literature 内完成。

## 边界

- 产品页面只组织入口，不另建一套任务或实验数据模型。
- 研究是否执行、执行状态、日志和指标仍以 OpenResearch 的真实记录为准。
- 新的论文渠道应由服务端调用，前端不保存渠道密钥，也不直接拼接第三方私有接口。
