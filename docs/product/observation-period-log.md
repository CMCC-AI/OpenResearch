# MobileSci 线上观察期记录（v0.2.24-mobilesci.1）

- **观察基线**：[`v0.2.24-mobilesci.1`](release-v0.2.24-mobilesci.1-delivery.md)（固定提交 `bcb90af4fd3dd3250d52f23b94dcbb12d87f8bbb`，2026-11-17 完成 `10.7.0.18` Gate 1.3 受控切换）
- **公网入口**：`http://49.232.238.110:20281/mobilesci/`
- **观察边界**：
  - 仅做只读健康探测与真实使用反馈登记；未经授权不执行生产容器变更、不清理历史备份容器。
  - 若期间命中 [v0.2.27 终局报告](v0.2.27-terminal-state.md#三触发即办清单共-6-项当前均不构成待办) 中的 6 项触发信号、B1 体验问题或 B2 拆解边界，先在本表登记事实证据，再独立排期处理。
  - 观察期稳定并确认不再需要回退 `v0.2.23-mobilesci.7.1` 后，另行安排按“保留最近 2 次发行切换备份”规则清理 `10.7.0.18` 历史 `-before-*` 容器与旧构建目录。

## 只读参考探测命令（开发机直连，零写操作）

```bash
curl -fsS http://49.232.238.110:20281/healthz
curl -fsS http://49.232.238.110:20281/_orx/runtime
```

---

## 观察登记表

| 日期 | 健康探测（只读） | 用户反馈（新用户首连 / OpenCode / 配额 / 案例） | 触发信号命中情况（B1 / B2 / 6 项预案 / 运维清理） | 记录人 / 后续动作编号 |
| --- | --- | --- | --- | --- |
| 2026-11-17（上线日基线） | `/healthz` 200、`/_orx/runtime` 返回 `0.2.24-mobilesci.1`、5 份 SQLite 与 PostgreSQL 一致、`models` 幂等读写正常 | 上线当日完成机测与管理员读写验证；真人日常使用反馈待收集 | 未命中触发信号；历史回滚容器待观察期后清理 | 已归档 [交付记录](release-v0.2.24-mobilesci.1-delivery.md) |
| 2026-11-18（收尾复核） | 未触碰线上生产；本地 `eaecbcdf` 触发 `workflow_dispatch` [CI `44219396114`](https://github.com/CMCC-AI/OpenResearch/actions/runs/44219396114) 10/11 执行 Job 全绿 | 无新增线上用户反馈上报 | 未命中 6 项触发预案；新外部阻塞记录：`pnpm audit` 因 `picomatch <=4.0.7`（GHSA-fc5q-39xc-vjpf，`Patched versions: None`）失败，待上游发版修复或另行评估审计配置后重跑 CI | 见 [终局报告](v0.2.27-terminal-state.md) |
| YYYY-MM-DD | `<待填：/healthz、/_orx/runtime、异常日志摘要>` | `<待填：受影响用户、操作路径、复现现象>` | `<待填：无 / 命中具体项>` | `<待填>` |
