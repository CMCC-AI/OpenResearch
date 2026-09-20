# 渠道、费用与 API 限制

核查日期：2026-09-20。下面区分官方规则、当前代码和未知事项。免费阅读、开源代码、API 配额和算力免费不是同一概念。

## 外部渠道清单

| 来源 | 当前调用与用途 | 费用/认证 | 官方限制与待确认项 |
|---|---|---|---|
| alphaXiv | /search/v2/paper/discover/keyword、embedding、fast；论文解析与 Markdown | 现有 REST 调用未带用户 key。不能推断商业使用永久免费 | 未查到这些 REST 端点的公开固定 QPS、SLA、商用报价。官方 MCP 使用 OAuth/API Key，研究工具计入 assistant quota；不能将 MCP 配额套用到旧 REST |
| OpenAlex | /works?search=、单篇 DOI/ID；也承担 bioRxiv 搜索 | 支持 OPENALEX_API_KEY；本轮以 Bearer 发送，避免 URL 暴露 key | 当前帮助中心：100 req/s；per_page ≤100；普通分页 ≤10000，更多用 cursor。旧文档 200/page、100000 credits/day 不作为当前承诺 |
| bioRxiv | 按 DOI 调 /details/biorxiv/{doi}/na；搜索走 OpenAlex | 公开文档示例不要求 key，未列按次价格 | /details 日期分页 30；/pubs 分页 100。未找到固定公开 QPS，不能写“无限制” |
| Hugging Face | Daily Papers 选题与元数据；Paper Markdown 正文 | 公共资源可访问，HF_TOKEN 可选；不同套餐配额不同 | Hub 官方通用 5 分钟窗口：匿名 API 500 / Pages 100，免费账户 API 1000 / Pages 200。文档表注明 September 2025 且匿名/免费可变；Daily Papers/Markdown 是否完全属于该配额须以响应头或官方确认为准 |
| arXiv | PDF 与原始论文链接，非当前 Deep Literature 全量采集源 | 可公开访问，正文许可逐篇不同 | legacy API/OAI-PMH/RSS 单连接、每 3 秒至多一次，所有受控机器合计；不能把此数值当 PDF 下载吞吐保证 |
| GitHub | 代码链接、仓库元数据/stars、克隆 | 公开仓库可访问；认证提高 API 配额 | REST 默认匿名 60/小时/IP，用户认证通常 5000/小时；搜索和 secondary limits 另外计算，Git clone 不等于 REST |
| Qwen/DashScope | Deep Literature Blog 与聊天 | token 计费；模型、地域、账户、输入长度、缓存可能影响单价 | RPM/TPM 按模型与账户；本仓库默认模型名不能代替已开通额度。生产定价从实际地域控制台确认 |
| Agent 与计算服务 | OpenResearch Agent 会话和实验 | CLI 软件开源不包含模型订阅、API token、GPU、磁盘和网络费 | 各 provider 额度独立；项目没有统一成本账本/全局预算硬停 |

## OpenAlex 的可量化费用

官方当前列出：有 key 每日 $1 免费用量，无 key $0.10；按 ID 获取单个实体免费，list/filter $0.10/1000 次，search $1/1000 次，content download $10/1000 次。超额可付费扩容。详情见 [官方成本表](https://help.openalex.org/access/example-costs/)。

项目“全部渠道”每次会执行 OpenAlex 普通搜索和 bioRxiv 过滤搜索各一次，二者都带 search。按当前单价推算，未命中缓存时约 $0.002 的 OpenAlex 计量用量/次，不含 alphaXiv、模型和网络。仅用于这种搜索时，$1/日约覆盖 500 次“全部渠道”；共享账户其他调用和网站浏览也会消耗预算。这是预算估算，不是压测结果或账单。

本轮 key 支持覆盖 discover_openalex 和 fetch_openalex_work，带 20 秒请求超时；尚未建设每日预算统计、分布式配额器和 429 冷却队列。前端 5 分钟搜索缓存只减少同一浏览器重复请求，不是跨用户缓存。

## 内部接口限制

| 接口/进程 | 代码内的限制 | 不代表什么 |
|---|---|---|
| Deep Literature 适配 feed | q ≤500 Unicode 字符；limit 1–50（默认18）；offset ≤10000；hot/new | 不是用户级 RPM 限额 |
| 适配 HTTP | 连接2秒、请求8秒、响应4 MiB；每进程最多4个并发；拒绝重定向 | 不是集群全局限流；过载目前归一为502 |
| 适配 status | 用真实 feed limit=1 检测，断开时不返回配置 URL | 不是廉价存活检查，仍会访问 PostgreSQL |
| 联合发现 | 2–500字符，每来源1–25；alphaXiv/OpenAlex检索20秒超时 | 其他原有论文接口未全部统一超时/重试 |
| Deep Literature 原生 feed | limit≤100、offset 分页，数据库搜索/排序 | OpenResearch adapter 的限制不保护直接访问 Deep Literature |
| HF 采集 | 20秒；最多3次尝试；分页最多20页 | 没有集中式 Retry-After 协调 |
| Deep Literature 登录 | 本地模式进程内 Map 默认8次/15分钟；托管 SSO 授权120次/用户/分钟、换码与退出300次/服务IP/分钟、会话内省6000次/服务IP/分钟 | OpenResearch 限流存 PostgreSQL，可跨网关共享；仍应在边缘网关设置连接/IP总量保护 |
| Deep Literature 聊天 | 登录、同源检查；生成 max_tokens=4096 | 无完整用户日预算、消息体 schema 和全链路取消控制 |

## 成本治理设计（待建设）

按 provider + credential + tenant 建集中配额器，读取 Retry-After、RateLimit 和 X-RateLimit-*；429 延迟排队，不立即重复轰击。原始查询缓存键包含来源、过滤、排序、版本；私有结果必须带 tenant/user，不混用公开缓存。

账本记录 requestId、tenant、project、provider/model、输入/输出/缓存 token、GPU 秒、存储和费用币种。先预算预占，终态结算，超额拒绝新任务；取消任务还需确认远端资源真正释放。

估算公式：日成本 = 搜索调用费用 + Blog 输入/输出 token 费用 + 聊天 token 费用 + Agent 费用 + GPU小时×单价 + 存储/流量。36,000字符不是36,000 token，应以供应商 usage 为准。禁止把 HF Token 与 Qwen Key 混成同一个计费来源。

## 许可与采购核查

OpenResearch Cargo.toml 标注 MIT；保留上游版权。元数据开放不表示 PDF、图表、代码仓库可任意再分发。入库保存逐篇许可和出处，未知许可在企业发布前核对。Deep Literature 自有代码与依赖仍需 SBOM/许可清单；本轮未给出法律许可结论。

## 官方依据

- [OpenAlex 认证、速率、响应头](https://help.openalex.org/api/authentication/)
- [OpenAlex 定价](https://help.openalex.org/access/pricing/)
- [alphaXiv MCP 认证与 quota](https://www.alphaxiv.org/docs/mcp)
- [bioRxiv API 与分页](https://api.biorxiv.org/)
- [Hugging Face Hub rate limits](https://huggingface.co/docs/hub/rate-limits)
- [arXiv API 使用条款](https://info.arxiv.org/help/api/tou.html)
- [GitHub REST 限制](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [阿里云模型计费](https://help.aliyun.com/en/model-studio/model-pricing)
- [阿里云模型限流](https://www.alibabacloud.com/help/en/model-studio/rate-limit)

每次上线及采购前复核；数值变更时更新核查日期，不把不同年代的 credit 与 dollar 表混算。
