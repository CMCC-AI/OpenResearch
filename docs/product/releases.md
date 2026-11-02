# MobileSci 版本发布

本轮产品版本为 `0.2.23-mobilesci.2`，范围见[发布说明](../../release-notes/v0.2.23-mobilesci.2.md)和[交付范围验证](../ai-for-science/research-delivery-scope-2026-11-02.md)。官方选择性回移批次记录保留在[v0.2.23 台账](../ai-for-science/upstream-v0.2.23-backports.md)，既有产品发布标签保持不变。

## 源码版本

`MobileSci source release` 工作流从 `release/mobilesci-<版本>` 分支的固定提交发布。版本须与 Cargo.toml、Cargo.lock、product-upstream.json 一致，并有同名发布说明。

流程依次为：候选校验 → 调用完整 CI → 生成源码归档及校验清单 → 创建 Git 标签 → 发布 GitHub Release。CI 失败时不创建新标签或 Release；修正发布候选后须重新通过 CI。已存在的标签不得移到其他提交。

附件包括源码 tar.gz、zip、SHA256SUMS 和 source-release.json，后者记录产品版本、标签及完整提交 SHA。源码归档直接取自该提交，构建要求干净工作区，并拒绝覆盖已有输出文件。发布任务仅在 CI 成功后获得当前仓库的 contents:write 权限。

这是源码发行路径。它不调用安装包签名流程，不更新产品的官方升级通道，不执行生产部署。部署仍遵循 [运行与部署约定](runtime-and-deployment.md) 中的备份、固定镜像、升级与恢复验收。既有多平台安装包发行流程保留独立门禁。

## 本轮范围

- 收敛当前交付的日志范围到最新任务 Run 与显式声明引用。
- 保留历史运行保护、用量统计、原始记录和旧审批；范围变化需要重新确认。
- 验证历史日志缺失、当前/引用日志缺失、篡改、继承结果、活动保护与审批兼容。

材料阅读追溯、指标和容量治理为后续独立批次。源码实现、本地验证、远端 CI 与生产部署分别记录。
