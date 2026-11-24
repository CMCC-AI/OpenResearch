//! One-shot drafts for whole workflows: the researcher describes the flow in
//! one sentence, a headless harness child writes a workflow name plus a chain
//! of expert tasks (id / role / brief / dependsOn / outputs) as a single JSON
//! object. Only agent tasks in v1 — control nodes (route / foreach / wait)
//! carry dense structural contracts a small model routinely violates, so they
//! stay hand-edited for now. Roles must exist locally; the output is sanitized
//! into an acyclic graph that passes `validate_route_rules`, so the draft can
//! be saved and later submitted without surprises. No cache: every draft
//! starts from what the user just typed.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Deserialize;

use super::draft_support::{
    built_in_picks, clip, custom_agent_picks, generation_agent, staged, DraftStage, Pick,
    GENERATION_TIMEOUT,
};
use super::harness::{OneShot, OneShotQuality, OneShotSink};
use crate::error::{anyhow, Result};
use crate::store::research::{validate_route_rules, TaskSpec};
use crate::store::Store;

/// 生成上限比校验上限（40）紧：小模型任务越多质量越差，超出的直接拒绝。
const MAX_TASKS: usize = 12;
const NAME_CHARS: usize = 120;
const BRIEF_CHARS: usize = 4000;
const OUTPUTS_PER_TASK: usize = 4;
const ID_CHARS: usize = 80;
/// 审查链三角色：提交计划时的祖先约束（validate_plan_with_roles），生成时提前把关。
const ROLE_REVIEWER: &str = "as-independent-reviewer";
const ROLE_AUDITOR: &str = "as-quality-citation-auditor";
const ROLE_CURATOR: &str = "as-research-package-curator";
const REVIEW_CHAIN_ROLES: [&str; 3] = [ROLE_REVIEWER, ROLE_AUDITOR, ROLE_CURATOR];

const SYSTEM_PROMPT: &str = "You design reusable research workflows for MobileSci, an AI for \
Science research workspace. You reply with a single JSON object and nothing else.";

/// 一份生成好的流程：任务已是合法 DAG，可直接进 `WorkflowDraftInput`。
pub struct GeneratedWorkflow {
    pub name: String,
    pub tasks: Vec<TaskSpec>,
}

/// 本机可用专家清单（内置 + 自定义），节点只引用这里的 id。
/// store 访问由调用侧包在 spawn_blocking 里。
pub fn agent_inventory(store: &Store) -> Result<Vec<Pick>> {
    let mut agents = built_in_picks();
    agents.extend(custom_agent_picks(store)?);
    Ok(agents)
}

/// 生成一份可通过结构校验的流程草稿。引擎不可用、模型超时或产出违反硬约束
/// （清单外的专家、空简报、审查链断链）时返回带可读文案的错误。`on_stage`
/// 在推进到真实节点时回调，调用侧借此把进度广播给前端。
pub async fn generate(
    intent: &str,
    locale: &str,
    agents: &[Pick],
    on_stage: impl Fn(DraftStage) + Send + Sync,
    sink: Option<OneShotSink>,
) -> Result<GeneratedWorkflow> {
    let (harness, model) = generation_agent()
        .await
        .ok_or_else(|| anyhow!("没有可用的对话引擎；请先在对话设置里登录一个引擎"))?;
    let raw = staged(&on_stage, || async {
        let request = OneShot {
            system: SYSTEM_PROMPT,
            prompt: &generation_prompt(intent, locale, agents),
            quality: OneShotQuality::Standard,
            model: model.as_deref(),
            timeout: GENERATION_TIMEOUT,
        };
        match &sink {
            Some(sink) => harness.one_shot_streaming(request, sink.clone()).await,
            None => harness.one_shot(request).await,
        }
        .map_err(|e| anyhow!("引擎调用失败：{e}"))
    })
    .await?;
    let (name, tasks) = parse_draft(&raw, agents)?;
    validate_route_rules(&tasks).map_err(|e| anyhow!("{e}"))?;
    Ok(GeneratedWorkflow { name, tasks })
}

fn generation_prompt(intent: &str, locale: &str, agents: &[Pick]) -> String {
    let mut out = format!(
        "Design ONE reusable research workflow of expert tasks for this request:\n{intent}\n\n\
         LANGUAGE — read this first: every piece of text a person will read (the workflow \
         \"name\" and every task \"brief\") MUST be written in the language with IETF tag \
         \"{locale}\" — the same language as the request above. Do not answer them in English \
         just because these instructions are in English. Only \"id\", \"role\", and \"outputs\" \
         stay in ASCII.\n\n\
         Rules:\n\
         - \"name\": a short title for this workflow, at most 30 characters, in the language \
         with IETF tag \"{locale}\" (for example a literature review is \"文献综述流程\").\n\
         - \"tasks\": 3 to 8 expert steps, each {{\"id\",\"role\",\"brief\",\"dependsOn\",\"outputs\"}}.\n\
         - \"id\": short and stable, ASCII letters/digits/underscores/hyphens only (like \"task-1\").\n\
         - \"role\": the expert doing this step, picked ONLY from the role list below.\n\
         - \"brief\": 2-4 sentences in the language with IETF tag \"{locale}\", specific to \
         this request: what the step reads, what it does, what it produces. Generic step \
         descriptions that would fit any workflow are wrong.\n\
         - \"dependsOn\": ids of the tasks whose outputs this step reads; [] when it starts \
         the flow. The graph must stay acyclic; every task should be reachable from a start.\n\
         - \"outputs\": one or two relative file paths starting with the task id, like \
         \"{{id}}/result.md\"; unique across the whole workflow; no leading \"/\", no \"..\".\n\
         - Ordering: discovery and analysis steps come first; synthesis, writing, review, \
         audit, and packaging steps come last.\n\
         - Review chain: \"as-independent-reviewer\" needs at least one prerequisite outside \
         the reviewer/auditor/curator trio; \"as-quality-citation-auditor\" must come after \
         \"as-independent-reviewer\"; \"as-research-package-curator\" must come after \
         \"as-quality-citation-auditor\" (directly or transitively).\n\
         - Reply with a single JSON object with keys \"name\" and \"tasks\", and nothing else.\n\n\
         ## Available agent roles (pick \"role\" only from this list)\n"
    );
    for agent in agents.iter().take(50) {
        out.push_str(&format!(
            "- {} | {} — {}\n",
            agent.key,
            agent.name,
            clip(&agent.description, 160)
        ));
    }
    out
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawWorkflow {
    name: String,
    tasks: Vec<RawTask>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawTask {
    id: String,
    role: String,
    brief: String,
    depends_on: Vec<String>,
    outputs: Vec<String>,
}

/// 模型输出 → 合法 DAG。容忍代码围栏与前后杂文；逐层消毒：
/// 非法 id 改名（引用跟随）、清单外专家与空简报整稿拒绝、产物路径兜底与全局去重、
/// 悬空/自引用依赖丢弃、增量破环，最后按审查链祖先规则把关。
fn parse_draft(raw: &str, agents: &[Pick]) -> Result<(String, Vec<TaskSpec>)> {
    let Some(start) = raw.find('{') else {
        return Err(anyhow!("模型没有返回有效的工作流草稿；请重试或换个说法"));
    };
    let Some(end) = raw.rfind('}') else {
        return Err(anyhow!("模型没有返回有效的工作流草稿；请重试或换个说法"));
    };
    if end <= start {
        return Err(anyhow!("模型没有返回有效的工作流草稿；请重试或换个说法"));
    }
    let raw: RawWorkflow = serde_json::from_str(&raw[start..=end])
        .map_err(|_| anyhow!("模型没有返回有效的工作流草稿；请重试或换个说法"))?;
    let name = clip(raw.name.trim(), NAME_CHARS);
    if name.is_empty() {
        return Err(anyhow!("模型没有给出工作流名称；请重试或换个说法"));
    }
    if raw.tasks.is_empty() {
        return Err(anyhow!("模型没有给出任何任务；请重试或换个说法"));
    }
    if raw.tasks.len() > MAX_TASKS {
        return Err(anyhow!(
            "模型给出了 {} 个任务，超出上限 {MAX_TASKS}；请重试并描述得更聚焦",
            raw.tasks.len()
        ));
    }
    let roles: HashSet<&str> = agents.iter().map(|agent| agent.key.as_str()).collect();

    // 非法 id 字符替换为 '-'，空 id 按序号兜底，撞名加后缀。
    // 依赖引用按原始 id 改写：原始 id → 下标（重复的原始 id 指向首个）。
    let mut ids: Vec<String> = Vec::with_capacity(raw.tasks.len());
    let mut used: HashSet<String> = HashSet::new();
    let mut raw_index_of: HashMap<&str, usize> = HashMap::new();
    for (index, task) in raw.tasks.iter().enumerate() {
        let sanitized: String = task
            .id
            .trim()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let base = clip(sanitized.trim_matches('-'), ID_CHARS);
        let mut id = if base.is_empty() {
            format!("task-{}", index + 1)
        } else {
            base
        };
        let mut suffix = 2;
        let stem = id.clone();
        while !used.insert(id.clone()) {
            id = format!("{stem}-{suffix}");
            suffix += 1;
        }
        ids.push(id);
        raw_index_of.entry(task.id.trim()).or_insert(index);
    }

    let mut tasks: Vec<TaskSpec> = Vec::with_capacity(raw.tasks.len());
    let mut seen_outputs: HashSet<String> = HashSet::new();
    for (index, raw_task) in raw.tasks.iter().enumerate() {
        let id = ids[index].clone();
        let role = raw_task.role.trim();
        if role.is_empty() || !roles.contains(role) {
            return Err(anyhow!(
                "任务「{id}」引用了清单之外的专家「{}」；请重试或换个说法",
                raw_task.role.trim()
            ));
        }
        let brief = clip(raw_task.brief.trim(), BRIEF_CHARS);
        if brief.is_empty() {
            return Err(anyhow!("任务「{id}」缺少工作说明；请重试或换个说法"));
        }
        let mut outputs: Vec<String> = raw_task
            .outputs
            .iter()
            .filter_map(|output| safe_relative(output))
            .map(|output| unique_output(&output, &mut seen_outputs))
            .take(OUTPUTS_PER_TASK)
            .collect();
        if outputs.is_empty() {
            outputs = vec![unique_output(&format!("{id}/result.md"), &mut seen_outputs)];
        }
        tasks.push(TaskSpec {
            id,
            role: role.to_string(),
            brief,
            depends_on: Vec::new(),
            outputs,
            force_rerun: false,
            inputs: Vec::new(),
            requires_approval: false,
            gate_downstream: false,
            max_rework: 0,
            kind: String::new(),
            route: None,
            route_branch: String::new(),
            wait_for: String::new(),
            for_each: None,
            wait_step: None,
        });
    }

    // 依赖改写：优先按原始 id 解析，退而按改名后的 id（模型直接写了规范 id 时），
    // 丢悬空与自引用，去重保序；以下标表示。
    let new_index_of: HashMap<&str, usize> = tasks
        .iter()
        .enumerate()
        .map(|(index, task)| (task.id.as_str(), index))
        .collect();
    let mut deps: Vec<Vec<usize>> = vec![Vec::new(); tasks.len()];
    for (index, raw_task) in raw.tasks.iter().enumerate() {
        for dep in &raw_task.depends_on {
            let dep = dep.trim();
            let Some(&target) = raw_index_of.get(dep).or_else(|| new_index_of.get(dep)) else {
                continue;
            };
            if target != index && !deps[index].contains(&target) {
                deps[index].push(target);
            }
        }
    }
    // 增量破环：按数组顺序接受依赖边，会成环的边直接丢弃，保证产出可校验的 DAG。
    let mut downstream: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); tasks.len()];
    for index in 0..tasks.len() {
        for &target in &deps[index] {
            if reaches(&downstream, index, target) {
                continue;
            }
            downstream[target].insert(index);
            tasks[index].depends_on.push(ids[target].clone());
        }
    }

    check_review_chain(&tasks)?;
    Ok((name, tasks))
}

/// `from` 能否沿 downstream 边到达 `target`（不含空步；自环因此也被拦下）。
fn reaches(downstream: &[BTreeSet<usize>], from: usize, target: usize) -> bool {
    let mut seen = HashSet::new();
    let mut stack = vec![from];
    while let Some(node) = stack.pop() {
        if !seen.insert(node) {
            continue;
        }
        for next in &downstream[node] {
            if *next == target {
                return true;
            }
            stack.push(*next);
        }
    }
    false
}

/// 审查链祖先规则：与提交时的 validate_plan_with_roles 对齐，别把问题留到提交。
fn check_review_chain(tasks: &[TaskSpec]) -> Result<()> {
    let index_of: HashMap<&str, usize> = tasks
        .iter()
        .enumerate()
        .map(|(index, task)| (task.id.as_str(), index))
        .collect();
    let ancestors_of = |index: usize| -> Vec<usize> {
        let mut seen = HashSet::new();
        let mut stack: Vec<usize> = tasks[index]
            .depends_on
            .iter()
            .filter_map(|dep| index_of.get(dep.as_str()).copied())
            .collect();
        while let Some(node) = stack.pop() {
            if !seen.insert(node) {
                continue;
            }
            for dep in &tasks[node].depends_on {
                if let Some(&pos) = index_of.get(dep.as_str()) {
                    stack.push(pos);
                }
            }
        }
        seen.into_iter().collect()
    };
    for (index, task) in tasks.iter().enumerate() {
        let ancestor_roles: Vec<&str> = ancestors_of(index)
            .into_iter()
            .map(|ancestor| tasks[ancestor].role.as_str())
            .collect();
        if task.role == ROLE_REVIEWER
            && !ancestor_roles
                .iter()
                .any(|role| !REVIEW_CHAIN_ROLES.contains(role))
        {
            return Err(anyhow!(
                "任务「{}」（独立审稿）需要有三人组（审稿/审计/归档）之外的前置任务；请重试或手动调整依赖",
                task.id
            ));
        }
        if task.role == ROLE_AUDITOR && !ancestor_roles.contains(&ROLE_REVIEWER) {
            return Err(anyhow!(
                "任务「{}」（引用审计）需要以独立审稿为前置（直接或间接）；请重试或手动调整依赖",
                task.id
            ));
        }
        if task.role == ROLE_CURATOR && !ancestor_roles.contains(&ROLE_AUDITOR) {
            return Err(anyhow!(
                "任务「{}」（研究包归档）需要以引用审计为前置（直接或间接）；请重试或手动调整依赖",
                task.id
            ));
        }
    }
    Ok(())
}

/// 相对路径消毒：空、绝对路径、含 `..`/`\`/`:` 的一律丢弃。
fn safe_relative(path: &str) -> Option<String> {
    let path = path.trim().trim_start_matches('/');
    if path.is_empty() || path.contains("..") || path.contains('\\') || path.contains(':') {
        return None;
    }
    Some(path.to_string())
}

/// 全局产物去重：撞名时在最后一段插入 `-2`/`-3` 后缀。
fn unique_output(path: &str, seen: &mut HashSet<String>) -> String {
    let mut candidate = path.to_string();
    let mut suffix = 2;
    while !seen.insert(candidate.clone()) {
        candidate = match path.rsplit_once('.') {
            Some((stem, ext)) if !stem.rsplit('/').next().unwrap_or(stem).contains('.') => {
                format!("{stem}-{suffix}.{ext}")
            }
            _ => format!("{path}-{suffix}"),
        };
        suffix += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(key: &str) -> Pick {
        Pick {
            key: key.to_string(),
            name: key.to_string(),
            description: String::new(),
        }
    }

    fn agents() -> Vec<Pick> {
        vec![
            agent("as-literature-researcher"),
            agent("as-research-synthesizer"),
            agent("as-independent-reviewer"),
            agent("as-quality-citation-auditor"),
            agent("as-research-package-curator"),
        ]
    }

    #[test]
    fn parse_tolerates_fences_and_prose() {
        let raw = "好的：\n```json\n{\"name\":\" 文献综述流程 \",\"tasks\":[\
                   {\"id\":\"task-1\",\"role\":\"as-literature-researcher\",\"brief\":\" 检索并筛选文献。 \",\
                   \"dependsOn\":[],\"outputs\":[\"task-1/papers.md\"]},\
                   {\"id\":\"task-2\",\"role\":\"as-research-synthesizer\",\"brief\":\" 综合成报告。 \",\
                   \"dependsOn\":[\"task-1\"],\"outputs\":[\"task-2/report.md\"]}]}\n```\n完毕。";
        let (name, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(name, "文献综述流程");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[1].depends_on, vec!["task-1"]);
        assert!(validate_route_rules(&tasks).is_ok());
    }

    #[test]
    fn invalid_ids_are_renamed_and_refs_follow() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"任务 1","role":"as-literature-researcher","brief":"b","outputs":["o1"]},
            {"id":"task-2","role":"as-research-synthesizer","brief":"b","dependsOn":["任务 1"],"outputs":["o2"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        // 中文字符逐个替换成 '-' 后再裁掉首尾横线，得到合法 id "1"；依赖引用跟随改名。
        assert_eq!(tasks[0].id, "1");
        assert_eq!(tasks[1].depends_on, vec!["1"]);
    }

    #[test]
    fn unknown_role_or_empty_brief_rejects_the_draft() {
        let raw =
            r#"{"name":"n","tasks":[{"id":"a","role":"as-ghost","brief":"b","outputs":["o"]}]}"#;
        let error = parse_draft(raw, &agents()).unwrap_err().to_string();
        assert!(error.contains("清单之外的专家"));
        let raw = r#"{"name":"n","tasks":[{"id":"a","role":"as-literature-researcher","brief":"  ","outputs":["o"]}]}"#;
        assert!(parse_draft(raw, &agents()).is_err());
    }

    #[test]
    fn outputs_are_defaulted_sanitized_and_globally_deduped() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"task-1","role":"as-literature-researcher","brief":"b","dependsOn":[],"outputs":["/abs.md","../up.md","a\\b.md","c:d.md","  ","ok.md"]},
            {"id":"task-2","role":"as-research-synthesizer","brief":"b","dependsOn":["task-1"],"outputs":["ok.md"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        // 开头 "/" 被裁掉后是合法相对路径，保留；`..`、`\`、`:` 与空白被丢弃。
        // 因为至少留下了一个产物，不触发兜底。
        assert_eq!(tasks[0].outputs, vec!["abs.md", "ok.md"]);
        // 第二个任务的 "ok.md" 全局撞名，自动加后缀。
        assert_eq!(tasks[1].outputs, vec!["ok-2.md"]);
    }

    #[test]
    fn all_outputs_unsafe_falls_back_to_id_result() {
        // 产物缺失、或全是非法路径时，兜底为 {id}/result.md。
        let raw = r#"{"name":"n","tasks":[
            {"id":"task-1","role":"as-literature-researcher","brief":"b","outputs":["../up.md","c:d.md"]},
            {"id":"task-2","role":"as-research-synthesizer","brief":"b","dependsOn":["task-1"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(tasks[0].outputs, vec!["task-1/result.md"]);
        assert_eq!(tasks[1].outputs, vec!["task-2/result.md"]);
        assert!(validate_route_rules(&tasks).is_ok());
    }

    #[test]
    fn duplicate_ids_get_suffixes() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"step","role":"as-literature-researcher","brief":"b","outputs":["a.md"]},
            {"id":"step","role":"as-research-synthesizer","brief":"b","outputs":["b.md"]},
            {"id":"","role":"as-research-synthesizer","brief":"b","outputs":["c.md"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(
            tasks
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>(),
            vec!["step", "step-2", "task-3"]
        );
    }

    #[test]
    fn too_many_tasks_is_rejected() {
        let tasks: Vec<String> = (0..13)
            .map(|n| {
                format!(
                    r#"{{"id":"t{n}","role":"as-literature-researcher","brief":"b","outputs":["t{n}/o.md"]}}"#
                )
            })
            .collect();
        let raw = format!(r#"{{"name":"n","tasks":[{}]}}"#, tasks.join(","));
        let error = parse_draft(&raw, &agents()).unwrap_err().to_string();
        assert!(error.contains("超出上限"));
    }

    #[test]
    fn dangling_and_self_deps_are_dropped() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"a","role":"as-literature-researcher","brief":"b","dependsOn":["ghost","a"],"outputs":["o-a"]},
            {"id":"b","role":"as-research-synthesizer","brief":"b","dependsOn":["a","a"],"outputs":["o-b"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(tasks[0].depends_on, Vec::<String>::new());
        assert_eq!(tasks[1].depends_on, vec!["a"]);
        assert!(validate_route_rules(&tasks).is_ok());
    }

    #[test]
    fn cycles_are_broken_incrementally() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"a","role":"as-literature-researcher","brief":"b","dependsOn":["b"],"outputs":["o-a"]},
            {"id":"b","role":"as-research-synthesizer","brief":"b","dependsOn":["a"],"outputs":["o-b"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        // 按数组顺序接受边：b 依赖 a 保留，a 依赖 b 成环被丢——仍是合法 DAG。
        let total: usize = tasks.iter().map(|task| task.depends_on.len()).sum();
        assert_eq!(total, 1);
        assert_eq!(tasks[0].depends_on, vec!["b"]);
        assert_eq!(tasks[1].depends_on, Vec::<String>::new());
        assert!(validate_route_rules(&tasks).is_ok());
    }

    #[test]
    fn review_chain_rules_reject_violations() {
        // 审计没有审稿祖先。
        let raw = r#"{"name":"n","tasks":[
            {"id":"a","role":"as-literature-researcher","brief":"b","outputs":["o-a"]},
            {"id":"b","role":"as-quality-citation-auditor","brief":"b","dependsOn":["a"],"outputs":["o-b"]}]}"#;
        let error = parse_draft(raw, &agents()).unwrap_err().to_string();
        assert!(error.contains("独立审稿"));
        // 归档缺审计祖先。
        let raw = r#"{"name":"n","tasks":[
            {"id":"a","role":"as-literature-researcher","brief":"b","outputs":["o-a"]},
            {"id":"b","role":"as-research-package-curator","brief":"b","dependsOn":["a"],"outputs":["o-b"]}]}"#;
        let error = parse_draft(raw, &agents()).unwrap_err().to_string();
        assert!(error.contains("引用审计"));
        // 审稿没有三人组之外的前置。
        let raw = r#"{"name":"n","tasks":[
            {"id":"a","role":"as-independent-reviewer","brief":"b","outputs":["o-a"]}]}"#;
        let error = parse_draft(raw, &agents()).unwrap_err().to_string();
        assert!(error.contains("三人组"));
    }

    #[test]
    fn full_chain_passes_both_layers() {
        let raw = r#"{"name":"综述流水线","tasks":[
            {"id":"search","role":"as-literature-researcher","brief":"检索","dependsOn":[],"outputs":["search/papers.md"]},
            {"id":"synth","role":"as-research-synthesizer","brief":"综合","dependsOn":["search"],"outputs":["synth/themes.md"]},
            {"id":"review","role":"as-independent-reviewer","brief":"审稿","dependsOn":["synth"],"outputs":["review/report.md"]},
            {"id":"audit","role":"as-quality-citation-auditor","brief":"审计","dependsOn":["review"],"outputs":["audit/list.md"]},
            {"id":"package","role":"as-research-package-curator","brief":"归档","dependsOn":["audit"],"outputs":["package/manifest.md"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        assert!(validate_route_rules(&tasks).is_ok());
    }

    #[test]
    fn prompt_contains_intent_locale_roles_and_chain_rules() {
        let prompt = generation_prompt("文献综述流程", "zh-CN", &agents());
        assert!(prompt.contains("文献综述流程"));
        assert!(prompt.contains("zh-CN"));
        assert!(prompt.contains("as-literature-researcher"));
        assert!(prompt.contains("as-independent-reviewer"));
        assert!(prompt.contains("acyclic"));
    }
}
