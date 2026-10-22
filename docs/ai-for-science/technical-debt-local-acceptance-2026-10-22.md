# 技术债本地测试与启动验收（2026-10-22）

## 范围与候选

本轮在 macOS arm64 本地实施可靠性回归并启动开发槽，不发布服务器版本。基线提交为 `6fc98a38f4ba0df57f650f2dac6b17b0a2ae4c7b`；候选还包含本轮未提交的测试改动，不能只用 HEAD 代表测试源码。源码和日志 SHA256 清单见本地 `.mobilesci-run/technical-debt/local-2026-10-22/evidence.json`。

本地工具链为 Rust 1.93.1、Node 22.20.0。该记录补充本地验证，不改变此前服务器部署候选 `4aa886d`，也不能替代其他操作系统的 CI 或后续发布证据。

## 实施内容

- `src/local/materials.rs`：增加真实子进程强杀回归，分别中断暂存、原件发布、manifest 提交后三个阶段。子进程持有实际配额锁，父进程等待阶段信号后强杀并等待退出；随后上传触发恢复。核验锁可重新取得、恢复重复执行安全、暂存被清理、未提交原件被移除、已提交及无关原件保留，封存后逐项核验原件哈希。
- `src/local/chat/mod.rs`：在既有静默检查点测试中增加真实 SQLite `BEGIN IMMEDIATE` 写锁冲突。确认失败不更新已确认快照、不把未保存尾部写成成功；释放锁后下一次检查点保存同一尾部，最终消息与提示卡仍强制持久化。
- 仅扩展测试，未改变业务持久化、材料回收或认证逻辑。

## 自动化结果

日志均位于 `.mobilesci-run/technical-debt/local-2026-10-22/`。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| `cargo test --locked -- --test-threads=1` | 1,188 单测通过，3 项原定义忽略；18 项集成通过，0 失败 | `rust-full.log` |
| 材料针对性回归 | 12 项通过，包含三个真实强杀阶段 | `materials.log` |
| `cargo fmt --all --check` | 通过 | `fmt-final.log` |
| `cargo clippy --locked --all-targets -- -D warnings` | 通过 | `clippy-final.log` |
| UI 完整单测 | 410 项通过 | `ui-tests.log` |
| UI 路由生成、Paraglide 类型生成、TypeScript | 通过 | `ui-generate.log`、`ui-typecheck-final.log` |
| 平台单测 | 33 项通过，含上传、隧道和 runner 锁 | `platform-tests.log` |
| PostgreSQL 集成 | 40 项通过；本地开发数据库随机独立 schema，结束后清理 | `platform-integration.log` |
| dev-slot、发行证据与启动辅助 | 20 项通过 | `helpers.log` |
| 部署辅助脚本 | 44 项通过；没有执行远程部署 | `deploy-tests.log` |
| i18n、主题样式、已提交 UI 入口预算、diff 空白检查 | 通过；入口 2,939,788 raw / 897,776 gzip bytes | 见本轮命令输出 |

首次离线 Rust 测试因缺少 zlib-rs 依赖未进入执行，随后按 Cargo.lock 下载依赖并完成全量验证。沙箱内回环端口测试曾受限，最终在允许本地端口的环境复跑通过。

前端依赖恢复过程中，当前 pnpm 报告 esbuild 构建脚本未获准，初次类型检查也发现旧 Paraglide 生成物缺少 SSH 消息。未放宽项目构建脚本策略；按现有锁文件恢复依赖、执行 Paraglide 生成后，直接调用已安装的路由生成器和 TypeScript，检查通过，Vite 实际启动成功。本轮未执行新的 UI 生产构建，预算检查针对已提交 ui/dist；不能写成生产构建验收通过。

## 启动与浏览器验收

启动前确认 slot-1 的前后端均停止，账号服务和文献服务已运行。读取账号容器配置确认 `OPENRESEARCH_APP_ORIGIN=http://localhost:5201`，未改写凭据或放宽 Origin。

通过 `./start-mobilesci-dev.command` 启动并复用现有 copy 模式开发槽：

- 前端：`http://localhost:5201/projects`，Vite 热更新。
- 后端：`http://127.0.0.1:4901`，`/api/health` 返回协议 2、版本 0.2.19、ok=true。
- 账号：`http://localhost:5300`，`/healthz` 返回 ok=true。
- 文献：`http://localhost:3000/`，入口 HTTP 200。
- 状态和运行数据：`~/.local/share/openresearch-dev/slot-1-state.json`、`slot-1/`；启动日志见 `startup.log`。

浏览器确认：未登录访问进入介绍页，登录入口跳转现有账号服务；用户自行完成登录后，科研主页与既有研究工作区可访问，文件/ZIP 多选和文件夹入口均可见。独立验收标签刷新后仍保留账号和项目列表，首页引导内容正常显示。未提交研究消息、批准研究闸门或操作既有研究任务；开发槽保持运行供用户验收。

HTTP 检查使用真实的 `/api/platform/browser-session`，来自开发 origin 的无 Cookie 请求返回 JSON 401（请先登录），不是 Origin 403，也不是 HTML 回退页。原始状态见 `http-smoke.json`。页面刷新恢复不等同于完整网络故障注入。

## 剩余边界

- 真实磁盘写满 ENOSPC、断电级持久性和长时间压力尚未覆盖；SQLite 写锁失败不等同于磁盘故障。
- 上传子进程在明确阶段边界强杀，不代表穷尽每条文件系统指令之间的崩溃窗口。
- 本轮没有用浏览器上传新的材料、模拟浏览器离线或验证真实模型端到端研究；上传与权限链路由本地自动化测试覆盖。
- 本机没有 pdftotext，未验收本机 PDF 正文提取；不能继承服务器镜像已有的 PDF 解析结果。
- 全 API DTO、聊天同步隔离、大模块治理、历史异常材料包完整恢复、依赖保留项和范围外 #717 状态不因本轮测试通过而关闭。
