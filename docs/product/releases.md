# MobileSci 版本发布

本轮版本确定为 `0.2.22-mobilesci.1`，范围见 [发布说明](../../release-notes/v0.2.22-mobilesci.1.md)。冻结当前已完成改动，steering 持久回执等剩余工作在发布完成后继续。

## 源码版本

`MobileSci source release` 工作流从 `codex/release-mobilesci-<版本>` 分支的固定提交发布。版本须与 Cargo.toml、Cargo.lock、product-upstream.json 一致，并有同名发布说明。

流程依次为：候选校验 → 调用完整 CI → 生成源码归档及校验清单 → 创建 Git 标签 → 发布 GitHub Release。CI 失败时不创建新标签或 Release；修正发布候选后须重新通过 CI。已存在的标签不得移到其他提交。

附件包括源码 tar.gz、zip、SHA256SUMS 和 source-release.json，后者记录产品版本、标签及完整提交 SHA。源码归档直接取自该提交，构建要求干净工作区，并拒绝覆盖已有输出文件。发布任务仅在 CI 成功后获得当前仓库的 contents:write 权限。

这是源码发行路径。它不调用安装包签名流程，不更新产品的官方升级通道，不执行生产部署。部署仍遵循 [运行与部署约定](runtime-and-deployment.md) 中的备份、固定镜像、升级与恢复验收。既有多平台安装包发行流程保留独立门禁。

## 本轮范围

- 材料目录、只读预览及工作区固定入口。
- 模型目录就绪、设置选择保留、发送前历史取消处理及独立本地错误。
- 普通 turn／队列的请求归属查询、未知结果保护及重试身份保持。
- 已完成的研究任务继承、证据扫描、存储调度与执行环境改进。

剩余工作及验收边界见 [分批实施记录](../ai-for-science/upstream-backport-plan-2026-10-28.md)。发布说明不把未完成能力或未执行的部署验收写成已完成。
