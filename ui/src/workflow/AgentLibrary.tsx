import { useEffect, useRef, useState } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";
import { createWorkflowAgent, deleteWorkflowAgent, updateWorkflowAgent } from "../api";
import { Badge, Button, Input, showAlert } from "../components/ui";
import type { WorkflowAgent, WorkflowAgentInput, WorkflowAgentSkill } from "./model";

const emptyAgent: WorkflowAgentInput = { name: "", description: "", prompt: "" };

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

export function AgentLibrary({ agents, onChanged }: { agents: WorkflowAgent[]; onChanged: () => Promise<unknown> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  const [form, setForm] = useState<WorkflowAgentInput>(emptyAgent);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm(selected ? { name: selected.name, description: selected.description, prompt: selected.prompt } : emptyAgent);
  }, [selectedId]);

  async function save() {
    setBusy(true);
    try {
      const saved = selected && !selected.builtIn
        ? await updateWorkflowAgent(selected.id, form)
        : await createWorkflowAgent(form);
      await onChanged();
      setSelectedId(saved.id);
      showAlert(selected ? "Agent 已保存为新版本，既有研究仍使用原快照" : "自定义 Agent 已创建", "success");
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(agent: WorkflowAgent) {
    if (!window.confirm(`删除自定义 Agent“${agent.name}”？已登记计划中的提示词快照会保留。`)) return;
    setBusy(true);
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
      <div className="flex flex-col gap-1" aria-label="Agent 资源列表">
        {agents.map((agent) => <button key={agent.id} type="button" aria-pressed={selectedId === agent.id} onClick={() => setSelectedId(agent.id)} className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-start ${selectedId === agent.id ? "border-primary bg-surface" : "border-transparent hover:bg-surface"}`}>
          <Bot size={16} className="shrink-0 text-subtext" />
          <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-normal text-text">{agent.name}</strong><span className="block truncate text-xs text-subtext">{agent.id}</span></span>
          {agent.builtIn ? <Badge size="small">内置</Badge> : <Badge size="small">v{agent.version}</Badge>}
        </button>)}
      </div>
    </aside>
    <section className="min-h-0 overflow-y-auto p-5" aria-label="Agent 定义">
      {selected?.builtIn ? <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div><h2 className="m-0 text-lg font-normal">{selected.name}</h2><p className="mb-0 mt-1 text-sm text-subtext">{selected.id}</p></div>
        <p className="m-0 rounded-md border border-border bg-surface p-4 text-sm text-subtext">这是现有专家团的内置角色，可直接加入工作流。角色定义保持只读，确保旧专家团和历史计划继续按原规范执行。</p>
        <section className="flex flex-col gap-1.5 text-sm" aria-label="能力说明">
          <h3 className="m-0 text-sm font-normal">能力说明</h3>
          <p className="m-0 whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 leading-relaxed text-text">{selected.description || "暂无能力说明"}</p>
        </section>
        {selected.toolPermissions && <section className="flex flex-col gap-1.5 text-sm" aria-label="工具与执行权限">
          <h3 className="m-0 text-sm font-normal">工具与执行权限</h3>
          <ul className="m-0 flex list-disc flex-col gap-2 rounded-md border border-border bg-background p-3 ps-8 leading-relaxed text-text">{selected.toolPermissions.map((permission) => <li key={permission}>{permission}</li>)}</ul>
        </section>}
        {selected.skills && <section className="flex flex-col gap-1.5 text-sm" aria-label="内置 Skills">
          <h3 className="m-0 text-sm font-normal">内置 Skills（{selected.skills.length}）<span className="ms-2 text-xs text-subtext">悬浮查看用途说明</span></h3>
          <div className="flex flex-wrap gap-2 rounded-md border border-border bg-background p-3">{selected.skills.map((skill) => <SkillBadge key={skill.name} skill={skill} />)}</div>
        </section>}
        <section className="flex flex-col gap-1.5 text-sm" aria-label="角色提示词">
          <h3 className="m-0 text-sm font-normal">角色提示词</h3>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-sans leading-relaxed text-text">{selected.prompt}</pre>
        </section>
      </div> : <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div><h2 className="m-0 text-lg font-normal">{selected ? `编辑 ${selected.name}` : "创建自定义 Agent"}</h2><p className="mb-0 mt-1 text-sm text-subtext">自定义 Agent 可与内置专家混合编排。保存修改会递增版本，不会改写已批准任务。</p></div>
        <label className="flex flex-col gap-1.5 text-sm">名称<Input value={form.name} maxLength={120} placeholder="例如：论文统计审查员" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">能力说明<Input value={form.description} maxLength={2048} placeholder="用于识别该 Agent 的职责和适用范围" onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <label className="flex flex-col gap-1.5 text-sm">角色提示词<textarea className="min-h-64 resize-y rounded-md border border-border bg-background p-3 text-sm text-text outline-none focus:border-text" value={form.prompt} maxLength={24000} placeholder="说明角色职责、使用证据的方式、输出契约和禁止事项" onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label>
        <div className="flex items-center justify-between gap-3">
          <div>{selected && !selected.builtIn && <Button variant="danger" disabled={busy} onClick={() => void remove(selected)}><Trash2 size={14} />删除</Button>}</div>
          <Button variant="primary" disabled={busy || !form.name.trim() || !form.prompt.trim()} onClick={() => void save()}>{selected ? "保存新版本" : "创建 Agent"}</Button>
        </div>
      </div>}
    </section>
  </div>;
}
