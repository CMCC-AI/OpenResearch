# 管理员大模型接入（OpenCode 风格）前后端改造方案

## 1. 背景与目标

当前额度模式（`backend === "quota"`）下的「系统管理 → 大模型接入」（`/admin/opencode`）将网关底层的扁平 `models[]` 数组直接映射为表单，导致管理员每接入一个模型都需要重复填写 `providerId`、`baseUrl`、`apiKey`、`contextTokens`、`maxOutputTokens` 与能力 JSON。

改造目标对齐 OpenCode 原生配置体验：

1. **提供商（Providers）层**：管理员选择供应商（或自定义 OpenAI 兼容中转站）后，只需输入一次 `API Key`（及可选 `Base URL`）即可完成连接。
2. **模型（Models）层**：按已连接供应商分组折叠/展开可用模型列表，管理员通过开关（Switch）控制向平台用户开放哪些模型，并指定平台默认模型。
3. **额度边界不退化**：在 `TOKEN_QUOTAS_ENABLED=true` 下，所有平台模型流量继续统一经过 `/api/platform/model-gateway/v1/chat/completions` 计费与预占，真实上游 `API Key` 始终隔离在平台侧，不进入用户执行器容器。

---

## 2. 额度模式安全边界与约束

1. **协议范围限制**：当前额度网关仅接管 OpenAI-compatible Chat Completions 并强制流式 `usage`。因此额度模式下供应商目录仅收录提供 OpenAI 兼容端点的供应商（如 OpenAI、DeepSeek、Moonshot / Kimi、智谱 GLM、OpenRouter、阿里云百炼、硅基流动及自定义 OpenAI 兼容服务）。
2. **预占参数确认**：额度网关在请求发起前按 `contextTokens + maxOutputTokens` 进行事务预占：
   - **内置目录模型**：由目录自动带出经过核验的默认 `contextTokens`、`maxOutputTokens` 与公开能力元数据（工具、思考、多模态），管理员可在高级参数中按需微调。
   - **动态探测 / 自定义模型**：`/v1/models` 接口不返回上下文与输出上限，启用开关时必须展开参数确认区，引导管理员核对或填写真实的 `contextTokens` 与 `maxOutputTokens` 后再保存启用。
3. **执行器下发不变**：平台后端保存后仍编译输出网关清单 `models.json`，执行器拉取到的仍是网关代理地址与 runner 凭据。
4. **模型开关与别名兼容**：
   - 保留存量模型的别名 `id`（如 `kimi-k2.6`），避免升级后旧会话失效。
   - 关闭模型开关等价于从网关清单移除该模型：不影响用户历史账本与月度额度，立即停止新请求调用，私人空间下次唤醒时刷新列表（平台至少保留 1 个启用模型）。

---

## 3. 后端接口扩展方案（`openresearch.sh` / `/api/platform/admin/opencode`）

为兼顾平滑升级，`/api/platform/admin/opencode` 在保留现有 `models[]` 与 `revision` 乐观锁的基础上，逐步扩展以下能力：

### 3.1 `GET /api/platform/admin/opencode` 响应扩展

```json
{
  "enabled": true,
  "backend": "quota",
  "revision": "rev-...",
  "providers": [
    {
      "id": "moonshotai-cn",
      "name": "Kimi / Moonshot",
      "baseUrl": "https://api.moonshot.cn/v1",
      "hasApiKey": true,
      "discoveredModels": ["kimi-k2.6", "kimi-k2.7-code", "kimi-k3"]
    }
  ],
  "models": [
    {
      "id": "kimi-k2.6",
      "name": "Kimi K2.6",
      "providerId": "moonshotai-cn",
      "providerName": "Kimi / Moonshot",
      "model": "kimi-k2.6",
      "baseUrl": "https://api.moonshot.cn/v1",
      "contextTokens": 131072,
      "maxOutputTokens": 8192,
      "outputParameter": "max_tokens",
      "opencode": {},
      "hasApiKey": true
    }
  ]
}
```

- `providers[]` 为可选扩展字段：即使旧版后端仅返回 `models[]`，前端也可从 `models[]` 聚合出已连接供应商。
- 密钥与私有 `headers` 继续严格脱敏，不返回浏览器。

### 3.2 `POST /api/platform/admin/opencode` 动作扩展

在现有单模型写入、`action: "default"`、`action: "remove"` 之外，新增供应商级动作：

1. **`action: "connectProvider"`**：保存供应商级 `providerId`、`providerName`、`baseUrl`、`apiKey`（留空则保留原凭据），并更新同供应商下已有模型的共享凭据。
2. **`action: "probeModels"`**：由平台后端使用已保存或传入的 `baseUrl` + `apiKey` 请求上游 `GET {baseUrl}/models`（带超时与 SSRF/内网地址校验），返回 `{ models: string[] }` 供前端展开勾选，避免浏览器 CORS 问题与密钥暴露。
3. **`action: "disconnectProvider"`**：移除该供应商下所有模型（若会导致平台可用模型数为 0 则拒绝并提示）并清除供应商凭据。

---

## 4. 前端改造架构（`OpenResearch/ui/src/product/`）

1. **[`quotaProviderCatalog.ts`](file:///Users/levent/cmccProjects/OpenResearch/ui/src/product/quotaProviderCatalog.ts)**：
   - 维护额度模式可用的 OpenAI 兼容供应商目录与内置模型元数据（默认 `baseUrl`、`contextTokens`、`maxOutputTokens`、`outputParameter`、`opencode` 能力标记）。
   - 提供供应商状态聚合、目录模型与动态探测模型合并、令牌数格式化及兼容写入载荷构建函数。
2. **[`AdminQuotaModels.tsx`](file:///Users/levent/cmccProjects/OpenResearch/ui/src/product/AdminQuotaModels.tsx)**：
   - 拆分为 **提供商** 与 **模型** 两个视图标签页：
     - **提供商**：展示已连接供应商（支持更新凭据、探测模型、查看模型、断开）与可连接供应商搜索列表（点击 `+ 连接` 一次输入 Key）。
     - **模型**：搜索框 + 按已连接供应商折叠/展开的模型列表，右侧提供 `Switch` 开关、设为默认按钮及参数编辑抽屉；启用动态/自定义模型时自动展开 `contextTokens` / `maxOutputTokens` 确认表单。
   - **向后兼容**：在后端尚未部署 `connectProvider` / `probeModels` 时，前端在当前会话内暂存已连接供应商的 `baseUrl` / `apiKey`，在管理员开启该供应商下的首个模型时自动随模型写入后端；若后端返回已有同供应商模型且管理员未修改 Key，则自动复用凭据。
