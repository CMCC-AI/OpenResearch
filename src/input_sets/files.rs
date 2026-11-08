//! Bounded snapshot files, path checks, stable identities and conservative cleanup.
use super::*;
use crate::verified_file::FileSnapshot;

pub(super) struct Witness {
    pub(super) name: PathBuf,
    pub(super) target: PathBuf,
    pub(super) source: FileSnapshot,
}
impl Witness {
    pub(super) fn check(&self) -> Result<()> {
        if self.name.canonicalize()? != self.target {
            return Err(anyhow!("输入来源路径核验期间变化"));
        }
        self.source.check_unchanged()
    }
}

pub(super) fn portable(path: &str) -> bool {
    crate::local::files::is_safe_rel_path(path)
        && path.len() <= 1024
        && !path.contains([':', '<', '>', '"', '|', '?', '*'])
        && !path.chars().any(char::is_control)
        && path.split('/').all(|s| {
            let base = s.split('.').next().unwrap_or("").to_ascii_lowercase();
            !s.ends_with(['.', ' '])
                && !matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
                && !(base.len() == 4
                    && (base.starts_with("com") || base.starts_with("lpt"))
                    && matches!(base.as_bytes()[3], b'1'..=b'9'))
        })
}
pub(super) fn directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_dir() => Ok(()),
        Ok(_) => Err(anyhow!("输入池目录不能是链接或特殊文件")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}
pub(super) fn pool(store: &Store) -> Result<PathBuf> {
    let root = store.input_data_root()?.join("input-sets");
    directory(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    }
    directory(&root.join("sets"))?;
    directory(&root.join("locks"))?;
    Ok(root)
}
pub(super) fn existing_pool(store: &Store) -> Result<PathBuf> {
    let root = store.input_data_root()?.join("input-sets");
    for path in [&root, &root.join("sets"), &root.join("locks")] {
        if !fs::symlink_metadata(path)?.file_type().is_dir() {
            return Err(anyhow!("冻结输入池目录缺失或已变化"));
        }
    }
    Ok(root)
}
#[cfg(unix)]
pub(super) fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}
#[cfg(not(unix))]
pub(super) fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}
pub(super) fn source_file(base: &Path, relative: &str) -> Result<(PathBuf, PathBuf, FileSource)> {
    if !crate::local::files::is_safe_rel_path(relative)
        || relative.len() > 1024
        || relative.contains(':')
        || relative.chars().any(char::is_control)
    {
        return Err(anyhow!("输入路径必须为安全相对路径"));
    }
    let root = base.canonicalize()?;
    let name = base.join(relative);
    let target = name.canonicalize()?;
    if !target.starts_with(&root) || !fs::symlink_metadata(&target)?.is_file() {
        return Err(anyhow!("输入来源越界或不是普通文件"));
    }
    let source = FileSource::open(&target, "冻结输入来源")?;
    if source.bytes() > MAX_BYTES {
        return Err(anyhow!("输入来源超过 64 MiB"));
    }
    Ok((name, target, source))
}

pub(super) fn blob_sizes(manifest: &Manifest) -> Result<BTreeMap<String, u64>> {
    if manifest.schema_version != 1
        || !uuid_valid(&manifest.id)
        || manifest.files.is_empty()
        || manifest.files.len() > 64
    {
        return Err(anyhow!("冻结清单版本或文件数无效"));
    }
    let mut paths: BTreeSet<String> = BTreeSet::new();
    let mut total = 0u64;
    for file in &manifest.files {
        let folded = file.path.to_lowercase();
        if !portable(&file.path)
            || paths.iter().any(|p| {
                p == &folded
                    || p.starts_with(&(folded.clone() + "/"))
                    || folded.starts_with(&(p.clone() + "/"))
            })
        {
            return Err(anyhow!("冻结目标路径不安全或冲突"));
        }
        paths.insert(folded);
        total = total
            .checked_add(file.bytes)
            .ok_or_else(|| anyhow!("冻结输入长度溢出"))?;
        if total > MAX_BYTES {
            return Err(anyhow!("冻结输入超出 64 MiB 逻辑预算"));
        }
    }
    let mut blobs = BTreeMap::new();
    for file in &manifest.files {
        if !digest_valid(&file.sha256) {
            return Err(anyhow!("冻结清单摘要无效"));
        }
        if let Some(old) = blobs.insert(file.sha256.clone(), file.bytes) {
            if old != file.bytes {
                return Err(anyhow!("相同摘要的长度不一致"));
            }
        }
    }
    Ok(blobs)
}
pub(super) fn check_layout(dir: &Path, manifest: &Manifest) -> Result<()> {
    if !fs::symlink_metadata(dir)?.file_type().is_dir()
        || !fs::symlink_metadata(dir.join("blobs"))?
            .file_type()
            .is_dir()
    {
        return Err(anyhow!("冻结集合目录已变化"));
    }
    let expected = blob_sizes(manifest)?;
    let check = |path: &Path, names: BTreeMap<std::ffi::OsString, bool>| -> Result<()> {
        let mut seen = BTreeSet::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let name = entry.file_name();
            let is_dir = names
                .get(&name)
                .ok_or_else(|| anyhow!("冻结集合包含未登记内容"))?;
            let kind = entry.file_type()?;
            if !seen.insert(name) || (*is_dir && !kind.is_dir()) || (!is_dir && !kind.is_file()) {
                return Err(anyhow!("冻结路径类型变化或包含重复内容"));
            }
        }
        if seen.len() != names.len() {
            return Err(anyhow!("冻结副本缺失"));
        }
        Ok(())
    };
    check(
        dir,
        [
            (std::ffi::OsString::from("blobs"), true),
            (std::ffi::OsString::from("manifest.json"), false),
        ]
        .into_iter()
        .collect(),
    )?;
    check(
        &dir.join("blobs"),
        expected
            .keys()
            .map(|key| (std::ffi::OsString::from(key), false))
            .collect(),
    )?;
    Ok(())
}
pub(super) fn verify_files(dir: &Path, manifest: &Manifest) -> Result<Vec<Witness>> {
    check_layout(dir, manifest)?;
    let mut expected = blob_sizes(manifest)?;
    let json = serde_json::to_vec(manifest)?;
    expected.insert("manifest.json".into(), json.len() as u64);
    let mut witnesses = Vec::new();
    for (name, bytes) in expected {
        let path = if name == "manifest.json" {
            dir.join(&name)
        } else {
            dir.join("blobs").join(&name)
        };
        if !fs::symlink_metadata(&path)?.file_type().is_file() {
            return Err(anyhow!("冻结文件不是普通文件"));
        }
        let mut source = FileSource::open(&path, "冻结输入副本")?;
        let expected = if name == "manifest.json" {
            hash(&json)
        } else {
            name
        };
        if source.bytes() != bytes || source.hash()? != expected {
            return Err(anyhow!("冻结副本缺失、损坏或摘要不匹配"));
        }
        witnesses.push(Witness {
            name: path.clone(),
            target: path.canonicalize()?,
            source: source.into_snapshot()?,
        });
    }
    Ok(witnesses)
}
/// Remove only paths allocated in an uncommitted record. Unknown files block all removal.
pub(super) fn discard(dir: &Path, manifest: &Manifest, apply: bool) -> Result<()> {
    match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(m) if m.file_type().is_dir() => {}
        _ => return Err(anyhow!("预约目录状态未知，保留供检查")),
    }
    let blobs = blob_sizes(manifest)?;
    let mut remove = Vec::new();
    let mut has_blobs = false;
    for item in fs::read_dir(dir)? {
        let item = item?;
        let name = item.file_name();
        if name == "manifest.json" && item.file_type()?.is_file() {
            remove.push(item.path());
        } else if name == "blobs" && item.file_type()?.is_dir() {
            has_blobs = true;
            for blob in fs::read_dir(item.path())? {
                let blob = blob?;
                let name = blob.file_name().to_string_lossy().into_owned();
                let key = name.strip_suffix(".part").unwrap_or(&name);
                if !blob.file_type()?.is_file() || !blobs.contains_key(key) {
                    return Err(anyhow!("预约包含未知文件，未删除任何文件"));
                }
                remove.push(blob.path());
            }
        } else {
            return Err(anyhow!("预约包含未知内容，未删除任何文件"));
        }
    }
    if !apply {
        return Ok(());
    }
    for path in remove {
        fs::remove_file(path)?;
    }
    if has_blobs {
        fs::remove_dir(dir.join("blobs"))?;
    }
    fs::remove_dir(dir)?;
    Ok(())
}
