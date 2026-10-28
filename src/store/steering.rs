//! Durable steering admission. Registration is not proof of native delivery.
use super::*;

#[derive(Debug)]
pub(crate) struct ClientTurnConflict;

impl std::fmt::Display for ClientTurnConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("clientTurnId was already used with different content")
    }
}

impl std::error::Error for ClientTurnConflict {}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ChatSubmission {
    pub kind: String,
    pub id: String,
    pub request_hash: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SteerAdmission {
    Inserted,
    Existing(ChatSubmission),
    Conflict,
}

pub(super) fn submission(
    conn: &Connection,
    session: &str,
    client: &str,
) -> Result<Option<ChatSubmission>> {
    Ok(conn.query_row(
        "SELECT 'turn', id, request_hash FROM chat_turns WHERE session_id = ?1 AND client_turn_id = ?2
         UNION ALL
         SELECT 'queued', id, request_hash FROM chat_queued_messages WHERE session_id = ?1 AND client_turn_id = ?2
         UNION ALL
         SELECT 'steer', id, request_hash FROM chat_steering_requests WHERE session_id = ?1 AND client_turn_id = ?2
         LIMIT 1",
        params![session, client],
        |row| Ok(ChatSubmission { kind: row.get(0)?, id: row.get(1)?, request_hash: row.get(2)? }),
    ).optional()?)
}

impl Store {
    pub(crate) fn chat_submission(
        &self,
        session: &str,
        client: &str,
    ) -> Result<Option<ChatSubmission>> {
        submission(&self.conn, session, client)
    }

    /// The write transaction serializes native admission with ordinary turn and
    /// queue inserts, including competing Store connections / up processes.
    pub(crate) fn admit_chat_steer(
        &self,
        message: &StoredQueuedChatMessage,
    ) -> Result<SteerAdmission> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id = ?1)",
            params![message.session_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(anyhow!("chat session not found"));
        }
        if let Some(existing) = submission(&tx, &message.session_id, &message.client_turn_id)? {
            return Ok(if existing.request_hash == message.request_hash {
                SteerAdmission::Existing(existing)
            } else {
                SteerAdmission::Conflict
            });
        }
        tx.execute(
            "INSERT INTO chat_steering_requests
             (id, session_id, client_turn_id, request_hash, payload_json, state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'registered', ?6)",
            params![
                message.id,
                message.session_id,
                message.client_turn_id,
                message.request_hash,
                message.payload_json,
                message.created_at
            ],
        )?;
        tx.commit()?;
        Ok(SteerAdmission::Inserted)
    }

    /// Only an explicitly rejected / unsent steer may become a queued message.
    /// Retain the receipt even after Stop deletes its queue row: absence of the
    /// queue must never let a retry deliver the original instruction again.
    pub(crate) fn park_chat_steer(&self, message: &StoredQueuedChatMessage) -> Result<bool> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let eligible: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_steering_requests
             WHERE session_id = ?1 AND client_turn_id = ?2 AND request_hash = ?3 AND state = 'registered')",
            params![message.session_id, message.client_turn_id, message.request_hash],
            |row| row.get(0),
        )?;
        if !eligible {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO chat_queued_messages
             (id, session_id, client_turn_id, request_hash, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                message.id,
                message.session_id,
                message.client_turn_id,
                message.request_hash,
                message.payload_json,
                message.created_at
            ],
        )?;
        tx.execute(
            "UPDATE chat_steering_requests SET state = 'queued'
             WHERE session_id = ?1 AND client_turn_id = ?2",
            params![message.session_id, message.client_turn_id],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// A native ACK (or successful stdin write) is a handoff, not model success.
    /// An ambiguous transport failure is never eligible for automatic parking.
    pub(crate) fn mark_chat_steer_handoff(
        &self,
        session: &str,
        client: &str,
        confirmed: bool,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_steering_requests SET state = ?3
             WHERE session_id = ?1 AND client_turn_id = ?2 AND state = 'registered'",
            params![
                session,
                client,
                if confirmed { "handed_off" } else { "uncertain" }
            ],
        )?;
        Ok(())
    }
}
