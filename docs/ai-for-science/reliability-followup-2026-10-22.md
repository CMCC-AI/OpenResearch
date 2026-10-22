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

## 专家派发与唤醒：计划完成，等待 G1

已在独立 slot-4 建立合成研究会话，由真实 OpenCode 主理人通过 `orx research plan` 登记计划 v1，没有直接写数据库或调用审批 API。

现有 team 校验要求独立审查及引用审计，因此单专家计划被拒绝；随后保留校验，使用最小三任务链：

1. `wake-check`：证据写作专家，仅写入含 `EXPERT_WAKE_ACCEPTANCE_OK` 的合成说明。
2. `review-check`：独立审稿专家，读取声明的上游合成说明并写核验结果。
3. `audit-check`：引用审计专家，核验声明依赖链并写合成审计结果。

所有产物局限于该隔离研究的产物目录，不读取业务数据、不检索文献、不启动实验或交付闸门。已打开研究面板展示完整计划及“批准当前版本”，等待用户在 G1 确认；尚未派发专家，不能标记唤醒通过。审批后按依赖顺序验证三次派发、完成通知、主理人唤醒及产物哈希，最后要求主理人回复 `PARENT_WAKE_ACCEPTANCE_OK`。

会话与页面状态保留在本地 `expert-wake-state.json`，截图为 `expert-g1-review.jpg`。此处等待来自项目现有研究流程的人类决策门槛，不是浏览器访问审批故障。
