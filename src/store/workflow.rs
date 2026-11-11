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
        CREATE TABLE IF NOT EXISTS workflow_drafts (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL UNIQUE,
            document TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS workflow_project_cleanup AFTER DELETE ON local_projects BEGIN
            DELETE FROM workflow_drafts WHERE project_id=OLD.id;
        END;",
    )?;
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
        self.conn.execute(
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
        self.conn.execute(
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
        Ok(agent)
    }

    pub fn delete_workflow_agent(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM workflow_agents WHERE id=?1", [id])?
            > 0)
    }

    pub fn workflow_draft(&self, project_id: &str) -> Result<Option<WorkflowDraft>> {
        Ok(self
            .conn
            .query_row(
                "SELECT document FROM workflow_drafts WHERE project_id=?1",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|document| serde_json::from_str(&document))
            .transpose()?)
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

    pub fn save_workflow_draft(
        &self,
        project_id: &str,
        input: WorkflowDraftInput,
    ) -> Result<WorkflowDraft> {
        validate_draft(&input)?;
        if project_id != GLOBAL_WORKFLOW_DRAFT_PROJECT {
            self.get_local_project(project_id)?
                .ok_or_else(|| crate::error::anyhow!("项目不存在"))?;
        }
        let previous = self.workflow_draft(project_id)?;
        let now = now_ms();
        let draft = WorkflowDraft {
            id: previous
                .as_ref()
                .map(|draft| draft.id.clone())
                .unwrap_or_else(|| format!("workflow-{}", uuid::Uuid::new_v4().simple())),
            project_id: project_id.to_string(),
            input,
            created_at: previous.as_ref().map_or(now, |draft| draft.created_at),
            updated_at: now,
        };
        self.conn.execute(
            "INSERT INTO workflow_drafts(id,project_id,document,created_at,updated_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(project_id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at",
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
        };
        let saved = store.save_workflow_draft("project", input).unwrap();
        drop(store);
        let store = Store::open_at(root.clone()).unwrap();
        let restored = store.workflow_draft("project").unwrap().unwrap();
        assert_eq!(restored.id, saved.id);
        assert_eq!(restored.input.positions["task"].x, 20.0);
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
        };
        store.save_workflow_draft("project", input).unwrap();
        assert_eq!(
            store.workflow_draft("project").unwrap().unwrap().input.name,
            "Reusable method"
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn global_draft_is_independent_from_project_copies() {
        let (root, store) = fixture();
        let input = WorkflowDraftInput {
            name: "Reusable literature review".into(),
            objective: "Compare methods".into(),
            summary: "Edit before choosing a project".into(),
            workflow: "literature".into(),
            tasks: vec![],
            positions: std::collections::HashMap::new(),
            viewport: None,
        };
        let global = store
            .save_workflow_draft(GLOBAL_WORKFLOW_DRAFT_PROJECT, input.clone())
            .unwrap();
        let project = store.save_workflow_draft("project", input).unwrap();
        assert_ne!(global.id, project.id);
        assert_eq!(global.project_id, GLOBAL_WORKFLOW_DRAFT_PROJECT);
        assert_eq!(project.project_id, "project");
        drop(store);
        let store = Store::open_at(root.clone()).unwrap();
        assert_eq!(
            store
                .workflow_draft(GLOBAL_WORKFLOW_DRAFT_PROJECT)
                .unwrap()
                .unwrap()
                .input
                .name,
            "Reusable literature review"
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
