import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as skillLibrary from "../src/workflow/skillLibrary.ts";

const require = createRequire(import.meta.url);
const servers = [
  { id: "mcp-rsi", name: "codegraph", transport: "stdio", command: "npx", args: ["-y", "codegraph-mcp"], env: { TOKEN: "s" }, url: "", headers: {}, description: "代码图谱检索", enabled: true, createdAt: 1, updatedAt: 1 },
  { id: "mcp-remote", name: "papers", transport: "http", command: "", args: [], env: {}, url: "https://mcp.example.com/v1", headers: {}, description: "文献服务", enabled: false, createdAt: 1, updatedAt: 2 },
];

// 能力库三组件共用一套轻量 mock：api 调用只记录不发请求，图标与 ui 基件替身为纯元素。
const calls = [];
const mocks = {
  "../api": {
    createWorkflowAgent: async (input) => { calls.push(["createWorkflowAgent", input]); return { id: "agent-new", version: 1, builtIn: false, ...input }; },
    updateWorkflowAgent: async (id, input) => { calls.push(["updateWorkflowAgent", id, input]); return { id, version: 2, builtIn: false, ...input }; },
    deleteWorkflowAgent: async () => ({ ok: true }),
    generateWorkflowAgentDraft: async (body) => { calls.push(["generateWorkflowAgentDraft", body]); return { name: "文献计量分析专家", description: "跑文献计量分析。", prompt: "你是文献计量专家。", mcpServers: [], userSkills: [] }; },
    listMcpServers: async () => servers,
    importMcpConfig: async (text) => { calls.push(["importMcpConfig", text]); return { created: 1, updated: 1, names: ["codegraph", "papers"], errors: [] }; },
    updateMcpServer: async (id, input) => { calls.push(["updateMcpServer", id, input]); return { id, ...input }; },
    deleteMcpServer: async () => ({ ok: true }),
    testMcpServer: async (input) => { calls.push(["testMcpServer", input]); return { ok: true, tools: ["search", "fetch"] }; },
    uploadUserSkill: async (req) => { calls.push(["uploadUserSkill", req]); return { name: "uploaded" }; },
    deleteUserSkill: async () => ({ ok: true }),
    bindSkill: async (req) => { calls.push(["bindSkill", req]); return { ok: true }; },
    unbindSkill: async (req) => { calls.push(["unbindSkill", req]); return { ok: true }; },
    demoteLegacySkill: async (name) => { calls.push(["demoteLegacySkill", name]); return { ok: true }; },
    createUserSkill: async (req) => { calls.push(["createUserSkill", req]); return { name: req.name }; },
    updateUserSkill: async (name, req) => { calls.push(["updateUserSkill", name, req]); return { name }; },
    getWorkflowSkillDetail: async (name) => ({ name, description: "", source: "user", origin: null, bytes: 1, files: [{ path: "SKILL.md", bytes: 1 }], updatedAt: 1, body: "# body", editable: true }),
    userSkillArchiveUrl: (name) => `/api/user-skills/${name}/archive`,
    fmtBytes: (bytes) => `${bytes} B`,
    timeAgo: () => "刚刚",
  },
  "../components/ui": {
    Badge: ({ children }) => React.createElement("span", { "data-badge": Array.isArray(children) ? children.join("") : String(children) }, children),
    Button: ({ children, ...props }) => React.createElement("button", props, children),
    ButtonLink: ({ children, ...props }) => React.createElement("a", props, children),
    Input: (props) => React.createElement("input", props),
    Spinner: (props) => React.createElement("span", { "data-spinner": "true", ...props }),
    showAlert: () => {},
  },
  "../components/Md": { Md: ({ text }) => React.createElement("div", { "data-md": "true" }, text) },
  "../locale": { useLocale: () => "zh-CN" },
  "../events": { onAgentDraftProgress: () => () => {} },
  "../clientTurnId": { createClientTurnId: () => "ct_test-request" },
  "../components/SkillsTab": { fileToBase64: async () => "ZmFrZQ==" },
  "./conversation": { skillConversationRequest: () => "draft", stageComposerHandoff: () => {} },
  "./skillLibrary": skillLibrary,
  "../composerStash": { EMPTY_COMPOSER_STASH: { draft: "", attachments: [], annotations: [] }, stageComposerDraft: () => {} },
  "@tanstack/react-query": { useQuery: () => ({ data: servers, isPending: false, refetch() {} }) },
  "../queries/client": { workspaceKey: (...parts) => parts, queryClient: { invalidateQueries() {} }, getWorkspaceGeneration: () => 1 },
  "lucide-react": new Proxy({}, { get: (_, name) => (props) => React.createElement("i", { "data-icon": String(name), ...props }) }),
  "./CapabilityTile": { CapabilityTile: (props) => React.createElement("i", { "data-tile": `${props.kind}:${props.size ?? "sm"}` }) },
};
function loadComponent(file) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported = {};
  new Function("require", "exports", code)((id) => (id in mocks ? mocks[id] : require(id)), exported);
  return exported;
}

test("McpLibrary is paste-first: import saves directly, entries list with enable badges", () => {
  const { McpLibrary } = loadComponent("../src/workflow/McpLibrary.tsx");
  const html = renderToStaticMarkup(React.createElement(McpLibrary));
  // 主路径：粘贴配置导入即保存，不再有手动字段表单。
  assert.match(html, /导入并保存/);
  assert.match(html, /mcpServers JSON 与 Codex 的 TOML/);
  assert.match(html, /同名服务自动覆盖更新/);
  assert.doesNotMatch(html, /启动参数/);
  // 列表条目带启停状态与命令摘要；密钥值永不出现在页面上。
  assert.match(html, /codegraph/);
  assert.match(html, /data-badge="启用"/);
  assert.match(html, /papers/);
  assert.match(html, /mcp\.example\.com/);
  assert.match(html, /只存本机/);
  assert.doesNotMatch(html, /TOKEN=s/);
});

test("SkillsLibrary groups builtin modules and user skills; uploads and deletes stay user-owned", () => {
  const { SkillsLibrary } = loadComponent("../src/workflow/SkillsLibrary.tsx");
  const skills = [
    { name: "orx-lit-review", description: "文献综述指南", source: "builtin", origin: null, bytes: null, updatedAt: null },
    { name: "my-lab-protocol", description: null, source: "user", origin: null, bytes: 2048, updatedAt: 1700000000000 },
    { name: "mirrored-skill", description: null, source: "user", origin: "claude", bytes: 1024, updatedAt: 1700000000000 },
  ];
  const html = renderToStaticMarkup(React.createElement(SkillsLibrary, { skills, agents: [], projects: [], onChanged: async () => {} }));
  assert.match(html, /我的技能（2）/);
  assert.match(html, /内置技能（1）/);
  // 内置技能卡片用中文展示名，技术标识 orx-* 保留为次要文字。
  assert.match(html, /文献证据/);
  assert.match(html, /orx-lit-review/);
  assert.match(html, /data-badge="内置"/);
  // 用户技能直接展示自己的用途摘要；镜像技能从描述回退到来源说明。
  assert.match(html, /mirrored-skill/);
  assert.match(html, /来自 claude 的镜像技能/);
  assert.match(html, /data-badge="按需使用"/);
  // 库说明讲清生效模型：默认不生效、按处绑定、/名字 唤起。
  assert.match(html, /默认不生效/);
  assert.match(html, /\/技能名/);
  // 全局技能库没有项目落点：不渲染对话入口，只保留文字提示。
  assert.doesNotMatch(html, /在对话中创建/);
  assert.match(html, /回对话让 AI 帮你创建/);
  // 未选中详情时展示库说明，不渲染删除按钮。
  assert.doesNotMatch(html, /删除/);
});

test("SkillsLibrary offers the in-conversation entry inside a project and hides it without one", () => {
  const { SkillsLibrary } = loadComponent("../src/workflow/SkillsLibrary.tsx");
  const skills = [{ name: "my-lab-protocol", description: null, source: "user", origin: null, bytes: 256, updatedAt: 1 }];
  const props = { skills, agents: [], projects: [], onChanged: async () => {} };
  // 项目工作区：入口按钮出现，说明文字指向它。
  const inProject = renderToStaticMarkup(React.createElement(SkillsLibrary, { ...props, projectId: "proj-1", sessionId: "sess-1", onOpenSession: () => {} }));
  assert.match(inProject, /在对话中创建/);
  assert.match(inProject, /点「在对话中创建」/);
  // 项目还没有会话（sessionId 为 null）时入口仍在：点击会落到科研首页的起始输入框。
  const freshProject = renderToStaticMarkup(React.createElement(SkillsLibrary, { ...props, projectId: "proj-1", sessionId: null, onOpenSession: () => {} }));
  assert.match(freshProject, /在对话中创建/);
  // 全局技能库（无项目上下文）：给 onOpenChats 就有入口，去科研首页选项目再发。
  const globalLibrary = renderToStaticMarkup(React.createElement(SkillsLibrary, { ...props, onOpenChats: () => {} }));
  assert.match(globalLibrary, /在对话中创建/);
  assert.match(globalLibrary, /点「在对话中创建」/);
  // 两个跳转出口都没给时才隐藏入口。
  const nowhere = renderToStaticMarkup(React.createElement(SkillsLibrary, props));
  assert.doesNotMatch(nowhere, /在对话中创建/);
});

test("SkillsLibrary shows the effective scope with legacy badge, project checkboxes and bound experts", () => {
  const { SkillsLibrary, SkillScopeSection } = loadComponent("../src/workflow/SkillsLibrary.tsx");
  const agents = [{ id: "agent-quant", name: "量化分析师", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1, mcpServers: [], userSkills: ["legacy-lab"] }];
  const skills = [
    { name: "legacy-lab", description: null, source: "user", origin: null, bytes: 512, updatedAt: 1, legacyGlobal: true, boundProjects: ["proj-1"], boundAgents: ["agent-quant"] },
    { name: "fresh-skill", description: null, source: "user", origin: null, bytes: 128, updatedAt: 2, legacyGlobal: false, boundProjects: [], boundAgents: [] },
  ];
  const projects = [{ id: "proj-1", name: "电池材料综述", slug: "battery", githubOwner: "", githubRepo: "", baselineBranch: "main", repoPath: "", path: "", githubEnabled: false, artifactsDir: "", createdAt: 1, updatedAt: 1 }];
  const library = renderToStaticMarkup(React.createElement(SkillsLibrary, { skills, agents, projects, onChanged: async () => {} }));
  // 列表行：legacy 技能带“全局生效”徽标；库说明讲清默认不生效。
  assert.match(library, /data-badge="全局生效"/);
  assert.match(library, /默认不生效/);
  // 生效范围区块：legacy 有“改为按需绑定”入口并点出挂载的专家；新技能给项目勾选。
  const legacyScope = renderToStaticMarkup(React.createElement(SkillScopeSection, {
    skill: skills[0], projects, busy: false,
    scopeSummary: "历史上传，保留全局生效：所有会话自动携带。",
    boundAgentNames: ["量化分析师"],
    onToggleProject: () => {}, onDemote: () => {},
  }));
  assert.match(legacyScope, /历史上传，保留全局生效/);
  assert.match(legacyScope, /改为按需绑定/);
  assert.match(legacyScope, /电池材料综述/);
  assert.match(legacyScope, /量化分析师/);
  const freshScope = renderToStaticMarkup(React.createElement(SkillScopeSection, {
    skill: skills[1], projects, busy: false,
    scopeSummary: "未绑定：不随任何会话自动携带；对话里输入 /技能名 仍可直接使用。",
    boundAgentNames: [],
    onToggleProject: () => {}, onDemote: () => {},
  }));
  assert.match(freshScope, /在哪些项目自动携带/);
  assert.match(freshScope, /还没有专家挂载这个技能/);
});

test("custom agents attach MCP servers; the create form lists every server as a checkbox", () => {
  const exported = loadComponent("../src/workflow/AgentLibrary.tsx");
  const agents = [
    { id: "as-asset-auditor", name: "科研资产盘点专家", description: "", prompt: "", version: 0, builtIn: true, createdAt: 0, updatedAt: 0, mcpServers: [], skills: [{ name: "orx-git", description: "Git 操作指南" }], toolPermissions: ["不得自行批准 G1–G4"] },
    { id: "agent-quant", name: "量化分析师", description: "", prompt: "", version: 1, builtIn: false, createdAt: 1, updatedAt: 1, mcpServers: ["mcp-rsi"] },
  ];
  // 无选中：新建表单带“MCP 服务”复选框组，列出全部已登记服务。
  const blank = renderToStaticMarkup(React.createElement(exported.AgentLibrary, { agents, mcpServers: servers, onChanged: async () => {} }));
  assert.match(blank, /创建自定义 Agent/);
  assert.match(blank, /MCP 服务/);
  assert.match(blank, /codegraph/);
  assert.match(blank, /papers/);
  assert.match(blank, /该专家工作时可以调用这些服务/);
  // 空服务库时引导去 MCP 页，而不是渲染空复选框组。
  const noServers = renderToStaticMarkup(React.createElement(exported.AgentLibrary, { agents, mcpServers: [], onChanged: async () => {} }));
  assert.match(noServers, /还没有登记 MCP 服务/);
  // “使用的技能”复选框组：列出上传技能；空库时引导去 Skills 页。
  const withSkills = renderToStaticMarkup(React.createElement(exported.AgentLibrary, { agents, mcpServers: servers, userSkills: [{ name: "my-lab-protocol", source: "user" }], onChanged: async () => {} }));
  assert.match(withSkills, /使用的技能/);
  assert.match(withSkills, /my-lab-protocol/);
  assert.match(withSkills, /未勾选的技能不生效/);
  const noSkills = renderToStaticMarkup(React.createElement(exported.AgentLibrary, { agents, mcpServers: servers, userSkills: [], onChanged: async () => {} }));
  assert.match(noSkills, /还没有上传技能/);
});

test("AI 帮我建 entry offers one-sentence agent drafting", () => {
  const exported = loadComponent("../src/workflow/AgentLibrary.tsx");
  const agents = [
    { id: "as-asset-auditor", name: "科研资产盘点专家", description: "", prompt: "", version: 0, builtIn: true, createdAt: 0, updatedAt: 0, mcpServers: [], skills: [] },
  ];
  const html = renderToStaticMarkup(React.createElement(exported.AgentLibrary, { agents, mcpServers: servers, onChanged: async () => {} }));
  assert.match(html, /新建 Agent/);
  assert.match(html, /AI 帮我建/);
  // 弹层默认收起：一句话输入与生成提示不随列表常驻渲染。
  assert.doesNotMatch(html, /用一句话描述这个专家/);
  assert.doesNotMatch(html, /生成草稿/);
});

test("AgentDraftProgress walks real backend stages and times the writing step", () => {
  const { AgentDraftProgress } = loadComponent("../src/workflow/AgentLibrary.tsx");
  const html = renderToStaticMarkup(React.createElement(AgentDraftProgress, { stage: "writing", startedAt: 0, now: 37000 }));
  // 四个阶段全部可见，标题与说明讲清“生成后填进表单”。
  assert.match(html, /正在创建这个专家/);
  assert.match(html, /整理可用的专家、工具和技能/);
  assert.match(html, /启动生成引擎/);
  assert.match(html, /AI 正在撰写专家设定/);
  assert.match(html, /检查并整理草稿/);
  assert.match(html, /自动填进这份表单/);
  // 撰写中就地计时；非撰写阶段不显示等待秒数。
  assert.match(html, /已等待 37 秒/);
  const early = renderToStaticMarkup(React.createElement(AgentDraftProgress, { stage: "inventory", startedAt: 0, now: 8000 }));
  assert.doesNotMatch(early, /已等待/);
});

test("agent draft typing reveal walks name → description → prompt by characters", () => {
  const { agentDraftTypingValue, agentDraftTypingTotal } = loadComponent("../src/workflow/AgentLibrary.tsx");
  const target = { name: "文献员", description: "跑计量", prompt: "你是文献计量专家。", mcpServers: [], userSkills: [] };
  assert.equal(agentDraftTypingTotal(target), 15);
  // 依次接力：名称展示完才轮到能力说明，最后是提示词。
  assert.equal(agentDraftTypingValue(target, "name", 1), "文");
  assert.equal(agentDraftTypingValue(target, "name", 2), "文献");
  assert.equal(agentDraftTypingValue(target, "name", 3), "文献员");
  assert.equal(agentDraftTypingValue(target, "description", 3), "");
  assert.equal(agentDraftTypingValue(target, "description", 4), "跑");
  assert.equal(agentDraftTypingValue(target, "prompt", 6), "");
  assert.equal(agentDraftTypingValue(target, "prompt", 7), "你");
  assert.equal(agentDraftTypingValue(target, "prompt", 13), "你是文献计量专");
  // 超出总量不会多吐字。
  assert.equal(agentDraftTypingValue(target, "prompt", 99), "你是文献计量专家。");
  // 代理对不被拆散：表情字符要么不出现，要么完整出现。
  const emoji = { name: "📊员", description: "", prompt: "", mcpServers: [], userSkills: [] };
  const half = agentDraftTypingValue(emoji, "name", 1);
  assert.ok(half === "" || half === "📊");
});
