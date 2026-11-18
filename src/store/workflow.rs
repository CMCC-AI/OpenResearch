use rusqlite::{params, OptionalExtension};

use super::{now_ms, Store};
use crate::error::Result;
use crate::workflow::{
    validate_agent, validate_draft, AgentDefinition, AgentInput, WorkflowDraft, WorkflowDraftInput,
};

pub(crate) const GLOBAL_WORKFLOW_DRAFT_PROJECT: &str = "";

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            prompt TEXT NOT NULL,
            version INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_agent_mcps (
            agent_id TEXT NOT NULL,
            mcp_id TEXT NOT NULL,
            PRIMARY KEY (agent_id, mcp_id)
        );
        CREATE TABLE IF NOT EXISTS workflow_drafts (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL UNIQUE,
            document TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )?;
    migrate_shared_workflow_drafts(conn)
}

/// Rebuild `workflow_drafts` into a shared library: several workflows may live
/// side by side per project, and deleting a project no longer cascades into
/// them (`project_id` keeps only the creation provenance).
fn migrate_shared_workflow_drafts(conn: &rusqlite::Connection) -> Result<()> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS product_migrations (name TEXT PRIMARY KEY)")?;
    let migrated: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM product_migrations WHERE name = 'shared-workflow-drafts-v1')",
        [],
        |row| row.get(0),
    )?;
    if migrated {
        // Older builds recreated the legacy cascade trigger on every open; drop
        // it again so deleting a project keeps leaving the shared library alone.
        tx.execute_batch("DROP TRIGGER IF EXISTS workflow_project_cleanup;")?;
        tx.commit()?;
        return Ok(());
    }
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS workflow_project_cleanup;
         CREATE TABLE workflow_drafts_shared (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            document TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         INSERT INTO workflow_drafts_shared(id,project_id,document,created_at,updated_at)
            SELECT id,project_id,document,created_at,updated_at FROM workflow_drafts;
         DROP TABLE workflow_drafts;
         ALTER TABLE workflow_drafts_shared RENAME TO workflow_drafts;
         CREATE INDEX IF NOT EXISTS workflow_drafts_project ON workflow_drafts(project_id);
         INSERT INTO product_migrations (name) VALUES ('shared-workflow-drafts-v1');",
    )?;
    tx.commit()?;
    Ok(())
}

fn agent_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentDefinition> {
    Ok(AgentDefinition {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        prompt: row.get(3)?,
        version: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const AGENT_COLUMNS: &str = "id,name,description,prompt,version,created_at,updated_at";

/// 重写一个 agent 的 MCP 挂载（在写事务内调用，agent 行与关联表保持原子）。
/// 注册表存在性校验在 API/CLI 入口做；这里只负责持久化，重复项静默去重，
/// 注册表中已删除的引用由快照与注入阶段跳过。
fn set_agent_mcps(
    tx: &rusqlite::Transaction<'_>,
    agent_id: &str,
    mcp_ids: &[String],
) -> Result<()> {
    tx.execute(
        "DELETE FROM workflow_agent_mcps WHERE agent_id=?1",
        [agent_id],
    )?;
    for mcp_id in mcp_ids {
        tx.execute(
            "INSERT OR IGNORE INTO workflow_agent_mcps(agent_id,mcp_id) VALUES(?1,?2)",
            params![agent_id, mcp_id],
        )?;
    }
    Ok(())
}

impl Store {
    pub fn list_workflow_agents(&self) -> Result<Vec<AgentDefinition>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {AGENT_COLUMNS} FROM workflow_agents ORDER BY updated_at DESC,id"
        ))?;
        let rows = statement.query_map([], agent_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>, _>>()?)
    }

    pub fn workflow_agent(&self, id: &str) -> Result<Option<AgentDefinition>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {AGENT_COLUMNS} FROM workflow_agents WHERE id=?1"),
                [id],
                agent_from_row,
            )
            .optional()?)
    }

    /// One agent's attached MCP server ids, in attachment order (rowid).
    pub fn workflow_agent_mcp_ids(&self, agent_id: &str) -> Result<Vec<String>> {
        let mut statement = self
            .conn
            .prepare("SELECT mcp_id FROM workflow_agent_mcps WHERE agent_id=?1 ORDER BY rowid")?;
        let rows = statement.query_map([agent_id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>, _>>()?)
    }

    /// Every agent→MCP attachment, for listing the whole library in one pass.
    pub fn list_workflow_agent_mcps(&self) -> Result<Vec<(String, String)>> {
        let mut statement = self
            .conn
            .prepare("SELECT agent_id,mcp_id FROM workflow_agent_mcps ORDER BY rowid")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>, _>>()?)
    }

    /// Drop every agent reference to one MCP server (registry delete path).
    pub fn delete_agent_mcp_refs(&self, mcp_id: &str) -> Result<usize> {
        Ok(self
            .conn
            .execute("DELETE FROM workflow_agent_mcps WHERE mcp_id=?1", [mcp_id])?)
    }

    pub fn create_workflow_agent(&self, input: AgentInput) -> Result<AgentDefinition> {
        validate_agent(&input)?;
        let now = now_ms();
        let agent = AgentDefinition {
            id: format!("agent-{}", uuid::Uuid::new_v4().simple()),
            name: input.name.trim().to_string(),
            description: input.description,
            prompt: input.prompt,
            version: 1,
            created_at: now,
            updated_at: now,
        };
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        tx.execute(
            "INSERT INTO workflow_agents VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                agent.id,
                agent.name,
                agent.description,
                agent.prompt,
                agent.version,
                agent.created_at,
                agent.updated_at
            ],
        )?;
        set_agent_mcps(&tx, &agent.id, &input.mcp_servers)?;
        super::skills::set_agent_skills(&tx, &agent.id, &input.user_skills)?;
        tx.commit()?;
        Ok(agent)
    }

    pub fn update_workflow_agent(&self, id: &str, input: AgentInput) -> Result<AgentDefinition> {
        validate_agent(&input)?;
        let previous = self
            .workflow_agent(id)?
            .ok_or_else(|| crate::error::anyhow!("自定义 Agent 不存在"))?;
        let agent = AgentDefinition {
            id: previous.id,
            name: input.name.trim().to_string(),
            description: input.description,
            prompt: input.prompt,
            version: previous.version + 1,
            created_at: previous.created_at,
            updated_at: now_ms(),
        };
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        tx.execute(
            "UPDATE workflow_agents SET name=?2,description=?3,prompt=?4,version=?5,updated_at=?6 WHERE id=?1",
            params![
                agent.id,
                agent.name,
                agent.description,
                agent.prompt,
                agent.version,
                agent.updated_at
            ],
        )?;
        set_agent_mcps(&tx, &agent.id, &input.mcp_servers)?;
        super::skills::set_agent_skills(&tx, &agent.id, &input.user_skills)?;
        tx.commit()?;
        Ok(agent)
    }

    pub fn delete_workflow_agent(&self, id: &str) -> Result<bool> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        tx.execute("DELETE FROM workflow_agent_mcps WHERE agent_id=?1", [id])?;
        super::skills::purge_scope_bindings_tx(&tx, super::skills::SCOPE_AGENT, id)?;
        let deleted = tx.execute("DELETE FROM workflow_agents WHERE id=?1", [id])? > 0;
        tx.commit()?;
        Ok(deleted)
    }

    /// The shared workflow library: every project resolves every draft by id,
    /// so the list is global with `project_id` kept as creation provenance.
    pub fn list_workflow_drafts(&self) -> Result<Vec<WorkflowDraft>> {
        let mut statement = self
            .conn
            .prepare("SELECT document FROM workflow_drafts ORDER BY updated_at DESC,id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let documents = rows.collect::<rusqlite::Result<Vec<_>, _>>()?;
        let mut drafts = Vec::with_capacity(documents.len());
        for document in documents {
            drafts.push(serde_json::from_str(&document)?);
        }
        Ok(drafts)
    }

    pub fn workflow_draft_by_id(&self, id: &str) -> Result<Option<WorkflowDraft>> {
        Ok(self
            .conn
            .query_row(
                "SELECT document FROM workflow_drafts WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|document| serde_json::from_str(&document))
            .transpose()?)
    }

    fn ensure_draft_project_exists(&self, project_id: &str) -> Result<()> {
        if project_id == GLOBAL_WORKFLOW_DRAFT_PROJECT {
            return Ok(());
        }
        if self.get_local_project(project_id)?.is_none() {
            return Err(crate::error::anyhow!("项目不存在"));
        }
        Ok(())
    }

    pub fn create_workflow_draft(
        &self,
        project_id: &str,
        input: WorkflowDraftInput,
    ) -> Result<WorkflowDraft> {
        validate_draft(&input)?;
        self.ensure_draft_project_exists(project_id)?;
        let now = now_ms();
        let draft = WorkflowDraft {
            id: format!("workflow-{}", uuid::Uuid::new_v4().simple()),
            project_id: project_id.to_string(),
            input,
            created_at: now,
            updated_at: now,
        };
        self.conn.execute(
            "INSERT INTO workflow_drafts(id,project_id,document,created_at,updated_at) VALUES(?1,?2,?3,?4,?5)",
            params![
                draft.id,
                draft.project_id,
                serde_json::to_string(&draft)?,
                draft.created_at,
                draft.updated_at
            ],
        )?;
        Ok(draft)
    }

    pub fn save_workflow_draft_by_id(
        &self,
        id: &str,
        input: WorkflowDraftInput,
    ) -> Result<WorkflowDraft> {
        validate_draft(&input)?;
        let previous = self
            .workflow_draft_by_id(id)?
            .ok_or_else(|| crate::error::anyhow!("工作流不存在"))?;
        let draft = WorkflowDraft {
            id: previous.id,
            // Provenance is fixed at creation; saving never re-parents a draft.
            project_id: previous.project_id,
            input,
            created_at: previous.created_at,
            updated_at: now_ms(),
        };
        self.conn.execute(
            "UPDATE workflow_drafts SET document=?2,updated_at=?3 WHERE id=?1",
            params![draft.id, serde_json::to_string(&draft)?, draft.updated_at],
        )?;
        Ok(draft)
    }

    /// Duplicate a workflow as a new library entry. Provenance carries over
    /// verbatim: the source row already exists, so its project may be deleted.
    pub fn copy_workflow_draft(&self, id: &str) -> Result<WorkflowDraft> {
        let previous = self
            .workflow_draft_by_id(id)?
            .ok_or_else(|| crate::error::anyhow!("工作流不存在"))?;
        let source_name = previous.input.name.clone();
        let mut input = previous.input;
        input.name = format!("{} 副本", source_name);
        let now = now_ms();
        let draft = WorkflowDraft {
            id: format!("workflow-{}", uuid::Uuid::new_v4().simple()),
            project_id: previous.project_id,
            input,
            created_at: now,
            updated_at: now,
        };
        validate_draft(&draft.input)?;
        self.conn.execute(
            "INSERT INTO workflow_drafts(id,project_id,document,created_at,updated_at) VALUES(?1,?2,?3,?4,?5)",
            params![
                draft.id,
                draft.project_id,
                serde_json::to_string(&draft)?,
                draft.created_at,
                draft.updated_at
            ],
        )?;
        Ok(draft)
    }

    pub fn delete_workflow_draft(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM workflow_drafts WHERE id=?1", [id])?
            > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::model::LocalProject;
    use crate::workflow::FlowPoint;

    fn fixture() -> (std::path::PathBuf, Store) {
        let root = std::env::temp_dir().join(format!("orx-workflow-test-{}", uuid::Uuid::new_v4()));
        let store = Store::open_at(root.clone()).unwrap();
        store
            .create_local_project(&LocalProject {
                id: "project".into(),
                name: "Project".into(),
                slug: "project".into(),
                github_owner: String::new(),
                github_repo: String::new(),
                github_sync_enabled: false,
                baseline_branch: "main".into(),
                repo_path: root.to_string_lossy().into_owned(),
                run_command: None,
                paper_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        (root, store)
    }

    fn agent(name: &str) -> AgentInput {
        AgentInput {
            name: name.into(),
            description: "custom role".into(),
            prompt: "Review evidence and cite sources.".into(),
            mcp_servers: Vec::new(),
            user_skills: Vec::new(),
        }
    }

    #[test]
    fn custom_agents_are_versioned_without_changing_old_ids() {
        let (root, store) = fixture();
        let created = store.create_workflow_agent(agent("Reviewer")).unwrap();
        let updated = store
            .update_workflow_agent(&created.id, agent("Senior reviewer"))
            .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(created.version, 1);
        assert_eq!(updated.version, 2);
        assert_eq!(store.list_workflow_agents().unwrap(), vec![updated.clone()]);
        assert!(store.delete_workflow_agent(&created.id).unwrap());
        assert!(store.workflow_agent(&created.id).unwrap().is_none());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agent_mcp_attachments_round_trip_and_cleanup() {
        let (root, store) = fixture();
        // 挂载去重 + 读取保序；注册表存在性校验在 API/CLI 入口。
        let analyst = store
            .create_workflow_agent(AgentInput {
                mcp_servers: vec!["mcp-a".into(), "mcp-b".into(), "mcp-a".into()],
                ..agent("Analyst")
            })
            .unwrap();
        assert_eq!(
            store.workflow_agent_mcp_ids(&analyst.id).unwrap(),
            vec!["mcp-a".to_string(), "mcp-b".to_string()]
        );
        // 保存新版本会整体重写挂载关系。
        let mut reattached = agent("Analyst v2");
        reattached.mcp_servers = Vec::new();
        let analyst_v2 = store
            .update_workflow_agent(&analyst.id, reattached)
            .unwrap();
        assert_eq!(analyst_v2.version, 2);
        assert!(store
            .workflow_agent_mcp_ids(&analyst.id)
            .unwrap()
            .is_empty());

        let mut with_mcps = agent("Auditor");
        with_mcps.mcp_servers = vec!["mcp-a".into(), "mcp-c".into()];
        let auditor = store.create_workflow_agent(with_mcps).unwrap();
        assert_eq!(store.workflow_agent_mcp_ids(&auditor.id).unwrap().len(), 2);
        assert_eq!(store.list_workflow_agent_mcps().unwrap().len(), 2);
        // 注册表删除服务时清理全部引用。
        assert_eq!(store.delete_agent_mcp_refs("mcp-a").unwrap(), 1);
        assert_eq!(
            store.workflow_agent_mcp_ids(&auditor.id).unwrap(),
            vec!["mcp-c".to_string()]
        );
        // 删除 agent 同样清理关联表。
        assert!(store.delete_workflow_agent(&auditor.id).unwrap());
        assert!(store.list_workflow_agent_mcps().unwrap().is_empty());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drafts_keep_canvas_state_and_survive_reopen() {
        let (root, store) = fixture();
        let input = WorkflowDraftInput {
            name: "Literature review".into(),
            objective: "Compare methods".into(),
            summary: "Draft may still be incomplete".into(),
            workflow: "literature".into(),
            tasks: vec![],
            positions: std::collections::HashMap::from([(
                "task".into(),
                FlowPoint { x: 20.0, y: 40.0 },
            )]),
            viewport: None,
            frames: Vec::new(),
        };
        let created = store
            .create_workflow_draft("project", input.clone())
            .unwrap();
        let mut renamed = input;
        renamed.name = "Renamed literature review".into();
        renamed.positions.insert(
            ":system:G1".into(),
            FlowPoint {
                x: -320.0,
                y: -180.0,
            },
        );
        let saved = store
            .save_workflow_draft_by_id(&created.id, renamed)
            .unwrap();
        assert_eq!(saved.id, created.id);
        assert_eq!(saved.created_at, created.created_at);
        assert_eq!(saved.project_id, "project");
        drop(store);
        let store = Store::open_at(root.clone()).unwrap();
        let restored = store.workflow_draft_by_id(&saved.id).unwrap().unwrap();
        assert_eq!(restored.input.name, "Renamed literature review");
        assert_eq!(restored.input.positions["task"].x, 20.0);
        assert_eq!(restored.input.positions[":system:G1"].y, -180.0);
        assert!(restored.input.into_plan("Run goal").tasks.is_empty());
        drop(store);
    }

    #[test]
    fn drafts_round_trip_stage_frames() {
        let (root, store) = fixture();
        let input = WorkflowDraftInput {
            name: "Framed plan".into(),
            objective: String::new(),
            summary: String::new(),
            workflow: "literature".into(),
            tasks: vec![],
            positions: std::collections::HashMap::new(),
            viewport: None,
            frames: vec![crate::workflow::FlowFrame {
                id: "stage-1".into(),
                title: "检索阶段".into(),
                x: -320.0,
                y: -180.0,
                width: 640.0,
                height: 480.0,
            }],
        };
        let created = store.create_workflow_draft("project", input).unwrap();
        drop(store);
        let store = Store::open_at(root.clone()).unwrap();
        let restored = store.workflow_draft_by_id(&created.id).unwrap().unwrap();
        let frames = restored.input.frames;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].title, "检索阶段");
        assert_eq!(frames[0].width, 640.0);
        // 旧草稿没有 frames 字段：读取按空数组处理，不受影响。
        let legacy: WorkflowDraftInput =
            serde_json::from_str(r#"{"name":"Legacy","workflow":"literature","tasks":[]}"#)
                .unwrap();
        assert!(legacy.frames.is_empty());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drafts_accept_empty_objective_and_summary_for_canvas_only_editing() {
        let (root, store) = fixture();
        let input = WorkflowDraftInput {
            name: "Reusable method".into(),
            objective: String::new(),
            summary: String::new(),
            workflow: "literature".into(),
            tasks: vec![],
            positions: std::collections::HashMap::new(),
            viewport: None,
            frames: Vec::new(),
        };
        let created = store.create_workflow_draft("project", input).unwrap();
        assert_eq!(
            store
                .workflow_draft_by_id(&created.id)
                .unwrap()
                .unwrap()
                .input
                .name,
            "Reusable method"
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workflow_library_is_shared_across_projects() {
        let (root, store) = fixture();
        let input = WorkflowDraftInput {
            name: "Reusable literature review".into(),
            objective: "Compare methods".into(),
            summary: "Shared by every project".into(),
            workflow: "literature".into(),
            tasks: vec![],
            positions: std::collections::HashMap::new(),
            viewport: None,
            frames: Vec::new(),
        };
        let global = store
            .create_workflow_draft(GLOBAL_WORKFLOW_DRAFT_PROJECT, input.clone())
            .unwrap();
        let first = store
            .create_workflow_draft("project", input.clone())
            .unwrap();
        let second = store.create_workflow_draft("project", input).unwrap();
        // Several workflows coexist per project and every project sees them all.
        assert_ne!(first.id, second.id);
        assert_eq!(store.list_workflow_drafts().unwrap().len(), 3);
        assert_eq!(
            store
                .workflow_draft_by_id(&global.id)
                .unwrap()
                .unwrap()
                .input
                .name,
            "Reusable literature review"
        );
        // Saving keeps creation provenance and timestamps.
        let mut renamed = second.input.clone();
        renamed.name = "Project's own variant".into();
        let saved = store
            .save_workflow_draft_by_id(&second.id, renamed)
            .unwrap();
        assert_eq!(saved.project_id, "project");
        assert_eq!(saved.created_at, second.created_at);
        // Copies get a fresh id and a "副本" suffix.
        let copied = store.copy_workflow_draft(&global.id).unwrap();
        assert_ne!(copied.id, global.id);
        assert_eq!(copied.input.name, "Reusable literature review 副本");
        assert_eq!(copied.project_id, GLOBAL_WORKFLOW_DRAFT_PROJECT);
        assert_eq!(store.list_workflow_drafts().unwrap().len(), 4);
        // Deleting removes exactly one entry.
        assert!(store.delete_workflow_draft(&copied.id).unwrap());
        assert!(!store.delete_workflow_draft(&copied.id).unwrap());
        assert_eq!(store.list_workflow_drafts().unwrap().len(), 3);
        // Creation still validates that the owning project exists.
        assert!(store
            .create_workflow_draft("missing-project", second.input)
            .is_err());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_unique_draft_schema_migrates_to_shared_library() {
        let root =
            std::env::temp_dir().join(format!("orx-workflow-migrate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        {
            let conn = rusqlite::Connection::open(root.join("orx.db")).unwrap();
            conn.execute_batch(
                // The legacy cleanup trigger references local_projects, so the
                // fixture needs that table under the same shape Store creates.
                "CREATE TABLE local_projects (
                    id              TEXT PRIMARY KEY,
                    name            TEXT NOT NULL,
                    slug            TEXT NOT NULL UNIQUE,
                    github_owner    TEXT NOT NULL,
                    github_repo     TEXT NOT NULL,
                    github_sync_enabled INTEGER NOT NULL DEFAULT 1,
                    baseline_branch TEXT NOT NULL DEFAULT 'main',
                    repo_path       TEXT NOT NULL,
                    run_command     TEXT,
                    paper_id        TEXT,
                    created_at      INTEGER NOT NULL,
                    updated_at      INTEGER NOT NULL
                );
                CREATE TABLE workflow_drafts (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL UNIQUE,
                    document TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TRIGGER workflow_project_cleanup AFTER DELETE ON local_projects BEGIN
                    DELETE FROM workflow_drafts WHERE project_id=OLD.id;
                END;
                INSERT INTO workflow_drafts VALUES('workflow-legacy','project',
                    '{\"id\":\"workflow-legacy\",\"projectId\":\"project\",\"name\":\"Legacy\",\"objective\":\"\",\"summary\":\"\",\"workflow\":\"literature\",\"tasks\":[],\"positions\":{},\"viewport\":null,\"createdAt\":1,\"updatedAt\":1}',
                    1, 1);",
            )
            .unwrap();
        }
        let store = Store::open_at(root.clone()).unwrap();
        // The legacy draft survives the rebuild with its document intact.
        let restored = store
            .workflow_draft_by_id("workflow-legacy")
            .unwrap()
            .unwrap();
        assert_eq!(restored.input.name, "Legacy");
        assert_eq!(restored.project_id, "project");
        // Several drafts may now share one project, and project deletion no
        // longer cascades into the library.
        store
            .create_workflow_draft(
                GLOBAL_WORKFLOW_DRAFT_PROJECT,
                WorkflowDraftInput {
                    name: "Fresh entry".into(),
                    objective: String::new(),
                    summary: String::new(),
                    workflow: "literature".into(),
                    tasks: vec![],
                    positions: std::collections::HashMap::new(),
                    viewport: None,
                    frames: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(store.list_workflow_drafts().unwrap().len(), 2);
        let trigger_gone = |store: &Store| -> bool {
            store
                .conn
                .query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='workflow_project_cleanup')",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert!(trigger_gone(&store));
        // The project row returns so a later open can prove deleting it leaves
        // the shared library untouched.
        store
            .conn
            .execute(
                "INSERT INTO local_projects(id,name,slug,github_owner,github_repo,repo_path,created_at,updated_at) VALUES('project','Legacy project','legacy','','','/tmp/orx-legacy',1,1)",
                [],
            )
            .unwrap();
        drop(store);
        // Reopening must not resurrect the cascade trigger; if it did, deleting
        // the project would silently wipe every draft it originated.
        let store = Store::open_at(root.clone()).unwrap();
        assert!(trigger_gone(&store));
        store
            .conn
            .execute("DELETE FROM local_projects WHERE id='project'", [])
            .unwrap();
        assert!(
            store
                .workflow_draft_by_id("workflow-legacy")
                .unwrap()
                .is_some(),
            "project deletion must not cascade into the shared workflow library"
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
