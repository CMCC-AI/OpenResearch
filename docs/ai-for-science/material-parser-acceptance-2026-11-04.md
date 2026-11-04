# 真实 PDF 解析与发行候选验收（2026-11-04）

承接交付快照后的 P1，本批将真实解析器验收从人工计划落实为可重复的门禁，并准备 `0.2.23-mobilesci.3` 源码候选。候选只有在自己的完整发行 CI 成功后才能发布；旧提交的 CI 不替代新候选验收。

## 实施与依据

- `tests/materials_cli.rs` 增加真实 Poppler 集成测试，使用合成双页文字 PDF、仅含图片的 PDF 和损坏 PDF，实际调用 CLI 子进程并检查 SQLite 读取回执。验证逐页内容、越界拒绝、损坏诊断、图片页需要 OCR、缺失工具失败，以及恢复工具后按原回执定位；失败不产生 written，重读产生新回执，跨 CLI 进程保留原来源和选区。
- 真实 PDF 测试显式标为需要外部工具的 ignored 测试，普通回归显示未运行；Linux/macOS 的独立 `Real PDF acceptance` 步骤必须执行 `scripts/test-real-pdf.sh`。脚本先检查测试名确实存在，再运行该精确测试；工具缺失、探测失败或测试缺失均失败，不允许零项测试冒充通过。原有伪解析器测试继续覆盖超时、管道、有界正文/诊断和布局变化，不能以真实 ASCII 测试替代它们。
- Linux 主检查安装 Poppler 并强制运行；新增 macOS CLI job 检查 clippy、构建及完整测试，同样强制真实 Poppler。Windows 仍运行原生构建/测试，默认显式忽略此外部工具测试，不宣称 Windows PDF 执行端验收完成。macOS CLI job 不等于签名桌面包验收。
- `executor-tools/pdf-check.py` 仅使用 Python 标准库生成夹具，以 stdin 调用真实 pdftotext，无网络、无需模型、无用户资料。安装脚本将它写入 `/usr/local/libexec/orx/check-pdf.py`，现有 `orx-check-executor-tools` 以 UID 1000 执行真实解析自检；新镜像及离线升级包共用该安装流程。
- `.3` 版本元数据同步 Cargo.toml/Cargo.lock/product-upstream.json，发行说明覆盖 `.2` 后的读取、修订、回执、网页来源和封存导出。真实官方祖先仍是 v0.2.19，v0.2.23 为部分回移，不恢复官方更新通道。

## 本地证据与范围

现有隔离镜像 `openresearch-executor-tools:verify` 内 Poppler 22.12.0，在 `--network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges` 下通过真实 PDF 自检。当前 CLI 通过仅放在 `/tmp` 的 pdftotext 适配脚本，向同一容器传递已验证输入流，真实 CLI 回归通过；这验证实际解析器和生产读取代码之间的管道，不声称在 macOS 主机原生安装 Poppler。

专用验收镜像从已有本地运行镜像和离线 deb 包重装更新后的工具脚本，构建期间禁网，非 root 全套工具/PDF 自检通过。没有替换现有私人空间、升级生产镜像或调用真实模型。构建后本机曾出现 ENOSPC，编译中断；清理项目生成的 orx 增量缓存后恢复约 10 GiB 可用空间；Docker API 曾不可用，使用官方停止/启动流程恢复，原有服务均恢复运行，临时验收镜像已删除。恢复后重新验收，失败记录不计作通过。

最终本地检查：全目标 clippy 零警告，6 项普通材料 CLI 测试及 1 项独立真实 Poppler 验收通过，46 项部署脚本测试及 6 项版本/源码发行证据测试通过，Rust/Windows launcher 格式与 diff 检查通过。UI 源码未变化，沿用已重建的 ui/dist；发行 CI 仍会复查构建一致性。

本地日志：`/tmp/mobilesci-real-pdf-{cli,image-build}.log`、`/tmp/mobilesci-parser-{clippy,all-cli,deploy-tests,release-tests}.log`。最终发行状态及候选 CI 必须按实际 GitHub 结果记录，不能从测试计划推断。

## 未完成与下一步

- P1：`.3` 源码发行与资产核验已完成；实际部署、升级恢复和既有私人执行器替换仍待验收。
- P2：解析器精确身份及版本追溯、复杂版面/加密/多语言/OCR 样本、任务阅读覆盖汇总和科学指标来源。当前合成夹具不证明这些能力。
- P2：交付缓存总占用统计、清理预览及受保护回收，保留当前输入/引用/审批/活动运行与失败恢复边界。


## Windows 发行门禁发现及修正

首个 `.3` 候选 `10755b0d` 的 [发行 CI 41752092845](https://github.com/CMCC-AI/OpenResearch/actions/runs/41752092845) 在 Windows 上的真实解析器版本探测失败（stderr 为空），因此阻止发布；该候选其余 1,371 项 Windows 单元测试通过，macOS Poppler 26.10.0 的真实解析测试也通过。没有据此认定 Windows 具备可用 Poppler，更没有把旧 CI 结果用于放行新候选。

修正后默认测试明确报告该外部工具测试未运行，由已安装 Poppler 的 Linux/macOS 独立强制门禁承担真实验收；Windows 的 PDF 执行端仍列未验收。探测失败输出状态、stdout、stderr，便于以后定位不兼容工具。修正不改变生产解析、平台权限或发布的完整 CI 要求，必须对新候选重新验收。

本地修正验证：普通材料 CLI 回归 6 项通过、真实 PDF 1 项明确 ignored；独立真实门禁显式执行该 1 项并通过（Poppler 22.12.0）。缺少工具及测试列表为空的负向检查均失败，未执行意外测试；clippy、格式和版本/发行回归通过。日志：`/tmp/mobilesci-pdf-boundary-{real,default,missing,empty-list,clippy,release-tests}.log`。


## macOS 全量回归稳定性修正

修正候选 `6c65fc16` 的 [CI 41754372242](https://github.com/CMCC-AI/OpenResearch/actions/runs/41754372242) 已通过 Windows、Linux、平台和执行器门禁，但 macOS 全量测试两次出现 SSH 配置探测超时，第二次还出现 consent 重试的即时文件断言失败，因此未发布。SSH 定向本地复核通过（0.23 秒），不能据此覆盖 CI 的失败。

本批进一步修正测试条件：原生 OpenSSH 路由夹具使用不同数值地址，保留路由区分、配置修改后快照固定、路径和代理断言；consent 测试有界等待本地服务器确认及文件移除，不再要求在生产 CLI 的短刷新窗口内必然完成。生产 SSH 的 10 秒超时、遥测发送/刷新策略与权限均不变化。

macOS CI 的全量测试采用 `--test-threads=1`，减少全局状态和原生进程探测的资源争用；内部显式并发测试仍运行自己的并发工作与断言，真实 PDF 仍由独立强制门禁执行。串行是测试运行策略，不意味着全局测试状态已经完成进程隔离；后续仍需逐项评估隔离改造及运行耗时。


上述稳定性修正的本地完整串行回归通过：1,449 项单元测试、24 项普通 CLI 集成测试；13 项既有单元忽略及 1 项外部 PDF 测试在默认套件中明确列出。独立 PDF 门禁另行通过该 1 项真实解析测试，合计 25 项 CLI 验收；全目标 clippy 零警告，格式及 6 项版本/发行测试通过。日志：`/tmp/mobilesci-macos-stability-{full,clippy,real-pdf,release}.log`。


## 最终发布状态

[`.3` 源码](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.23-mobilesci.3) 已发布，标签/清单提交 `66ae1b5a895e2401ae8d01dafa98dad7d16587c6`，[最终发行 CI](https://github.com/CMCC-AI/OpenResearch/actions/runs/41768398929) 全部必需门禁成功。Linux/macOS 的独立真实 PDF 步骤通过，Windows 保留明确未验收边界。已下载全部四项资产并通过校验和核验；未部署生产或生成签名安装包。历史失败记录保留，不作为最终候选通过证据。
