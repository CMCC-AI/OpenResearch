//! Permanent input-set identities and executor-wide reservations for their own pool.
use super::{now_ms, Store};
use crate::error::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub sequence: i64,
    pub id: String,
    pub project_id: String,
    pub state: String,
    pub charged_bytes: u64,
    pub manifest_sha256: String,
    pub manifest: crate::input_sets::Manifest,
}

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS input_set_budget (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=9007199254740991));
    CREATE TABLE IF NOT EXISTS frozen_input_sets (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('preparing','copying','frozen','cancelled')),
        charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=0),
        manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
        manifest TEXT NOT NULL CHECK(json_valid(manifest) AND length(CAST(manifest AS BLOB))<=131072
          AND json_extract(manifest,'$.id')=id AND json_extract(manifest,'$.projectId')=project_id));
    CREATE INDEX IF NOT EXISTS frozen_input_sets_charge ON frozen_input_sets(charged_bytes) WHERE state!='cancelled';
    CREATE INDEX IF NOT EXISTS frozen_input_sets_project ON frozen_input_sets(project_id,sequence);
    CREATE TRIGGER IF NOT EXISTS input_set_budget_no_replace BEFORE INSERT ON input_set_budget
      WHEN EXISTS(SELECT 1 FROM input_set_budget) BEGIN SELECT RAISE(ABORT,'请更新已有输入池配额'); END;
    CREATE TRIGGER IF NOT EXISTS input_set_budget_guard BEFORE UPDATE ON input_set_budget
      WHEN NEW.singleton!=OLD.singleton OR NEW.bytes<(SELECT COALESCE(sum(charged_bytes),0) FROM frozen_input_sets WHERE state!='cancelled')
      BEGIN SELECT RAISE(ABORT,'输入池配额低于已占用及在途预约'); END;
    CREATE TRIGGER IF NOT EXISTS input_set_budget_no_delete BEFORE DELETE ON input_set_budget
      BEGIN SELECT RAISE(ABORT,'输入池配额不可移除'); END;
    CREATE TRIGGER IF NOT EXISTS frozen_input_sets_admit BEFORE INSERT ON frozen_input_sets
      WHEN NEW.state!='preparing' OR NEW.charged_bytes<=0
        OR EXISTS(SELECT 1 FROM frozen_input_sets WHERE id=NEW.id OR sequence=NEW.sequence)
        OR NOT EXISTS(SELECT 1 FROM local_projects WHERE id=NEW.project_id)
        OR NOT EXISTS(SELECT 1 FROM input_set_budget WHERE bytes>=NEW.charged_bytes+(SELECT COALESCE(sum(charged_bytes),0) FROM frozen_input_sets WHERE state!='cancelled'))
      BEGIN SELECT RAISE(ABORT,'输入池未配置、容量不足或预约身份无效'); END;
    CREATE TRIGGER IF NOT EXISTS frozen_input_sets_immutable BEFORE UPDATE ON frozen_input_sets
      WHEN (OLD.state='preparing' AND NEW.state NOT IN ('copying','cancelled'))
        OR (OLD.state='copying' AND NEW.state NOT IN ('frozen','cancelled'))
        OR OLD.state IN ('frozen','cancelled')
        OR OLD.id IS NOT NEW.id OR OLD.sequence IS NOT NEW.sequence OR OLD.project_id IS NOT NEW.project_id
        OR OLD.created_at IS NOT NEW.created_at OR OLD.manifest IS NOT NEW.manifest OR OLD.manifest_sha256 IS NOT NEW.manifest_sha256
        OR (NEW.state IN ('copying','frozen') AND OLD.charged_bytes!=NEW.charged_bytes)
        OR (NEW.state='cancelled' AND NEW.charged_bytes!=0)
      BEGIN SELECT RAISE(ABORT,'冻结输入身份不可改写'); END;
    CREATE TRIGGER IF NOT EXISTS frozen_input_sets_no_delete BEFORE DELETE ON frozen_input_sets
      BEGIN SELECT RAISE(ABORT,'输入冻结台账不可删除'); END;
    CREATE TRIGGER IF NOT EXISTS frozen_inputs_project_retention BEFORE DELETE ON local_projects
      WHEN EXISTS(SELECT 1 FROM frozen_input_sets WHERE project_id=OLD.id AND state!='cancelled')
      BEGIN SELECT RAISE(ABORT,'项目仍有冻结输入或在途预约；当前版本保留这些来源，不支持删除'); END;")?;
    Ok(())
}

impl Store {
    pub(crate) fn input_data_root(&self) -> Result<PathBuf> {
        Ok(Path::new(
            self.conn
                .path()
                .ok_or_else(|| anyhow!("输入冻结需要持久数据库"))?,
        )
        .parent()
        .ok_or_else(|| anyhow!("数据库目录无效"))?
        .to_path_buf())
    }
    pub(crate) fn input_budget(&self, bytes: Option<u64>) -> Result<serde_json::Value> {
        let tx = self.begin_immediate()?;
        if let Some(bytes) = bytes {
            if bytes == 0 || bytes > (1_u64 << 53) - 1 {
                return Err(anyhow!("配额需要正的 SQLite 安全整数"));
            }
            if tx.execute(
                "UPDATE input_set_budget SET bytes=?1 WHERE singleton=1",
                [bytes],
            )? == 0
            {
                tx.execute(
                    "INSERT INTO input_set_budget(singleton,bytes) VALUES(1,?1)",
                    [bytes],
                )?;
            }
        }
        let limit: Option<u64> = tx
            .query_row(
                "SELECT bytes FROM input_set_budget WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let used: u64 = tx.query_row(
            "SELECT COALESCE(sum(charged_bytes),0) FROM frozen_input_sets WHERE state!='cancelled'",
            [],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(
            serde_json::json!({"scope":"frozen-input-pool-only","limitBytes":limit,"chargedBytes":used,"includesPreparing":true,"countsDatabaseMetadata":false,"automaticDeletion":false}),
        )
    }
    pub(crate) fn input_reserve(
        &self,
        manifest: &crate::input_sets::Manifest,
        json: &str,
        hash: &str,
        bytes: u64,
    ) -> Result<()> {
        let tx = self.begin_immediate()?;
        let configured: bool =
            tx.query_row("SELECT EXISTS(SELECT 1 FROM input_set_budget)", [], |r| {
                r.get(0)
            })?;
        if !configured {
            return Err(anyhow!(
                "请先由操作者运行 orx inputs quota --bytes N，显式配置冻结输入池配额"
            ));
        }
        tx.execute("INSERT INTO frozen_input_sets(id,project_id,created_at,state,charged_bytes,manifest_sha256,manifest) VALUES(?1,?2,?3,'preparing',?4,?5,?6)",
            params![manifest.id,manifest.project_id,now_ms(),bytes,hash,json])?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn input_begin_copy(&self, project: &str, id: &str) -> Result<()> {
        let tx = self.begin_immediate()?;
        if tx.execute("UPDATE frozen_input_sets SET state='copying' WHERE project_id=?1 AND id=?2 AND state='preparing'",params![project,id])? != 1 {return Err(anyhow!("输入预约状态已变化"));}
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn input_finish(
        &self,
        project: &str,
        id: &str,
        hash: &str,
        recheck: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let tx = self.begin_immediate()?;
        recheck()?;
        if tx.execute("UPDATE frozen_input_sets SET state='frozen' WHERE project_id=?1 AND id=?2 AND manifest_sha256=?3 AND state='copying'", params![project,id,hash])? != 1 {
            return Err(anyhow!("输入预约已变化，请核查台账"));
        }
        tx.commit()?;
        Ok(())
    }
    /// Only after the owned uncommitted files have been removed under their lease.
    pub(crate) fn input_cancel(&self, project: &str, id: &str) -> Result<()> {
        let tx = self.begin_immediate()?;
        if tx.execute("UPDATE frozen_input_sets SET state='cancelled',charged_bytes=0 WHERE project_id=?1 AND id=?2 AND state IN ('preparing','copying')",params![project,id])? != 1 {
            return Err(anyhow!("只能恢复未冻结的输入预约"));
        }
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn input_record(&self, project: &str, id: &str) -> Result<Record> {
        let record = self.conn.query_row("SELECT sequence,id,project_id,state,charged_bytes,manifest_sha256,manifest FROM frozen_input_sets WHERE project_id=?1 AND id=?2",params![project,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get::<_,String>(6)?))).optional()?.ok_or_else(|| anyhow!("本项目中不存在该输入集合"))?;
        let (sequence, id, project_id, state, charged_bytes, manifest_sha256, json) = record;
        if crate::store::research::digest(json.as_bytes()) != manifest_sha256 {
            return Err(anyhow!("输入清单台账摘要不一致"));
        }
        Ok(Record {
            sequence,
            id,
            project_id,
            state,
            charged_bytes,
            manifest_sha256,
            manifest: serde_json::from_str(&json)?,
        })
    }
    pub(crate) fn input_list(
        &self,
        project: &str,
        after: i64,
        limit: usize,
    ) -> Result<serde_json::Value> {
        if after < 0 || !(1..=50).contains(&limit) {
            return Err(anyhow!("游标或分页大小无效"));
        }
        let mut stmt=self.conn.prepare("SELECT sequence,id,state,charged_bytes,manifest_sha256,created_at FROM frozen_input_sets WHERE project_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let rows=stmt.query_map(params![project,after,limit+1],|r| Ok(serde_json::json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"state":r.get::<_,String>(2)?,"chargedBytes":r.get::<_,u64>(3)?,"manifestSha256":r.get::<_,String>(4)?,"createdAt":r.get::<_,i64>(5)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let more = rows.len() > limit;
        let items: Vec<_> = rows.into_iter().take(limit).collect();
        let next = items
            .last()
            .and_then(|r| r["sequence"].as_i64())
            .unwrap_or(after);
        Ok(serde_json::json!({"items":items,"after":next,"hasMore":more}))
    }
}
