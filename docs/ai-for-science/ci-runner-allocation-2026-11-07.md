# macOS CI 资源分配（2026-11-07）

此前多个候选的 macOS 作业尚未分配 runner 就被取消，GitHub 注解明确记录 ARM 容量不足。恢复执行后，科学指标候选已通过完整 ARM 原生检查，但工作区候选仍未获 runner；环境隔离候选的 ARM 原生测试和真实 PDF 成功，短小的源码归档任务却仍未分配并最终取消。不能据此将完整 CI 记作成功。

本改动只把 `source-archive-hashes` 的 macOS 矩阵项改为 `macos-15-intel`。该任务仅使用 Node/Git 生成固定提交的 ZIP、tar.gz、manifest 和摘要；GitHub [标准 runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)列出这一 Intel 标签。避开 ARM 队列是否能改善等待，需要实际 CI 验证，不承诺容量或时延。

`macos-cli` 继续使用 `macos-latest`，Rust 原生构建、Clippy、测试及真实 PDF 的 ARM 验证保留；Linux/Windows 和所有其他构建门禁保持原有范围。没有使用大规格 runner、跳过检查或将未执行作业计为通过。

归档附件仍按 `runner.os` 保存为 macOS/Linux/Windows 三份摘要；聚合比较三个系统对同一提交生成的完整结果，任何系统未执行或摘要不同都阻止完整 CI。发行作业仍需匹配其对应 CI 清单，旧标签和资产不可变。本地 YAML 语法及 8 项版本/归档/发行证据检查通过；Intel 归档与 ARM 原生组合的最终证据以该候选实际 CI 为准。
