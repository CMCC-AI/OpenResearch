# OpenResearch v0.2.24 选择性回移台账

官方目标固定为 `23a4d67bb5ce3cf9051f8d62b2cd52e93116e16d`。本页是[16 项分析](upstream-v0.2.24-review-2026-11-06.md)的后续实施记录；真实合并祖先仍为 v0.2.19，产品仍为已发布 `0.2.23-mobilesci.4`，不宣称已完整合并 .24。保留 `product-upstream.json` 的 .23 产品发行绑定和关闭官方自动更新策略。

## 原生测试夹具批次

| 来源 | 实施内容 | 影响与验收 |
| --- | --- | --- |
| [#698 / `38070ed5`](https://github.com/alphaXiv/OpenResearch/commit/38070ed5eb4196c5e812486c9581938222c08861) | SSH 取消测试的 poll/read 遇到 EINTR 时重试，poll 的每次等待从原 10 秒截止时间计算 | 仅 `src/jobs/ssh.rs` 的 Unix 测试夹具；不改变生产取消、TERM→KILL 行为或 SSH 超时。既有原生回归实际 fork、设置 TERM 忽略、取消进程组并校验无关进程存活 |
| [#860 / `390ae1ab`](https://github.com/alphaXiv/OpenResearch/commit/390ae1ab0b7b99444e53206a95aa9fc416249dc3) | 本地作业测试等待由 100 次轮询改为明确 60 秒截止时间，仍每 100ms 轮询 | 仅 `src/jobs/localbox.rs` 的终态夹具；不改变生产作业时限，不把仍为 RUNNING 算作成功。Windows 真实启动/回收由对应 CI 验证 |

两项均从固定官方 diff 适配，不引入 Agent、认证、平台 API、启动器或 UI 改动。此批不等于测试进程全局状态隔离已完成；正常/忙碌 runner 的等待口径及 EINTR 是两个具体问题。

## 后续与状态

源码位于独立 `fix/upstream-test-fixtures` 分支。本地 jobs 定向回归 92 项通过、2 项既有忽略，包含实际 SSH 取消进程组和 local_job_lifecycle；全目标 Clippy 零警告、格式及真实上游基线检查通过。日志为 `/tmp/mobilesci-v024-native-tests.log` 与 `/tmp/mobilesci-v024-native-clippy.log`。Windows 及最终模拟合并 CI 尚待完成，不计入已发布回移数量。

P1 #872 跨项目工作区恢复仍未实施，需要保留 MobileSci 路由、保存 pane、未保存离开保护及只读案例边界，重建隔离工作树的 ui/dist 并验证实际切换入口。#869 先复现本地逐轮渲染模型，不机械引入上游不同函数；技能编辑与桌面专项保持独立验收。新 OAuth/Vercel 后端/官方自动更新和 dev.ts 不整批引入。
