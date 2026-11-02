//! Project-scoped reading receipts. No document text or model understanding is stored.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadContext {
    pub project_id: String,
    pub package_id: String,
    pub session_id: Option<String>,
    pub study_id: Option<String>,
    pub task_id: Option<String>,
    pub task_session_id: Option<String>,
    pub plan_version: Option<u32>,
    pub in_plan_inputs: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReceipt {
    pub context: ReadContext,
    pub package_id: String,
    pub source: String,
    pub path: String,
    pub sha256: String,
    pub format: String,
    pub requested_offset: usize,
    pub requested_limit: usize,
    pub requested_page: Option<u32>,
    pub verified: bool,
    pub outcome: String,
    pub selection: Option<serde_json::Value>,
    pub error: Option<String>,
    pub started_at: i64,
    pub recorded_at: i64,
}

#[derive(Default)]
pub struct ReadFilter {
    pub package: Option<String>,
    pub source: Option<String>,
    pub session: Option<String>,
    pub study: Option<String>,
}

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS material_read_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES local_projects(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT, study_id TEXT,
        receipt TEXT NOT NULL CHECK(json_valid(receipt)),
        output_state TEXT NOT NULL CHECK(output_state IN ('pending','written','failed','notApplicable')),
        output_at INTEGER, output_error TEXT
    );
    CREATE INDEX IF NOT EXISTS material_read_events_project ON material_read_events(project_id,sequence);
    CREATE INDEX IF NOT EXISTS material_read_events_package ON material_read_events(project_id,package_id,sequence);
    CREATE INDEX IF NOT EXISTS material_read_events_session ON material_read_events(project_id,session_id,sequence);
    CREATE INDEX IF NOT EXISTS material_read_events_study ON material_read_events(project_id,study_id,sequence);
    CREATE TRIGGER IF NOT EXISTS material_read_events_guard BEFORE UPDATE ON material_read_events
    WHEN NEW.sequence IS NOT OLD.sequence OR NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
      OR NEW.package_id IS NOT OLD.package_id OR NEW.source IS NOT OLD.source
      OR NEW.session_id IS NOT OLD.session_id OR NEW.study_id IS NOT OLD.study_id OR NEW.receipt IS NOT OLD.receipt
      OR OLD.output_state <> 'pending' OR NEW.output_state NOT IN ('written','failed') OR NEW.output_at IS NULL
    BEGIN SELECT RAISE(ABORT,'读取回执不可改写，输出状态仅能确认一次'); END;
    CREATE TRIGGER IF NOT EXISTS material_read_events_no_delete BEFORE DELETE ON material_read_events
    WHEN EXISTS(SELECT 1 FROM local_projects WHERE id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT,'读取回执不可单独删除'); END;")?;
    Ok(())
}

/// Bound diagnostic text without slicing through UTF-8. Never store source content.
pub fn bounded_error(error: &str) -> String {
    let mut end = error.len().min(2048);
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    error[..end].into()
}

impl Store {
    pub fn material_read_context(
        &self,
        project: &str,
        session: Option<&str>,
        package: &str,
    ) -> Result<ReadContext> {
        // One read snapshot for session ancestry, task binding and the plan input set.
        let tx = self.conn.unchecked_transaction()?;
        self.get_local_project(project)?
            .ok_or_else(|| anyhow!("project not found"))?;
        let mut context = ReadContext {
            project_id: project.into(),
            package_id: package.into(),
            session_id: session.map(str::to_string),
            study_id: None,
            task_id: None,
            task_session_id: None,
            plan_version: None,
            in_plan_inputs: None,
        };
        if let Some(session) = session {
            let chat = self
                .get_chat_session(session)?
                .ok_or_else(|| anyhow!("agent session not found"))?;
            if chat.project_id != project {
                return Err(anyhow!("不能跨项目读取材料"));
            }
            type Anchor = (String, Option<String>, Option<u32>, String);
            let anchor: Option<Anchor> = self.conn.query_row("WITH RECURSIVE lineage(id,depth) AS (
                SELECT ?1,0 UNION ALL SELECT COALESCE(s.side_parent_session_id,s.parent_session_id),l.depth+1
                FROM chat_sessions s JOIN lineage l ON s.id=l.id
                WHERE l.depth<16 AND COALESCE(s.side_parent_session_id,s.parent_session_id) IS NOT NULL
            ), anchors AS (
                SELECT r.study_id AS study,r.task_id AS task,r.version AS version,r.session_id AS actor,l.depth AS depth
                FROM lineage l JOIN research_sessions r ON r.session_id=l.id
                UNION ALL SELECT r.id,NULL,NULL,r.session_id,l.depth FROM lineage l JOIN research_studies r ON r.session_id=l.id
            ) SELECT study,task,version,actor FROM anchors ORDER BY depth LIMIT 1", [session], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            if let Some((id, task, version, actor)) = anchor {
                let anchor_chat = self
                    .get_chat_session(&actor)?
                    .ok_or_else(|| anyhow!("关联任务会话不存在"))?;
                if anchor_chat.project_id != project {
                    return Err(anyhow!("关联会话归属与材料项目不一致"));
                }
                let study = self.research_study(&id)?;
                if study.project_id != project {
                    return Err(anyhow!("研究归属与材料项目不一致"));
                }
                let plan = if let Some(version) = version {
                    let plan = study
                        .plans
                        .iter()
                        .find(|p| p.version == version)
                        .ok_or_else(|| anyhow!("任务计划不存在"))?;
                    if !plan.tasks.iter().any(|t| {
                        Some(&t.spec.id) == task.as_ref() && t.session_id.as_deref() == Some(&actor)
                    }) {
                        return Err(anyhow!("任务会话与计划绑定不一致"));
                    }
                    Some(plan)
                } else {
                    study.plans.last()
                };
                context.plan_version = Some(plan.map_or(0, |p| p.version));
                context.in_plan_inputs = plan
                    .and_then(|p| p.material_ids.as_ref())
                    .map(|ids| ids.iter().any(|id| id == package));
                context.study_id = Some(id);
                context.task_session_id = task.as_ref().map(|_| actor);
                context.task_id = task;
            }
        }
        tx.commit()?;
        Ok(context)
    }

    pub fn record_material_read(&self, receipt: &ReadReceipt) -> Result<String> {
        let document = serde_json::to_string(receipt)?;
        if document.len() > 16 * 1024 || !matches!(receipt.outcome.as_str(), "prepared" | "failed")
        {
            return Err(anyhow!("读取回执需要有效结果类型且不超过 16 KiB"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let output = if receipt.outcome == "prepared" {
            "pending"
        } else {
            "notApplicable"
        };
        self.conn.execute("INSERT INTO material_read_events(id,project_id,package_id,source,session_id,study_id,receipt,output_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id,receipt.context.project_id,receipt.package_id,receipt.source,receipt.context.session_id,receipt.context.study_id,document,output])?;
        Ok(id)
    }

    pub fn material_read_output(&self, project: &str, id: &str, error: Option<&str>) -> Result<()> {
        let state = if error.is_some() { "failed" } else { "written" };
        let error = error.map(bounded_error);
        let updated = self.conn.execute("UPDATE material_read_events SET output_state=?3,output_at=?4,output_error=?5 WHERE project_id=?1 AND id=?2 AND output_state='pending'", params![project,id,state,now_ms(),error])?;
        if updated != 1 {
            return Err(anyhow!("读取输出回执不存在或已经确认"));
        }
        Ok(())
    }

    pub fn material_read_events(
        &self,
        project: &str,
        filter: &ReadFilter,
        after: i64,
        limit: usize,
    ) -> Result<serde_json::Value> {
        if after < 0
            || !(1..=200).contains(&limit)
            || (filter.source.is_some() && filter.package.is_none())
        {
            return Err(anyhow!(
                "after 从 0 开始，limit 为 1–200；source 必须同时指定 package"
            ));
        }
        self.get_local_project(project)?
            .ok_or_else(|| anyhow!("project not found"))?;
        let mut sql = "SELECT sequence,id,receipt,output_state,output_at,output_error FROM material_read_events WHERE project_id=? AND sequence>?".to_string();
        let mut values = vec![
            rusqlite::types::Value::Text(project.into()),
            rusqlite::types::Value::Integer(after),
        ];
        for (column, value) in [
            ("package_id", &filter.package),
            ("source", &filter.source),
            ("session_id", &filter.session),
            ("study_id", &filter.study),
        ] {
            if let Some(value) = value {
                sql.push_str(&format!(" AND {column}=?"));
                values.push(value.clone().into());
            }
        }
        sql.push_str(" ORDER BY sequence LIMIT ?");
        values.push(((limit + 1) as i64).into());
        let mut statement = self.conn.prepare(&sql)?;
        let mut rows = statement.query(rusqlite::params_from_iter(values))?;
        let mut events = Vec::new();
        while let Some(row) = rows.next()? {
            let receipt: String = row.get(2)?;
            events.push(serde_json::json!({"sequence":row.get::<_,i64>(0)?,"id":row.get::<_,String>(1)?,"receipt":serde_json::from_str::<serde_json::Value>(&receipt)?,"outputState":row.get::<_,String>(3)?,"outputAt":row.get::<_,Option<i64>>(4)?,"outputError":row.get::<_,Option<String>>(5)?}));
        }
        let more = events.len() > limit;
        events.truncate(limit);
        let next = more.then(|| events.last().unwrap()["sequence"].clone());
        Ok(
            serde_json::json!({"events":events,"nextAfter":next,"meaning":"outputState=written 仅表示 CLI 已写入输出流，不证明模型接收、理解或完成审查；本记录不覆盖预览、下载及其他工具读取"}),
        )
    }
}
