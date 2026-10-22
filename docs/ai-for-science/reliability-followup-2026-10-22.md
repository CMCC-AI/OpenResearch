# 可靠性后续验收（2026-10-22）

前一批侧聊回移、界面修正、可靠性回归及验收文档已提交为 `231525b`，并推送至 `origin/feat/ai4s-product`。本轮不部署服务器。

## 真实磁盘写满：本地验证通过

`src/local/materials.rs` 增加 `real_enospc_preserves_materials_and_allows_retry`。它仅用于受控的小容量文件系统，默认忽略，必须显式执行；普通单元测试通过不能代替这一项的运行结果。

可复现的 macOS 入口：

```sh
bash scripts/test-material-enospc-macos.sh
```

脚本新建 32 MiB HFS+ 磁盘镜像，确认挂载点设备与宿主不同、容量不超过 64 MiB 后写入专用标记。填充文件位于材料配额目录之外，因此触发的是物理文件系统 ENOSPC，而不是逻辑配额拒绝；测试另有 64 MiB 写入硬上限，配置错误时不会无限填盘。退出时卸载并删除本次镜像；卸载失败则保留镜像并报告，不继续删除。

已验证：

- 材料上传失败的错误链包含真实 OS error 28；没有发布新原件或遗留 `.upload-*` 暂存目录。
- 清单替换失败后，原 manifest 字节不变，manifest.tmp 被清理；已登记原件的哈希有效，未登记原件保持原样。
- SQLite 写入失败后，原有记录仍可读取，失败插入没有产生新记录。本次 SQLite 在创建回滚日志时报告“unable to open database file”，不能假定所有磁盘满都返回 SQLITE_FULL。
- 释放填充文件后，材料上传及 finalize 成功，封存原件逐项通过哈希核验；SQLite 重试写入成功，integrity_check 返回 ok。

初始测试断言只接受 SQLITE_FULL，因实际日志创建错误而失败；随后限定接受 DiskFull、CannotOpen 或 SystemIoFailure，并同时检查原数据、失败插入和释放空间后的重试结果，重新运行通过。没有因此修改生产存储逻辑。

验证结果：专用镜像回归 1/1 通过；可复用脚本完整创建、挂载、测试、卸载及清理成功；材料普通回归 12 项通过、专用故障项按定义忽略；`cargo clippy --locked --all-targets -- -D warnings`、fmt、shell 语法及 diff 检查通过。日志位于忽略目录 `.mobilesci-run/backport-v0.2.20/acceptance/`：`enospc-real.log`、`enospc-runner.log`、`enospc-materials.log`、`enospc-clippy.log`。

边界：这是 macOS HFS+ 文件系统上的本地故障回归，不等于 Linux 生产文件系统、实际聊天检查点在 ENOSPC 下的完整生命周期、断电耐久性或长期压力均已验收。SQLite 部分直接验证事务失败与重试，不冒充真实聊天消息 ENOSPC 端到端测试。

## 专家派发与唤醒：真实合成闭环通过

已在独立 slot-4 建立合成研究会话，由真实 OpenCode 主理人通过 `orx research plan` 登记计划 v1，没有直接写数据库或调用审批 API。

现有 team 校验要求独立审查及引用审计，因此单专家计划被拒绝；随后保留校验，使用最小三任务链：

1. `wake-check`：证据写作专家，仅写入含 `EXPERT_WAKE_ACCEPTANCE_OK` 的合成说明。
2. `review-check`：独立审稿专家，读取声明的上游合成说明并写核验结果。
3. `audit-check`：引用审计专家，核验声明依赖链并写合成审计结果。

用户在研究面板批准 G1 后，主理人自动恢复，只派发当前依赖就绪的任务，并在每次派发后结束当前 turn。三个专家分别完成 `orx research finish`，三次完成通知均唤醒主理人；主理人核对上游产物后逐次派发下一任务，最终界面显示 3/3 个任务已验收，并回复 `PARENT_WAKE_ACCEPTANCE_OK`。

通过正常界面的“下载草稿包”导出，独立计算三个实际文件的大小和 SHA-256，均与导出包内登记一致；首个文件包含约定标记。包中仅有三个声明产物及系统生成的 manifest、README。

| 产物 | 字节 | SHA-256 |
| --- | --- | --- |
| wake-check.md | 1450 | 6c041cba67c4bd72d8ddb4ff63c29ab69859a132ff082caabeef6e7625befe20 |
| review-check.md | 3988 | 4b7ef9d9116bae98eaec9cc7e6eab22f25c9da60d975b7d0db685b8b5f608dd3 |
| audit-check.md | 6784 | 3bfbb4b2bf8838028532b312aa10bcc026caddba7c93e1a7b2640b8be0cab881 |

本轮只批准了 G1；未申请或批准交付闸门，没有启动实验或外部服务。研究保持草稿状态，最终主理人 turn 已结束；隔离服务和页面保留供复核。该结果证明本地 OpenCode 自定义 team 的合成派发/依赖/完成唤醒链，不等于 W1–W4、G2/G3 实验审批、实际科研结论或生产服务器全部验收。

会话入口保留在本地 `expert-wake-state.json`；审批截图 `expert-g1-review.jpg`，最终截图 `expert-wake-complete.jpg`；文件核验记录 `expert-artifact-evidence.json`。材料故障日志及源码哈希汇总见 `enospc-evidence.json`。这些证据均在忽略目录 acceptance 下，不提交测试数据库或模型会话日志。

一次独立 API 状态快照采集因自动审批连接中断而未执行，也没有通过其他执行方式补跑该命令。上述完成证据来自持续进行的正常浏览器验收及草稿产物导出，不将未生成的 API 快照列作已归档证据。
