# 真实 PDF 解析与发行候选验收（2026-11-04）

承接交付快照后的 P1，本批将真实解析器验收从人工计划落实为可重复的门禁，并准备 `0.2.23-mobilesci.3` 源码候选。候选只有在自己的完整发行 CI 成功后才能发布；旧提交的 CI 不替代新候选验收。

## 实施与依据

- `tests/materials_cli.rs` 增加真实 Poppler 集成测试，使用合成双页文字 PDF、仅含图片的 PDF 和损坏 PDF，实际调用 CLI 子进程并检查 SQLite 读取回执。验证逐页内容、越界拒绝、损坏诊断、图片页需要 OCR、缺失工具失败，以及恢复工具后按原回执定位；失败不产生 written，重读产生新回执，跨 CLI 进程保留原来源和选区。
- `ORX_REQUIRE_REAL_PDF=1` 强制存在可用的真实解析器；工具缺失时此门禁失败。普通开发环境缺少工具时明确输出未运行，不将它算作真实解析验收。原有伪解析器测试继续覆盖超时、管道、有界正文/诊断和布局变化，不能以真实 ASCII 测试替代它们。
- Linux 主检查安装 Poppler 并强制运行；新增 macOS CLI job 检查 clippy、构建及完整测试，同样强制真实 Poppler。Windows 仍运行原生构建/测试；未安装 Poppler 时不宣称 Windows PDF 执行端验收完成。macOS CLI job 不等于签名桌面包验收。
- `executor-tools/pdf-check.py` 仅使用 Python 标准库生成夹具，以 stdin 调用真实 pdftotext，无网络、无需模型、无用户资料。安装脚本将它写入 `/usr/local/libexec/orx/check-pdf.py`，现有 `orx-check-executor-tools` 以 UID 1000 执行真实解析自检；新镜像及离线升级包共用该安装流程。
- `.3` 版本元数据同步 Cargo.toml/Cargo.lock/product-upstream.json，发行说明覆盖 `.2` 后的读取、修订、回执、网页来源和封存导出。真实官方祖先仍是 v0.2.19，v0.2.23 为部分回移，不恢复官方更新通道。

## 本地证据与范围

现有隔离镜像 `openresearch-executor-tools:verify` 内 Poppler 22.12.0，在 `--network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges` 下通过真实 PDF 自检。当前 CLI 通过仅放在 `/tmp` 的 pdftotext 适配脚本，向同一容器传递已验证输入流，真实 CLI 回归通过；这验证实际解析器和生产读取代码之间的管道，不声称在 macOS 主机原生安装 Poppler。

专用验收镜像从已有本地运行镜像和离线 deb 包重装更新后的工具脚本，构建期间禁网，非 root 全套工具/PDF 自检通过。没有替换现有私人空间、升级生产镜像或调用真实模型。构建后本机曾出现 ENOSPC，编译中断；清理项目生成的 orx 增量缓存后恢复约 10 GiB 可用空间；Docker API 曾不可用，使用官方停止/启动流程恢复，原有服务均恢复运行，临时验收镜像已删除。恢复后重新验收，失败记录不计作通过。

最终本地检查：全目标 clippy 零警告，全部 7 项材料 CLI 测试通过且真实 Poppler 强制启用，46 项部署脚本测试及 6 项版本/源码发行证据测试通过，Rust/Windows launcher 格式与 diff 检查通过。UI 源码未变化，沿用已重建的 ui/dist；发行 CI 仍会复查构建一致性。

本地日志：`/tmp/mobilesci-real-pdf-{cli,image-build}.log`、`/tmp/mobilesci-parser-{clippy,all-cli,deploy-tests,release-tests}.log`。最终发行状态及候选 CI 必须按实际 GitHub 结果记录，不能从测试计划推断。

## 未完成与下一步

- P1：同一 `.3` 候选的完整发行门禁、不可变源码资产及发布状态核验；实际部署和既有私人执行器替换另行验收。
- P2：解析器精确身份及版本追溯、复杂版面/加密/多语言/OCR 样本、任务阅读覆盖汇总和科学指标来源。当前合成夹具不证明这些能力。
- P2：交付缓存总占用统计、清理预览及受保护回收，保留当前输入/引用/审批/活动运行与失败恢复边界。
