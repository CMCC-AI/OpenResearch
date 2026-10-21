# 一键启动 MobileSci

在 macOS 中双击仓库根目录的 `start-mobilesci.command`，或在终端执行：

```bash
cd /Users/levent/cmccProjects/OpenResearch
./start-mobilesci.command
```

启动成功后访问 `http://localhost:4791/projects`。启动窗口可关闭，MobileSci 在后台继续运行；日志位于 `.mobilesci-run/workspace.log`，进程信息位于 `.mobilesci-run/workspace.json`。这些本地文件不会提交到 Git。

脚本复用健康的账号服务（5300）、DeepXiv（3000）和 MobileSci（4791）。服务未运行时按现有配置启动；保留账号平台容器记录的 Compose 配置（包括既有 managed 配置）。不会覆盖 `.env`、生成新密码、更换数据库或停止已有服务。首次启动或后端源码变化时会编译，后续可复用编译缓存；工作区未运行时会构建最新前端。

账号或 DeepXiv 未运行时，需要先打开 Docker Desktop，并已配置 `packages/platform/.env` 与 DeepXiv 的 `.env.local`。脚本会明确报告缺少的配置。DeepXiv 默认位于相邻的 `../DeepLiterature` 仓库，可通过 `./start-mobilesci.command --deeplit-dir /path/to/DeepLiterature` 指定。

`--rebuild` 可强制重新编译尚未运行的工作区；如果工作区已运行，仍会复用服务，避免中断研究。原有 `scripts/start-local.mjs` 保留作为完整初始化入口，新脚本用于日常启动现有个人工作区。开发隔离实例继续使用 `scripts/dev-slot.mjs`。

远程服务器的一键打包、SCP 上传与安装方案见 [MobileSci 一键服务器部署](deploy-mobilesci.md)。

## 前端热更新开发

日常启动入口 `start-mobilesci.command` 使用构建后的前端，不监听 TSX/CSS 源码。开发界面时，在账号服务（5300）与 DeepXiv（3000）已运行的情况下使用：

```bash
./start-mobilesci-dev.command
```

该入口通过 `scripts/dev-slot.mjs` 启动 Vite 与隔离后端，首次复制个人工作区数据库，后续复用同一开发槽。请访问启动日志中显示的 **UI 地址**（通常为 `http://localhost:5201/projects`），不要访问后端端口。前端变更由 Vite 热更新；Rust 后端变更仍需停止并重新启动开发槽以编译生效。数据库副本中的后续更改不会自动同步回个人工作区数据库。

```bash
node scripts/dev-slot.mjs status
node scripts/dev-slot.mjs stop
```

账号服务的 `OPENRESEARCH_APP_ORIGIN` 必须与开发前端的浏览器地址一致（通常为 `http://localhost:5201`），否则登录态请求会因来源不受信任返回 403，登录后也会跳回旧端口。切换到日常 4791 入口时，同步调整 `packages/platform/.env` 中该值，并使用账号服务原有 Compose 文件重建 `platform` 容器；不需要更换数据库或凭据。

开发槽支持主工作区位于功能分支。Vite 由受管 Node 进程直接启动，避免部分 pnpm 版本分离进程组导致归属检查及停止失败。
