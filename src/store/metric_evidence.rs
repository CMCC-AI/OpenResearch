//! Append-only project observations. A deleted Run cannot silently erase history.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{now_ms, Store, StoredRun};
use crate::error::{anyhow, Result};

const SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricEvidence {
    pub sequence: i64,
    pub id: String,
    pub project_id: String,
    pub run_id: String,
    pub registered_at: i64,
    pub producer_version: String,
    /// SHA-256 of the stored serialized inspection, distinct from the raw report hash.
    pub snapshot_sha256: String,
    pub inspection: serde_json::Value,
}

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS scientific_metric_evidence (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES local_projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        producer_version TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        inspection TEXT NOT NULL CHECK(json_valid(inspection) AND length(CAST(inspection AS BLOB))<=4194304)
    );
    CREATE INDEX IF NOT EXISTS scientific_metric_evidence_run ON scientific_metric_evidence(project_id,run_id,sequence);
    CREATE TRIGGER IF NOT EXISTS scientific_metric_evidence_no_replace BEFORE INSERT ON scientific_metric_evidence
    WHEN EXISTS(SELECT 1 FROM scientific_metric_evidence WHERE id=NEW.id OR sequence=NEW.sequence)
    BEGIN SELECT RAISE(ABORT,'科学指标登记不可替换'); END;
    CREATE TRIGGER IF NOT EXISTS scientific_metric_evidence_no_update BEFORE UPDATE ON scientific_metric_evidence
    BEGIN SELECT RAISE(ABORT,'科学指标登记不可改写'); END;
    CREATE TRIGGER IF NOT EXISTS scientific_metric_evidence_no_delete BEFORE DELETE ON scientific_metric_evidence
    WHEN EXISTS(SELECT 1 FROM local_projects WHERE id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT,'科学指标登记不可单独删除'); END;")?;
    Ok(())
}

impl Store {
    pub(crate) fn register_metric_evidence(
        &self,
        expected: &StoredRun,
        inspection: &crate::scientific_metrics::Inspection,
    ) -> Result<MetricEvidence> {
        let json = serde_json::to_string(inspection)?;
        if json.len() > SNAPSHOT_BYTES {
            return Err(anyhow!("科学指标登记超过 4 MiB；未保存部分内容"));
        }
        let snapshot_sha256 = format!("{:x}", Sha256::digest(json.as_bytes()));
        let parsed = serde_json::from_str(&json)?;
        // Only DB identity checks and one insert under the lock; no file hashing.
        let tx = self.begin_immediate()?;
        let current = self
            .get_run(&expected.id)?
            .ok_or_else(|| anyhow!("Run 已删除"))?;
        if !crate::scientific_metrics::same_run(&current, expected) {
            return Err(anyhow!("Run 在登记前变化，请重新核验"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let registered_at = now_ms();
        let producer_version = env!("CARGO_PKG_VERSION").to_string();
        tx.execute("INSERT INTO scientific_metric_evidence(id,project_id,run_id,registered_at,producer_version,snapshot_sha256,inspection) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id,expected.project_id,expected.id,registered_at,producer_version,snapshot_sha256,json])?;
        let sequence = tx.last_insert_rowid();
        tx.commit()?;
        Ok(MetricEvidence {
            sequence,
            id,
            project_id: expected.project_id.clone(),
            run_id: expected.id.clone(),
            registered_at,
            producer_version,
            snapshot_sha256,
            inspection: parsed,
        })
    }

    pub(crate) fn metric_evidence(&self, project: &str, id: &str) -> Result<MetricEvidence> {
        let row = self.conn.query_row("SELECT sequence,id,project_id,run_id,registered_at,producer_version,snapshot_sha256,inspection FROM scientific_metric_evidence WHERE project_id=?1 AND id=?2", params![project,id], |r| {
            Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?))
        }).optional()?.ok_or_else(|| anyhow!("本项目中不存在该科学指标登记"))?;
        let (
            sequence,
            id,
            project_id,
            run_id,
            registered_at,
            producer_version,
            snapshot_sha256,
            json,
        ) = row;
        if json.len() > SNAPSHOT_BYTES
            || format!("{:x}", Sha256::digest(json.as_bytes())) != snapshot_sha256
        {
            return Err(anyhow!("科学指标登记内容或摘要损坏"));
        }
        Ok(MetricEvidence {
            sequence,
            id,
            project_id,
            run_id,
            registered_at,
            producer_version,
            snapshot_sha256,
            inspection: serde_json::from_str(&json)?,
        })
    }

    /// Summaries only: at most 50 rows, never 50 full point collections.
    pub(crate) fn metric_evidence_list(
        &self,
        project: &str,
        run: &str,
        after: i64,
        limit: usize,
    ) -> Result<serde_json::Value> {
        if after < 0 || !(1..=50).contains(&limit) {
            return Err(anyhow!("after 需为非负序号，limit 需为 1–50"));
        }
        self.get_local_project(project)?
            .ok_or_else(|| anyhow!("project not found"))?;
        let mut statement = self.conn.prepare("SELECT sequence,id,registered_at,producer_version,snapshot_sha256 FROM scientific_metric_evidence WHERE project_id=?1 AND run_id=?2 AND sequence>?3 ORDER BY sequence LIMIT ?4")?;
        let mut records = statement.query_map(params![project,run,after,(limit+1) as i64], |r| {
            Ok(serde_json::json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"registeredAt":r.get::<_,i64>(2)?,"producerVersion":r.get::<_,String>(3)?,"snapshotSha256":r.get::<_,String>(4)?}))
        })?.collect::<std::result::Result<Vec<_>,_>>()?;
        let has_more = records.len() > limit;
        records.truncate(limit);
        let next_after = if has_more {
            records.last().and_then(|r| r["sequence"].as_i64())
        } else {
            None
        };
        Ok(
            serde_json::json!({"projectId":project,"runId":run,"records":records,"nextAfter":next_after}),
        )
    }
}
