//! MCP server proposals the lead (AI) files through `orx mcp propose`. A
//! proposal is inert until the user approves it from the chat card; approval
//! is what writes the real registry (`config_dir()/mcp.json`). Payloads keep
//! the full server config so approval is one click, but env values are never
//! rendered back into the chat — the card shows keys only.

use rusqlite::{params, OptionalExtension};

use super::{now_ms, Store};
use crate::error::{anyhow, Result};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpProposal {
    pub id: String,
    pub session_id: String,
    pub name: String,
    /// `serde_json` of [`crate::local::mcp_registry::McpServerInput`].
    pub payload: String,
    pub rationale: String,
    pub status: String,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpProposalInput {
    pub server: crate::local::mcp_registry::McpServerInput,
    #[serde(default)]
    pub rationale: String,
}

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mcp_proposals (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,
            rationale TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            decided_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS mcp_proposals_session ON mcp_proposals(session_id,status);",
    )?;
    Ok(())
}

fn proposal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpProposal> {
    Ok(McpProposal {
        id: row.get(0)?,
        session_id: row.get(1)?,
        name: row.get(2)?,
        payload: row.get(3)?,
        rationale: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        decided_at: row.get(7)?,
    })
}

const PROPOSAL_COLUMNS: &str = "id,session_id,name,payload,rationale,status,created_at,decided_at";

impl Store {
    pub fn create_mcp_proposal(
        &self,
        session_id: &str,
        input: &McpProposalInput,
    ) -> Result<McpProposal> {
        let name = input.server.name.trim().to_string();
        if name.is_empty() {
            return Err(anyhow!("提案缺少服务名称"));
        }
        crate::local::mcp_registry::validate_mcp_server(&input.server)?;
        let proposal = McpProposal {
            id: format!("mcpprop-{}", uuid::Uuid::new_v4().simple()),
            session_id: session_id.to_string(),
            name: name.clone(),
            payload: serde_json::to_string(&input.server)?,
            rationale: input.rationale.trim().to_string(),
            status: "pending".into(),
            created_at: now_ms(),
            decided_at: None,
        };
        // 同名已有待审提案时不重复堆卡片；已批准/已拒绝的历史不算挡路。
        let duplicate: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_proposals WHERE session_id=?1 AND name=?2 AND status='pending')",
            params![session_id, name],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(anyhow!("已有「{name}」的待确认提案，等待用户处理即可"));
        }
        self.conn.execute(
            "INSERT INTO mcp_proposals VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                proposal.id,
                proposal.session_id,
                proposal.name,
                proposal.payload,
                proposal.rationale,
                proposal.status,
                proposal.created_at,
                proposal.decided_at,
            ],
        )?;
        Ok(proposal)
    }

    /// Pending proposals for a chat session, oldest first (card order).
    pub fn pending_mcp_proposals(&self, session_id: &str) -> Result<Vec<McpProposal>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {PROPOSAL_COLUMNS} FROM mcp_proposals WHERE session_id=?1 AND status='pending' ORDER BY created_at,id"
        ))?;
        let rows = statement.query_map([session_id], proposal_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>, _>>()?)
    }

    /// Fetch a proposal in any status. The approval flow reads the payload
    /// from here before consuming the proposal: the registry write happens
    /// between the read and [`Store::decide_mcp_proposal`], so a failed
    /// registration (name conflict) leaves the proposal pending.
    pub fn mcp_proposal(&self, id: &str) -> Result<Option<McpProposal>> {
        let proposal = self
            .conn
            .query_row(
                &format!("SELECT {PROPOSAL_COLUMNS} FROM mcp_proposals WHERE id=?1"),
                [id],
                proposal_from_row,
            )
            .optional()?;
        Ok(proposal)
    }

    /// Move a pending proposal to approved/rejected. The registry write for an
    /// approval happens in the caller before this runs (file side effect stays
    /// out of the tx; a failed write above leaves the proposal pending).
    pub fn decide_mcp_proposal(&self, id: &str, approve: bool) -> Result<McpProposal> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let proposal = tx
            .query_row(
                &format!("SELECT {PROPOSAL_COLUMNS} FROM mcp_proposals WHERE id=?1"),
                [id],
                proposal_from_row,
            )
            .optional()?
            .ok_or_else(|| anyhow!("提案不存在"))?;
        if proposal.status != "pending" {
            return Err(anyhow!("提案已被处理（{}）", proposal.status));
        }
        let status = if approve { "approved" } else { "rejected" };
        let decided_at = now_ms();
        tx.execute(
            "UPDATE mcp_proposals SET status=?2, decided_at=?3 WHERE id=?1",
            params![id, status, decided_at],
        )?;
        tx.commit()?;
        Ok(McpProposal {
            status: status.into(),
            decided_at: Some(decided_at),
            ..proposal
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::mcp_registry::McpServerInput;
    use crate::local::mcp_registry::McpTransport;

    fn fixture() -> (std::path::PathBuf, Store) {
        let root = std::env::temp_dir().join(format!("orx-mcp-proposal-{}", uuid::Uuid::new_v4()));
        let store = Store::open_at(root.clone()).unwrap();
        (root, store)
    }

    fn input(name: &str) -> McpProposalInput {
        McpProposalInput {
            server: McpServerInput {
                name: name.into(),
                transport: McpTransport::Stdio,
                command: "npx".into(),
                args: vec!["-y".into(), "server-thing".into()],
                env: Default::default(),
                url: String::new(),
                headers: Default::default(),
                description: "示例服务".into(),
                enabled: true,
            },
            rationale: "任务需要".into(),
        }
    }

    #[test]
    fn proposals_follow_the_pending_lifecycle() {
        let (root, store) = fixture();
        let proposal = store
            .create_mcp_proposal("chat-1", &input("codegraph"))
            .unwrap();
        assert!(proposal.id.starts_with("mcpprop-"));
        assert_eq!(proposal.status, "pending");
        // 同名待审提案拒绝重复堆卡。
        assert!(store
            .create_mcp_proposal("chat-1", &input("codegraph"))
            .is_err());
        assert_eq!(store.pending_mcp_proposals("chat-1").unwrap().len(), 1);
        assert!(store.pending_mcp_proposals("chat-2").unwrap().is_empty());
        // 处理后再处理报错；拒绝后的同名可以重新提案。
        let decided = store.decide_mcp_proposal(&proposal.id, false).unwrap();
        assert_eq!(decided.status, "rejected");
        assert!(decided.decided_at.is_some());
        assert!(store.decide_mcp_proposal(&proposal.id, true).is_err());
        let again = store
            .create_mcp_proposal("chat-1", &input("codegraph"))
            .unwrap();
        let approved = store.decide_mcp_proposal(&again.id, true).unwrap();
        assert_eq!(approved.status, "approved");
        assert!(store.pending_mcp_proposals("chat-1").unwrap().is_empty());
        // 非法配置（stdio 缺命令）在提案入口被拒绝。
        let mut broken = input("broken");
        broken.server.command = String::new();
        assert!(store.create_mcp_proposal("chat-1", &broken).is_err());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
