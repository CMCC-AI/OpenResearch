//! Conservative retention: every observed delivery snapshot is permanent protection.
//! Only registered, never-published preparation objects can be reclaimed manually.
use super::{delivery::ArchiveDescriptor, files::FileSource, *};
use std::{fs, time::UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const SCAN_LIMIT: usize = 2000;
const BATCH_LIMIT: usize = 20;
const BATCH_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_archive_migrations')", [], |r|r.get(0))?;
    if exists
        && conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM research_archive_migrations WHERE version=1)",
            [],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS research_archive_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS research_archive_objects (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        study_id TEXT NOT NULL REFERENCES research_studies(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL,
        scope_hash TEXT NOT NULL DEFAULT '',
        legacy INTEGER NOT NULL CHECK(legacy IN (0,1)), created_at INTEGER NOT NULL,
        UNIQUE(study_id,sha256));
        CREATE TABLE IF NOT EXISTS research_archive_decision_scopes (
        study_id TEXT NOT NULL REFERENCES research_studies(id) ON DELETE CASCADE,
        scope_hash TEXT NOT NULL, PRIMARY KEY(study_id,scope_hash));
        CREATE TRIGGER IF NOT EXISTS research_archive_scopes_immutable BEFORE UPDATE ON research_archive_decision_scopes
        BEGIN SELECT RAISE(ABORT,'审批范围保留记录不可改写'); END;
        CREATE TRIGGER IF NOT EXISTS research_archive_scopes_retained BEFORE DELETE ON research_archive_decision_scopes
        WHEN EXISTS(SELECT 1 FROM research_studies WHERE id=OLD.study_id)
        BEGIN SELECT RAISE(ABORT,'审批范围保留记录不可删除'); END;
        CREATE TABLE IF NOT EXISTS research_archive_history (
        study_id TEXT NOT NULL, scope_hash TEXT NOT NULL, sha256 TEXT NOT NULL,
        PRIMARY KEY(study_id,scope_hash,sha256),
        FOREIGN KEY(study_id,sha256) REFERENCES research_archive_objects(study_id,sha256) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS research_archive_objects_page ON research_archive_objects(study_id,seq);
        CREATE INDEX IF NOT EXISTS research_archive_history_hash ON research_archive_history(study_id,sha256);
        CREATE TABLE IF NOT EXISTS research_archive_gc (
        id TEXT PRIMARY KEY, study_id TEXT NOT NULL, sha256 TEXT NOT NULL,
        preview_hash TEXT NOT NULL, requested_at INTEGER NOT NULL, completed_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('planned','removed','absent','aborted','failed')),
        FOREIGN KEY(study_id,sha256) REFERENCES research_archive_objects(study_id,sha256) ON DELETE CASCADE);
        CREATE TRIGGER IF NOT EXISTS research_archive_gc_insert_guard BEFORE INSERT ON research_archive_gc
        WHEN NEW.status!='planned' OR EXISTS(SELECT 1 FROM research_archive_history WHERE study_id=NEW.study_id AND sha256=NEW.sha256)
        OR EXISTS(SELECT 1 FROM research_archive_objects WHERE study_id=NEW.study_id AND sha256=NEW.sha256 AND (legacy=1 OR EXISTS(SELECT 1 FROM research_archive_decision_scopes d WHERE d.study_id=NEW.study_id AND d.scope_hash=research_archive_objects.scope_hash)))
        BEGIN SELECT RAISE(ABORT,'受保护归档不能回收'); END;
        CREATE TRIGGER IF NOT EXISTS research_archive_gc_immutable BEFORE UPDATE ON research_archive_gc
        WHEN OLD.status!='planned' OR NEW.status='planned' OR NEW.id IS NOT OLD.id OR NEW.study_id IS NOT OLD.study_id
        OR NEW.sha256 IS NOT OLD.sha256 OR NEW.preview_hash IS NOT OLD.preview_hash OR NEW.requested_at IS NOT OLD.requested_at OR NEW.completed_at IS NULL
        BEGIN SELECT RAISE(ABORT,'回收记录只能由待执行转为终态'); END;
        CREATE TRIGGER IF NOT EXISTS research_archive_gc_retained BEFORE DELETE ON research_archive_gc
        WHEN EXISTS(SELECT 1 FROM research_studies WHERE id=OLD.study_id)
        BEGIN SELECT RAISE(ABORT,'回收记录不可删除'); END;
        CREATE INDEX IF NOT EXISTS research_archive_gc_recovery ON research_archive_gc(study_id,status,requested_at,id);
        CREATE UNIQUE INDEX IF NOT EXISTS research_archive_gc_pending ON research_archive_gc(study_id,sha256) WHERE status='planned';
        CREATE TRIGGER IF NOT EXISTS research_archive_objects_immutable BEFORE UPDATE ON research_archive_objects
        BEGIN SELECT RAISE(ABORT,'归档登记不可改写'); END;
        CREATE TRIGGER IF NOT EXISTS research_archive_history_immutable BEFORE UPDATE ON research_archive_history
        BEGIN SELECT RAISE(ABORT,'归档历史不可改写'); END;
        CREATE TRIGGER IF NOT EXISTS research_archive_objects_retained BEFORE DELETE ON research_archive_objects
        WHEN EXISTS(SELECT 1 FROM research_studies WHERE id=OLD.study_id)
        BEGIN SELECT RAISE(ABORT,'归档登记不可删除'); END;
        CREATE TRIGGER IF NOT EXISTS research_archive_history_retained BEFORE DELETE ON research_archive_history
        WHEN EXISTS(SELECT 1 FROM research_studies WHERE id=OLD.study_id)
        BEGIN SELECT RAISE(ABORT,'归档历史不可删除'); END;")?;
    // Guard malformed legacy documents before every JSON access. Backfill cannot
    // infer the provenance of existing bytes; they remain legacy forever.
    let capture = |document: &str, study: &str| {
        let json = format!("CASE WHEN json_valid({document}) THEN {document} ELSE '{{}}' END");
        format!("INSERT OR IGNORE INTO research_archive_objects(study_id,sha256,bytes,manifest_sha256,legacy,created_at)
          SELECT {study},json_extract({json},'$.deliverySnapshot.archive.sha256'),
          COALESCE(json_extract({json},'$.deliverySnapshot.archive.bytes'),0),
          COALESCE(json_extract({json},'$.deliverySnapshot.archive.manifestSha256'),''),1,0
          WHERE json_type({json},'$.deliverySnapshot.archive.sha256')='text';
          INSERT OR IGNORE INTO research_archive_history(study_id,scope_hash,sha256)
          SELECT {study},COALESCE(json_extract({json},'$.deliverySnapshot.scopeHash'),''),
          json_extract({json},'$.deliverySnapshot.archive.sha256')
          WHERE json_type({json},'$.deliverySnapshot.archive.sha256')='text';
          INSERT OR IGNORE INTO research_archive_decision_scopes(study_id,scope_hash)
          SELECT {study},json_extract(CASE WHEN json_valid(value) THEN value ELSE '{{}}' END,'$.scopeHash') FROM json_each({json},'$.decisions')
          WHERE json_type(CASE WHEN json_valid(value) THEN value ELSE '{{}}' END,'$.scopeHash')='text';")
    };
    // Backfill only once; persistent triggers capture all subsequent writers.
    let initialized: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM research_archive_migrations WHERE version=1)",
        [],
        |r| r.get(0),
    )?;
    if !initialized {
        for sql in capture("document", "research_studies.id")
            .split(';')
            .filter(|s| !s.trim().is_empty())
        {
            let sql = if sql.contains(" FROM json_each(") {
                sql.replacen(" FROM json_each(", " FROM research_studies,json_each(", 1)
            } else {
                sql.replacen(
                    "\n          WHERE",
                    " FROM research_studies\n          WHERE",
                    1,
                )
            };
            conn.execute_batch(&sql)?;
        }
        conn.execute(
            "INSERT INTO research_archive_migrations(version) VALUES(1)",
            [],
        )?;
    }
    for event in ["INSERT", "UPDATE"] {
        let old = if event == "UPDATE" {
            capture("OLD.document", "OLD.id")
        } else {
            String::new()
        };
        conn.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS research_archive_capture_{} AFTER {event} ON research_studies BEGIN {old} {} END;", event.to_lowercase(), capture("NEW.document", "NEW.id")))?;
    }
    let new_json = "CASE WHEN json_valid(NEW.document) THEN NEW.document ELSE '{}' END";
    let old_json = "CASE WHEN json_valid(OLD.document) THEN OLD.document ELSE '{}' END";
    conn.execute_batch(&format!("DROP TRIGGER IF EXISTS research_delivery_snapshot_guard;
        CREATE TRIGGER research_delivery_snapshot_guard BEFORE UPDATE ON research_studies
        WHEN (json_type({old_json},'$.deliverySnapshot')='object' AND json_type({new_json},'$.deliverySnapshot') IS NOT 'object')
        OR (json_extract({old_json},'$.deliverySnapshot.catalogVersion') IS NOT NULL AND json_extract({new_json},'$.deliverySnapshot.catalogVersion') IS NOT json_extract({old_json},'$.deliverySnapshot.catalogVersion'))
        BEGIN SELECT RAISE(ABORT,'交付快照已启用，请使用支持快照及归档登记的兼容版本'); END;"))?;
    for event in ["INSERT", "UPDATE"] {
        conn.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS research_archive_reference_guard_{} BEFORE {event} ON research_studies
        WHEN (json_extract({new_json},'$.deliverySnapshot.catalogVersion') IS NOT NULL AND json_extract({new_json},'$.deliverySnapshot.catalogVersion') IS NOT 1)
        OR EXISTS(SELECT 1 FROM research_archive_gc WHERE study_id=NEW.id AND status='planned' AND (sha256=json_extract({new_json},'$.deliverySnapshot.archive.sha256') OR EXISTS(
            SELECT 1 FROM research_archive_objects o,json_each({new_json},'$.decisions') d WHERE o.study_id=NEW.id AND o.sha256=research_archive_gc.sha256
            AND o.scope_hash=json_extract(CASE WHEN json_valid(d.value) THEN d.value ELSE '{{}}' END,'$.scopeHash'))))
        BEGIN SELECT RAISE(ABORT,'归档正在恢复或版本不兼容'); END;", event.to_lowercase()))?;
    }
    tx.commit()?;
    Ok(())
}

/// A bounded catalog window. Keep `before` and `through` for every page;
/// each page still needs its own reviewed preview token.
#[derive(Clone, Copy, Debug)]
pub struct ArchiveGcWindow {
    pub before: i64,
    pub after: i64,
    pub through: Option<i64>,
}
impl From<i64> for ArchiveGcWindow {
    fn from(before: i64) -> Self {
        Self {
            before,
            after: 0,
            through: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCandidate {
    pub cursor: i64,
    pub sha256: String,
    pub bytes: u64,
    pub modified_at: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveGcPreview {
    pub project_id: String,
    pub study_id: String,
    pub before: i64,
    pub after: i64,
    pub through: i64,
    pub next_cursor: i64,
    pub document_hash: String,
    pub candidates: Vec<ArchiveCandidate>,
    pub preview_hash: String,
    pub scanned: usize,
    pub retained: usize,
    pub has_more: bool,
    pub logical_bytes: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveGcResult {
    pub preview_hash: String,
    pub after: i64,
    pub through: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub removed: Vec<String>,
    pub failed: Vec<String>,
    pub logical_bytes_removed: u64,
}

fn hash_name(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn regular(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.is_file() && !meta.is_symlink()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
impl Store {
    pub(super) fn research_register_archive(
        &self,
        study: &Study,
        archive: &ArchiveDescriptor,
        existed: bool,
        scope_hash: &str,
    ) -> Result<()> {
        let pending: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM research_archive_gc WHERE study_id=?1 AND sha256=?2 AND status='planned')", params![study.id,archive.sha256], |r| r.get(0))?;
        if pending {
            return Err(anyhow!("归档回收尚未恢复，请先运行 archive-recover"));
        }
        self.conn.execute("INSERT OR IGNORE INTO research_archive_objects(study_id,sha256,bytes,manifest_sha256,legacy,created_at,scope_hash) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![study.id,archive.sha256,archive.bytes,archive.manifest_sha256,existed,now_ms(),scope_hash])?;
        let matches: bool = self.conn.query_row("SELECT bytes=?3 AND manifest_sha256=?4 FROM research_archive_objects WHERE study_id=?1 AND sha256=?2",params![study.id,archive.sha256,archive.bytes,archive.manifest_sha256],|r|r.get(0))?;
        if !matches {
            return Err(anyhow!("归档登记与实际文件不一致"));
        }
        Ok(())
    }
    fn archive_study(&self, project: &str, id: &str) -> Result<Study> {
        let study = self.research_study(id)?;
        let row: (String, String) = self.conn.query_row(
            "SELECT id,project_id FROM research_studies WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if study.id != row.0 || study.project_id != row.1 || row.1 != project {
            return Err(anyhow!("研究不属于当前项目"));
        }
        Ok(study)
    }
    fn archive_directory(&self, study: &Study) -> Result<PathBuf> {
        let directory = self.archive_dir(study)?;
        let base = Path::new(self.conn.path().ok_or_else(|| anyhow!("需要持久数据库"))?)
            .parent()
            .ok_or_else(|| anyhow!("数据库目录无效"))?;
        // Reject links at every app-controlled directory; never traverse another
        // project's directory via a stored slug or a linked cache directory.
        let mut path = base.to_path_buf();
        for part in directory.strip_prefix(base)?.components() {
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() && !meta.is_symlink() => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                _ => return Err(anyhow!("归档目录包含链接或非目录项")),
            }
        }
        Ok(directory)
    }
    fn archive_lock(&self, study: &Study) -> Result<fd_lock::RwLock<fs::File>> {
        let directory = self.archive_directory(study)?;
        fs::create_dir_all(&directory)?;
        let path = directory.join("prepare.lock");
        if fs::symlink_metadata(&path).is_ok() && !regular(&path)? {
            return Err(anyhow!("归档锁路径无效"));
        }
        Ok(fd_lock::RwLock::new(
            fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(path)?,
        ))
    }
    fn archive_quiet(&self, study: &Study, now: i64) -> Result<()> {
        if study
            .plans
            .iter()
            .any(|p| p.tasks.iter().any(|t| t.state == "running"))
            || self
                .research_runs(study)?
                .iter()
                .any(|r| !crate::local::is_terminal(&r.status))
        {
            return Err(anyhow!("研究任务或运行尚未结束"));
        }
        let pending: bool = self.conn.query_row(&format!("{RESEARCH_MEMBERS_CTE} SELECT
            EXISTS(SELECT 1 FROM chat_turn_leases WHERE chat_session_id IN members AND heartbeat_at>=?3)
            OR EXISTS(SELECT 1 FROM chat_queued_messages WHERE session_id IN members)
            OR EXISTS(SELECT 1 FROM chat_spawns WHERE session_id IN members AND state!='done')
            OR EXISTS(SELECT 1 FROM chat_steering_requests WHERE session_id IN members AND state='registered')"),params![study.id,study.session_id,now-super::super::CHAT_TURN_LEASE_TTL_MS],|r|r.get(0))?;
        if pending {
            return Err(anyhow!("研究会话仍在处理或等待发送"));
        }
        Ok(())
    }
    fn archive_document_hash(&self, id: &str) -> Result<String> {
        let body: String = self.conn.query_row(
            "SELECT document FROM research_studies WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        Ok(digest(body.as_bytes()))
    }
    /// Catalog pagination never treats unknown filesystem entries as candidates.
    pub fn research_archives(
        &self,
        project: &str,
        id: &str,
        after: i64,
        limit: usize,
    ) -> Result<serde_json::Value> {
        let study = self.archive_study(project, id)?;
        if after < 0 || !(1..=200).contains(&limit) {
            return Err(anyhow!("游标或分页大小无效"));
        }
        let directory = self.archive_directory(&study)?;
        let tx = self.conn.unchecked_transaction()?;
        let current = study
            .delivery_snapshot
            .as_ref()
            .map(|s| s.archive.sha256.as_str());
        let mut stmt = self.conn.prepare("SELECT seq,sha256,bytes,legacy,created_at,(EXISTS(SELECT 1 FROM research_archive_history h WHERE h.study_id=o.study_id AND h.sha256=o.sha256) OR EXISTS(SELECT 1 FROM research_archive_decision_scopes d WHERE d.study_id=o.study_id AND d.scope_hash=o.scope_hash)),EXISTS(SELECT 1 FROM research_archive_gc g WHERE g.study_id=o.study_id AND g.sha256=o.sha256 AND status='planned') FROM research_archive_objects o WHERE study_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
        let mut rows = stmt.query(params![id, after, limit + 1])?;
        let mut items = vec![];
        let mut cursor = after;
        let mut more = false;
        while let Some(row) = rows.next()? {
            if items.len() == limit {
                more = true;
                break;
            }
            let seq: i64 = row.get(0)?;
            let hash: String = row.get(1)?;
            let present = hash_name(&hash) && regular(&directory.join(format!("{hash}.zip")))?;
            items.push(serde_json::json!({"cursor":seq,"sha256":hash,"bytes":row.get::<_,u64>(2)?,"legacy":row.get::<_,bool>(3)?,"createdAt":row.get::<_,i64>(4)?,"referenceProtected":row.get::<_,bool>(5)?,"pendingRecovery":row.get::<_,bool>(6)?,"current":current==Some(hash.as_str()),"regularFilePresent":present}));
            cursor = seq;
        }
        drop(rows);
        drop(stmt);
        tx.commit()?;
        Ok(
            serde_json::json!({"studyId":id,"items":items,"nextCursor":cursor,"hasMore":more,"unknownFilesProtected":true,"policy":"all-observed-snapshots"}),
        )
    }
    pub fn research_archive_gc_preview(
        &self,
        project: &str,
        id: &str,
        window: impl Into<ArchiveGcWindow>,
    ) -> Result<ArchiveGcPreview> {
        self.archive_preview_at(project, id, window, now_ms())
    }
    pub(super) fn archive_preview_at(
        &self,
        project: &str,
        id: &str,
        window: impl Into<ArchiveGcWindow>,
        now: i64,
    ) -> Result<ArchiveGcPreview> {
        let study = self.archive_study(project, id)?;
        let mut lock = self.archive_lock(&study)?;
        let _guard = lock.try_write()?;
        self.archive_preview_locked(project, id, window.into(), now)
    }
    fn archive_preview_locked(
        &self,
        project: &str,
        id: &str,
        window: ArchiveGcWindow,
        now: i64,
    ) -> Result<ArchiveGcPreview> {
        let before = window.before;
        if before <= 0 || before > now.saturating_sub(DAY) {
            return Err(anyhow!("回收截止时间必须至少早于当前时间 24 小时"));
        }
        let tx = self.conn.unchecked_transaction()?;
        let study = self.archive_study(project, id)?;
        self.archive_quiet(&study, now)?;
        let directory = self.archive_directory(&study)?;
        let maximum: i64 = self.conn.query_row(
            "SELECT COALESCE(max(seq),0) FROM research_archive_objects WHERE study_id=?1",
            [id],
            |r| r.get(0),
        )?;
        let through = window.through.unwrap_or(maximum);
        if window.after < 0 || window.after > through || through > maximum {
            return Err(anyhow!("归档扫描游标或窗口无效"));
        }
        let mut preview = ArchiveGcPreview {
            project_id: project.into(),
            study_id: id.into(),
            before,
            after: window.after,
            through,
            next_cursor: window.after,
            document_hash: self.archive_document_hash(id)?,
            candidates: vec![],
            preview_hash: String::new(),
            scanned: 0,
            retained: 0,
            has_more: false,
            logical_bytes: 0,
        };
        let mut stmt=self.conn.prepare("SELECT sha256,bytes,legacy,created_at,(EXISTS(SELECT 1 FROM research_archive_history h WHERE h.study_id=o.study_id AND h.sha256=o.sha256) OR EXISTS(SELECT 1 FROM research_archive_decision_scopes d WHERE d.study_id=o.study_id AND d.scope_hash=o.scope_hash)),EXISTS(SELECT 1 FROM research_archive_gc g WHERE g.study_id=o.study_id AND g.sha256=o.sha256 AND status='planned'),seq FROM research_archive_objects o WHERE study_id=?1 AND seq>?2 AND seq<=?3 ORDER BY seq LIMIT ?4")?;
        let mut rows = stmt.query(params![id, window.after, through, SCAN_LIMIT + 1])?;
        while let Some(row) = rows.next()? {
            if preview.scanned == SCAN_LIMIT {
                preview.has_more = true;
                break;
            }
            let previous = preview.next_cursor;
            preview.next_cursor = row.get(6)?;
            preview.scanned += 1;
            let hash: String = row.get(0)?;
            let bytes: u64 = row.get(1)?;
            let path = directory.join(format!("{hash}.zip"));
            if row.get::<_, bool>(2)?
                || row.get::<_, i64>(3)? > before
                || row.get::<_, bool>(4)?
                || row.get::<_, bool>(5)?
                || !hash_name(&hash)
                || !regular(&path)?
            {
                preview.retained += 1;
                continue;
            }
            let modified = fs::metadata(&path)?
                .modified()?
                .duration_since(UNIX_EPOCH)?
                .as_millis();
            let modified = u64::try_from(modified)?;
            if modified > before as u64 || fs::metadata(&path)?.len() != bytes {
                preview.retained += 1;
                continue;
            }
            let file = FileSource::open(&path, "待回收归档")?;
            if file.lock_exclusive().is_err() {
                preview.retained += 1;
                continue;
            }
            file.check_unchanged()?;
            if bytes > BATCH_BYTES {
                return Err(anyhow!("单个归档超出回收批次预算，请核查登记"));
            }
            if preview.candidates.len() == BATCH_LIMIT
                || bytes > BATCH_BYTES - preview.logical_bytes
            {
                preview.has_more = true;
                preview.next_cursor = previous;
                preview.scanned -= 1;
                break;
            }
            preview.logical_bytes += bytes;
            preview.candidates.push(ArchiveCandidate {
                cursor: preview.next_cursor,
                sha256: hash,
                bytes,
                modified_at: modified,
            });
        }
        drop(rows);
        drop(stmt);
        tx.commit()?;
        // A fixed cutoff makes the review token stable; observations/timings are
        // excluded. Recheck document, object metadata and file hash before unlink.
        preview.preview_hash = digest(&serde_json::to_vec(
            &serde_json::json!({"policy":2,"project":project,"study":id,"before":before,"after":window.after,"through":through,"nextCursor":preview.next_cursor,"document":preview.document_hash,"candidates":preview.candidates}),
        )?);
        Ok(preview)
    }
    pub fn research_archive_gc_apply(
        &self,
        project: &str,
        id: &str,
        window: impl Into<ArchiveGcWindow>,
        expected: &str,
    ) -> Result<ArchiveGcResult> {
        self.archive_apply_at(project, id, window, expected, now_ms(), |_| Ok(()))
    }
    pub(super) fn archive_apply_at(
        &self,
        project: &str,
        id: &str,
        window: impl Into<ArchiveGcWindow>,
        expected: &str,
        now: i64,
        mut checkpoint: impl FnMut(&str) -> Result<()>,
    ) -> Result<ArchiveGcResult> {
        let study = self.archive_study(project, id)?;
        let mut lock = self.archive_lock(&study)?;
        let _guard = lock.try_write()?;
        let window = window.into();
        let before = window.before;
        let preview = self.archive_preview_locked(project, id, window, now)?;
        if preview.preview_hash != expected {
            return Err(anyhow!("回收预览已变化，请重新检查预览"));
        }
        let directory = self.archive_directory(&study)?;
        let mut files = vec![];
        for candidate in &preview.candidates {
            let path = directory.join(format!("{}.zip", candidate.sha256));
            if !regular(&path)? {
                return Err(anyhow!("归档路径已变化"));
            }
            let mut file = FileSource::open(&path, "待回收归档")?;
            file.lock_exclusive()?;
            let modified = fs::metadata(&path)?
                .modified()?
                .duration_since(UNIX_EPOCH)?
                .as_millis();
            if modified != u128::from(candidate.modified_at) {
                return Err(anyhow!("归档修改时间已变化"));
            }
            if file.bytes() != candidate.bytes || file.hash()? != candidate.sha256 {
                return Err(anyhow!("归档内容与登记不一致，停止回收"));
            }
            files.push((path, file));
        }
        checkpoint("verified")?;
        let tx = self.begin_immediate()?;
        self.archive_quiet(&self.archive_study(project, id)?, now)?;
        if self.archive_document_hash(id)? != preview.document_hash {
            return Err(anyhow!("研究状态已变化"));
        }
        let mut intents = vec![];
        for candidate in &preview.candidates {
            let intent = uuid::Uuid::new_v4().to_string();
            let count=self.conn.execute("INSERT INTO research_archive_gc(id,study_id,sha256,preview_hash,requested_at,status) SELECT ?1,?2,?3,?4,?5,'planned' WHERE EXISTS(SELECT 1 FROM research_archive_objects WHERE study_id=?2 AND sha256=?3 AND legacy=0 AND created_at<=?6 AND NOT EXISTS(SELECT 1 FROM research_archive_decision_scopes d WHERE d.study_id=?2 AND d.scope_hash=research_archive_objects.scope_hash)) AND NOT EXISTS(SELECT 1 FROM research_archive_history WHERE study_id=?2 AND sha256=?3)",params![intent,id,candidate.sha256,expected,now,before])?;
            if count != 1 {
                return Err(anyhow!("归档引用已变化"));
            }
            intents.push(intent);
        }
        tx.commit()?;
        checkpoint("planned")?;
        let mut result = ArchiveGcResult {
            preview_hash: expected.into(),
            after: preview.after,
            through: preview.through,
            next_cursor: preview.next_cursor,
            has_more: preview.has_more,
            removed: vec![],
            failed: vec![],
            logical_bytes_removed: 0,
        };
        for ((candidate, (path, file)), intent) in preview.candidates.iter().zip(files).zip(intents)
        {
            let removed = file.check_unchanged().and_then(|_| {
                if !regular(&path)? {
                    return Err(anyhow!("归档路径已变化"));
                }
                fs::remove_file(&path)?;
                Ok(())
            });
            checkpoint("unlinked")?;
            let status = if removed.is_ok() {
                result.removed.push(candidate.sha256.clone());
                result.logical_bytes_removed += candidate.bytes;
                "removed"
            } else {
                result.failed.push(candidate.sha256.clone());
                result.next_cursor = preview.after;
                result.has_more = true;
                "failed"
            };
            self.conn.execute("UPDATE research_archive_gc SET status=?2,completed_at=?3 WHERE id=?1 AND status='planned'",params![intent,status,now_ms()])?;
        }
        Ok(result)
    }
    /// Recovery never deletes bytes: present objects are retained, absent objects
    /// are recorded as absent, not claimed as bytes reclaimed by this process.
    pub fn research_archive_recover(&self, project: &str, id: &str) -> Result<serde_json::Value> {
        let study = self.archive_study(project, id)?;
        let mut lock = self.archive_lock(&study)?;
        let _guard = lock.try_write()?;
        let directory = self.archive_directory(&study)?;
        let mut stmt=self.conn.prepare("SELECT id,sha256 FROM research_archive_gc WHERE study_id=?1 AND status='planned' ORDER BY requested_at,id LIMIT 201")?;
        let pending = stmt
            .query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let more = pending.len() > 200;
        let mut results = vec![];
        for (intent, hash) in pending.into_iter().take(200) {
            if !hash_name(&hash) {
                return Err(anyhow!("恢复归档标识无效"));
            }
            let path = directory.join(format!("{hash}.zip"));
            let file = match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_file() && !meta.is_symlink() => {
                    let f = FileSource::open(&path, "待恢复归档")?;
                    f.lock_exclusive()?;
                    Some(f)
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                _ => return Err(anyhow!("恢复路径异常，保留待恢复记录")),
            };
            let status = if file.is_some() { "aborted" } else { "absent" };
            self.conn.execute("UPDATE research_archive_gc SET status=?2,completed_at=?3 WHERE id=?1 AND status='planned'",params![intent,status,now_ms()])?;
            results.push(serde_json::json!({"id":intent,"sha256":hash,"status":status}));
        }
        Ok(serde_json::json!({"studyId":id,"items":results,"hasMore":more,"deletedFiles":0}))
    }
}
