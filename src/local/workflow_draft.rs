//! One-shot drafts for whole workflows: the researcher describes the flow in
//! one sentence, a headless harness child writes a workflow name plus a DAG of
//! expert tasks and control nodes, and the sanitizer turns that into a draft
//! the editor can save and submit. The model only writes the semantic half —
//! which step repeats per item, where a person must decide, where a run may
//! fail and what the fallback is. The mechanical half (list sidecar, verdict
//! gate, branch markers, input bindings, review gates) is derived here so a
//! small model cannot get the dense contracts wrong. Roles must exist locally;
//! the result passes `validate_route_rules` and the plan validator, so a
//! generated draft never fails at submission. No cache: every draft starts
//! from what the user just typed.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Deserialize;

use super::draft_support::{
    built_in_picks, clip, custom_agent_picks, generation_agent, staged, DraftStage, Pick,
    GENERATION_TIMEOUT,
};
use super::harness::{OneShot, OneShotQuality, OneShotSink};
use crate::error::{anyhow, Result};
use crate::store::research::{
    validate_plan_with_roles, validate_route_rules, ForEachSpec, PlanInput, RouteSpec, TaskSpec,
};
use crate::store::Store;

/// 生成上限比校验上限（40）紧：小模型节点越多质量越差，超出的直接拒绝。
/// 控制节点（人工/逐项/分流）也占名额。
const MAX_TASKS: usize = 14;
/// 自动绑定输入的条数上限：超过就把最靠前的几条留给专家按需自查。
const MAX_INPUTS: usize = 8;
const NAME_CHARS: usize = 120;
const BRIEF_CHARS: usize = 4000;
const OUTPUTS_PER_TASK: usize = 4;
const ID_CHARS: usize = 80;
/// 审查链三角色：提交计划时的祖先约束（validate_plan_with_roles），生成时提前把关。
const ROLE_REVIEWER: &str = "as-independent-reviewer";
const ROLE_AUDITOR: &str = "as-quality-citation-auditor";
const ROLE_CURATOR: &str = "as-research-package-curator";
/// 实验执行任务不支持结论把关：分流只能改用「上游失败」谓词。
const ROLE_EXPERIMENT_OPERATOR: &str = "as-experiment-operator";
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
    Ok(GeneratedWorkflow { name, tasks })
}

fn generation_prompt(intent: &str, locale: &str, agents: &[Pick]) -> String {
    let mut out = format!(
        "Design ONE reusable research workflow of expert tasks for this request:\n{intent}\n\n\
         LANGUAGE — read this first: every piece of text a person will read (the workflow \
         \"name\" and every task \"brief\", control nodes included) MUST be written in the \
         language with IETF tag \"{locale}\" — the same language as the request above. Do not \
         answer them in English just because these instructions are in English. Only \"id\", \
         \"role\", \"kind\", \"branch\", \"reads\" and \"outputs\" stay in ASCII.\n\n\
         Rules:\n\
         - \"name\": a short title for this workflow, at most 30 characters, in the language \
         with IETF tag \"{locale}\" (for example a literature review is \"文献综述流程\").\n\
         - \"tasks\": 3 to 10 expert steps plus the control nodes described below; at most 14 \
         nodes in total. Prefer the smallest structure that covers the real risks.\n\
         - \"id\": short and stable, ASCII letters/digits/underscores/hyphens only (like \"task-1\").\n\
         - \"role\": the expert doing this step, picked ONLY from the role list below. Control \
         nodes have no role.\n\
         - \"brief\": 2-4 sentences in the language with IETF tag \"{locale}\", specific to \
         this request: what the step reads, what it does, what it produces. Generic step \
         descriptions that would fit any workflow are wrong. For a human task the brief is \
         what the researcher sees, so write it as an instruction.\n\
         - \"dependsOn\": ids of the tasks that must finish before this step (ordering); [] when \
         it starts the flow. The graph must stay acyclic; every task should be reachable from a \
         start.\n\
         - \"reads\": the exact upstream output paths this step directly reads, copied from the \
         producing task's \"outputs\" (for example \"task-1/papers.md\"); [] when it reads no \
         upstream file. List every file the brief names, even when the producer is already an \
         ancestor — only direct prerequisites can be bound as inputs. The runtime adds each \
         producer to \"dependsOn\" automatically.\n\
         - \"outputs\": one or two relative file paths starting with the task id, like \
         \"{{id}}/result.md\"; unique across the whole workflow; no leading \"/\", no \"..\".\n\
         - Do NOT write \"inputs\": they are derived from \"reads\" and the direct prerequisites.\n\
         - Ordering: discovery and analysis steps come first; synthesis, writing, review, \
         audit, and packaging steps come last.\n\
         - Review chain: \"as-independent-reviewer\" needs at least one prerequisite outside \
         the reviewer/auditor/curator trio; \"as-quality-citation-auditor\" must come after \
         \"as-independent-reviewer\"; \"as-research-package-curator\" must come after \
         \"as-quality-citation-auditor\" (directly or transitively).\n\n\
         CONTROL NODES — use one only when the pattern clearly applies:\n\
         - A step reads a list of 5-20 similar items and repeats the same work per item (for \
         example reading every shortlisted paper): emit ONE node with \"kind\":\"foreach\" \
         instead of one expert reading them all. No \"role\", no \"outputs\", but a short \
         \"brief\" as the node name. Add \
         \"forEach\":{{\"source\":\"<the list artifact, an output of the direct prerequisite>\",\
         \"itemBrief\":\"2-4 sentences with {{item}} for the current item\",\
         \"itemOutput\":\"<id>/{{item}}.md\"}}. The runtime asks the upstream task to write the \
         \"<source>.items.json\" list automatically. At most one such node.\n\
         - A decision only the researcher can make (which papers to reproduce, which scheme to \
         adopt) and the rest of the flow depends on it: emit \"kind\":\"human\" with no \
         \"role\", a short \"brief\" and exactly one \"outputs\" path. Put it right BEFORE the \
         expensive or irreversible work it governs, never at the end. At most two.\n\
         - A step may fail and the flow has a meaningful fallback (a failed reproduction is \
         still reported): emit \"kind\":\"route\" with no \"role\"/\"outputs\", a short \
         \"brief\", and \
         \"route\":{{\"source\":\"<an output of the direct prerequisite>\",\"verdictIs\":\"pass\"}}. \
         Give it exactly two downstream tasks, one with \"branch\":\"then\" and one with \
         \"branch\":\"else\"; both branches must lead onward and may merge into a later task \
         that lists both in \"dependsOn\". The runtime enables the verdict gate on the source \
         task automatically. At most two.\n\
         - \"approve\":true on an expert task adds a short confirmation checkpoint after it. \
         Prefer it over a human task when nobody has to produce content, only to approve.\n\
         - Do not add control nodes the request does not need; no empty forks.\n\
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
    /// 这一步直接读取的上游产物路径（从上游任务的 outputs 原样复制）。
    /// 产出它的任务会被自动补成直接前置：只有直接前置的产物才能绑定为任务输入。
    reads: Vec<String>,
    outputs: Vec<String>,
    /// 空或 "agent" 为专家任务；"human" / "foreach" / "route" 为控制节点。
    kind: String,
    /// 分流节点的子任务标记："then" 或 "else"。
    branch: String,
    /// 专家任务完成后停一次等主理人确认。
    approve: bool,
    for_each: Option<RawForEach>,
    route: Option<RawRoute>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawForEach {
    source: String,
    item_output: String,
    item_brief: String,
    on_failure: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawRoute {
    source: String,
    verdict_is: String,
}

/// 模型输出 → 合法 DAG。容忍代码围栏与前后杂文；逐层消毒：
/// 非法 id 改名（引用跟随）、清单外专家与空简报整稿拒绝、产物路径兜底与全局去重、
/// 悬空/自引用依赖丢弃、增量破环，最后按审查链祖先规则把关。
fn parse_draft(raw: &str, agents: &[Pick]) -> Result<(String, Vec<TaskSpec>)> {
    // 只认第一段能反序列化的完整对象：模型偶尔把整份草稿输出两遍，或先说一段
    // 不完整的草稿再重来。取“首尾花括号”会把两段 JSON 拼在一起而解析失败。
    let Some(raw) = parse_first_workflow(raw) else {
        return Err(anyhow!("模型没有返回有效的工作流草稿；请重试或换个说法"));
    };
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
        let brief = clip(raw_task.brief.trim(), BRIEF_CHARS);
        let kind = raw_task.kind.trim().to_ascii_lowercase();
        let mut spec = TaskSpec {
            id: id.clone(),
            role: String::new(),
            brief: brief.clone(),
            depends_on: Vec::new(),
            outputs: Vec::new(),
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
        };
        match kind.as_str() {
            "" | "agent" => {
                if brief.is_empty() {
                    return Err(anyhow!("任务「{id}」缺少工作说明；请重试或换个说法"));
                }
                let role = raw_task.role.trim();
                if role.is_empty() || !roles.contains(role) {
                    return Err(anyhow!(
                        "任务「{id}」引用了清单之外的专家「{}」；请重试或换个说法",
                        raw_task.role.trim()
                    ));
                }
                spec.role = role.to_string();
                spec.outputs = raw_task
                    .outputs
                    .iter()
                    .filter_map(|output| safe_relative(output))
                    .map(|output| unique_output(&output, &mut seen_outputs))
                    .take(OUTPUTS_PER_TASK)
                    .collect();
                if spec.outputs.is_empty() {
                    spec.outputs =
                        vec![unique_output(&format!("{id}/result.md"), &mut seen_outputs)];
                }
                spec.requires_approval = raw_task.approve;
            }
            "human" => {
                // 人工任务由主理人亲自完成：提交即产出，不选专家、不叠加确认。
                if brief.is_empty() {
                    return Err(anyhow!(
                        "人工任务「{id}」缺少给主理人的说明；请重试或换个说法"
                    ));
                }
                spec.kind = "human".into();
                let output = raw_task
                    .outputs
                    .iter()
                    .filter_map(|output| safe_relative(output))
                    .next()
                    .map(|output| unique_output(&output, &mut seen_outputs))
                    .unwrap_or_else(|| {
                        unique_output(&format!("{id}/decision.md"), &mut seen_outputs)
                    });
                spec.outputs = vec![output];
            }
            "foreach" => {
                // 逐项任务不选专家、不声明产物：清单来源与产物模板由系统补齐。
                // 节点名（brief）模型常只写逐项简报，缺省用固定名，画布上仍可辨认。
                spec.kind = "foreach".into();
                if spec.brief.is_empty() {
                    spec.brief = "逐项处理".into();
                }
                let raw_for_each = raw_task.for_each.clone().unwrap_or_default();
                let item_brief = clip(raw_for_each.item_brief.trim(), BRIEF_CHARS);
                let item_brief = if item_brief.is_empty() {
                    if brief.is_empty() {
                        "完成本项：{item}".to_string()
                    } else {
                        format!("{brief}（本次处理：{{item}}）")
                    }
                } else {
                    item_brief
                };
                let item_output = safe_relative(&raw_for_each.item_output)
                    .filter(|path| path.contains("{item}"))
                    .unwrap_or_else(|| format!("{id}/{{item}}.md"));
                spec.for_each = Some(ForEachSpec {
                    source: String::new(),
                    item_output,
                    item_brief,
                    on_failure: if raw_for_each.on_failure.trim() == "skip" {
                        "skip".into()
                    } else {
                        "pause".into()
                    },
                });
            }
            "route" => {
                // 分流节点不选专家、不产出文件：条件来源与把关由系统补齐。
                spec.kind = "route".into();
                if spec.brief.is_empty() {
                    spec.brief = "条件分流".into();
                }
                let raw_route = raw_task.route.clone().unwrap_or_default();
                let verdict_is = match raw_route.verdict_is.trim() {
                    "blocked" => "blocked",
                    _ => "pass",
                };
                spec.route = Some(RouteSpec {
                    on: "verdict".into(),
                    source: String::new(),
                    verdict_is: verdict_is.into(),
                    default_branch: "else".into(),
                });
            }
            other => {
                return Err(anyhow!(
                    "任务「{id}」用了暂不支持自动生成的节点类型「{other}」；复现实验和事件等待请在画布上手动添加"
                ));
            }
        }
        tasks.push(spec);
    }

    // 控制节点的清单/结论来源若指向某个任务的产物，就把产出它的任务补成直接前置。
    // 专家任务的 reads 同理：说明里点名要读的文件，产出它的任务必须是直接前置，
    // 否则运行时不会把文件绑定成输入（间接祖先只保证顺序，不转交文件）。
    let owner_of_output: HashMap<String, usize> = tasks
        .iter()
        .enumerate()
        .flat_map(|(index, task)| {
            task.outputs
                .iter()
                .map(move |output| (output.clone(), index))
        })
        .collect();
    let source_owner: Vec<Option<usize>> = raw
        .tasks
        .iter()
        .map(|raw_task| {
            let source = match raw_task.kind.trim().to_ascii_lowercase().as_str() {
                "foreach" => raw_task
                    .for_each
                    .as_ref()
                    .map(|spec| spec.source.trim())
                    .unwrap_or(""),
                "route" => raw_task
                    .route
                    .as_ref()
                    .map(|spec| spec.source.trim())
                    .unwrap_or(""),
                _ => "",
            };
            if source.is_empty() {
                None
            } else {
                owner_of_output.get(source).copied()
            }
        })
        .collect();

    // 依赖改写：优先按原始 id 解析，退而按改名后的 id（模型直接写了规范 id 时），
    // 丢悬空与自引用，去重保序；以下标表示。
    let new_index_of: HashMap<&str, usize> = tasks
        .iter()
        .enumerate()
        .map(|(index, task)| (task.id.as_str(), index))
        .collect();
    // reads 里的路径先精确匹配产物，再按唯一文件名兜底；模型误写任务 id 时读该任务的全部产物。
    let read_owners: Vec<Vec<usize>> = raw
        .tasks
        .iter()
        .enumerate()
        .map(|(index, raw_task)| {
            let mut owners = Vec::new();
            for read in &raw_task.reads {
                let read = read.trim();
                if read.is_empty() {
                    continue;
                }
                let basename_owner = || {
                    let base = read.rsplit('/').next().unwrap_or(read);
                    let mut found = None;
                    let mut count = 0usize;
                    for (candidate, task) in tasks.iter().enumerate() {
                        if task
                            .outputs
                            .iter()
                            .any(|output| output.rsplit('/').next() == Some(base))
                        {
                            found = Some(candidate);
                            count += 1;
                        }
                    }
                    if count == 1 {
                        found
                    } else {
                        None
                    }
                };
                let owner = owner_of_output
                    .get(read)
                    .copied()
                    .or_else(basename_owner)
                    .or_else(|| new_index_of.get(read).copied());
                if let Some(owner) = owner {
                    if owner != index && !owners.contains(&owner) {
                        owners.push(owner);
                    }
                }
            }
            owners
        })
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
        // 清单/结论来源不在前置里时补上，随后统一破环。
        if let Some(owner) = source_owner[index] {
            if owner != index && !deps[index].contains(&owner) {
                deps[index].push(owner);
            }
        }
        // 直接读取的产物，其生产者必须进前置，否则输入绑定不到。
        for &owner in &read_owners[index] {
            if owner != index && !deps[index].contains(&owner) {
                deps[index].push(owner);
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

    // 补齐控制节点的来源：显式指定的优先，否则取第一个产出了文件的直接前置。
    // 分流的结论来源必须是专家任务，才能读它旁边的 verdict 文件。
    let mut failure_route_ids: HashSet<String> = HashSet::new();
    for index in 0..tasks.len() {
        let is_foreach = tasks[index].kind == "foreach";
        let is_route = tasks[index].kind == "route";
        if !is_foreach && !is_route {
            continue;
        }
        let requested = if is_foreach {
            raw.tasks[index]
                .for_each
                .as_ref()
                .map(|spec| spec.source.trim())
                .unwrap_or("")
        } else {
            raw.tasks[index]
                .route
                .as_ref()
                .map(|spec| spec.source.trim())
                .unwrap_or("")
        };
        let Some(source) = resolve_control_source(&tasks, index, requested, is_route) else {
            return Err(anyhow!(
                "节点「{}」缺少可用的来源：从产出清单或结论的上游连一条线进来；请重试或手动调整",
                tasks[index].id
            ));
        };
        if is_foreach {
            if let Some(spec) = tasks[index].for_each.as_mut() {
                spec.source = source;
            }
        } else {
            let owner = tasks
                .iter()
                .position(|task| task.outputs.iter().any(|output| output == &source));
            let owner_is_experiment =
                owner.is_some_and(|owner| tasks[owner].role == ROLE_EXPERIMENT_OPERATOR);
            let route_id = tasks[index].id.clone();
            if let Some(spec) = tasks[index].route.as_mut() {
                if owner_is_experiment {
                    // 实验执行任务不支持结论把关；“跑成功/跑失败”本身就是可判定的谓词。
                    spec.on = "failure".into();
                    spec.source.clear();
                    spec.verdict_is.clear();
                    failure_route_ids.insert(route_id);
                } else {
                    spec.source = source.clone();
                }
            }
            if !owner_is_experiment {
                if let Some(owner) = owner {
                    tasks[owner].gate_downstream = true;
                }
            }
        }
    }

    // 分支标记：挂在哪个分流节点下就记哪个；只有一个标记时按另一侧补齐。
    for index in 0..tasks.len() {
        // 分流节点自身不挂分支；模型偶尔会把标记写错位置，忽略即可。
        if tasks[index].kind == "route" {
            continue;
        }
        let branch = raw.tasks[index].branch.trim();
        if branch.is_empty() {
            continue;
        }
        if branch != "then" && branch != "else" {
            return Err(anyhow!(
                "任务「{}」的分支标记无效：{branch}",
                tasks[index].id
            ));
        }
        let routes: Vec<usize> = tasks[index]
            .depends_on
            .iter()
            .filter_map(|dep| {
                tasks
                    .iter()
                    .position(|task| &task.id == dep && task.kind == "route")
            })
            .collect();
        match routes.len() {
            1 => tasks[index].route_branch = branch.to_string(),
            0 => {
                return Err(anyhow!(
                    "任务「{}」标记了分支，但前置里没有分流节点；请重试或手动调整",
                    tasks[index].id
                ))
            }
            _ => {
                return Err(anyhow!(
                    "任务「{}」同时挂在多个分流节点下，无法判断分支；请重试或手动调整",
                    tasks[index].id
                ))
            }
        }
    }
    let route_children: Vec<Vec<usize>> = tasks
        .iter()
        .filter(|task| task.kind == "route")
        .map(|route| {
            tasks
                .iter()
                .enumerate()
                .filter(|(_, child)| child.depends_on.iter().any(|dep| dep == &route.id))
                .map(|(index, _)| index)
                .collect()
        })
        .collect();
    for children in route_children {
        if children.len() != 2 {
            continue;
        }
        let first = tasks[children[0]].route_branch.clone();
        let second = tasks[children[1]].route_branch.clone();
        match (first.as_str(), second.as_str()) {
            ("then", "") => tasks[children[1]].route_branch = "else".into(),
            ("else", "") => tasks[children[1]].route_branch = "then".into(),
            ("", "then") => tasks[children[0]].route_branch = "else".into(),
            ("", "else") => tasks[children[0]].route_branch = "then".into(),
            _ => {}
        }
    }

    // 「上游失败」谓词的成立分支是失败路径：把模型按「结论=通过」写的 then/else 对调，
    // 成功分支仍走成功、失败分支仍走失败。
    let mut swap_branches: Vec<usize> = Vec::new();
    for task in &tasks {
        if !failure_route_ids.contains(&task.id) {
            continue;
        }
        swap_branches.extend(
            tasks
                .iter()
                .enumerate()
                .filter(|(_, child)| child.depends_on.contains(&task.id))
                .map(|(child_index, _)| child_index),
        );
    }
    swap_branches.sort_unstable();
    swap_branches.dedup();
    for index in swap_branches {
        tasks[index].route_branch = match tasks[index].route_branch.as_str() {
            "then" => "else".into(),
            "else" => "then".into(),
            _ => String::new(),
        };
    }

    // 分支任务还要直接连回分流节点的前置：分支里要读的运行结果/证据只有作为
    // 直接前置才能绑定输入，否则只剩一个不产出文件的分流节点可连。
    for index in 0..tasks.len() {
        if tasks[index].route_branch.is_empty() {
            continue;
        }
        let route_deps: Vec<String> = tasks[index]
            .depends_on
            .iter()
            .filter_map(|dep| {
                tasks
                    .iter()
                    .find(|task| &task.id == dep && task.kind == "route")
            })
            .flat_map(|route| route.depends_on.clone())
            .collect();
        for dep in route_deps {
            if dep != tasks[index].id && !tasks[index].depends_on.contains(&dep) {
                tasks[index].depends_on.push(dep);
            }
        }
    }

    // 输入绑定由系统补齐：直接前置产出的文件全部登记，派发时注入并核对哈希。
    // 控制节点保持 inputs 为空（分流/逐项由自身契约携带来源）。
    let dep_outputs: HashMap<String, Vec<String>> = tasks
        .iter()
        .map(|task| (task.id.clone(), task.outputs.clone()))
        .collect();
    for task in &mut tasks {
        if !matches!(task.kind.as_str(), "" | "agent") {
            continue;
        }
        let mut inputs: Vec<String> = Vec::new();
        for dep in &task.depends_on {
            for output in dep_outputs.get(dep).into_iter().flatten() {
                if !inputs.iter().any(|existing| existing == output) {
                    inputs.push(output.clone());
                }
            }
        }
        inputs.truncate(MAX_INPUTS);
        task.inputs = inputs;
    }

    // 审查链沿用内置文献综述模板的控制：审稿阻塞自动返工上游（最多 2 轮），
    // 审计阻塞暂停下游交给主理人。生成稿不再出现“审出问题却没人改”。
    for task in &mut tasks {
        if !matches!(task.kind.as_str(), "" | "agent")
            || task.depends_on.is_empty()
            || task.outputs.is_empty()
        {
            continue;
        }
        match task.role.as_str() {
            ROLE_REVIEWER => {
                task.gate_downstream = true;
                task.max_rework = 2;
            }
            ROLE_AUDITOR => task.gate_downstream = true,
            _ => {}
        }
    }

    check_review_chain(&tasks)?;
    validate_route_rules(&tasks).map_err(|e| anyhow!("生成的流程还不能直接使用：{e}"))?;
    let plan = PlanInput {
        workflow: None,
        summary: "AI 生成的流程草稿".into(),
        tasks: tasks.clone(),
    };
    // 与“在对话中使用”走同一条提交路径：保存成方法后由主理人显式选用，
    // 因此按 explicit_method 校验（自定义编排不强制三人审查链）。
    validate_plan_with_roles(&plan, "team", true, |role| {
        if roles.contains(role) {
            Ok(())
        } else {
            Err(anyhow!("清单之外的专家：{role}"))
        }
    })
    .map_err(|e| anyhow!("生成的流程还不能直接使用：{e}"))?;
    Ok((name, tasks))
}

/// 控制节点的来源解析：显式指定的产物必须来自直接前置；否则取第一个有产物的前置。
/// `agent_only` 用于分流——结论文件只能由专家任务产出。
fn resolve_control_source(
    tasks: &[TaskSpec],
    index: usize,
    requested: &str,
    agent_only: bool,
) -> Option<String> {
    let candidate = |task: &TaskSpec| {
        !task.outputs.is_empty() && (!agent_only || matches!(task.kind.as_str(), "" | "agent"))
    };
    if !requested.is_empty() {
        let owned_by_dependency = tasks[index].depends_on.iter().any(|dep| {
            tasks.iter().any(|task| {
                &task.id == dep
                    && candidate(task)
                    && task.outputs.iter().any(|output| output == requested)
            })
        });
        if owned_by_dependency {
            return Some(requested.to_string());
        }
    }
    tasks[index].depends_on.iter().find_map(|dep| {
        tasks
            .iter()
            .find(|task| &task.id == dep && candidate(task))
            .map(|task| task.outputs[0].clone())
    })
}

/// 依次尝试文本里的完整花括号对象，返回第一份有名字、有任务的草稿。
/// 从每个 `{` 起点重试，前半段被截断或只是一份空壳时也能落到后一份完整草稿。
fn parse_first_workflow(text: &str) -> Option<RawWorkflow> {
    let mut offset = 0;
    while let Some(relative) = text[offset..].find('{') {
        let start = offset + relative;
        offset = start + 1;
        let Some(object) = first_json_object(&text[start..]) else {
            continue;
        };
        let Ok(workflow) = serde_json::from_str::<RawWorkflow>(object) else {
            continue;
        };
        if !workflow.name.trim().is_empty() && !workflow.tasks.is_empty() {
            return Some(workflow);
        }
    }
    None
}

/// 取第一段花括号配平的 JSON 对象，忽略其后的重复对象或说明文字。
fn first_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(&text[start..start + offset + ch.len_utf8()]);
                }
            }
            _ => {}
        }
    }
    None
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
            agent("as-experiment-operator"),
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
    fn reads_add_the_producing_task_as_a_direct_prerequisite() {
        // 说明里点名要读某个祖先的产物时，只连顺序前置是不够的：
        // 运行时只把直接前置的产物绑定成输入，所以生产者必须补成直接前置。
        let raw = r#"{"name":"n","tasks":[
            {"id":"scan","role":"as-literature-researcher","brief":"检索","outputs":["scan/papers.md"]},
            {"id":"read","role":"as-research-synthesizer","brief":"深读","dependsOn":["scan"],"outputs":["read/cards.md"]},
            {"id":"run","role":"as-experiment-operator","brief":"复现","dependsOn":["read"],"outputs":["run/log.md"]},
            {"id":"write","role":"as-research-synthesizer","brief":"写作","dependsOn":["run"],
             "reads":["read/cards.md","run/log.md"],"outputs":["write/slides.md"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        let write = tasks.iter().find(|task| task.id == "write").unwrap();
        assert!(write.depends_on.contains(&"read".to_string()));
        assert!(write.depends_on.contains(&"run".to_string()));
        // 输入由直接前置的产物补齐：证据卡和运行日志都能绑定。
        assert!(write.inputs.contains(&"read/cards.md".to_string()));
        assert!(write.inputs.contains(&"run/log.md".to_string()));
    }

    #[test]
    fn reads_resolve_a_unique_output_basename() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"scan","role":"as-literature-researcher","brief":"检索","outputs":["scan/papers.md"]},
            {"id":"read","role":"as-research-synthesizer","brief":"深读","dependsOn":["scan"],"outputs":["read/cards.md"]},
            {"id":"write","role":"as-research-synthesizer","brief":"写作","dependsOn":["read"],"reads":["cards.md"],"outputs":["write/slides.md"]}]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        let write = tasks.iter().find(|task| task.id == "write").unwrap();
        assert!(write.depends_on.contains(&"read".to_string()));
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
        let tasks: Vec<String> = (0..15)
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
        assert!(prompt.contains("foreach"));
        assert!(prompt.contains("kind"));
        assert!(prompt.contains("\"reads\""));
    }

    /// 一张包含逐项、人工、分流和审查链的生成稿：机械契约（来源、模板、分支标记、
    /// 把关、输入绑定）都应该由代码补齐，模型只写语义。
    fn control_fixture() -> &'static str {
        r#"{"name":"复现流程","tasks":[
            {"id":"scan","role":"as-literature-researcher","brief":"梳理候选论文","outputs":["scan/papers.md"]},
            {"id":"read","kind":"foreach","brief":"逐篇精读","dependsOn":["scan"],
             "forEach":{"source":"scan/papers.md","itemBrief":"精读 {item} 并写证据卡","itemOutput":"read/{item}.md"}},
            {"id":"pick","kind":"human","brief":"挑选要复现的 1-3 篇","dependsOn":["read"]},
            {"id":"run","role":"as-research-synthesizer","brief":"执行复现","dependsOn":["pick"],"outputs":["run/result.md"],"approve":true},
            {"id":"fork","kind":"route","brief":"复现结果分流","dependsOn":["run"],"route":{"verdictIs":"pass"}},
            {"id":"ok","role":"as-research-synthesizer","brief":"结果对比","dependsOn":["fork"],"branch":"then","outputs":["ok/report.md"]},
            {"id":"fail","role":"as-research-synthesizer","brief":"失败分析","dependsOn":["fork"],"outputs":["fail/analysis.md"]},
            {"id":"review","role":"as-independent-reviewer","brief":"审稿","dependsOn":["ok","fail"],"outputs":["review/report.md"]},
            {"id":"audit","role":"as-quality-citation-auditor","brief":"审计","dependsOn":["review"],"outputs":["audit/report.md"]},
            {"id":"package","role":"as-research-package-curator","brief":"归档","dependsOn":["audit"],"outputs":["package/manifest.md"]}
        ]}"#
    }

    #[test]
    fn control_nodes_are_synthesized_and_hardened() {
        let (_, tasks) = parse_draft(control_fixture(), &agents()).unwrap();
        let task = |id: &str| tasks.iter().find(|task| task.id == id).unwrap();

        // 逐项：不选专家、不声明产物；来源与模板落位。
        let read = task("read");
        assert_eq!(read.kind, "foreach");
        assert!(read.role.is_empty());
        assert!(read.outputs.is_empty());
        let for_each = read.for_each.as_ref().unwrap();
        assert_eq!(for_each.source, "scan/papers.md");
        assert_eq!(for_each.item_output, "read/{item}.md");
        assert_eq!(for_each.item_brief, "精读 {item} 并写证据卡");

        // 人工：缺省产物路径；不选专家。
        let pick = task("pick");
        assert_eq!(pick.kind, "human");
        assert!(pick.role.is_empty());
        assert_eq!(pick.outputs, vec!["pick/decision.md"]);

        // 专家任务上的 approve 变成 G5 检查点。
        assert!(task("run").requires_approval);

        // 分流：来源缺省取前置首个产物，并自动给来源任务开结论把关。
        let fork = task("fork");
        assert_eq!(fork.kind, "route");
        assert_eq!(fork.route.as_ref().unwrap().source, "run/result.md");
        assert_eq!(fork.route.as_ref().unwrap().default_branch, "else");
        assert!(task("run").gate_downstream);

        // 分支标记缺一个时按另一侧补齐；分支任务直接连回分流的前置。
        assert_eq!(task("ok").route_branch, "then");
        assert_eq!(task("fail").route_branch, "else");
        assert_eq!(task("ok").depends_on, vec!["fork", "run"]);
        assert_eq!(task("fail").depends_on, vec!["fork", "run"]);

        // 审查链控制与内置文献综述模板一致。
        assert!(task("review").gate_downstream);
        assert_eq!(task("review").max_rework, 2);
        assert!(task("audit").gate_downstream);

        // 输入绑定：专家任务绑定直接前置产物；控制节点不绑定。
        assert!(task("scan").inputs.is_empty());
        assert!(read.inputs.is_empty());
        assert!(pick.inputs.is_empty());
        assert_eq!(task("run").inputs, vec!["pick/decision.md"]);
        assert!(fork.inputs.is_empty());
        assert_eq!(task("ok").inputs, vec!["run/result.md"]);
        assert_eq!(
            task("review").inputs,
            vec!["ok/report.md", "fail/analysis.md"]
        );
        assert_eq!(task("package").inputs, vec!["audit/report.md"]);

        // 整份草稿能直接提交。
        assert!(validate_route_rules(&tasks).is_ok());
    }

    #[test]
    fn route_with_one_branch_is_rejected() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"run","role":"as-research-synthesizer","brief":"跑","outputs":["run/result.md"]},
            {"id":"fork","kind":"route","brief":"分流","dependsOn":["run"],"route":{"verdictIs":"pass"}},
            {"id":"ok","role":"as-research-synthesizer","brief":"成功","dependsOn":["fork"],"branch":"then","outputs":["ok/report.md"]}
        ]}"#;
        let error = parse_draft(raw, &agents()).unwrap_err().to_string();
        assert!(error.contains("两条分支"), "{error}");
    }

    #[test]
    fn unsupported_control_kind_is_rejected_with_guidance() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"run","kind":"experiment","brief":"跑实验","outputs":["run/result.md"]}
        ]}"#;
        let error = parse_draft(raw, &agents()).unwrap_err().to_string();
        assert!(error.contains("暂不支持自动生成"));
        assert!(error.contains("手动添加"));
    }

    #[test]
    fn a_route_on_an_experiment_step_uses_the_failure_predicate_instead() {
        // 实机生成时模型把复现执行者（as-experiment-operator）当作结论来源；
        // 该角色不支持结论把关，系统改用「上游失败」并把分支对调。
        let raw = r#"{"name":"n","tasks":[
            {"id":"run","role":"as-experiment-operator","brief":"跑复现","outputs":["run/report.md"]},
            {"id":"fork","kind":"route","brief":"复现结果分流","dependsOn":["run"],
             "route":{"source":"run/report.md","verdictIs":"pass"}},
            {"id":"ok","role":"as-research-synthesizer","brief":"成功对照","dependsOn":["fork"],"branch":"then","outputs":["ok/report.md"]},
            {"id":"gap","role":"as-research-synthesizer","brief":"失败差距","dependsOn":["fork"],"branch":"else","outputs":["gap/report.md"]}
        ]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        let task = |id: &str| tasks.iter().find(|task| task.id == id).unwrap();
        let route = task("fork").route.as_ref().unwrap();
        assert_eq!(route.on, "failure");
        assert!(route.source.is_empty());
        assert!(route.verdict_is.is_empty());
        assert!(!task("run").gate_downstream);
        // then = 上游失败，所以原来的成功分支改走 else。
        assert_eq!(task("ok").route_branch, "else");
        assert_eq!(task("gap").route_branch, "then");
        assert!(validate_route_rules(&tasks).is_ok());
    }

    #[test]
    fn duplicate_json_takes_the_first_complete_object() {
        // 实机生成时模型把整份草稿输出过两遍；取首尾花括号会拼成非法 JSON。
        let raw = "```json\n{\"name\":\"n\",\"tasks\":[{\"id\":\"a\",\"role\":\"as-literature-researcher\",\"brief\":\"b\",\"outputs\":[\"o-a\"]}]}\n```\n说明\n```json\n{\"name\":\"重复\",\"tasks\":[]}\n```";
        let (name, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(name, "n");
        assert_eq!(tasks.len(), 1);
    }

    #[test]
    fn first_json_object_ignores_braces_inside_strings() {
        assert_eq!(
            first_json_object(r#"前言 {"a":"} x","b":{"c":1}} 后 {"d":2}"#),
            Some(r#"{"a":"} x","b":{"c":1}}"#)
        );
    }

    #[test]
    fn a_truncated_first_draft_falls_through_to_the_next() {
        let raw = r#"{"name":"坏的","tasks":[{"id":"a","role":"as-literature-researcher","brief":"b"
{"name":"好的","tasks":[{"id":"a","role":"as-literature-researcher","brief":"b","outputs":["o-a"]}]}"#;
        let (name, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(name, "好的");
        assert_eq!(tasks.len(), 1);

        // 空壳草稿（有名字没任务）同样跳过，而不是拿它去报“没有任务”。
        let raw = r#"{"name":"空壳","tasks":[]} {"name":"好的","tasks":[{"id":"a","role":"as-literature-researcher","brief":"b","outputs":["o-a"]}]}"#;
        let (name, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(name, "好的");
        assert_eq!(tasks.len(), 1);
    }

    #[test]
    fn missing_control_brief_falls_back_to_a_node_name() {
        let raw = r#"{"name":"n","tasks":[
            {"id":"scan","role":"as-literature-researcher","brief":"检索","outputs":["scan/papers.md"]},
            {"id":"read","kind":"foreach","dependsOn":["scan"],
             "forEach":{"source":"scan/papers.md","itemBrief":"精读 {item}","itemOutput":"read/{item}.md"}}
        ]}"#;
        let (_, tasks) = parse_draft(raw, &agents()).unwrap();
        assert_eq!(tasks[1].brief, "逐项处理");
        assert_eq!(
            tasks[1].for_each.as_ref().unwrap().item_brief,
            "精读 {item}"
        );
    }
}
