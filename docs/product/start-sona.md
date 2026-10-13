# 一键启动 SONA

在 macOS 中双击仓库根目录的 `start-sona.command`，或在终端执行：

```bash
cd /Users/levent/cmccProjects/OpenResearch
./start-sona.command
```

启动成功后访问 `http://localhost:4791/projects`。启动窗口可关闭，SONA 在后台继续运行；日志位于 `.sona-run/workspace.log`，进程信息位于 `.sona-run/workspace.json`。这些本地文件不会提交到 Git。

脚本复用健康的账号服务（5300）、DeepXiv（3000）和 SONA（4791）。服务未运行时按现有配置启动；保留账号平台容器记录的 Compose 配置（包括既有 managed 配置）。不会覆盖 `.env`、生成新密码、更换数据库或停止已有服务。首次启动或后端源码变化时会编译，后续可复用编译缓存；工作区未运行时会构建最新前端。

账号或 DeepXiv 未运行时，需要先打开 Docker Desktop，并已配置 `packages/platform/.env` 与 DeepXiv 的 `.env.local`。脚本会明确报告缺少的配置。DeepXiv 默认位于相邻的 `../DeepLiterature` 仓库，可通过 `./start-sona.command --deeplit-dir /path/to/DeepLiterature` 指定。

`--rebuild` 可强制重新编译尚未运行的工作区；如果工作区已运行，仍会复用服务，避免中断研究。原有 `scripts/start-local.mjs` 保留作为完整初始化入口，新脚本用于日常启动现有个人工作区。开发隔离实例继续使用 `scripts/dev-slot.mjs`。

远程服务器的一键打包、SCP 上传与安装方案见 [SONA 一键服务器部署](deploy-sona.md)。
