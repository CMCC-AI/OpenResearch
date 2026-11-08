//! Independent per-Run input bytes; availability is not consumption evidence.
use super::*;
use crate::{run_inputs::InputSetRef, store::RunStatus};

#[cfg(test)]
mod tests;

pub(crate) struct PreparedInput {
    pub reference: InputSetRef,
    project: String,
    manifest: Manifest,
    witnesses: Vec<Witness>,
}
impl PreparedInput {
    pub(crate) fn check(&self, store: &Store) -> Result<()> {
        let current = store.input_record(&self.project, &self.reference.id)?;
        if current.state != "frozen" || current.manifest_sha256 != self.reference.manifest_sha256 {
            return Err(anyhow!("冻结输入身份已变化"));
        }
        check_layout(
            &existing_pool(store)?.join("sets").join(&self.reference.id),
            &self.manifest,
        )?;
        for witness in &self.witnesses {
            witness.check()?;
        }
        Ok(())
    }
}
pub(crate) fn prepare(store: &Store, project: &str, id: &str) -> Result<PreparedInput> {
    project_slug(store, project)?;
    if !uuid_valid(id) {
        return Err(anyhow!("输入集合 ID 无效"));
    }
    let record = store.input_record(project, id)?;
    if record.state != "frozen" {
        return Err(anyhow!("输入集合尚未冻结"));
    }
    let witnesses = verify_files(
        &existing_pool(store)?.join("sets").join(id),
        &record.manifest,
    )?;
    Ok(PreparedInput {
        reference: InputSetRef {
            id: id.into(),
            manifest_sha256: record.manifest_sha256,
        },
        project: project.into(),
        manifest: record.manifest,
        witnesses,
    })
}
fn roots(store: &Store, create: bool) -> Result<(PathBuf, PathBuf)> {
    let root = existing_pool(store)?;
    let dirs = (root.join("deliveries"), root.join("delivery-locks"));
    for dir in [&dirs.0, &dirs.1] {
        if create {
            super::files::directory(dir)?;
        } else {
            match fs::symlink_metadata(dir) {
                Ok(m) if m.file_type().is_dir() => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(anyhow!("投递目录缺失或变化")),
            }
        }
    }
    Ok(dirs)
}
fn lease_file(path: &Path, create: bool) -> Result<fs::File> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_file() => {}
        Err(e) if create && e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(anyhow!("投递锁未知")),
    }
    let file = fs::OpenOptions::new()
        .create(create)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(anyhow!("投递锁类型变化"));
    }
    Ok(file)
}
fn record(
    store: &Store,
    project: &str,
    run_id: &str,
) -> Result<(crate::store::input_deliveries::Delivery, Manifest)> {
    if !uuid_valid(run_id) {
        return Err(anyhow!("Run ID 无效"));
    }
    let delivery = store.input_delivery(project, run_id)?;
    let input = store.input_record(project, &delivery.input_id)?;
    let run = store
        .get_run(run_id)?
        .ok_or_else(|| anyhow!("Run 不存在"))?;
    let descriptor = crate::jobs::BackendDescriptor::parse(&run.backend_json)?;
    if run.project_id != project
        || descriptor.kind != "local_job"
        || descriptor.input_set
            != Some(InputSetRef {
                id: delivery.input_id.clone(),
                manifest_sha256: delivery.manifest_sha256.clone(),
            })
        || input.state != "frozen"
        || input.manifest_sha256 != delivery.manifest_sha256
    {
        return Err(anyhow!("Run 投递身份不匹配"));
    }
    blob_sizes(&input.manifest)?;
    Ok((delivery, input.manifest))
}
fn expected(manifest: &Manifest) -> Result<BTreeMap<PathBuf, bool>> {
    blob_sizes(manifest)?;
    let mut tree = BTreeMap::from([
        (PathBuf::from("files"), true),
        (PathBuf::from("manifest.json"), false),
    ]);
    for file in &manifest.files {
        let path = PathBuf::from("files").join(&file.path);
        for parent in path
            .ancestors()
            .skip(1)
            .filter(|p| !p.as_os_str().is_empty())
        {
            tree.insert(parent.into(), true);
        }
        tree.insert(path, false);
    }
    Ok(tree)
}
/// Enumerate only a bounded whitelist; any unknown path blocks all cleanup.
fn layout(dir: &Path, manifest: &Manifest, complete: bool) -> Result<Vec<(PathBuf, bool)>> {
    match fs::symlink_metadata(dir) {
        Err(e) if !complete && e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(m) if m.file_type().is_dir() => {}
        _ => return Err(anyhow!("投递目录状态未知")),
    }
    let expected = expected(manifest)?;
    let mut seen = BTreeSet::new();
    let mut todo = vec![PathBuf::new()];
    let mut entries = Vec::new();
    while let Some(relative) = todo.pop() {
        for entry in fs::read_dir(dir.join(&relative))? {
            let entry = entry?;
            let path = relative.join(entry.file_name());
            let is_dir = *expected
                .get(&path)
                .ok_or_else(|| anyhow!("投递包含未知文件，保留全部内容"))?;
            let kind = entry.file_type()?;
            if !seen.insert(path.clone())
                || (is_dir && !kind.is_dir())
                || (!is_dir && !kind.is_file())
            {
                return Err(anyhow!("投递路径类型变化"));
            }
            if is_dir {
                todo.push(path.clone());
            }
            entries.push((path, is_dir));
        }
    }
    if complete && seen.len() != expected.len() {
        return Err(anyhow!("投递副本不完整"));
    }
    Ok(entries)
}
fn verify_files_at(dir: &Path, manifest: &Manifest) -> Result<Vec<Witness>> {
    layout(dir, manifest, true)?;
    let json = serde_json::to_vec(manifest)?;
    let mut files: Vec<_> = manifest
        .files
        .iter()
        .map(|f| {
            (
                PathBuf::from("files").join(&f.path),
                f.bytes,
                f.sha256.clone(),
            )
        })
        .collect();
    files.push((
        PathBuf::from("manifest.json"),
        json.len() as u64,
        hash(&json),
    ));
    let mut witnesses = Vec::new();
    for (relative, bytes, digest) in files {
        let path = dir.join(relative);
        let mut source = FileSource::open(&path, "Run 输入副本")?;
        if source.bytes() != bytes || source.hash()? != digest {
            return Err(anyhow!("Run 输入副本损坏或变化"));
        }
        witnesses.push(Witness {
            name: path.clone(),
            target: path.canonicalize()?,
            source: source.into_snapshot()?,
        });
    }
    Ok(witnesses)
}
fn readonly(path: &Path) -> Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)?;
    Ok(())
}
fn discard(dir: &Path, manifest: &Manifest, apply: bool) -> Result<()> {
    let mut entries = layout(dir, manifest, false)?;
    if !apply || !dir.exists() {
        return Ok(());
    }
    entries.sort_by_key(|(p, _)| std::cmp::Reverse(p.components().count()));
    for (relative, is_dir) in entries {
        let path = dir.join(relative);
        if is_dir {
            fs::remove_dir(path)?;
        } else {
            #[cfg(windows)]
            {
                let mut p = fs::metadata(&path)?.permissions();
                p.set_readonly(false);
                fs::set_permissions(&path, p)?;
            }
            fs::remove_file(path)?;
        }
    }
    fs::remove_dir(dir)?;
    Ok(())
}

pub(crate) fn deliver(store: &Store, project: &str, run_id: &str) -> Result<PathBuf> {
    deliver_with_check(store, project, run_id, |_| Ok(()))
}
fn deliver_with_check(
    store: &Store,
    project: &str,
    run_id: &str,
    mut check: impl FnMut(Phase) -> Result<()>,
) -> Result<PathBuf> {
    let (delivery, manifest) = record(store, project, run_id)?;
    if delivery.state == "available" {
        verify(store, project, run_id)?;
        return Ok(roots(store, false)?.0.join(run_id).canonicalize()?);
    }
    if delivery.state != "preparing" {
        return Err(anyhow!("投递未完成，需要操作者检查/恢复"));
    }
    let (root, locks) = roots(store, true)?;
    let file = lease_file(&locks.join(run_id), true)?;
    file.sync_all()?;
    sync_directory(&locks)?;
    let mut lock = fd_lock::RwLock::new(file);
    let _guard = lock.try_write().map_err(|_| anyhow!("投递已有活跃租约"))?;
    if store.input_delivery(project, run_id)?.state != "preparing" {
        return Err(anyhow!("投递预约已变化"));
    }
    let dir = root.join(run_id);
    fs::create_dir(&dir)?;
    let result = (|| -> Result<()> {
        store.input_delivery_transition(run_id, "preparing", "copying", || Ok(()))?;
        check(Phase::Copying)?;
        let prepared = prepare(store, project, &delivery.input_id)?;
        super::files::directory(&dir.join("files"))?;
        for entry in &manifest.files {
            let target = PathBuf::from("files").join(&entry.path);
            let parents: Vec<_> = target
                .ancestors()
                .skip(1)
                .filter(|p| !p.as_os_str().is_empty())
                .collect();
            for parent in parents.into_iter().rev() {
                super::files::directory(&dir.join(parent))?;
            }
            let source_path = existing_pool(store)?
                .join("sets")
                .join(&delivery.input_id)
                .join("blobs")
                .join(&entry.sha256);
            let mut source = FileSource::open(&source_path, "冻结输入来源")?;
            if source.bytes() != entry.bytes {
                return Err(anyhow!("冻结输入大小变化"));
            }
            let path = dir.join(target);
            let mut out = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)?;
            let copied = std::io::copy(&mut source.reader(), &mut out)?;
            out.sync_all()?;
            drop(out);
            if copied != entry.bytes {
                return Err(anyhow!("输入复制时大小变化"));
            }
            source.check_unchanged()?;
            readonly(&path)?;
        }
        let path = dir.join("manifest.json");
        let mut out = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        out.write_all(&serde_json::to_vec(&manifest)?)?;
        out.sync_all()?;
        drop(out);
        readonly(&path)?;
        let witnesses = verify_files_at(&dir, &manifest)?;
        let mut directories = layout(&dir, &manifest, true)?
            .into_iter()
            .filter(|(_, d)| *d)
            .map(|(p, _)| dir.join(p))
            .collect::<Vec<_>>();
        directories.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for path in directories {
            sync_directory(&path)?;
        }
        sync_directory(&dir)?;
        sync_directory(&root)?;
        check(Phase::Committing)?;
        store.input_delivery_transition(run_id, "copying", "available", || {
            let run = store
                .get_run(run_id)?
                .ok_or_else(|| anyhow!("Run 不存在"))?;
            if run.status != "starting" || run.cancel_requested {
                return Err(anyhow!("Run 已取消或状态变化，未启动"));
            }
            prepared.check(store)?;
            layout(&dir, &manifest, true)?;
            for witness in &witnesses {
                witness.check()?;
            }
            Ok(())
        })
    })();
    if let Err(error) = result {
        // Unknown files or uncertain ownership retain both bytes and charge.
        if store
            .input_delivery(project, run_id)
            .is_ok_and(|d| d.state == "copying")
            && discard(&dir, &manifest, true).is_ok()
        {
            store.input_delivery_transition(run_id, "copying", "cancelled", || Ok(()))?;
        }
        return Err(anyhow!("Run 输入投递失败，保留预约供查询/恢复: {error}"));
    }
    dir.canonicalize().map_err(Into::into)
}
pub(crate) fn show(store: &Store, project: &str, run_id: &str) -> Result<serde_json::Value> {
    let (delivery, _) = record(store, project, run_id)?;
    Ok(serde_json::json!({"delivery":delivery,"consumptionObserved":false}))
}
pub(crate) fn verify(store: &Store, project: &str, run_id: &str) -> Result<serde_json::Value> {
    let (delivery, manifest) = record(store, project, run_id)?;
    if delivery.state != "available" {
        return Err(anyhow!("Run 输入尚未可用"));
    }
    verify_files_at(&roots(store, false)?.0.join(run_id), &manifest)?;
    let run = store
        .get_run(run_id)?
        .ok_or_else(|| anyhow!("Run 不存在"))?;
    let descriptor = crate::jobs::BackendDescriptor::parse(&run.backend_json)?;
    let digest = descriptor
        .source_digest
        .ok_or_else(|| anyhow!("代码归档摘要缺失"))?;
    let bytes = descriptor
        .source_size
        .ok_or_else(|| anyhow!("代码归档长度缺失"))?;
    let mut path = PathBuf::from(
        descriptor
            .source_path
            .ok_or_else(|| anyhow!("代码归档路径缺失"))?,
    );
    if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        path = store
            .input_data_root()?
            .join("source-snapshots")
            .join(format!("{digest}.tar"));
    }
    let mut source = FileSource::open(&path, "Run 代码归档")?;
    if source.bytes() != bytes || source.hash()? != digest {
        return Err(anyhow!("Run 代码归档缺失或摘要不匹配"));
    }
    Ok(
        serde_json::json!({"runId":run_id,"inputSet":{"id":delivery.input_id,"manifestSha256":delivery.manifest_sha256},"copiesVerified":true,"codeSnapshotVerified":true,"consumptionObserved":false}),
    )
}
pub(crate) fn recover(
    store: &Store,
    project: &str,
    run_id: &str,
    apply: bool,
) -> Result<serde_json::Value> {
    let (delivery, _) = record(store, project, run_id)?;
    if !matches!(delivery.state.as_str(), "preparing" | "copying") {
        return Err(anyhow!("仅能恢复未完成投递"));
    }
    let (root, locks) = roots(store, apply)?;
    let path = locks.join(run_id);
    let missing_lock =
        fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
    let dir = root.join(run_id);
    if missing_lock {
        if delivery.state != "preparing" || fs::symlink_metadata(&dir).is_ok() {
            return Err(anyhow!("投递锁/目录归属未知"));
        }
        if !apply {
            return Ok(
                serde_json::json!({"runId":run_id,"applied":false,"scope":"uncommitted-run-input-delivery-only","notStartedAtInspection":true}),
            );
        }
    }
    let mut lock = fd_lock::RwLock::new(lease_file(&path, apply)?);
    let _guard = lock.try_write().map_err(|_| anyhow!("投递仍在进行"))?;
    let (delivery, manifest) = record(store, project, run_id)?;
    if !matches!(delivery.state.as_str(), "preparing" | "copying") {
        return Err(anyhow!("投递预约已变化"));
    }
    if store
        .get_run(run_id)?
        .is_some_and(|run| run.status == "running")
    {
        return Err(anyhow!("Run 仍在运行，拒绝恢复投递"));
    }
    if delivery.state == "preparing" && fs::symlink_metadata(&dir).is_ok() {
        return Err(anyhow!("投递目录归属尚未确认"));
    }
    discard(&dir, &manifest, apply)?;
    if apply {
        store.input_delivery_transition(run_id, &delivery.state, "cancelled", || {
            store.update_status(
                run_id,
                RunStatus::Failed,
                Some(crate::store::now_ms()),
                None,
            )?;
            Ok(())
        })?;
    }
    Ok(
        serde_json::json!({"runId":run_id,"applied":apply,"scope":"uncommitted-run-input-delivery-only"}),
    )
}
