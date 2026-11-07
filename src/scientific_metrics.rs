//! Bounded inspections and explicitly registered scientific observations.
//! A report's association with a Run is a producer declaration; matching bytes do not prove that code consumed
//! these inputs or that a scientific result is valid.
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{anyhow, Result};
use crate::jobs::BackendDescriptor;
use crate::store::{Store, StoredRun};
use crate::verified_file::FileSource;

const REPORT_BYTES: u64 = 2 * 1024 * 1024;
const INPUT_BYTES: u64 = 64 * 1024 * 1024;
const SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_POINTS: usize = 10_000;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Point {
    step: u64,
    value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Series {
    name: String,
    unit: String,
    split: String,
    points: Vec<Point>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Data {
    /// Explicitly declares an analytical run with no file inputs.
    None {},
    /// Paths are relative to this run's project artifacts, never arbitrary host paths.
    Artifacts { files: Vec<Input> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Report {
    schema_version: u32,
    run_id: String,
    experiment_id: String,
    commit_sha: String,
    source_sha256: String,
    data: Data,
    series: Vec<Series>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inspection {
    schema_version: u32,
    project_id: String,
    run_id: String,
    experiment_id: String,
    status: String,
    command: String,
    execution: serde_json::Value,
    report_path: String,
    report_sha256: String,
    report_bytes: u64,
    source_bytes: u64,
    measured_at: i64,
    meaning: &'static str,
    report: Report,
}

fn sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn parse(bytes: &[u8], run: &StoredRun, backend: &BackendDescriptor) -> Result<Report> {
    if bytes.len() as u64 > REPORT_BYTES {
        return Err(anyhow!("科学指标文件超过 2 MiB；未返回部分序列"));
    }
    let report: Report = serde_json::from_slice(bytes)?;
    if report.schema_version != 1
        || report.run_id != run.id
        || report.experiment_id != run.experiment_id
        || Some(&report.commit_sha) != run.commit_sha.as_ref()
        || Some(&report.source_sha256) != backend.source_digest.as_ref()
        || !sha256(&report.source_sha256)
        || ![40, 64].contains(&report.commit_sha.len())
        || !report.commit_sha.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(anyhow!("指标文件与 Run、实验或冻结代码身份不一致"));
    }
    if report.series.is_empty() || report.series.len() > 64 {
        return Err(anyhow!("科学指标需要 1–64 个明确标注单位和数据划分的序列"));
    }
    let mut identities = HashSet::new();
    let mut points = 0;
    for series in &report.series {
        if !label(&series.name, 128)
            || !label(&series.unit, 64)
            || !label(&series.split, 128)
            || !identities.insert((&series.name, &series.split))
            || series.points.is_empty()
        {
            return Err(anyhow!("指标序列名称/单位/划分无效、重复或没有观测值"));
        }
        points += series.points.len();
        if points > MAX_POINTS {
            return Err(anyhow!("科学指标总计超过 10000 点；未返回部分序列"));
        }
        let mut previous = None;
        for point in &series.points {
            if !point.value.is_finite()
                || point.step > MAX_SAFE_INTEGER
                || previous.is_some_and(|step| point.step <= step)
            {
                return Err(anyhow!("指标需要有限数值和严格递增的安全整数 step"));
            }
            previous = Some(point.step);
        }
    }
    if let Data::Artifacts { files } = &report.data {
        if files.is_empty() || files.len() > 64 {
            return Err(anyhow!(
                "数据来源需要 1–64 个明确的产物身份，或显式声明无文件输入"
            ));
        }
        let mut paths = HashSet::new();
        let mut total = 0_u64;
        for input in files {
            if !crate::local::files::is_safe_rel_path(&input.path)
                || input.path.contains(':')
                || input.path.len() > 1024
                || input.path.chars().any(char::is_control)
                || !paths.insert(&input.path)
                || !sha256(&input.sha256)
            {
                return Err(anyhow!("数据来源路径或 SHA-256 无效、重复"));
            }
            total = total.saturating_add(input.bytes);
            if total > INPUT_BYTES {
                return Err(anyhow!("数据来源核验总量超过 64 MiB；未跳过任何来源"));
            }
        }
    }
    Ok(report)
}

fn open_hashed(path: &Path, hash: &str, bytes: u64, budget: u64) -> Result<FileSource> {
    if bytes > budget {
        return Err(anyhow!("来源文件超过核验预算"));
    }
    let mut source = open_regular(path, "科学指标来源")?;
    if source.bytes() != bytes || source.bytes() > budget || source.hash()? != hash {
        return Err(anyhow!("科学指标来源字节数或 SHA-256 已变化"));
    }
    Ok(source)
}

fn open_regular(path: &Path, kind: &'static str) -> Result<FileSource> {
    // Refuse devices and FIFOs before opening (opening a FIFO could block).
    // FileSource also checks the opened descriptor and later path identity.
    if !std::fs::metadata(path)?.is_file() {
        return Err(anyhow!("科学指标及来源必须为普通文件"));
    }
    FileSource::open(path, kind)
}

/// No network, external process, database write transaction or experiment launch.
fn verify(
    store: &Store,
    project: &str,
    run_id: &str,
    relative: &str,
) -> Result<(Inspection, StoredRun)> {
    if relative.len() > 1024 || relative.contains(':') || relative.chars().any(char::is_control) {
        return Err(anyhow!("指标报告需要安全的项目产物相对路径"));
    }
    let run = store
        .get_run(run_id)?
        .ok_or_else(|| anyhow!("Run 不存在"))?;
    if run.project_id != project {
        return Err(anyhow!("不能跨项目检查科学指标"));
    }
    if run.status != "done" || run.exit_code != Some(0) {
        return Err(anyhow!("科学指标检查需要成功结束且 exitCode=0 的 Run"));
    }
    let project_row = store
        .get_local_project(project)?
        .ok_or_else(|| anyhow!("project not found"))?;
    let backend = BackendDescriptor::parse(&run.backend_json)?;
    let report_path = crate::local::files::file_path(&project_row, relative)?;
    let mut report_file = open_regular(&report_path, "科学指标报告")?;
    if report_file.bytes() > REPORT_BYTES {
        return Err(anyhow!("科学指标文件超过 2 MiB；未返回部分序列"));
    }
    let mut bytes = Vec::new();
    report_file
        .reader()
        .take(REPORT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > REPORT_BYTES || bytes.len() as u64 != report_file.bytes() {
        return Err(anyhow!("科学指标文件读取期间长度变化"));
    }
    let report = parse(&bytes, &run, &backend)?;
    let digest = backend
        .source_digest
        .as_deref()
        .ok_or_else(|| anyhow!("Run 缺少代码快照 SHA-256"))?;
    let size = backend
        .source_size
        .ok_or_else(|| anyhow!("Run 缺少代码快照字节数"))?;
    // Match the launcher's data-directory migration fallback without following
    // URLs or guessing an experiment's current branch as the old source.
    let recorded = backend.source_path.as_ref().map(std::path::PathBuf::from);
    let path = recorded.filter(|path| path.is_file()).unwrap_or_else(|| {
        crate::store::data_dir()
            .join("source-snapshots")
            .join(format!("{digest}.tar"))
    });
    let mut sources = vec![open_hashed(&path, digest, size, SOURCE_BYTES)?];
    if let Data::Artifacts { files } = &report.data {
        for input in files {
            let path = crate::local::files::file_path(&project_row, &input.path)?;
            sources.push(open_hashed(&path, &input.sha256, input.bytes, INPUT_BYTES)?);
        }
    }
    report_file.check_unchanged()?;
    for source in &sources {
        source.check_unchanged()?;
    }
    let current = store
        .get_run(&run.id)?
        .ok_or_else(|| anyhow!("Run 在核验期间被删除"))?;
    if !same_run(&current, &run) {
        return Err(anyhow!("Run 来源在核验期间变化，请重试"));
    }
    let inspection = Inspection {
        schema_version: 1, project_id: project.into(), run_id: run.id.clone(),
        experiment_id: run.experiment_id.clone(), status: run.status.clone(), command: run.command.clone(),
        execution: serde_json::json!({"kind":backend.kind,"flavor":backend.flavor,"image":backend.image,
            "timeoutSecs":backend.timeout_secs,"cpusPerTask":backend.cpus_per_task,"mem":backend.mem}),
        report_path: relative.into(), report_sha256: format!("{:x}", Sha256::digest(&bytes)),
        report_bytes: bytes.len() as u64, source_bytes: size, measured_at: crate::store::now_ms(),
        meaning: "报告声明关联此 Run；核验的是检查时的报告、冻结代码和数据文件字节身份，不证明运行时实际使用、指标正确性或可复现性。未登记持久证据，不生成实验或阅读回执。",
        report,
    };
    Ok((inspection, run))
}

/// Compare every Run field represented by, or relevant to, this observation.
/// Repeated under the writer lock before an immutable record is inserted.
pub(crate) fn same_run(current: &StoredRun, expected: &StoredRun) -> bool {
    current.id == expected.id
        && current.project_id == expected.project_id
        && current.experiment_id == expected.experiment_id
        && current.status == expected.status
        && current.exit_code == expected.exit_code
        && current.commit_sha == expected.commit_sha
        && current.backend_json == expected.backend_json
        && current.command == expected.command
        && current.created_at == expected.created_at
        && current.ended_at == expected.ended_at
        && current.updated_at == expected.updated_at
}

pub(crate) fn inspect(store: &Store, project: &str, run: &str, file: &str) -> Result<Inspection> {
    Ok(verify(store, project, run, file)?.0)
}

/// Filesystem work finishes before taking the database writer lock. This stores
/// the observed snapshot, not a promise that live files remain unchanged.
pub(crate) fn register(
    store: &Store,
    project: &str,
    run: &str,
    file: &str,
) -> Result<crate::store::metric_evidence::MetricEvidence> {
    let (mut inspection, expected) = verify(store, project, run, file)?;
    inspection.meaning = "持久保存核验时的报告内容及来源字节身份；关联是生产者声明，不证明运行时实际使用、指标正确性或可复现性。当前文件可能已经变化；未封存原始报告、代码或数据文件，不生成实验或阅读回执。";
    store.register_metric_evidence(&expected, &inspection)
}

#[cfg(test)]
mod tests;
