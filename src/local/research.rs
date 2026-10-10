//! Harness-independent expert roles and research package export.
use crate::error::{anyhow, Result};
use crate::store::{
    research::{digest, read_artifact, RunContract, Study},
    Store,
};
use std::io::{Cursor, Write};
use std::path::Path;

pub const GUIDE: &str = include_str!("../../agent-skills/orx-research-team/SKILL.md");
pub const ROLES: &[(&str, &str)] = &[
    (
        "as-asset-auditor",
        include_str!("../../agent-skills/orx-research-team/references/as-asset-auditor.md"),
    ),
    (
        "as-code-data-engineer",
        include_str!("../../agent-skills/orx-research-team/references/as-code-data-engineer.md"),
    ),
    (
        "as-evidence-writer",
        include_str!("../../agent-skills/orx-research-team/references/as-evidence-writer.md"),
    ),
    (
        "as-experiment-designer",
        include_str!("../../agent-skills/orx-research-team/references/as-experiment-designer.md"),
    ),
    (
        "as-experiment-diagnostician",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-experiment-diagnostician.md"
        ),
    ),
    (
        "as-experiment-operator",
        include_str!("../../agent-skills/orx-research-team/references/as-experiment-operator.md"),
    ),
    (
        "as-feasibility-advisor",
        include_str!("../../agent-skills/orx-research-team/references/as-feasibility-advisor.md"),
    ),
    (
        "as-figure-citation-editor",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-figure-citation-editor.md"
        ),
    ),
    (
        "as-independent-reviewer",
        include_str!("../../agent-skills/orx-research-team/references/as-independent-reviewer.md"),
    ),
    (
        "as-intent-router",
        include_str!("../../agent-skills/orx-research-team/references/as-intent-router.md"),
    ),
    (
        "as-literature-researcher",
        include_str!("../../agent-skills/orx-research-team/references/as-literature-researcher.md"),
    ),
    (
        "as-literature-strategist",
        include_str!("../../agent-skills/orx-research-team/references/as-literature-strategist.md"),
    ),
    (
        "as-methodology-designer",
        include_str!("../../agent-skills/orx-research-team/references/as-methodology-designer.md"),
    ),
    (
        "as-outline-architect",
        include_str!("../../agent-skills/orx-research-team/references/as-outline-architect.md"),
    ),
    (
        "as-paper-evidence-analyst",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-paper-evidence-analyst.md"
        ),
    ),
    (
        "as-quality-citation-auditor",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-quality-citation-auditor.md"
        ),
    ),
    (
        "as-research-package-curator",
        include_str!(
            "../../agent-skills/orx-research-team/references/as-research-package-curator.md"
        ),
    ),
    (
        "as-research-planner",
        include_str!("../../agent-skills/orx-research-team/references/as-research-planner.md"),
    ),
    (
        "as-research-synthesizer",
        include_str!("../../agent-skills/orx-research-team/references/as-research-synthesizer.md"),
    ),
    (
        "as-result-analyst",
        include_str!("../../agent-skills/orx-research-team/references/as-result-analyst.md"),
    ),
];
pub fn role(id: &str) -> Result<&'static str> {
    ROLES
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, prompt)| *prompt)
        .ok_or_else(|| anyhow!("未知专家角色: {id}"))
}
pub fn turn_context(store: &Store, session: &str) -> Result<Option<String>> {
    let Some(study) = store.research_for_session(session)? else {
        return Ok(None);
    };
    study.ensure_active()?;
    let root = store.research_root(&study)?;
    std::fs::create_dir_all(&root)?;
    let instruction = if let Some((task_id, version)) = store.research_session_task(session)? {
        if study.plan()?.version != version {
            return Err(anyhow!("该专家任务属于旧版计划，请返回主会话"));
        }
        let task = study.task(&task_id)?;
        format!(
            "你是独立专家，任务 {}。角色规范：\n{}\n任务契约：{}",
            task_id,
            role(&task.spec.role)?,
            serde_json::to_string(task)?
        )
    } else {
        "你是科研主理人。先理解需求、盘点材料，再制定按需裁剪的任务 DAG。通过 orx research dispatch 调用真实专家；不得自己模拟成员或代写专业产物。不要调用原生 task/subagent，也不要调用 orx agent spawn 绕开任务登记。已有授权应写入计划并由用户一次确认范围，避免反复询问。".into()
    };
    Ok(Some(format!("\n<research-study>\nStudy: {}\nMode: {}\nObjective: {}\nartifactRoot: {}\ncodeRoot: 当前会话独立 Git worktree\n{}\n{}\n当前计划与决策用 orx research status 查询。\n</research-study>",study.id,study.mode,study.objective,root.display(),instruction,GUIDE)))
}
pub fn run_contract(store: &Store, args: &crate::ExpRunArgs) -> Result<RunContract> {
    let exp = store
        .get_local_experiment(&args.exp_id)?
        .ok_or_else(|| anyhow!("实验不存在"))?;
    let project = store
        .get_local_project(&exp.project_id)?
        .ok_or_else(|| anyhow!("项目不存在"))?;
    let command = if exp.run_command.trim().is_empty() {
        project.run_command.unwrap_or_default()
    } else {
        exp.run_command
    };
    let revision = super::git::local_head_sha(Path::new(&project.repo_path), &exp.branch_name)?;
    // Settings changes invalidate approval without exposing credentials in the UI.
    let settings: serde_json::Value =
        std::fs::read(crate::config::config_dir().join("settings.json"))
            .ok()
            .map(|b| serde_json::from_slice(&b))
            .transpose()?
            .unwrap_or(serde_json::Value::Null);
    let mut execution_settings = serde_json::Map::new();
    for key in [
        "ssh",
        "defaultBackend",
        "defaultFlavor",
        "slurm",
        "ray",
        "k8s",
        "modal",
        "computeInstructions",
    ] {
        execution_settings.insert(
            key.into(),
            settings
                .get(key)
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );
    }
    let mut env = crate::config::list_synced_env();
    env.sort();
    let settings = serde_json::to_vec(&(execution_settings, env))?;
    Ok(RunContract {
        experiment_id: exp.id,
        revision,
        command,
        options: serde_json::json!({
            "backend":args.backend.as_deref().unwrap_or("local"),"flavor":args.flavor,"host":args.host,
            "image":args.image,"manifest":args.manifest,"container":args.container,"noContainer":args.no_container,
            "timeout":args.timeout,"disk":args.disk,"provider":args.provider,"org":args.org,
            "settingsHash":digest(&settings)
        }),
    })
}
pub fn export_package(store: &Store, study: &Study, published: bool) -> Result<Vec<u8>> {
    if published {
        let scope = store.research_package_scope(study)?;
        study.require_gate("G4", &scope)?;
    }
    let root = store.research_root(study)?;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut total = 0usize;
    let mut add = |path: &str, bytes: &[u8]| -> Result<()> {
        total += bytes.len();
        if total > 128 * 1024 * 1024 {
            return Err(anyhow!(
                "研究包超过 128 MiB，请通过产物文件单独交付大型数据"
            ));
        }
        zip.start_file(path, options)?;
        zip.write_all(bytes)?;
        Ok(())
    };
    let runs = store.research_runs(study)?;
    // Serialize public provenance only; backend descriptors may carry private paths.
    let run_records:Vec<_>=runs.iter().map(|r|serde_json::json!({"id":r.id,"experimentId":r.experiment_id,"status":r.status,"command":r.command,"commitSha":r.commit_sha,"exitCode":r.exit_code,"createdAt":r.created_at,"endedAt":r.ended_at})).collect();
    add(
        "research-package-manifest.json",
        &serde_json::to_vec_pretty(
            &serde_json::json!({"schemaVersion":1,"publicationState":if published {"approved"}else{"draft"},"study":study,"runs":run_records}),
        )?,
    )?;
    add("README.md",b"# Research Package\n\nSee research-package-manifest.json for approvals, evidence and provenance. A successful process does not establish scientific validity. Source commits are identified in the manifest; this archive includes registered artifacts and logs, including source snapshots and registered data; large external datasets remain referenced. External publication requires separate authorization.\n")?;
    if let Some(plan) = study.plans.last() {
        for task in &plan.tasks {
            for artifact in &task.artifacts {
                let bytes = read_artifact(&root, &artifact.path)?;
                if digest(&bytes) != artifact.sha256 {
                    return Err(anyhow!("产物已变化: {}", artifact.path));
                }
                add(&format!("artifacts/{}", artifact.path), &bytes)?;
            }
        }
    }
    let mut source_digests = std::collections::HashSet::new();
    for run in &runs {
        let descriptor = crate::jobs::BackendDescriptor::parse(&run.backend_json)?;
        if descriptor.source_digest.is_some() {
            let source = crate::compute::SourceSnapshot::from_run(run, &descriptor)?;
            if source.size > 32 * 1024 * 1024 {
                return Err(anyhow!("源码快照超过 32 MiB，请单独交付"));
            }
            if source_digests.insert(source.digest.clone()) {
                add(
                    &format!("sources/{}.tar", source.digest),
                    &std::fs::read(source.path)?,
                )?;
            }
        } else if published {
            return Err(anyhow!("Run 缺少源码快照: {}", run.id));
        }
        let path = store.research_log_path(&run.id)?;
        if path.exists() {
            if path.metadata()?.len() > 32 * 1024 * 1024 {
                return Err(anyhow!("运行日志超过 32 MiB，请单独交付"));
            }
            add(&format!("logs/{}.log", run.id), &std::fs::read(path)?)?;
        } else if published {
            return Err(anyhow!("运行日志缺失: {}", run.id));
        }
    }
    Ok(zip.finish()?.into_inner())
}
