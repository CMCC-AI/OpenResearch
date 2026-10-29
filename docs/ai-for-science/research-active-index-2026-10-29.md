# 活跃研究巡检的部分索引（2026-10-29）

接续 `a4f77ef` 的聚合更新优化。`research_active_studies` 原来每轮读取并反序列化
全部研究文档，之后才检查 active；已结束研究的历史声明也会重复进入巡检解析。

## 选择与实现

- 在 research_studies(id) 上增加仅包含 active 文档的部分索引。
  索引和查询使用同一个 CASE 谓词，先 json_valid，再检查文档中的 status。
  SQLite 直接筛选候选行，Rust 仍验证完整 Study，保留原先跳过损坏记录的行为。
- status 仍以原 document 为准；不加需要同步的冗余状态列，不拆表或迁移历史内容。
  SQLite 自动维护直接写入、旧二进制写入、状态变化和事务回滚后的索引成员。
- CREATE INDEX IF NOT EXISTS 只在第一次升级时构建；之后的研究 schema 检查
  不要求额外写锁。构建时需要读取既有文档并取得写锁，有一次性升级成本。
  若将来改变索引谓词，应使用新的索引名及显式迁移，不改写已应用的定义。
- 非 active 研究仍可按 ID 完整读取；坏 JSON 不会阻止索引创建，也不会被删除或重写。
  有效 JSON 但缺少 Study 字段的记录继续由 Rust 解码验证并跳过。

## 合成测量与代价

临时 Store 中保存 32 份约 1 MiB 文档和 1 份空研究，仅 2 份活跃，
分别运行 5 次巡检取中位数。本机开发构建中，巡检从 93.701 ms 降为 5.316 ms。
EXPLAIN QUERY PLAN 回归确认查询使用 idx_research_studies_active。

索引在真实更新时重新计算 JSON 谓词，有维护成本。同一聚合更新基准中：

| 聚合字节 | 无索引实际更新 ms | 有索引实际更新 ms |
| --- | ---: | ---: |
| 1,061,924 | 18.887 | 20.266 |
| 8,494,208 | 149.002 | 161.654 |

无变化更新仍不写库，8 MiB 样本约 22 ms。与最初约 401 ms 的实际更新相比，
前一批优化仍有效；本批以少量写入成本换取周期巡检跳过已结束历史。
这些是无争用的隔离合成样本，不是生产 p95 或稳定性能阈值。

## 验证范围与后续

功能回归覆盖缺少索引的旧库升级、损坏／字段不完整 JSON、转义键及转义状态值、
原文保留、按 ID 查看已结束研究、直接文档写入、结束研究、事务回滚、
实际查询计划，以及索引已存在时其他写者持锁的 schema 检查。

基准默认忽略，已单独运行；复现命令：

```sh
cargo test --locked --bin orx research_active_scan_benchmark -- --ignored --nocapture
cargo test --locked --bin orx research_aggregate_update_benchmark -- --ignored --nocapture
```

短期基准日志：`/tmp/orx-active-{before,after,write-cost}.log`。
数据总量、损坏记录的诊断展示及历史日志审计／回收规则仍保留，不因增加索引而删除历史。
本批没有调用真实模型、访问生产数据库、修改 UI 或部署。

## 验证结果

- 完整 Rust 回归：1,381 项单元、18 项集成通过；13 项默认忽略由原有 11 项及
  本日新增的两个手动基准组成，两个基准均已独立执行。
- 最终索引专项 3 项通过，包含转义键／值及其他写者持锁的研究 schema 检查。
- Clippy 全目标、构建、格式、独立 include 测试文件格式及差异检查通过。
- 短期日志：`/tmp/orx-active-{tests,final-targeted,rust-full,clippy,build}.log`。

没有 UI 变化，未重建内嵌资源；未运行远端 CI、Windows/Linux 打包、
平台 PostgreSQL 集成或在线依赖审计。
