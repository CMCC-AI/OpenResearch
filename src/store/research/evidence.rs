//! Capture bounded evidence outside the write transaction, then revalidate its
//! study, run and file identity before appending to the current aggregate.
use std::fs::{File, Metadata};
use std::io::Read;
use std::time::SystemTime;

use super::*;

pub(super) const MAX_CLAIM_INPUT_BYTES: usize = 64 * 1024;
pub(super) const MAX_EXCERPT_BYTES: usize = 64 * 1024;

pub(super) struct PreparedClaim {
    study_id: String,
    project_id: String,
    claim: EvidenceClaim,
    run: Option<RunSource>,
    log: Option<LogSource>,
}

#[derive(PartialEq, Eq)]
struct RunSource {
    id: String,
    project_id: String,
    status: String,
    commit_sha: Option<String>,
    updated_at: i64,
}

impl From<&StoredRun> for RunSource {
    fn from(run: &StoredRun) -> Self {
        Self {
            id: run.id.clone(),
            project_id: run.project_id.clone(),
            status: run.status.clone(),
            commit_sha: run.commit_sha.clone(),
            updated_at: run.updated_at,
        }
    }
}

#[derive(PartialEq, Eq)]
struct LogStamp {
    bytes: u64,
    modified: SystemTime,
}
impl LogStamp {
    fn read(metadata: Metadata) -> Result<Self> {
        if !metadata.is_file() {
            return Err(anyhow!("实验日志必须为普通文件"));
        }
        Ok(Self {
            bytes: metadata.len(),
            modified: metadata.modified()?,
        })
    }
}

struct LogSource {
    path: PathBuf,
    file: File,
    identity: same_file::Handle,
    stamp: LogStamp,
}
impl LogSource {
    fn check_unchanged(&self) -> Result<()> {
        if self.stamp != LogStamp::read(self.file.metadata()?)?
            || self.identity != same_file::Handle::from_path(&self.path)?
        {
            return Err(anyhow!("实验日志读取后发生变化，请重新登记证据"));
        }
        Ok(())
    }
}

/// Hash every byte while retaining only the requested lines. No unselected
/// line, even a single multi-gigabyte line, needs to be buffered.
pub(super) fn scan_log(
    mut reader: impl Read,
    start: usize,
    end: usize,
) -> Result<(String, String)> {
    validate_range(start, end)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut selected = Vec::new();
    let mut complete_lines = 0usize;
    let mut trailing_line = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        for segment in buffer[..count].split_inclusive(|byte| *byte == b'\n') {
            let line = complete_lines + 1;
            if (start..=end).contains(&line) {
                if selected.len().saturating_add(segment.len()) > MAX_EXCERPT_BYTES {
                    return Err(anyhow!("证据日志摘录超过 64 KiB，请缩小行范围"));
                }
                selected.extend_from_slice(segment);
            }
            trailing_line = segment.last() != Some(&b'\n');
            if !trailing_line {
                complete_lines += 1;
            }
        }
    }
    if end > complete_lines + usize::from(trailing_line) {
        return Err(anyhow!("需要有效日志行范围（最多 201 行）"));
    }
    // Match the former lossy UTF-8 and str::lines CRLF normalization, after
    // bounding raw bytes. Lossy decoding can expand malformed bytes threefold.
    let excerpt = String::from_utf8_lossy(&selected)
        .lines()
        .collect::<Vec<_>>()
        .join("\n");
    if excerpt.len() > MAX_EXCERPT_BYTES {
        return Err(anyhow!("证据日志摘录超过 64 KiB，请缩小行范围"));
    }
    Ok((format!("{:x}", hash.finalize()), excerpt))
}

fn validate_range(start: usize, end: usize) -> Result<()> {
    if start == 0 || end < start || end - start > 200 {
        return Err(anyhow!("需要有效日志行范围（最多 201 行）"));
    }
    Ok(())
}

impl Store {
    pub fn research_add_claim(&self, id: &str, input: ClaimInput) -> Result<()> {
        let prepared =
            self.research_prepare_claim_with_reader(id, input, |reader, start, end| {
                scan_log(reader, start, end)
            })?;
        self.research_commit_claim(id, prepared)
    }

    pub(super) fn research_prepare_claim_with_reader(
        &self,
        id: &str,
        input: ClaimInput,
        read_log: impl FnOnce(&mut dyn Read, usize, usize) -> Result<(String, String)>,
    ) -> Result<PreparedClaim> {
        let input_bytes = [&input.text, &input.support, &input.source]
            .into_iter()
            .map(|s| s.len())
            .chain(
                [input.location.as_ref(), input.run_id.as_ref()]
                    .into_iter()
                    .flatten()
                    .map(|s| s.len()),
            )
            .fold(0usize, usize::saturating_add);
        if input_bytes > MAX_CLAIM_INPUT_BYTES {
            return Err(anyhow!("证据声明字段总计超过 64 KiB"));
        }
        if input.text.trim().is_empty()
            || input.source.trim().is_empty()
            || !["paper", "experiment", "inference"].contains(&input.support.as_str())
        {
            return Err(anyhow!("结论需要文本、来源及明确的证据类型"));
        }
        let study = self.research_study(id)?;
        study.ensure_active()?;
        let mut claim = EvidenceClaim {
            id: uuid::Uuid::new_v4().to_string(),
            input,
            commit_sha: None,
            log_sha256: None,
            excerpt: None,
            created_at: now_ms(),
        };
        let (run, log) = if claim.input.support == "experiment" {
            let start = claim.input.line_start.unwrap_or(0);
            let end = claim.input.line_end.unwrap_or(0);
            validate_range(start, end)?;
            let run = self
                .get_run(
                    claim
                        .input
                        .run_id
                        .as_deref()
                        .ok_or_else(|| anyhow!("实验结论需要 runId"))?,
                )?
                .ok_or_else(|| anyhow!("Run 不存在"))?;
            if run.project_id != study.project_id || !crate::local::is_terminal(&run.status) {
                return Err(anyhow!("结论必须关联本项目已结束的 Run"));
            }
            let path = self.research_log_path(&run.id)?;
            let file = File::open(&path)?;
            let stamp = LogStamp::read(file.metadata()?)?;
            let identity = same_file::Handle::from_file(file.try_clone()?)?;
            let mut log = LogSource {
                path,
                file,
                identity,
                stamp,
            };
            // A growing file cannot keep a read alive indefinitely. Any append
            // or replacement is rejected by metadata/identity checks below.
            let mut reader = (&mut log.file).take(log.stamp.bytes.saturating_add(1));
            let (hash, excerpt) = read_log(&mut reader, start, end)?;
            log.check_unchanged()?;
            claim.log_sha256 = Some(hash);
            claim.excerpt = Some(excerpt);
            claim.commit_sha = run.commit_sha.clone();
            (Some(RunSource::from(&run)), Some(log))
        } else {
            if claim.input.support == "paper"
                && claim
                    .input
                    .location
                    .as_ref()
                    .is_none_or(|v| v.trim().is_empty())
            {
                return Err(anyhow!("论文声明需要页码或章节位置"));
            }
            (None, None)
        };
        Ok(PreparedClaim {
            study_id: study.id,
            project_id: study.project_id,
            claim,
            run,
            log,
        })
    }

    pub(super) fn research_commit_claim(&self, id: &str, prepared: PreparedClaim) -> Result<()> {
        self.research_update(id, |study| {
            study.ensure_active()?;
            if prepared.study_id != study.id || prepared.project_id != study.project_id {
                return Err(anyhow!("研究归属已变化，请重新登记证据"));
            }
            if let Some(expected) = &prepared.run {
                let current = self
                    .get_run(&expected.id)?
                    .ok_or_else(|| anyhow!("Run 不存在"))?;
                if RunSource::from(&current) != *expected {
                    return Err(anyhow!("Run 记录已变化，请重新登记证据"));
                }
            }
            if let Some(log) = &prepared.log {
                log.check_unchanged()?;
            }
            study.claims.push(prepared.claim);
            Ok(())
        })
    }
}
