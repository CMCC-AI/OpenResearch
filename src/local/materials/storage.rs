//! Executor-wide capacity and explicit collection of abandoned, unsealed uploads.
use crate::error::{anyhow, Result};
use std::{fs, path::Path};

const DEFAULT_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
pub(super) fn limit() -> Result<u64> {
    match std::env::var("ORX_MATERIAL_STORAGE_BYTES") {
        Ok(value) => {
            let bytes: u64 = value
                .parse()
                .map_err(|_| anyhow!("ORX_MATERIAL_STORAGE_BYTES must be an integer"))?;
            if bytes < super::MAX_FILE as u64 {
                return Err(anyhow!(
                    "Material storage limit must allow at least one 32 MiB file"
                ));
            }
            Ok(bytes)
        }
        Err(std::env::VarError::NotPresent) => Ok(DEFAULT_LIMIT),
        Err(error) => Err(anyhow!("Invalid material storage limit: {error}")),
    }
}
pub(super) fn lock(root: &Path) -> Result<fd_lock::RwLock<fs::File>> {
    fs::create_dir_all(root)?;
    Ok(fd_lock::RwLock::new(
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(".quota.lock"))?,
    ))
}
pub(super) fn bytes(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            total = total.saturating_add(bytes(&entry.path())?);
        }
    }
    Ok(total)
}
pub(super) fn remaining(root: &Path) -> Result<u64> {
    let used = bytes(root)?;
    let limit = limit()?;
    if used >= limit {
        return Err(anyhow!(
            "材料存储空间已达上限，请清理未完成上传或归档材料后重试"
        ));
    }
    Ok(limit - used)
}

/// Call only while holding the executor-wide quota lock. Count logical bytes,
/// including both the old file and its replacement until rename commits.
pub(super) fn admit(root: &Path, additional: u64) -> Result<()> {
    admit_with_limit(root, additional, limit()?)
}

pub(super) fn admit_with_limit(root: &Path, additional: u64, limit: u64) -> Result<()> {
    if bytes(root)?
        .checked_add(additional)
        .is_none_or(|peak| peak > limit)
    {
        return Err(anyhow!("材料存储空间不足，请先清理未完成上传"));
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub packages: Vec<String>,
    pub bytes: u64,
    pub applied: bool,
    /// Unknown ownership/state is reported for manual inspection, never deleted.
    pub anomalies: Vec<String>,
}
pub(super) fn collect_at(
    root: &Path,
    project: &str,
    now: i64,
    age_ms: i64,
    apply: bool,
) -> Result<Collection> {
    if age_ms < 24 * 60 * 60 * 1000 {
        return Err(anyhow!("未完成材料至少保留 24 小时"));
    }
    let mut lock = lock(root)?;
    let _guard = lock.write()?;
    let mut report = Collection {
        packages: Vec::new(),
        bytes: 0,
        applied: apply,
        anomalies: Vec::new(),
    };
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !super::valid_id(&id) {
            continue;
        }
        let package = match super::read_at(root, &id, project) {
            Ok(package) => package,
            Err(_) => {
                // Other projects are not anomalies of this project. A broken
                // manifest cannot establish ownership and must not be collected.
                if super::inspect_at(root, &id).is_err() {
                    report.anomalies.push(id);
                }
                continue;
            }
        };
        // Finalized snapshots can be referenced by transcripts or evidence: never collect them.
        if package.ready {
            continue;
        }
        let modified = fs::metadata(entry.path().join("manifest.json"))?
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| anyhow!("Invalid material timestamp: {error}"))?
            .as_millis() as i64;
        if now.saturating_sub(modified.max(package.created_at)) < age_ms {
            continue;
        }
        let mut package_lock = fd_lock::RwLock::new(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(entry.path().join("lock"))?,
        );
        let Ok(guard) = package_lock.try_write() else {
            continue;
        };
        let size = bytes(&entry.path())?;
        // The global quota lock excludes uploads; drop file handles for Windows removal.
        drop(guard);
        drop(package_lock);
        if apply {
            fs::remove_dir_all(entry.path())?;
        }
        report.packages.push(id);
        report.bytes = report.bytes.saturating_add(size);
    }
    Ok(report)
}
