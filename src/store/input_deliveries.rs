//! Per-Run copies share the explicitly configured input-copy budget.
use super::Store;
use crate::error::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub(crate) const USED: &str = "(SELECT COALESCE(sum(charged_bytes),0) FROM frozen_input_sets WHERE state!='cancelled') + (SELECT COALESCE(sum(charged_bytes),0) FROM input_deliveries WHERE state!='cancelled')";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Delivery {
    pub run_id: String,
    pub project_id: String,
    pub input_id: String,
    pub manifest_sha256: String,
    pub state: String,
    pub charged_bytes: u64,
}

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!("
    CREATE TABLE IF NOT EXISTS input_deliveries (
      run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, input_id TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('preparing','copying','available','cancelled')),
      charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=0));
    CREATE INDEX IF NOT EXISTS input_deliveries_charge ON input_deliveries(charged_bytes) WHERE state!='cancelled';
    CREATE INDEX IF NOT EXISTS input_deliveries_project ON input_deliveries(project_id,run_id);
    CREATE TRIGGER IF NOT EXISTS input_deliveries_admit BEFORE INSERT ON input_deliveries
      WHEN NEW.state!='preparing' OR NEW.charged_bytes<=0
        OR EXISTS(SELECT 1 FROM input_deliveries WHERE run_id=NEW.run_id)
        OR NOT EXISTS(SELECT 1 FROM runs r JOIN frozen_input_sets f ON f.id=NEW.input_id
          WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id AND f.project_id=r.project_id
          AND r.status='starting' AND json_extract(r.backend_json,'$.kind')='local_job'
          AND json_extract(r.backend_json,'$.inputSet.id')=f.id
          AND json_extract(r.backend_json,'$.inputSet.manifestSha256')=f.manifest_sha256
          AND f.state='frozen' AND f.manifest_sha256=NEW.manifest_sha256
          AND NEW.charged_bytes=length(CAST(f.manifest AS BLOB))+(SELECT COALESCE(sum(json_extract(value,'$.bytes')),0) FROM json_each(f.manifest,'$.files')))
        OR NOT EXISTS(SELECT 1 FROM input_set_budget WHERE bytes>=NEW.charged_bytes+({USED}))
      BEGIN SELECT RAISE(ABORT,'Run input delivery admission failed: identity, state or shared input budget'); END;
    CREATE TRIGGER IF NOT EXISTS input_deliveries_immutable BEFORE UPDATE ON input_deliveries
      WHEN OLD.run_id IS NOT NEW.run_id OR OLD.project_id IS NOT NEW.project_id
        OR OLD.input_id IS NOT NEW.input_id OR OLD.manifest_sha256 IS NOT NEW.manifest_sha256
        OR (OLD.state='preparing' AND NEW.state NOT IN ('copying','cancelled'))
        OR (OLD.state='copying' AND NEW.state NOT IN ('available','cancelled'))
        OR OLD.state IN ('available','cancelled')
        OR (NEW.state!='cancelled' AND NEW.charged_bytes!=OLD.charged_bytes)
        OR (NEW.state='cancelled' AND NEW.charged_bytes!=0)
      BEGIN SELECT RAISE(ABORT,'Run input delivery identity/state is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS input_deliveries_no_delete BEFORE DELETE ON input_deliveries
      BEGIN SELECT RAISE(ABORT,'Run input delivery ledger is retained'); END;
    CREATE TRIGGER IF NOT EXISTS frozen_inputs_delivery_budget BEFORE INSERT ON frozen_input_sets
      WHEN NOT EXISTS(SELECT 1 FROM input_set_budget WHERE bytes>=NEW.charged_bytes+({USED}))
      BEGIN SELECT RAISE(ABORT,'Shared input-copy budget exceeded'); END;
    CREATE TRIGGER IF NOT EXISTS input_budget_includes_deliveries BEFORE UPDATE ON input_set_budget
      WHEN NEW.bytes<({USED})
      BEGIN SELECT RAISE(ABORT,'Shared input-copy budget is below retained and preparing copies'); END;
    "))?;
    Ok(())
}

impl Store {
    /// Called inside the same immediate transaction as the starting Run.
    pub(crate) fn reserve_input_delivery(&self, run_id: &str) -> Result<()> {
        if self.conn.is_autocommit() {
            return Err(anyhow!("Run 与输入预约必须处于同一事务"));
        }
        let n=self.conn.execute("INSERT INTO input_deliveries(run_id,project_id,input_id,manifest_sha256,state,charged_bytes)
          SELECT r.id,r.project_id,f.id,f.manifest_sha256,'preparing',length(CAST(f.manifest AS BLOB))+(SELECT COALESCE(sum(json_extract(value,'$.bytes')),0) FROM json_each(f.manifest,'$.files'))
          FROM runs r JOIN frozen_input_sets f ON f.id=json_extract(r.backend_json,'$.inputSet.id') WHERE r.id=?1",[run_id])?;
        if n != 1 {
            return Err(anyhow!(
                "Run input reservation is missing its frozen identity"
            ));
        }
        Ok(())
    }
    pub(crate) fn input_delivery(&self, project: &str, run_id: &str) -> Result<Delivery> {
        self.conn.query_row("SELECT run_id,project_id,input_id,manifest_sha256,state,charged_bytes FROM input_deliveries WHERE run_id=?1 AND project_id=?2",params![run_id,project],|r|Ok(Delivery{run_id:r.get(0)?,project_id:r.get(1)?,input_id:r.get(2)?,manifest_sha256:r.get(3)?,state:r.get(4)?,charged_bytes:r.get(5)?})).optional()?.ok_or_else(||anyhow!("本项目没有该 Run 的输入投递预约"))
    }
    pub(crate) fn input_delivery_transition(
        &self,
        run_id: &str,
        old: &str,
        new: &str,
        check: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let tx = self.begin_immediate()?;
        check()?;
        let n=tx.execute("UPDATE input_deliveries SET state=?3,charged_bytes=CASE WHEN ?3='cancelled' THEN 0 ELSE charged_bytes END WHERE run_id=?1 AND state=?2",params![run_id,old,new])?;
        if n != 1 {
            return Err(anyhow!("投递预约状态已变化"));
        }
        tx.commit()?;
        Ok(())
    }
}
