# 研究声明修订（2026-11-02）

基于产品提交 `4953e575`，在独立 worktree、`feat/research-claim-amendments` 实施。上一批 `f6ae1277` 已保证材料读取快照；本批继续解决错误声明无法显式退出当前证据集合的问题。

## 契约与影响范围

- `orx research amend-claim <claim-id> --file request.json` 仅研究主理人可执行。请求必须提供当前计划 `version`（无计划为 0）、声明 `revision`（无 claimRevision 为 0）、非空原因（最多 4 KiB）。`action` 为 withdraw 或 replace；replace 必须提供完整 replacement，沿用原声明输入及实验日志校验。不新增 CLI 批准命令。
- 原始 `claims` 不删除、不改写。SQLite `research_claim_changes` 保存顺序版本、原因、操作者、原/替代声明哈希、请求哈希与时间；替代声明和回执在同一事务提交。精确重试返回原回执；不同请求不得重复修订同一声明。可以继续修订替代声明，形成可追溯链。
- 替代日志采集在写锁外进行。提交时重新核查研究状态、主理人、计划与声明版本、Run 记录及日志身份；失败时原子回滚。原始声明与替代声明的哈希在读取有效证据时校验，审计记录禁止直接更新或单独删除；显式删除研究/项目仍可级联清理。
- 修订立即使本轮交付决定失效（通常 G4，方案交付 G3），保留旧范围及审批记录。新的审查 digest 绑定有效声明和完整修订历史；修订计划时旧审稿/引用审计不再继承。修订后的所有模式必须安排独立审稿和引用审计，方案模式也不能绕过；未修订的旧流程保持原有规则。
- 新交付只纳入有效声明及其 Run 日志，并保留修订历史。最新计划的任务 Run 继续纳入；历史 Run 元数据及活动运行保护仍然保留。撤回某声明不等于删除日志、取消实验、放宽当前任务要求或证明替代声明科学有效。
- API 与 `research status` 在有修订时增量提供 `activeClaimIds`、`claimChanges`、`evidenceReviewRequired`、`staleReviewTaskIds`。界面分开展示当前与历史声明，显示修订原因及替代关系，旧审查不会继续呈现为当前证据已通过；主理人上下文和科研技能说明同步更新。

撤回示例：

```json
{"action":"withdraw","version":1,"revision":0,"reason":"重新核对后发现该解释缺少支持"}
```

替代示例：

```json
{"action":"replace","version":1,"revision":0,"reason":"将因果结论收敛为待验证假设","replacement":{"text":"可能存在相关性，尚待实验验证","support":"inference","source":"现有材料分析","location":null,"runId":null,"lineStart":null,"lineEnd":null}}
```

## 兼容与交付边界

未发生修订的 Study 不新增序列化字段，原有审查摘要及交付范围哈希保持一致。首次修订后保存 `claimRevision`，数据库触发器拒绝旧 CLI 丢弃该字段后写回。因此**使用修订功能前须一起更新后端、执行端 CLI 和界面**；已修订研究不能降级到不支持该契约的旧版本继续写入。数据库管理员仍可直接更改数据库或删除触发器，本设计不是防数据库管理员篡改的外部签名账本。

本批只对临时数据库做自动化验收，不修改真实研究，不运行付费模型或实验。结构化材料阅读事件、引用跳转、指标来源、容量分页与受保护回收尚未在本批实施。当前产品发行号仍为 `0.2.23-mobilesci.2`；本批源码不等于新版本已发布、跨平台 CI 已通过或生产服务已部署。

## 验证记录

定向回归覆盖旧 JSON/摘要兼容、撤回后的重新审查与人工交付、替代链和跨重启幂等、非法输入/越权/过期版本、事务回滚、旧写入器防护及级联删除，以及采集期间的并发修订、计划变更、结束、Run 变化和重复请求。界面回归验证当前/历史分组、原因转义和过期审查提示。最终检查：

- 新增 Rust 定向测试 11 项（10 项存储/并发/交付契约，1 项 CLI 参数约束），全部通过。
- 完整 Rust：1423 项单元测试、18 项 CLI 集成测试通过；13 项既有忽略。
- Clippy 全目标零警告、Rust 与 Windows launcher 格式检查、普通构建通过；构建渠道仍为 development。
- UI 541 项测试通过，其中新增 3 项；类型检查、样式/本地化检查、`pnpm build` 及资源预算检查通过，ui/dist 已重建。使用缓存 pnpm 10，与 CI 主版本一致。
- 产品上游基线检查、4 项版本/源码发行测试及 git diff 检查通过。
- 临时日志：`/tmp/mobilesci-claims-{final,final-clippy,build,ui-tests,ui-build,styles,release-checks}.log`。

以上是 macOS 本地验证；本批没有新建发行版或执行跨平台 GitHub CI，Windows/Linux 和真实模型/部署验收未据此宣称通过。
