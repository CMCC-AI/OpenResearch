//! Hash/copy outside SQLite write transactions. Human approval binds immutable ZIP bytes.
use super::files::FileSource;
use super::*;
use std::io::{Read, Write};

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 2048;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDescriptor {
    pub format_version: u32,
    pub sha256: String,
    pub bytes: u64,
    pub manifest_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_version: Option<u32>,
    pub scope_hash: String,
    pub identity_hash: String,
    pub archive: ArchiveDescriptor,
}
pub struct PreparedDelivery {
    pub scope: String,
    identity: String,
    snapshot: DeliverySnapshot,
    files: Vec<FileSource>,
}
struct TempArchive(PathBuf);
impl Drop for TempArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
struct Builder {
    zip: zip::ZipWriter<std::fs::File>,
    files: Vec<FileSource>,
    entries: Vec<serde_json::Value>,
    bytes: u64,
}
impl Builder {
    fn bytes(&mut self, name: &str, bytes: &[u8]) -> Result<()> {
        self.admit(name, bytes.len() as u64)?;
        self.zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .last_modified_time(zip::DateTime::default()),
        )?;
        self.zip.write_all(bytes)?;
        self.entries
            .push(serde_json::json!({"path":name,"bytes":bytes.len(),"sha256":digest(bytes)}));
        Ok(())
    }
    fn admit(&mut self, name: &str, size: u64) -> Result<()> {
        if !safe_relative(name)
            || self.entries.len() >= MAX_ENTRIES
            || self.entries.iter().any(|e| e["path"] == name)
        {
            return Err(anyhow!("研究包路径重复、越界或文件数超过 2048"));
        }
        self.bytes = self
            .bytes
            .checked_add(size)
            .ok_or_else(|| anyhow!("研究包大小溢出"))?;
        if self.bytes > MAX_BYTES {
            return Err(anyhow!("研究包内容超过 512 MiB，不能静默省略文件"));
        }
        Ok(())
    }
    fn file(
        &mut self,
        name: &str,
        path: &Path,
        expected: Option<&str>,
        expected_bytes: Option<u64>,
    ) -> Result<String> {
        let mut file = FileSource::open(path, "交付文件")?;
        if expected_bytes.is_some_and(|size| size != file.bytes()) {
            return Err(if let Some(path) = name.strip_prefix("artifacts/") {
                anyhow!("产物变化，需要重新审查: {path}")
            } else {
                anyhow!("交付文件大小已变化: {name}")
            });
        }
        self.admit(name, file.bytes())?;
        self.zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .last_modified_time(zip::DateTime::default()),
        )?;
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        let expected_size = file.bytes();
        let mut reader = file.reader();
        loop {
            let count = match reader.read(&mut buffer) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 {
                break;
            }
            if count as u64 > expected_size.saturating_sub(size) {
                return Err(anyhow!("交付文件在复制期间增长: {name}"));
            }
            self.zip.write_all(&buffer[..count])?;
            hash.update(&buffer[..count]);
            size += count as u64;
        }
        file.check_unchanged()?;
        let hash = format!("{:x}", hash.finalize());
        if size != file.bytes() || expected.is_some_and(|expected| expected != hash) {
            return Err(if let Some(path) = name.strip_prefix("artifacts/") {
                anyhow!("产物变化，需要重新审查: {path}")
            } else {
                anyhow!("交付文件内容已变化，需要重新审查: {name}")
            });
        }
        self.entries
            .push(serde_json::json!({"path":name,"bytes":size,"sha256":hash}));
        self.files.push(file);
        Ok(hash)
    }
}
pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TRIGGER IF NOT EXISTS research_delivery_snapshot_guard BEFORE UPDATE ON research_studies
        WHEN json_type(OLD.document,'$.deliverySnapshot')='object' AND json_type(NEW.document,'$.deliverySnapshot') IS NOT 'object'
        BEGIN SELECT RAISE(ABORT,'交付快照已启用，请使用支持快照的版本'); END;")?;
    Ok(())
}

impl Store {
    pub(crate) fn research_delivery_identity(&self, study: &Study) -> Result<String> {
        let evidence = self.research_evidence(study)?;
        let mut runs = self.research_runs(study)?;
        runs.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(digest(&serde_json::to_vec(
            &serde_json::json!({"project":study.project_id,"session":study.session_id,"mode":study.mode,"plans":study.plans,"claims":study.claims,"claimRevision":study.claim_revision,"materialCitationRevision":study.material_citation_revision,"changes":evidence.changes,"runs":runs}),
        )?))
    }
    pub(super) fn archive_dir(&self, study: &Study) -> Result<PathBuf> {
        if study.id.is_empty()
            || !study
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(anyhow!("研究标识无效"));
        }
        let project = self
            .get_local_project(&study.project_id)?
            .ok_or_else(|| anyhow!("项目不存在"))?;
        if !super::super::storage_usage::single_component(&project.slug) {
            return Err(anyhow!("项目目录标识无效"));
        }
        let root = self.research_root(study)?;
        Ok(root
            .parent()
            .ok_or_else(|| anyhow!("研究目录无效"))?
            .join(".delivery-bundles")
            .join(&study.id))
    }
    pub fn research_prepare_delivery(&self, study: &Study) -> Result<PreparedDelivery> {
        self.research_prepare_delivery_at(study, &crate::local::materials::root(), |_| Ok(()))
    }
    pub(super) fn research_prepare_delivery_at(
        &self,
        study: &Study,
        material_root: &Path,
        mut after_file: impl FnMut(&str) -> Result<()>,
    ) -> Result<PreparedDelivery> {
        let plan = study.plan()?;
        if plan.tasks.iter().any(|t| t.state != "completed") {
            return Err(anyhow!("全部计划任务必须通过验收后才能申请交付确认"));
        }
        if !self.conn.is_autocommit() {
            return Err(anyhow!("交付准备必须在 SQLite 写事务外执行"));
        }
        if self
            .research_runs(study)?
            .iter()
            .any(|r| !crate::local::is_terminal(&r.status))
        {
            return Err(anyhow!("仍有未结束的运行"));
        }
        let identity = self.research_delivery_identity(study)?;
        let evidence = self.research_evidence(study)?;
        let evidence_digest = evidence.digest()?;
        for claim in &evidence.claims {
            self.research_validate_material_claim(study, claim)?;
        }
        if !evidence.changes.is_empty() {
            claims::require_review_roles(plan.tasks.iter().map(|t| t.spec.role.as_str()))?;
        }
        if plan.tasks.iter().any(|t| {
            matches!(
                t.spec.role.as_str(),
                "as-independent-reviewer" | "as-quality-citation-auditor"
            ) && t.evidence_digest.as_deref() != Some(&evidence_digest)
        }) {
            return Err(anyhow!("审查后证据已变化，请修订计划并重新审查"));
        }
        let directory = self.archive_dir(study)?;
        std::fs::create_dir_all(&directory)?;
        let mut lock = fd_lock::RwLock::new(
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(directory.join("prepare.lock"))?,
        );
        let _lock = lock.write()?;
        let temp = TempArchive(directory.join(format!(".prepare-{}.zip", uuid::Uuid::new_v4())));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true).read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut builder = Builder {
            zip: zip::ZipWriter::new(options.open(&temp.0)?),
            files: vec![],
            entries: vec![],
            bytes: 0,
        };
        let root = self.research_root(study)?;
        let mut artifacts: Vec<_> = plan.tasks.iter().flat_map(|t| &t.artifacts).collect();
        artifacts.sort_by(|a, b| a.path.cmp(&b.path));
        for artifact in artifacts {
            if artifact.bytes > MAX_ARTIFACT_BYTES {
                return Err(anyhow!("单个研究包产物超过 32 MiB"));
            }
            if !safe_relative(&artifact.path) {
                return Err(anyhow!("产物路径越界"));
            }
            let base = crate::paths::canonicalize(&root)?;
            let path = crate::paths::canonicalize(base.join(&artifact.path))?;
            if !path.starts_with(&base) {
                return Err(anyhow!("产物路径越界"));
            }
            builder.file(
                &format!("artifacts/{}", artifact.path),
                &path,
                Some(&artifact.sha256),
                Some(artifact.bytes),
            )?;
            after_file(&format!("artifacts/{}", artifact.path))?;
        }
        let selected: HashSet<_> = plan
            .tasks
            .iter()
            .flat_map(|t| t.run_ids.iter().map(String::as_str))
            .chain(
                evidence
                    .claims
                    .iter()
                    .filter_map(|c| c.input.run_id.as_deref()),
            )
            .collect();
        let mut runs = self.research_runs(study)?;
        runs.sort_by(|a, b| a.id.cmp(&b.id));
        let mut provenance = vec![];
        for run in runs.iter().filter(|r| selected.contains(r.id.as_str())) {
            if !safe_relative(&run.id) || run.id.contains('/') {
                return Err(anyhow!("Run 标识越界"));
            }
            let log_hash = builder.file(
                &format!("runs/{}/log.txt", run.id),
                &self.research_log_path(&run.id)?,
                None,
                None,
            )?;
            after_file(&format!("runs/{}/log.txt", run.id))?;
            if evidence.claims.iter().any(|c| {
                c.input.support == "experiment"
                    && c.input.run_id.as_deref() == Some(&run.id)
                    && c.log_sha256.as_ref() != Some(&log_hash)
            }) {
                return Err(anyhow!("证据日志已变化，需要重新审查"));
            }
            builder.bytes(
                &format!("runs/{}/metadata.json", run.id),
                &serde_json::to_vec(&serde_json::json!({"id":run.id,"experimentId":run.experiment_id,"projectId":run.project_id,"status":run.status,"commit":run.commit_sha,"createdAt":run.created_at,"endedAt":run.ended_at,"exitCode":run.exit_code}))?,
            )?;
            let backend = crate::jobs::BackendDescriptor::parse(&run.backend_json)?;
            provenance.push(serde_json::json!({"id":run.id,"commit":run.commit_sha,"status":run.status,"logHash":log_hash,"sourceHash":backend.source_digest}));
        }
        let mut sources: std::collections::BTreeMap<(String, String), serde_json::Value> =
            std::collections::BTreeMap::new();
        let mut receipts = HashSet::new();
        for claim in &evidence.claims {
            let Some(citation) = &claim.material_citation else {
                continue;
            };
            let key = (citation.package_id.clone(), citation.source.clone());
            if let Some(existing) = sources.get(&key) {
                if existing["sha256"] != citation.sha256 || existing["path"] != citation.path {
                    return Err(anyhow!("同一来源引用了不一致的材料版本"));
                }
            } else {
                let manifest_path = material_root
                    .join(&citation.package_id)
                    .join("manifest.json");
                let mut manifest = FileSource::open(&manifest_path, "材料清单")?;
                if manifest.bytes() > 4 * 1024 * 1024 {
                    return Err(anyhow!("材料清单超过 4 MiB"));
                }
                let mut bytes = vec![];
                manifest
                    .reader()
                    .take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > 4 * 1024 * 1024 {
                    return Err(anyhow!("材料清单超过 4 MiB"));
                }
                manifest.check_unchanged()?;
                let package: crate::local::materials::Package = serde_json::from_slice(&bytes)?;
                let entry = package
                    .files
                    .iter()
                    .find(|e| e.id == citation.source)
                    .ok_or_else(|| anyhow!("引用来源不存在"))?;
                if !package.ready
                    || package.id != citation.package_id
                    || package.project_id != study.project_id
                    || entry.path != citation.path
                    || entry.format != citation.format
                    || entry.sha256 != citation.sha256
                    || entry.size > crate::local::materials::MAX_FILE as u64
                    || !safe_relative(&entry.path)
                {
                    return Err(anyhow!("引用材料登记信息已变化"));
                }
                let base = crate::paths::canonicalize(
                    material_root.join(&citation.package_id).join("originals"),
                )?;
                let path = crate::paths::canonicalize(base.join(&entry.path))?;
                if !path.starts_with(&base) {
                    return Err(anyhow!("材料原件路径越界"));
                }
                let name = format!(
                    "materials/{}/{}/{}",
                    citation.package_id, citation.source, citation.path
                );
                builder.file(&name, &path, Some(&citation.sha256), Some(entry.size))?;
                after_file(&name)?;
                builder.files.push(manifest);
                sources.insert(key,serde_json::json!({"packageId":citation.package_id,"source":citation.source,"path":citation.path,"sha256":citation.sha256,"bytes":entry.size,"archivePath":name}));
            }
            if receipts.insert(citation.read_event_id.clone()) {
                let (body,state):(String,String)=self.conn.query_row("SELECT receipt,output_state FROM material_read_events WHERE project_id=?1 AND id=?2",params![study.project_id,citation.read_event_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
                builder.bytes(&format!("read-receipts/{}.json",citation.read_event_id),&serde_json::to_vec(&serde_json::json!({"id":citation.read_event_id,"receipt":serde_json::from_str::<serde_json::Value>(&body)?,"outputState":state}))?)?;
            }
        }
        let mut scope = serde_json::json!({"plan":plan,"claims":evidence.claims,"runs":provenance});
        if !evidence.changes.is_empty() {
            scope["claimChanges"] = serde_json::to_value(&evidence.changes)?;
        }
        let has_sources = !sources.is_empty();
        if has_sources {
            scope["materialSources"] =
                serde_json::to_value(sources.into_values().collect::<Vec<_>>())?;
        }
        builder.bytes("README.txt", b"OpenResearch research package, archive format 1\nresearch.json: current plan, active claims and run provenance.\nmanifest.json: SHA-256 and byte size of each payload file.\nmaterials/: immutable originals cited by active claims, preserving paths.\nartifacts/: accepted outputs of the current plan.\nruns/: selected run logs and minimal lifecycle metadata.\nread-receipts/: recorded source and selection provenance, not proof of understanding.\nThe final approval binds this ZIP through the delivery scope outside the archive.\n")?;
        builder.bytes("research.json", &serde_json::to_vec(&scope)?)?;
        let manifest =
            serde_json::to_vec(&serde_json::json!({"formatVersion":1,"files":builder.entries}))?;
        let manifest_hash = digest(&manifest);
        builder.bytes("manifest.json", &manifest)?;
        let archive = builder.zip.finish()?;
        archive.sync_all()?;
        drop(archive);
        let mut archive = FileSource::open(&temp.0, "封存研究包")?;
        let descriptor = ArchiveDescriptor {
            format_version: 1,
            sha256: archive.hash()?,
            bytes: archive.bytes(),
            manifest_sha256: manifest_hash,
        };
        drop(archive);
        let target = directory.join(format!("{}.zip", descriptor.sha256));
        let existed = target.try_exists()?;
        if existed {
            let mut existing = FileSource::open(&target, "封存研究包")?;
            if existing.bytes() != descriptor.bytes || existing.hash()? != descriptor.sha256 {
                return Err(anyhow!("已有封存研究包损坏，请核查存储"));
            }
        } else {
            std::fs::rename(&temp.0, &target)?;
        }
        let mut final_archive = FileSource::open(&target, "封存研究包")?;
        final_archive.lock_shared()?;
        if final_archive.hash()? != descriptor.sha256 {
            return Err(anyhow!("封存研究包发布期间发生变化"));
        }
        builder.files.push(final_archive);
        if has_sources {
            scope["deliveryBundle"] = serde_json::to_value(&descriptor)?;
        }
        let scope = serde_json::to_string(&scope)?;
        self.research_register_archive(study, &descriptor, existed, &digest(scope.as_bytes()))?;
        let snapshot = DeliverySnapshot {
            catalog_version: Some(1),
            scope_hash: digest(scope.as_bytes()),
            identity_hash: identity.clone(),
            archive: descriptor,
        };
        let prepared = PreparedDelivery {
            scope,
            identity,
            snapshot,
            files: builder.files,
        };
        self.research_validate_delivery(study, &prepared)?;
        Ok(prepared)
    }
    pub fn research_validate_delivery(
        &self,
        study: &Study,
        prepared: &PreparedDelivery,
    ) -> Result<()> {
        if self
            .research_runs(study)?
            .iter()
            .any(|r| !crate::local::is_terminal(&r.status))
        {
            return Err(anyhow!("仍有未结束的运行"));
        }
        if self.research_delivery_identity(study)? != prepared.identity {
            return Err(anyhow!("研究输入、任务或 Run 已变化，请重新准备交付"));
        }
        for file in &prepared.files {
            file.check_unchanged()?;
        }
        Ok(())
    }
    pub fn research_apply_delivery(
        &self,
        study: &mut Study,
        prepared: &PreparedDelivery,
    ) -> Result<()> {
        self.research_validate_delivery(study, prepared)?;
        study.delivery_snapshot = Some(prepared.snapshot.clone());
        Ok(())
    }
    pub fn research_request_package(&self, id: &str) -> Result<()> {
        let initial = self.research_study(id)?;
        initial.ensure_active()?;
        let prepared = self.research_prepare_delivery(&initial)?;
        self.research_update(id, |study| {
            study.ensure_active()?;
            self.research_apply_delivery(study, &prepared)?;
            study.delivery_error = None;
            study.request_gate(
                crate::local::research::delivery_gate(study.workflow_mode()),
                prepared.scope.clone(),
            )
        })
    }
    pub fn research_download_package(&self, id: &str) -> Result<(std::fs::File, DeliverySnapshot)> {
        let study = self.research_study(id)?;
        if self
            .research_runs(&study)?
            .iter()
            .any(|r| !crate::local::is_terminal(&r.status))
        {
            return Err(anyhow!("仍有未结束的运行"));
        }
        let snapshot = study
            .delivery_snapshot
            .as_ref()
            .ok_or_else(|| anyhow!("研究包尚未准备，请重新申请交付确认"))?
            .clone();
        if self.research_delivery_identity(&study)? != snapshot.identity_hash {
            return Err(anyhow!("研究内容已变化，请重新申请交付确认"));
        }
        let gate = crate::local::research::delivery_gate(study.workflow_mode());
        let decision = study
            .decisions
            .iter()
            .find(|d| {
                d.version == study.plan().map_or(0, |p| p.version)
                    && d.gate == gate
                    && d.status == "approved"
                    && d.scope_hash == snapshot.scope_hash
            })
            .ok_or_else(|| anyhow!("当前研究包尚未通过人工交付确认"))?;
        study.require_gate(gate, &decision.scope)?;
        if snapshot.archive.sha256.len() != 64
            || !snapshot
                .archive
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err(anyhow!("封存研究包标识无效"));
        }
        let mut file = FileSource::open(
            &self
                .archive_dir(&study)?
                .join(format!("{}.zip", snapshot.archive.sha256)),
            "封存研究包",
        )?;
        file.lock_shared()?;
        if file.bytes() != snapshot.archive.bytes || file.hash()? != snapshot.archive.sha256 {
            return Err(anyhow!("封存研究包已变化，不能下载"));
        }
        let current = self.research_study(id)?;
        if self.research_delivery_identity(&current)? != snapshot.identity_hash
            || current.delivery_snapshot.as_ref() != Some(&snapshot)
            || !current
                .decisions
                .iter()
                .any(|d| d.id == decision.id && d.status == "approved")
        {
            return Err(anyhow!("研究确认状态已变化，请刷新后下载"));
        }
        Ok((file.into_file()?, snapshot))
    }
}
