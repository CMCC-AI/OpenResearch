import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, CircleDot, Plus, Sparkles, Trash2 } from "lucide-react";
import { createWorkflowAgent, deleteWorkflowAgent, generateWorkflowAgentDraft, updateWorkflowAgent } from "../api";
import { createClientTurnId } from "../clientTurnId";
import { onAgentDraftProgress } from "../events";
import { Badge, Button, Input, showAlert, Spinner } from "../components/ui";
import { useLocale } from "../locale";
import { CapabilityTile } from "./CapabilityTile";
import type { WorkflowAgent, WorkflowAgentInput, WorkflowAgentSkill, WorkflowLibrarySkill, McpServer } from "./model";

const emptyAgent: WorkflowAgentInput = { name: "", description: "", prompt: "", mcpServers: [], userSkills: [] };

/** 生成期间右侧清单的阶段与文案；key 与后端 agentDraft.progress 事件的 stage 一一对应。 */
const DRAFT_STAGES = [
  { key: "inventory", label: "整理可用的专家、工具和技能" },
  { key: "engine", label: "启动生成引擎" },
  { key: "writing", label: "AI 正在撰写专家设定" },
  { key: "reviewing", label: "检查并整理草稿" },
] as const;

/** 生成期间右侧的过程视图：每个阶段都对应后端真实动作；撰写阶段就地计时。 */
export function AgentDraftProgress({ stage, startedAt, now }: { stage: string; startedAt: number; now: number }) {
  const current = Math.max(0, DRAFT_STAGES.findIndex((step) => step.key === stage));
  const elapsed = Math.floor(Math.max(0, now - startedAt) / 1000);
  return <div className="mx-auto flex max-w-3xl flex-col gap-4" role="status" aria-label="正在创建专家">
    <div>
      <h2 className="m-0 text-lg font-normal">正在创建这个专家</h2>
      <p className="mb-0 mt-1 text-sm text-subtext">生成通常要一两分钟。完成后草稿会自动填进这份表单，你确认或修改后再保存。</p>
    </div>
    <ol className="m-0 flex list-none flex-col gap-2.5 text-sm">
      {DRAFT_STAGES.map((step, index) => {
        const state = index < current ? "done" : index === current ? "running" : "pending";
        return <li key={step.key} className={`flex items-center gap-2 ${state === "pending" ? "text-subtext" : "text-text"}`}>
          {state === "done"
            ? <CheckCircle2 size={15} aria-hidden className="shrink-0" />
            : state === "running"
              ? <CircleDot size={15} aria-hidden className="shrink-0 animate-pulse" />
              : <Circle size={15} aria-hidden className="shrink-0 opacity-50" />}
          <span>{step.label}{step.key === "writing" && state === "running" && elapsed > 0 ? `（已等待 ${elapsed} 秒）` : ""}</span>
        </li>;
    })}
  </ol>
  </div>;
}

/** 打字机填表的总字数：名称→能力说明→提示词 三段接力展示。 */
export function agentDraftTypingTotal(target: WorkflowAgentInput): number {
  return [...Array.from(target.name), ...Array.from(target.description), ...Array.from(target.prompt)].length;
}

/** 已展示 shown 个字时某字段的可见文本；按字符切分，避免拆散代理对。 */
export function agentDraftTypingValue(target: WorkflowAgentInput, field: "name" | "description" | "prompt", shown: number): string {
  const chars = Array.from(target[field]);
  const before = field === "name" ? 0
    : field === "description" ? Array.from(target.name).length
    : Array.from(target.name).length + Array.from(target.description).length;
  return chars.slice(0, Math.max(0, Math.min(chars.length, shown - before))).join("");
}

/** 内置 skill 名称对非开发者不直观；悬浮展开名称与用途说明（内容来自后端技能描述）。 */
function SkillBadge({ skill }: { skill: WorkflowAgentSkill }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  function show() {
    const trigger = triggerRef.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    if (!card.matches(":popover-open")) card.showPopover();
    const anchor = trigger.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left - 8, window.innerWidth - bounds.width - 8));
    card.style.left = `${left}px`;
    card.style.top = anchor.top > bounds.height + 16 ? `${anchor.top - bounds.height - 8}px` : `${anchor.bottom + 8}px`;
  }

  function hide() {
    if (!triggerRef.current?.matches(":hover, :focus-visible")) cardRef.current?.hidePopover();
  }

  useEffect(() => {
    const dismiss = () => cardRef.current?.hidePopover();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  return <span
    ref={triggerRef}
    tabIndex={0}
    role="img"
    aria-label={`${skill.name}：${skill.description}`}
    className="inline-flex cursor-help rounded-full outline-none focus-visible:outline-2 focus-visible:outline-text focus-visible:outline-offset-2"
    onMouseEnter={show}
    onMouseLeave={hide}
    onFocus={(event) => {
      if (event.target.matches(":focus-visible")) show();
    }}
    onBlur={hide}
    onKeyDown={(event) => {
      if (event.key === "Escape" && cardRef.current?.matches(":popover-open")) {
        event.preventDefault();
        event.stopPropagation();
        cardRef.current.hidePopover();
      }
    }}
  >
    <Badge size="small">{skill.name}</Badge>
    <div
      ref={cardRef}
      role="tooltip"
      popover="manual"
      className="pointer-events-none fixed inset-auto z-100 m-0 w-80 whitespace-normal rounded-md border-0 bg-text px-3 py-2.5 font-sans text-sm font-normal leading-relaxed text-background shadow-control-subtle"
    >
      <strong className="mb-1 block font-mono text-xs font-normal opacity-80">{skill.name}</strong>
      {skill.description || "暂无说明"}
    </div>
  </span>;
}

export function AgentLibrary({ agents, mcpServers = [], userSkills = [], onChanged }: { agents: WorkflowAgent[]; mcpServers?: McpServer[]; userSkills?: WorkflowLibrarySkill[]; onChanged: () => Promise<unknown> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  const [form, setForm] = useState<WorkflowAgentInput>(emptyAgent);
  const [busy, setBusy] = useState(false);
  // AI 生成的草稿：非空时覆盖表单重置逻辑，让生成结果落进创建表单。
  const [draft, setDraft] = useState<WorkflowAgentInput | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftIntent, setDraftIntent] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  // 生成过程的右侧展示：requestId 匹配本页请求，stage 推进清单，startedAt 用于撰写计时。
  const [draftRequestId, setDraftRequestId] = useState<string | null>(null);
  const [draftStage, setDraftStage] = useState("inventory");
  const [draftStartedAt, setDraftStartedAt] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // 打字机填表：草稿到手后按 名称→能力说明→提示词 顺序限时填入；手动编辑即跳到完整值。
  const [typing, setTyping] = useState<{ target: WorkflowAgentInput; shown: number } | null>(null);
  const locale = useLocale();
  useEffect(() => {
    setForm(draft ?? (selected ? { name: selected.name, description: selected.description, prompt: selected.prompt ?? "", mcpServers: selected.mcpServers ?? [], userSkills: selected.userSkills ?? [] } : emptyAgent));
  }, [selectedId, draft]);

  // 只推进本页发起的生成；SSE 断线时清单停在当前阶段，请求返回仍会正常收尾。
  useEffect(() => {
    if (!draftRequestId) return;
    return onAgentDraftProgress((event) => {
      if (event.requestId === draftRequestId) setDraftStage(event.stage);
    });
  }, [draftRequestId]);

  // 生成期间每秒刷新计时；结束即停。
  useEffect(() => {
    if (!draftBusy) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [draftBusy]);

  // 打字机动画：全程限时约 2.4 秒，步长随总字数放大，长提示词也快进完。
  useEffect(() => {
    if (!typing) return;
    const total = agentDraftTypingTotal(typing.target);
    if (typing.shown >= total) {
      setTyping(null);
      return;
    }
    const step = Math.max(2, Math.ceil(total / 150));
    const timer = window.setTimeout(() => {
      setTyping((current) => current && current.target === typing.target ? { ...current, shown: Math.min(total, current.shown + step) } : current);
    }, 16);
    return () => window.clearTimeout(timer);
  }, [typing]);

  const typed = typing
    ? {
      name: agentDraftTypingValue(typing.target, "name", typing.shown),
      description: agentDraftTypingValue(typing.target, "description", typing.shown),
      prompt: agentDraftTypingValue(typing.target, "prompt", typing.shown),
    }
    : null;

  async function generateDraft() {
    const intent = draftIntent.trim();
    if (!intent || draftBusy) return;
    // 服务器托管的 HTTP 部署没有 crypto.randomUUID，沿用对话轮次那套带兜底的生成器。
    const requestId = createClientTurnId();
    setDraftStage("inventory");
    setDraftStartedAt(Date.now());
    setDraftRequestId(requestId);
    setDraftBusy(true);
    try {
      const agent = await generateWorkflowAgentDraft({ intent, locale, requestId });
      setDraft(agent);
      setSelectedId(null);
      setDraftOpen(false);
      setDraftIntent("");
      setTyping({ target: agent, shown: 0 });
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setDraftBusy(false);
      setDraftRequestId(null);
    }
  }

  async function save() {
    setBusy(true);
    setDraft(null);
    setTyping(null);
    try {
      const saved = selected && !selected.builtIn
        ? await updateWorkflowAgent(selected.id, form)
        : await createWorkflowAgent(form);
      await onChanged();
      setSelectedId(saved.id);
      showAlert(selected ? "Agent 已保存为新版本；已经在跑的研究继续用原来的版本" : "自定义 Agent 已创建", "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(agent: WorkflowAgent) {
    if (!window.confirm(`删除自定义 Agent“${agent.name}”？已经在跑的计划仍保留当时的提示词。`)) return;
    setBusy(true);
    setDraft(null);
    setTyping(null);
    try {
      await deleteWorkflowAgent(agent.id);
      await onChanged();
      setSelectedId(null);
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
    <aside className="min-h-0 overflow-y-auto border-b border-border p-3 lg:border-b-0 lg:border-e">
      <Button className="mb-3 w-full" variant="primary" onClick={() => setSelectedId(null)}><Plus size={15} />新建 Agent</Button>
      <div className="relative mb-3" onKeyDown={(event) => { if (event.key === "Escape" && draftOpen) { event.stopPropagation(); setDraftOpen(false); } }}>
        <Button className="w-full" variant="ghost" aria-expanded={draftOpen} aria-haspopup="dialog" onClick={() => setDraftOpen((value) => !value)}><Sparkles size={15} />AI 帮我建</Button>
        {draftOpen && <div role="dialog" aria-label="AI 建专家" className="absolute top-full start-0 z-50 mt-2 flex flex-col gap-2 rounded-md border border-border bg-background p-3 shadow-dropdown">
          <strong className="text-sm font-normal">用一句话描述这个专家</strong>
          <p className="m-0 text-xs text-subtext">比如：帮我建一个专门做文献计量分析的专家。生成后会填进右侧表单，确认或修改后再保存。</p>
          <textarea className="min-h-20 resize-y rounded-md border border-border bg-background p-2.5 text-sm text-text outline-none focus:border-text" value={draftIntent} placeholder="这个专家要负责什么？" onChange={(event) => setDraftIntent(event.target.value)} />
          <div className="flex items-center justify-between gap-2">
            <Button size="small" variant="ghost" onClick={() => setDraftOpen(false)}>关闭</Button>
            <Button size="small" variant="primary" disabled={!draftIntent.trim() || draftBusy} onClick={() => void generateDraft()}>
              {draftBusy ? <span className="flex items-center gap-2"><Spinner />生成中…</span> : "生成草稿"}
            </Button>
          </div>
        </div>}
      </div>
      <div className="flex flex-col gap-1" aria-label="Agent 资源列表">
        {agents.map((agent) => <button key={agent.id} type="button" aria-pressed={selectedId === agent.id} onClick={() => { setDraft(null); setTyping(null); setSelectedId(agent.id); }} className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-start ${selectedId === agent.id ? "border-primary bg-surface" : "border-transparent hover:bg-surface"}`}>
          <CapabilityTile kind="agent" name={`${agent.name} ${agent.id}`} />
          <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-normal text-text">{agent.name}</strong><span className="block truncate text-xs text-subtext">{agent.id}</span></span>
          {agent.builtIn ? <Badge size="small">内置</Badge> : <Badge size="small">v{agent.version}</Badge>}
        </button>)}
      </div>
    </aside>
    <section className="min-h-0 overflow-y-auto p-5" aria-label="Agent 定义">
      {draftBusy ? <AgentDraftProgress stage={draftStage} startedAt={draftStartedAt} now={nowTick} />
      : selected?.builtIn ? <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-start gap-3">
          <CapabilityTile kind="agent" name={`${selected.name} ${selected.id}`} size="md" />
          <div className="min-w-0"><h2 className="m-0 text-lg font-normal">{selected.name}</h2><p className="mb-0 mt-1 text-sm text-subtext">{selected.id}</p></div>
        </div>
        <p className="m-0 text-sm leading-relaxed text-subtext">这是现有专家团的内置角色，可直接加入工作流。角色配置保持只读；提示词由团队统一调优维护，不对外展示，确保历史计划按原规范执行。</p>
        <section className="flex flex-col gap-1.5 text-sm" aria-label="能力说明">
          <h3 className="m-0 text-sm font-normal">能力说明</h3>
          <p className="m-0 whitespace-pre-wrap break-words leading-relaxed text-text">{selected.description || "暂无能力说明"}</p>
        </section>
        {selected.toolPermissions && <section className="flex flex-col gap-1.5 text-sm" aria-label="工具与执行权限">
          <h3 className="m-0 text-sm font-normal">工具与执行权限</h3>
          <ul className="m-0 flex list-disc flex-col gap-2 ps-8 leading-relaxed text-text">{selected.toolPermissions.map((permission) => <li key={permission}>{permission}</li>)}</ul>
        </section>}
        {selected.skills && <section className="flex flex-col gap-1.5 text-sm" aria-label="内置 Skills">
          <h3 className="m-0 text-sm font-normal">内置 Skills（{selected.skills.length}）<span className="ms-2 text-xs text-subtext">悬浮查看用途说明</span></h3>
          <div className="flex flex-wrap gap-2">{selected.skills.map((skill) => <SkillBadge key={skill.name} skill={skill} />)}</div>
        </section>}
      </div> : <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div><h2 className="m-0 text-lg font-normal">{selected ? `编辑 ${selected.name}` : "创建自定义 Agent"}</h2><p className="mb-0 mt-1 text-sm text-subtext">自定义 Agent 可与内置专家混合编排。保存修改会递增版本，不会改写已批准任务。</p></div>
        <label className="flex flex-col gap-1.5 text-sm">名称<Input value={typed ? typed.name : form.name} maxLength={120} placeholder="例如：论文统计审查员" onChange={(event) => { setTyping(null); setForm({ ...form, name: event.target.value }); }} /></label>
        <label className="flex flex-col gap-1.5 text-sm">能力说明<Input value={typed ? typed.description : form.description} maxLength={2048} placeholder="用于识别该 Agent 的职责和适用范围" onChange={(event) => { setTyping(null); setForm({ ...form, description: event.target.value }); }} /></label>
        <label className="flex flex-col gap-1.5 text-sm">角色提示词<textarea className="min-h-64 resize-y rounded-md border border-border bg-background p-3 text-sm text-text outline-none focus:border-text" value={typed ? typed.prompt : form.prompt} maxLength={24000} placeholder="说明这个专家的职责、怎么使用证据、要输出什么、不能做什么" onChange={(event) => { setTyping(null); setForm({ ...form, prompt: event.target.value }); }} /></label>
        <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-col gap-1.5 text-sm">
          <legend className="p-0">MCP 服务<span className="ms-2 text-xs font-normal text-subtext">该专家工作时可以调用这些服务</span></legend>
          {mcpServers.length === 0 ? <p className="m-0 text-subtext">还没有登记 MCP 服务；可先到 MCP 页添加，或在对话里让 AI 提议。</p> : <div className="flex flex-col gap-1.5">
            {mcpServers.map((server) => <label key={server.id} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={form.mcpServers.includes(server.id)} onChange={(event) => setForm({ ...form, mcpServers: event.target.checked ? [...form.mcpServers, server.id] : form.mcpServers.filter((id) => id !== server.id) })} />
              <span className="min-w-0"><span className="text-text">{server.name}</span>{server.description && <span className="ms-2 text-xs text-subtext">{server.description}</span>}</span>
            </label>)}
          </div>}
        </fieldset>
        <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-col gap-1.5 text-sm">
          <legend className="p-0">使用的技能<span className="ms-2 text-xs font-normal text-subtext">该专家工作时自动携带这些技能；未勾选的技能不生效</span></legend>
          {userSkills.length === 0 ? <p className="m-0 text-subtext">还没有上传技能；可先到 Skills 页上传，或在对话里让 AI 登记。</p> : <div className="flex flex-col gap-1.5">
            {userSkills.map((skill) => <label key={skill.name} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={form.userSkills.includes(skill.name)} onChange={(event) => setForm({ ...form, userSkills: event.target.checked ? [...form.userSkills, skill.name] : form.userSkills.filter((name) => name !== skill.name) })} />
              <span className="min-w-0"><span className="text-text">{skill.name}</span>{skill.description && <span className="ms-2 text-xs text-subtext">{skill.description}</span>}</span>
            </label>)}
          </div>}
        </fieldset>
        <div className="flex items-center justify-between gap-3">
          <div>{selected && !selected.builtIn && <Button variant="danger" disabled={busy} onClick={() => void remove(selected)}><Trash2 size={14} />删除</Button>}</div>
          <Button variant="primary" disabled={busy || !form.name.trim() || !form.prompt.trim()} onClick={() => void save()}>{selected ? "保存新版本" : "创建 Agent"}</Button>
        </div>
      </div>}
    </section>
  </div>;
}
