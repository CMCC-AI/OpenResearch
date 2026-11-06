//! Bounded observations only. This inventory never authorizes reclamation.
use super::*;
use crate::local::materials::Package;
use std::{collections::BTreeSet, fs, io::Read, time::Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    regular_file_bytes: u64,
    regular_files: u64,
    skipped_links: u64,
    unavailable_entries: u64,
    complete: bool,
}
impl Default for Usage {
    fn default() -> Self {
        Self {
            regular_file_bytes: 0,
            regular_files: 0,
            skipped_links: 0,
            unavailable_entries: 0,
            complete: true,
        }
    }
}
impl Usage {
    fn add(&mut self, other: Self) {
        self.regular_file_bytes = self
            .regular_file_bytes
            .saturating_add(other.regular_file_bytes);
        self.regular_files += other.regular_files;
        self.skipped_links += other.skipped_links;
        self.unavailable_entries += other.unavailable_entries;
        self.complete &= other.complete;
    }
}
struct Budget {
    entries: usize,
    maximum: usize,
    start: Instant,
}
impl Budget {
    fn take(&mut self) -> bool {
        if self.entries >= self.maximum || self.start.elapsed() >= Duration::from_secs(3) {
            return false;
        }
        self.entries += 1;
        true
    }
}
fn scan(path: &Path, depth: usize, budget: &mut Budget) -> Usage {
    let mut result = Usage::default();
    if depth > 64 || !budget.take() {
        result.complete = false;
        return result;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return result,
        Err(_) => {
            result.complete = false;
            result.unavailable_entries += 1;
            return result;
        }
    };
    if metadata.is_symlink() {
        result.skipped_links = 1;
        result.complete = false;
    } else if metadata.is_file() {
        result.regular_file_bytes = metadata.len();
        result.regular_files = 1;
    } else if metadata.is_dir() {
        match fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries {
                    if !budget.take() {
                        result.complete = false;
                        break;
                    }
                    match entry {
                        Ok(entry) => result.add(scan(&entry.path(), depth + 1, budget)),
                        Err(_) => {
                            result.complete = false;
                            result.unavailable_entries += 1;
                        }
                    }
                }
            }
            Err(_) => {
                result.complete = false;
                result.unavailable_entries += 1;
            }
        }
    } else {
        result.complete = false;
        result.unavailable_entries += 1;
    }
    result
}
fn single_component(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && Path::new(value).components().count() == 1
        && matches!(
            Path::new(value).components().next(),
            Some(std::path::Component::Normal(_))
        )
}
fn manifest(path: &Path) -> Result<Package> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(anyhow!("manifest is not a regular file"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(anyhow!("material manifest exceeds inventory limit"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
impl Store {
    pub fn project_storage_usage(&self, project: &str) -> Result<serde_json::Value> {
        let start = Instant::now();
        let mut budget = Budget {
            entries: 0,
            maximum: 100_000,
            start,
        };
        let project = self
            .get_local_project(project)?
            .ok_or_else(|| anyhow!("project not found"))?;
        if !single_component(&project.slug) {
            return Err(anyhow!("项目目录标识无效"));
        }
        let database = Path::new(self.conn.path().ok_or_else(|| anyhow!("需要持久数据库"))?);
        let root = database.parent().ok_or_else(|| anyhow!("数据库目录无效"))?;
        let tx = self.conn.unchecked_transaction()?;
        let (events,receipt_bytes):(u64,u64)=self.conn.query_row("SELECT count(*),COALESCE(sum(length(CAST(receipt AS BLOB))),0) FROM material_read_events WHERE project_id=?1",[&project.id],|r| Ok((r.get(0)?,r.get(1)?)))?;
        let (studies,document_bytes):(u64,u64)=self.conn.query_row("SELECT count(*),COALESCE(sum(length(CAST(document AS BLOB))),0) FROM research_studies WHERE project_id=?1",[&project.id],|r| Ok((r.get(0)?,r.get(1)?)))?;
        let mut statement=self.conn.prepare("SELECT id,json_extract(document,'$.deliverySnapshot.archive.sha256') FROM research_studies WHERE project_id=?1 ORDER BY id LIMIT 1001")?;
        let rows = statement.query_map([&project.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        let mut current = BTreeSet::new();
        let mut references_complete = true;
        for (index, row) in rows.enumerate() {
            let (study, hash) = row?;
            if index == 1000 {
                references_complete = false;
                break;
            }
            if let Some(hash) = hash {
                current.insert((study, hash));
            }
        }
        drop(statement);
        tx.commit()?;
        let query_ms = start.elapsed().as_millis();
        let project_files = root.join("files").join(&project.slug);
        let project_usage = scan(&project_files, 0, &mut budget);
        let bundles = project_files.join("research/.delivery-bundles");
        let bundle_usage = scan(&bundles, 0, &mut budget);
        let mut sealed = Usage::default();
        let mut unsealed = Usage::default();
        let mut sealed_packages = 0;
        let mut unsealed_packages = 0;
        let mut unknown_ownership = 0;
        let material_root = root.join("materials");
        let mut materials_complete = true;
        if material_root.is_symlink() {
            materials_complete = false;
        } else if let Ok(entries) = fs::read_dir(&material_root) {
            for entry in entries {
                if !budget.take() {
                    materials_complete = false;
                    break;
                }
                let Ok(entry) = entry else {
                    materials_complete = false;
                    continue;
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                if uuid::Uuid::parse_str(&name).is_err() {
                    continue;
                }
                if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                    materials_complete = false;
                    continue;
                }
                let package = match manifest(&entry.path().join("manifest.json")) {
                    Ok(package) if package.id == name => package,
                    _ => {
                        unknown_ownership += 1;
                        materials_complete = false;
                        continue;
                    }
                };
                if package.project_id != project.id {
                    continue;
                }
                if package.ready {
                    sealed_packages += 1;
                    sealed.add(scan(&entry.path(), 0, &mut budget));
                } else {
                    unsealed_packages += 1;
                    unsealed.add(scan(&entry.path(), 0, &mut budget));
                }
            }
        } else if material_root.exists() {
            materials_complete = false;
        }
        let mut shared = serde_json::Map::new();
        for (label, path) in [
            ("database", database.to_path_buf()),
            ("wal", PathBuf::from(format!("{}-wal", database.display()))),
            ("shm", PathBuf::from(format!("{}-shm", database.display()))),
        ] {
            shared.insert(
                label.into(),
                serde_json::to_value(scan(&path, 0, &mut budget))?,
            );
        }
        Ok(
            serde_json::json!({"projectId":project.id,"observedAt":now_ms(),"elapsedMs":start.elapsed().as_millis(),"metadataQueryMs":query_ms,
            "projectFilesIncludingDeliveryBundles":project_usage,"deliveryBundlesSubset":bundle_usage,
            "materials":{"sealed":sealed,"unsealed":unsealed,"sealedPackages":sealed_packages,"unsealedPackages":unsealed_packages,"ownershipScanComplete":materials_complete,"unattributedManifestCount":unknown_ownership,"executorLimitBytes":crate::local::materials::storage_limit()?},
            "projectMetadata":{"readEvents":events,"receiptJsonBytes":receipt_bytes,"studies":studies,"studyJsonBytes":document_bytes},
            "sharedExecutorDatabase":shared,
            "scanBudget":{"visitedEntries":budget.entries,"maximumEntries":budget.maximum,"maximumDepth":64,"budgetMs":3000},
            "archiveRetention":{"currentDescriptorCount":current.len(),"referenceScanComplete":references_complete,"allCachedArchivesProtected":true,"deletionCandidates":[]},
            "meaning":"观测普通文件的逻辑字节数，不是物理磁盘占用；目录扫描预算为 100000 次、64 层、3 秒，按条目检查；未完成项是下界，链接不跟随。材料限额属于执行器，当前项目占用不是执行器剩余额度。数据库文件属于整个私人执行器，不能按项目相加；交付包已包含于项目文件，不能重复相加。历史审批归档未完整登记，所有缓存 ZIP 保留，本报告不授权回收。扫描与文件写入可并发，数值不是配额准入快照。"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_is_bounded_and_measures_regular_logical_bytes() {
        let root = std::env::temp_dir().join(format!("orx-inventory-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("a"), b"abc").unwrap();
        fs::write(root.join("nested/b"), b"defgh").unwrap();
        let mut budget = Budget {
            entries: 0,
            maximum: 100,
            start: Instant::now(),
        };
        let usage = scan(&root, 0, &mut budget);
        assert!(usage.complete);
        assert_eq!(usage.regular_file_bytes, 8);
        assert_eq!(usage.regular_files, 2);
        let mut budget = Budget {
            entries: 0,
            maximum: 1,
            start: Instant::now(),
        };
        assert!(!scan(&root, 0, &mut budget).complete);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, root.join("nested/loop")).unwrap();
            let mut budget = Budget {
                entries: 0,
                maximum: 100,
                start: Instant::now(),
            };
            let usage = scan(&root, 0, &mut budget);
            assert!(!usage.complete);
            assert_eq!(usage.skipped_links, 1);
            assert_eq!(usage.regular_file_bytes, 8);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
