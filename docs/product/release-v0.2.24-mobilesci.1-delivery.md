# MobileSci v0.2.24-mobilesci.1 生产交付记录（Gate 1.3）

完成状态：2026-11-17，已完成 [`v0.2.24-mobilesci.1`](https://github.com/CMCC-AI/OpenResearch/releases/tag/v0.2.24-mobilesci.1)（固定提交 `bcb90af4fd3dd3250d52f23b94dcbb12d87f8bbb`）在生产环境 `10.7.0.18`（公网入口 `http://49.232.238.110:20281/mobilesci/`）的受控升级切换与上线验收；既有不可变 Release 标签与附件保持不变，真实上游祖先仍为 `v0.2.19`。

## 1. 候选与离线构建基线

- 源码与依赖包（`/opt/mobilesci/staging/`）：
  - `source-bcb90af4.tar.gz`：`0be5312ea7c9a41ad1a339e89c010d0d17e761f1789141622e0fb55d6d4480a4`
  - `vendor-bcb90af4.tar.gz`：`ca58a5ff37a0f33631dc36036fd92309965d0bb957ecd4bbd2a7f26ed4771faf`（含 `quinn-udp 0.5.16` `RUSTSEC-2026-0538` 修复）
  - `opencode-amd64-1.18.33.tar.gz`：`4a561c721ab8aa3524aa7662214215a19be7f0c04df6ced491880807bb69d0e4`（包含 `opencode-ai@1.18.33` 与 `@opencode-ai/plugin@1.18.33` 及 `/opt/opencode-npm-cache`）
- 候选工作目录：`/opt/mobilesci/candidates/release-0.2.24-mobilesci.1-bcb90af4`
- 原生 CLI（`rust:1.93-bookworm` 离线锁定构建 `--release --locked --offline`）：`orx 0.2.24-mobilesci.1`，SHA-256 `7dc3a86ea5baf83eda81975b96c2867c220df92925e1cf3284a65ed52e94e32e`
- 平台与 Provisioner 镜像（`mobilesci-current-platform:bcb90af4`）：`sha256:b27c3291ab3d41c78f825e6060344cf6a7bec9dc2480d6c51972c137ed250a09`
- 执行器镜像（`mobilesci-current-executor:bcb90af4`）：`sha256:8c69fc319952f11bab95dda85b613b8979999d60eb14f80b41625b497707dc2c`
  - 构建阶段以非 root 用户 `node` 验证 `orx-check-executor-tools`、`orx --version` = `orx 0.2.24-mobilesci.1`、`opencode --version` = `1.18.33` 及 `/opt/opencode-npm-cache/_cacache` 存在。

## 2. 切换前隔离集成验收

在 `10.7.0.18` 上使用 `mobilesci-current-platform:bcb90af4` 与 `--internal` 临时 PostgreSQL 容器（`--tmpfs`）执行全部平台集成回归：

- `test/integration.mjs`
- `test/accounts.integration.mjs`
- `test/cases.integration.mjs`
- `test/runtime-pool.integration.mjs`
- `test/token-quotas.integration.mjs`
- 结果：**5 组 58/58 项全部通过**（`fail: 0`, `skipped: 0`）。

## 3. 受控升级切换与完整备份

- 切换计划摘要（两阶段锁确认）：`c338f6564dc01240b371de38459a29791f710910ef309a3d6a6ba5ee3b572019`
- 备份目录（不含对外公开的凭据副本）：`/opt/mobilesci/backups/release-0.2.24-mobilesci.1-cutover-20261117t085827z/`
  - PostgreSQL 全库备份 `platform.dump`（`pg_dump -Fc` 并完成 `pg_restore --list` 校验）；
  - 5 个存量私人空间 SQLite 在线一致性备份（`orx-managed-*.db`，每份均通过 `PRAGMA integrity_check = ok` 与 `PRAGMA foreign_key_check` 零异常）；
  - 原 `compose.yaml`、`nginx.conf`、`ui/index.html`、`token-quotas/models.json` 与切换前后受保护账号/额度/案例状态快照（`protected.before.json` 与 `protected.after.json` 完全一致）；
  - 旧容器重命名为 `*-before-v24-20261117t085827z` 保留为快速回滚依据。
- 同步对象：
  - `mobilesci-replica-platform-1` 与 `mobilesci-replica-provisioner-1` 切换至 `mobilesci-current-platform:bcb90af4`；
  - `mobilesci-replica-provisioner-1` 与 `/opt/mobilesci/current/compose.yaml` 的 `MANAGED_EXECUTOR_IMAGE` / `MANAGED_CONNECTOR_IMAGE` 同步为 `mobilesci-current-executor:bcb90af4`（保留 `MANAGED_CAPACITY=6`、`MANAGED_IDLE_SECONDS=45` 及内存配额）；
  - 5 个存量私人执行器容器全部重建对齐新执行器镜像，并保留 `/home/node` 挂载与宿主机限制；
  - `/opt/mobilesci/current/ui` 更新 327 个静态资源（入口 `assets/index-Dl4DNglY.js`）；`/opt/mobilesci/current/nginx.conf` `/_orx/runtime` 版本同步为 `0.2.24-mobilesci.1`。

## 4. 切换后验收结果

- **组件与数据一致性校验（`verify-bcb90af4.py`）**：
  - 平台、Provisioner、5 个存量私人执行器与 `compose.yaml` 镜像、环境变量、挂载与容器标签（`revision=bcb90af4...`、`version=0.2.24-mobilesci.1`）全部对齐；
  - 5 份私人空间 SQLite 的 38 张表行数与备份逐表一致，`models.json` 与数据库受保护账号/额度/案例数据零变更；
  - 网关回环 7 个入口（`/healthz`、`/_orx/runtime`、`/mobilesci/projects`、`/mobilesci/admin/quotas`、`/mobilesci/admin/cases`、`/mobilesci/settings/account`、`/mobilesci/settings/quota`）与主 JS 入口摘要校验全部通过。
- **公网入口验证（从开发机直连 `http://49.232.238.110:20281`）**：
  - `GET /healthz` 返回 `{"ok":true}`；
  - `GET /_orx/runtime` 返回 `{"kind":"local","version":"0.2.24-mobilesci.1","accountUrl":"http://49.232.238.110:20281"}`；
  - `GET /mobilesci/projects` 返回构建入口 `assets/index-Dl4DNglY.js`。
- **管理员模型开关读写与执行器冷启动缓存验证**：
  - 管理员登录 `POST /api/platform/login`、`GET /api/platform/capabilities`、`GET /api/platform/admin/opencode`（1 个供应商、6 个模型，默认 `kimi-k2.6`）、`POST /api/platform/admin/opencode`（`action: "default"` 幂等写回后 `models.json` 字节摘要一致）、`GET /api/platform/cases`（4 个公开案例）均返回 200；
  - 在 `mobilesci-current-executor:bcb90af4` 中以空白 `tmpfs` `/home/node` 验证 `seedOpenCodeNpmCache` 成功填充 `/home/node/.npm/_cacache`，`opencode --version` = `1.18.33`，`orx --version` = `orx 0.2.24-mobilesci.1`；并在无网络隔离容器内跑通 `test-case-api-2b708ad2.py`（`caseApi: passed`）。
