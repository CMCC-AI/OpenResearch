//! Explicit byte snapshots, not execution or scientific consumption receipts.
use crate::{
    error::{anyhow, Result},
    store::{Store, StoredRun},
    verified_file::FileSource,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) mod delivery;
mod files;
use files::{
    blob_sizes, check_layout, discard, existing_pool, pool, portable, source_file, sync_directory,
    verify_files, Witness,
};

pub(crate) const MAX_MANIFEST: u64 = 128 * 1024;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Selection {
    Material {
        #[serde(rename = "packageId")]
        package_id: String,
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    Artifact {
        #[serde(rename = "runId")]
        run_id: String,
        path: String,
        sha256: String,
        bytes: u64,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedFile {
    pub path: String,
    pub source: Selection,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub schema_version: u32,
    pub files: Vec<SelectedFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Origin {
    Material {
        #[serde(rename = "packageId")]
        package_id: String,
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "originalPath")]
        original_path: String,
        #[serde(rename = "manifestSha256")]
        manifest_sha256: String,
    },
    Artifact {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "experimentId")]
        experiment_id: String,
        #[serde(rename = "projectPath")]
        project_path: String,
        #[serde(rename = "commitSha")]
        commit_sha: Option<String>,
        #[serde(rename = "commandSha256")]
        command_sha256: String,
        #[serde(rename = "backendSha256")]
        backend_sha256: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub origin: Origin,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub project_id: String,
    pub prepared_at: i64,
    pub producer_version: String,
    pub meaning: String,
    pub files: Vec<FrozenFile>,
}
struct Prepared {
    file: FrozenFile,
    source: FileSource,
    name: PathBuf,
    target: PathBuf,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest_valid(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid_valid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s)
}
fn project_slug(store: &Store, project: &str) -> Result<String> {
    let slug = store
        .get_local_project(project)?
        .ok_or_else(|| anyhow!("project not found"))?
        .slug;
    if !crate::store::storage_usage::single_component(&slug) {
        return Err(anyhow!("项目目录标识无效"));
    }
    Ok(slug)
}
fn same_run(left: &StoredRun, right: &StoredRun) -> bool {
    left.id == right.id
        && left.project_id == right.project_id
        && left.experiment_id == right.experiment_id
        && left.status == right.status
        && left.exit_code == right.exit_code
        && left.commit_sha == right.commit_sha
        && left.command == right.command
        && left.backend_json == right.backend_json
        && left.updated_at == right.updated_at
}
fn prepare(
    store: &Store,
    project: &str,
    slug: &str,
    request: Request,
) -> Result<(Vec<Prepared>, Vec<Witness>, Vec<StoredRun>)> {
    if request.schema_version != 1 || request.files.is_empty() || request.files.len() > 64 {
        return Err(anyhow!("输入清单需要版本 1 及 1–64 个文件"));
    }
    let root = store.input_data_root()?;
    let mut paths = BTreeSet::new();
    let mut inputs = Vec::new();
    let mut witnesses = Vec::new();
    let mut runs = Vec::new();
    let mut total = 0u64;
    for entry in request.files {
        let folded = entry.path.to_lowercase();
        if !portable(&entry.path)
            || paths.iter().any(|p: &String| {
                p == &folded
                    || p.starts_with(&(folded.clone() + "/"))
                    || folded.starts_with(&(p.clone() + "/"))
            })
        {
            return Err(anyhow!("输入目标路径重复、冲突或不安全"));
        }
        paths.insert(folded);
        let (name, target, source, expected, bytes, origin) = match entry.source {
            Selection::Material {
                package_id,
                source_id,
            } => {
                if !uuid_valid(&package_id) {
                    return Err(anyhow!("材料包 ID 无效"));
                }
                let base = root.join("materials").join(&package_id);
                if !fs::symlink_metadata(&base)?.file_type().is_dir()
                    || !fs::symlink_metadata(base.join("originals"))?
                        .file_type()
                        .is_dir()
                {
                    return Err(anyhow!("材料来源目录不能为链接"));
                }
                let (mn, mt, mut manifest) = source_file(&base, "manifest.json")?;
                if manifest.bytes() > 4 * 1024 * 1024 {
                    return Err(anyhow!("材料清单超过 4 MiB"));
                }
                let mut json = Vec::new();
                manifest
                    .reader()
                    .take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut json)?;
                if json.len() as u64 != manifest.bytes() {
                    return Err(anyhow!("材料清单读取期间变化"));
                }
                let package: crate::local::materials::Package = serde_json::from_slice(&json)?;
                if package.id != package_id || package.project_id != project || !package.ready {
                    return Err(anyhow!("材料未封存或不属于本项目"));
                }
                let mut matches = package.files.iter().filter(|f| f.id == source_id);
                let file = matches.next().ok_or_else(|| anyhow!("材料来源不存在"))?;
                if matches.next().is_some() {
                    return Err(anyhow!("材料来源 ID 重复"));
                }
                let (name, target, source) = source_file(&base.join("originals"), &file.path)?;
                let origin = Origin::Material {
                    package_id,
                    source_id,
                    original_path: file.path.clone(),
                    manifest_sha256: hash(&json),
                };
                witnesses.push(Witness {
                    name: mn,
                    target: mt,
                    source: manifest.into_snapshot()?,
                });
                (name, target, source, file.sha256.clone(), file.size, origin)
            }
            Selection::Artifact {
                run_id,
                path,
                sha256,
                bytes,
            } => {
                let run = store
                    .get_run(&run_id)?
                    .ok_or_else(|| anyhow!("Run 不存在"))?;
                if run.project_id != project || run.status != "done" || run.exit_code != Some(0) {
                    return Err(anyhow!("产物关联需要本项目成功结束的 Run"));
                }
                let base = crate::local::files::files_dir_at(&root, slug);
                if !fs::symlink_metadata(&base)?.file_type().is_dir() {
                    return Err(anyhow!("项目产物目录不能为链接"));
                }
                let (name, target, source) = source_file(&base, &path)?;
                let origin = Origin::Artifact {
                    run_id,
                    experiment_id: run.experiment_id.clone(),
                    project_path: path,
                    commit_sha: run.commit_sha.clone(),
                    command_sha256: hash(run.command.as_bytes()),
                    backend_sha256: hash(run.backend_json.as_bytes()),
                };
                runs.push(run);
                (name, target, source, sha256, bytes, origin)
            }
        };
        if !digest_valid(&expected) || bytes != source.bytes() {
            return Err(anyhow!("输入字节数或 SHA-256 身份无效"));
        }
        total = total
            .checked_add(bytes)
            .ok_or_else(|| anyhow!("输入预算溢出"))?;
        if total > MAX_BYTES {
            return Err(anyhow!("输入逻辑总量超过 64 MiB；未省略任何文件"));
        }
        inputs.push(Prepared {
            file: FrozenFile {
                path: entry.path,
                sha256: expected,
                bytes,
                origin,
            },
            source,
            name,
            target,
        });
    }
    Ok((inputs, witnesses, runs))
}
pub(crate) fn freeze(store: &Store, project: &str, request: Request) -> Result<serde_json::Value> {
    freeze_with_check(store, project, request, |_| Ok(()))
}
fn freeze_with_check(
    store: &Store,
    project: &str,
    request: Request,
    before_commit: impl FnOnce(&Manifest) -> Result<()>,
) -> Result<serde_json::Value> {
    let mut check = Some(before_commit);
    freeze_with_observer(store, project, request, |phase, manifest| {
        if phase == Phase::Committing {
            check.take().ok_or_else(|| anyhow!("重复提交核验"))?(manifest)?;
        }
        Ok(())
    })
}
#[derive(PartialEq, Eq)]
enum Phase {
    Copying,
    Committing,
}
fn freeze_with_observer(
    store: &Store,
    project: &str,
    request: Request,
    mut observe: impl FnMut(Phase, &Manifest) -> Result<()>,
) -> Result<serde_json::Value> {
    let slug = project_slug(store, project)?;
    let (inputs, mut witnesses, runs) = prepare(store, project, &slug, request)?;
    let manifest=Manifest {schema_version:1,id:uuid::Uuid::new_v4().to_string(),project_id:project.into(),prepared_at:crate::store::now_ms(),producer_version:env!("CARGO_PKG_VERSION").into(),meaning:"Frozen copies only; no delivery, execution or consumption proof. Artifact-to-Run association is operator-selected, not verified production. Retained permanently in this version; frozen sets block project deletion. Only uncommitted reservations can be recovered.".into(),files:inputs.iter().map(|i|i.file.clone()).collect()};
    let json = serde_json::to_vec(&manifest)?;
    if json.len() as u64 > MAX_MANIFEST {
        return Err(anyhow!("冻结清单超过 128 KiB"));
    }
    let charge = blob_sizes(&manifest)?.values().sum::<u64>() + json.len() as u64;
    let digest = hash(&json);
    let root = pool(store)?;
    let lock_path = root.join("locks").join(&manifest.id);
    let file = fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&lock_path)?;
    file.sync_all()?;
    sync_directory(&root.join("locks"))?;
    let mut lock = fd_lock::RwLock::new(file);
    let guard = lock.write()?;
    if let Err(error) = store.input_reserve(&manifest, std::str::from_utf8(&json)?, &digest, charge)
    {
        drop(guard);
        drop(lock);
        let _ = fs::remove_file(lock_path);
        return Err(error);
    }
    let dir = root.join("sets").join(&manifest.id);
    // A pre-existing directory is never ours to clean, even on UUID collision.
    if let Err(error) = fs::create_dir(&dir) {
        return Err(anyhow!(
            "输入预约 {} 未创建目录，保留供检查: {error}",
            manifest.id
        ));
    }
    let result = (|| -> Result<()> {
        store.input_begin_copy(project, &manifest.id)?;
        observe(Phase::Copying, &manifest)?;
        fs::create_dir(dir.join("blobs"))?;
        let mut copied = BTreeSet::new();
        for mut input in inputs {
            let first = copied.insert(input.file.sha256.clone());
            let mut writer = if first {
                Some(
                    fs::OpenOptions::new().create_new(true).write(true).open(
                        dir.join("blobs")
                            .join(format!("{}.part", input.file.sha256)),
                    )?,
                )
            } else {
                None
            };
            let mut hasher = Sha256::new();
            let mut count = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            let mut reader = input.source.reader();
            loop {
                let n = match reader.read(&mut buffer) {
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    result => result?,
                };
                if n == 0 {
                    break;
                }
                count += n as u64;
                hasher.update(&buffer[..n]);
                if let Some(file) = writer.as_mut() {
                    file.write_all(&buffer[..n])?;
                }
            }
            if count != input.file.bytes || format!("{:x}", hasher.finalize()) != input.file.sha256
            {
                return Err(anyhow!("输入读取期间变化或来源摘要不匹配"));
            }
            witnesses.push(Witness {
                name: input.name,
                target: input.target,
                source: input.source.into_snapshot()?,
            });
            if let Some(file) = writer {
                file.sync_all()?;
                drop(file);
                fs::rename(
                    dir.join("blobs")
                        .join(format!("{}.part", input.file.sha256)),
                    dir.join("blobs").join(&input.file.sha256),
                )?;
            }
        }
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(dir.join("manifest.json"))?;
        output.write_all(&json)?;
        output.sync_all()?;
        drop(output);
        sync_directory(&dir.join("blobs"))?;
        sync_directory(&dir)?;
        sync_directory(&root.join("sets"))?;
        sync_directory(&root)?;
        sync_directory(&store.input_data_root()?)?;
        witnesses.extend(verify_files(&dir, &manifest)?);
        observe(Phase::Committing, &manifest)?;
        store.input_finish(project, &manifest.id, &digest, || {
            check_layout(&dir, &manifest)?;
            if project_slug(store, project)? != slug {
                return Err(anyhow!("项目来源在冻结期间变化"));
            }
            for run in &runs {
                if !store
                    .get_run(&run.id)?
                    .is_some_and(|current| same_run(&current, run))
                {
                    return Err(anyhow!("关联 Run 在冻结期间变化"));
                }
            }
            for witness in &witnesses {
                witness.check()?;
            }
            Ok(())
        })
    })();
    if let Err(error) = result {
        if store.input_record(project, &manifest.id).is_ok_and(|r| {
            matches!(r.state.as_str(), "preparing" | "copying") && r.manifest_sha256 == digest
        }) && discard(&dir, &manifest, true).is_ok()
        {
            store.input_cancel(project, &manifest.id)?;
        }
        return Err(anyhow!(
            "输入冻结失败，预约 {}（可查询/恢复）: {error}",
            manifest.id
        ));
    }
    Ok(
        serde_json::json!({"snapshot":store.input_record(project,&manifest.id)?,"copiesVerified":true,"executionObserved":false}),
    )
}
pub(crate) fn verify(store: &Store, project: &str, id: &str) -> Result<serde_json::Value> {
    project_slug(store, project)?;
    if !uuid_valid(id) {
        return Err(anyhow!("输入集合 ID 无效"));
    }
    let record = store.input_record(project, id)?;
    if record.state != "frozen" {
        return Err(anyhow!("输入集合尚未冻结"));
    }
    verify_files(
        &existing_pool(store)?.join("sets").join(id),
        &record.manifest,
    )?;
    Ok(
        serde_json::json!({"id":id,"manifestSha256":record.manifest_sha256,"copiesVerified":true,"verifiedAt":crate::store::now_ms(),"executionObserved":false}),
    )
}
pub(crate) fn recover(
    store: &Store,
    project: &str,
    id: &str,
    apply: bool,
) -> Result<serde_json::Value> {
    project_slug(store, project)?;
    if !uuid_valid(id) {
        return Err(anyhow!("输入集合 ID 无效"));
    }
    let root = existing_pool(store)?;
    let path = root.join("locks").join(id);
    if !fs::symlink_metadata(&path)?.file_type().is_file() {
        return Err(anyhow!("预约锁状态未知"));
    }
    let mut lock = fd_lock::RwLock::new(fs::OpenOptions::new().read(true).write(true).open(path)?);
    let _guard = lock.try_write().map_err(|_| anyhow!("输入冻结仍在进行"))?;
    let record = store.input_record(project, id)?;
    if !matches!(record.state.as_str(), "preparing" | "copying") {
        return Err(anyhow!("只能恢复未冻结的预约"));
    }
    let dir = root.join("sets").join(id);
    if record.state == "preparing" && fs::symlink_metadata(&dir).is_ok() {
        return Err(anyhow!("目录创建归属尚未确认，保留供人工检查"));
    }
    discard(&dir, &record.manifest, apply)?;
    if apply {
        store.input_cancel(project, id)?;
    }
    Ok(
        serde_json::json!({"id":id,"chargedBytes":record.charged_bytes,"applied":apply,"scope":"uncommitted-input-reservation-only"}),
    )
}

#[cfg(test)]
mod tests;
