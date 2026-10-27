# 2026-10-27：私人执行器 OOM 修复

目标为经 `root@10.7.0.18` 访问的 MobileSci 副本服务器，Compose 项目 `mobilesci-replica`，公开入口为 `http://49.232.238.110:20281/mobilesci/`。本记录不代表其他服务器已更新。

## 原因与修复

原私人执行器的 1 GiB 内存和 1 GiB swap 配额被多个常驻 OpenCode 进程及其工具子进程耗尽。内核多次记录 cgroup OOM 并终止 `opencode.exe`，使 `/session/<id>/message` 请求中断。宿主仍有可用内存，Web 健康检查正常不能代表活跃 Agent 存活。

保留现场应急提高的 2.5 GiB 内存、4.5 GiB 内存加 swap 合计限制，将其写入 provisioner 环境、当前发布的 Compose 和 `/opt/mobilesci/state/.env`，平台并发空间上限设为 2。provisioner 支持明确配置的配额热更新，并对新建容器使用同一配置。

新 orx 接入 OpenCode 闲置回收，使用租约保护完整会话与压缩，闲置释放进程组，重启后沿用持久化原生会话。Linux 闲置策略读取 cgroup 配额。此前案例文件 SHA-256 的 HTTP 兼容修复及重新生成的前端一并内嵌进入执行器。

## 发布与验证

- provisioner 镜像：`mobilesci-oom-provisioner:20261027t132728z`。
- 执行器镜像：`mobilesci-oom-executor:20261027t133144z`，两个现有私人执行器均已替换，provisioner 和 Compose 中未来实例镜像同步更新。
- orx SHA-256：`198468b15b905c95a3b35630aaed635f7292a09a63d20f31b0ca75bf2ffa6449`，逐容器核验一致。
- 替换前核验全部空间的活跃 Agent、实验、排队消息、租约和未完成派发均为零。每个研究 SQLite 先做备份，再用候选二进制离线演练迁移，校验数据库完整性和原有表记录数。
- 原环境变量、数据卷和网络配置保留；数据库账号、模型凭据和文献服务未调整。旧执行器保留为带 `before-oom` 后缀的停止容器。
- 配置回退资料：`/opt/mobilesci/fixes/oom-lifecycle-20261027/backup-20261027T132728Z/`；执行器快照与回退映射：同目录下的 `executor-backup-20261027t133144z/`。快照可能包含原环境变量，按私密运维资料保存。
- 验证包括 Rust 全套测试、Clippy、Linux cgroup 专项测试、平台单元测试、部署脚本测试及前端测试和构建。线上执行器健康、平台和网关入口检查通过；未新建线上研究或调用模型。

替换后的首次观测中，宿主可用内存约 6.25 GiB，swap 使用归零。该观测处于空闲状态，不能替代持续研究负载下的容量评估；多会话同时活跃时仍受单空间配额约束。
