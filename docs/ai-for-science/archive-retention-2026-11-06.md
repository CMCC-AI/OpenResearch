# 归档登记与受保护回收

本批在 `feat/archive-retention` 隔离工作树继续容量治理，基于已发布 `.4` 的容量观测。它不移动 `.4` 标签，不接触用户主工作区的图标/静态资源改动，不执行生产删除。

## 保留边界

`research_archive_objects` 永久记录研究、归档 SHA、字节数、manifest SHA、准备时审批范围哈希、初次登记时间及 legacy 来源。已有文件首次登记时永久标记 legacy，不能通过再次准备转为可删除。登记与哈希校验在交付准备锁内完成；快照准备、下载的原生共享锁随文件描述符存活，下载流关闭前不能取得回收独占锁。

`research_archive_history` 永久记录观测过的快照范围→归档关系，既保护已批准快照，也保留未批准、后来被替换的快照。`research_archive_decision_scopes` 另行回填并永久保留全部旧审批范围，包括指针已经丢失的历史审批；相同范围重新生成的包仍被保护。历史保护采用过度保留策略，不从“未批准”推导“可以删除”，也不从当前指针推导旧包无引用。

旧文件、未登记文件、链接、异常路径、近期文件、登记大小不符的文件和有待恢复记录的文件均不能成为候选。材料原件、运行日志和数据库不在删除范围。新快照带 `catalogVersion:1`；SQLite 触发器阻止旧写入器丢失该标记、删除快照或写入未知版本，同时捕获新旧快照/审批范围。触发器也阻止回收期间重新引用目标。首次回填及模式变化在一个事务中执行，后续启动不重复全表回填。

## 操作流程

以下命令须替换真实项目和研究 ID；示例没有预先指定生产对象。

```sh
orx storage --project PROJECT archives --study STUDY --after 0 --limit 100
orx storage --project PROJECT archive-gc --study STUDY
```

归档台账按游标分页，每页最多 200 条。回收预览默认以七天前作为固定截止时间，输出 `before` 和 `previewHash`。人工检查候选后，明确传回同一组值：

```sh
orx storage --project PROJECT archive-gc --study STUDY --before BEFORE --apply PREVIEW_HASH
```

执行只允许独立操作员终端；Agent 会话不能回收或恢复，未知会话也不会降级为操作员。没有自动回收、网页删除接口或 Agent 删除工具。截止时间最少早于当前 24 小时，每批最多 20 个对象、2 GiB 逻辑字节；扫描最多 2000 个登记项，`hasMore` 明示剩余工作，不能当作完整总量。此版 GC 还没有扫描游标，大历史量的继续回收需要后续分页扩展；台账分页已提供。

执行重新生成预览并比对令牌，在 SQLite 写事务外取得文件独占锁并核验全部 SHA；随后短事务复核文档、历史引用、活动任务、所有非终态 Run，以及主/历史专家/后代会话的租约、队列、派生任务和 steering，再登记待执行意图。提交后才删除文件，每项结束另记终态。逻辑字节变化不等于释放物理磁盘空间，也不等于执行器配额准入。

中断后运行：

```sh
orx storage --project PROJECT archive-recover --study STUDY
```

恢复持有同一准备锁和目标文件独占锁：文件仍在则中止该意图并保留文件，已经缺失则记录 absent；它不删除任何文件，也不把缺失字节计作本次释放。链接、异常路径或无法锁定的文件保留待恢复状态。登记、历史保护及回收日志不可直接通过应用写入改写或删除；项目本身删除时随项目元数据级联。

## 兼容与后续

首次启用归档目录治理前仍需备份数据库和文件。旧 CLI 可以读取已有快照；启用新快照标记后，旧版写入会明确失败。回滚应恢复匹配的数据库/文件备份，不能删除保护字段绕过门禁。仅有 .4 以前的历史决策无法重建全部 ZIP 指针，未知缓存继续保留。

本批不是总配额治理、材料/Run GC、历史研究文档分页或科学指标实现。默认保留全部观测快照会持续占用空间；放宽保留必须另行设计审计、引用和恢复协议。跨进程锁为协作协议，不能防止主机管理员绕过锁直接改动文件；实际写入和删除前仍校验文件身份、时间和内容。

本地最终回归 1467 项单元及 27 项普通 CLI 通过；13 项既有单元忽略与 1 项外部真实 PDF 忽略未计通过。新增 11 项存储和 1 项 CLI 回归，覆盖历史审批指针丢失、旧写入器、跨连接竞争、共享锁生命周期、后代租约、路径链接、哈希变化、两处中断和 Agent 权限。全目标 Clippy 零警告、Rust/Windows launcher 格式及 8 项版本/归档/发行证据检查通过。

固定源码 `792fc9ddf17f1a17a5931327c9f539b5fe8cf142` 的完整 [CI 42215810593](https://github.com/CMCC-AI/OpenResearch/actions/runs/42215810593) attempt 1 成功；Linux 双架构、macOS、Windows、平台、执行器、版本及三系统源码归档一致性门禁均完成，Linux/macOS 另执行真实 PDF。PR 的 [Release 检查](https://github.com/CMCC-AI/OpenResearch/actions/runs/42215810322) 成功是 PR 门禁，不是发布了新版本。[PR #4](https://github.com/CMCC-AI/OpenResearch/pull/4) 合入提交为 `12f5d00395928991b46772738ad3a642e173b4f4`。

开发中迁移索引顺序错误导致一次完整运行失败并被终止；随后纠正并复跑，又发现旧错误提示关键词兼容性断言不匹配。最终修正提示、补齐历史审批范围保护后从最终代码完整通过；没有将这些中间失败计作成功。原始日志保留在 `/tmp/mobilesci-archive-{full-tests,full-tests-final,verified-full,tests-final,clippy-verified,release-checks}.log`。

本批已合入，未另行发行或部署，也未在生产执行 GC。源码完成、CI 合入、发行和生产上线分别记账。

## GC 扫描续页候选（2026-11-07）

后续 `feat/archive-gc-pagination` 解决上述首版的 2000 项扫描及批次边界问题。预览新增 `after`、`through` 和 `nextCursor`；首次缺省 through 时固定为该研究当前最大登记序号，之后保持相同 before/through 逐页检查。`hasMore:false` 只表示本窗口处理完毕，不代表窗口之后的新登记或全执行器已清理。受保护/缺失/在用项仍保留，可在以后重新扫描。

```sh
# 首次预览，记录 before、through、after 和 previewHash
orx storage --project PROJECT archive-gc --study STUDY
# 审核并执行本页；必须与该页预览的参数对应
orx storage --project PROJECT archive-gc --study STUDY --before BEFORE --after AFTER --through THROUGH --apply PREVIEW_HASH
# hasMore 为 true 时，将 nextCursor 作为下一页 after；每页重新预览和审核
orx storage --project PROJECT archive-gc --study STUDY --before BEFORE --after NEXT_CURSOR --through THROUGH
```

令牌策略升为 2，绑定固定窗口、起始/结束游标、当前文档和候选描述；旧预览必须重新生成。窗口/游标变化会拒绝执行，即使候选列表恰好相同。新增登记不会进入已审核的固定窗口；省略 through 而范围已变化时会拒绝旧令牌。没有增加自动分页删除或一次令牌授权多页。

20 个对象或 2 GiB 达到批次边界时，尚未处理的候选不会被游标跳过。逐文件删除失败保留 failed 记录，返回原页 after 和 hasMore:true；CLI 先输出结构化结果再以非零退出，须检查失败原因并重新预览当前页。已删部分不重复计释放。准备/下载锁、历史保护、活动准入、事务外哈希和中断恢复保持原协议。

新增回归覆盖 2000 个旧登记后的候选、21 个候选的批次边界、固定上界下并发新增、错误窗口和空页、局部失败重试及实际 CLI 参数/令牌绑定。Unix 另以稀疏文件元数据测试 2 GiB 边界，不读取或哈希大文件、不把虚构内容计作真实归档验收。本地完整 1472 项单元和 28 项普通 CLI 通过（13 项既有单元与 1 项外部真实 PDF 忽略不计通过），全目标 Clippy 零警告、格式、上游基线与 8 项发行相关检查通过。新增 5 项存储及 1 项 CLI 回归，最后增强的窗口空隙令牌断言另行重跑通过。日志为 `/tmp/mobilesci-gc-page-{full,cli,window-token,clippy-final,release-checks}.log`。完整模拟合并 CI 和合入状态另行记录，尚未发布或在生产执行删除。
