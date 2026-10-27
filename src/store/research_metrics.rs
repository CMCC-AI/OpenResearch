//! Local-only usage and activity accounting for research dashboards.
use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::{now_ms, research::Study, Store, StoredChatMessage, TokenUsage};
use crate::error::Result;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResearchMetrics {
    pub active_duration_ms: Option<i64>,
    pub token_count: Option<u64>,
    pub token_count_complete: bool,
    pub measured_at: i64,
    pub running: bool,
}

fn pending_prompt(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(values) => values.iter().any(pending_prompt),
        serde_json::Value::Object(object) => {
            object.get("prompt").is_some_and(|prompt| {
                prompt.get("resolved").and_then(|value| value.as_bool()) != Some(true)
            }) || object.get("children").is_some_and(pending_prompt)
        }
        _ => false,
    }
}

/// Called at durable transcript checkpoints, not by dashboard polling. A held
/// permission/question/plan closes the span; resolving it opens a new span.
pub(super) fn record_chat_activity(
    conn: &Connection,
    message: &StoredChatMessage,
    first_seen: bool,
) -> Result<()> {
    if message.role != "assistant" {
        return Ok(());
    }
    record_chat_activity_at(conn, message, first_seen, now_ms())
}

fn record_chat_activity_at(
    conn: &Connection,
    message: &StoredChatMessage,
    first_seen: bool,
    now: i64,
) -> Result<()> {
    let admitted: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_turns WHERE assistant_message_id=?1 AND session_id=?2)",
        params![message.id, message.session_id],
        |row| row.get(0),
    )?;
    if !admitted {
        return Ok(());
    }
    let completed: Option<i64> = conn.query_row(
        "SELECT completed_at FROM chat_messages WHERE id=?1",
        [&message.id],
        |row| row.get(0),
    )?;
    let parts: serde_json::Value = serde_json::from_str(&message.parts_json)?;
    let active = completed.is_none() && !pending_prompt(&parts);
    let open: Option<(i64, i64)> = conn
        .query_row(
            "SELECT id, started_at FROM chat_activity_spans WHERE message_id=?1 AND ended_at IS NULL",
            [&message.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match (active, open) {
        (true, Some((id, _))) => {
            conn.execute(
                "UPDATE chat_activity_spans SET observed_at=?2 WHERE id=?1",
                params![id, now],
            )?;
        }
        (false, Some((id, start))) => {
            conn.execute(
                "UPDATE chat_activity_spans SET ended_at=?2, observed_at=?2 WHERE id=?1",
                params![id, completed.unwrap_or(now).min(now).max(start)],
            )?;
        }
        (true, None) => {
            let prior: Option<bool> = conn.query_row(
                "SELECT MIN(complete) FROM chat_activity_spans WHERE message_id=?1",
                [&message.id],
                |row| row.get(0),
            )?;
            let complete = first_seen || prior == Some(true);
            let start = if first_seen {
                message.created_at.min(now)
            } else {
                now
            };
            conn.execute(
                "INSERT INTO chat_activity_spans(message_id,session_id,started_at,observed_at,complete) VALUES(?1,?2,?3,?4,?5)",
                params![message.id, message.session_id, start, now, complete],
            )?;
        }
        (false, None) => {
            if first_seen {
                if let Some(end) = completed {
                    let start = message.created_at.min(end);
                    conn.execute("INSERT INTO chat_activity_spans(message_id,session_id,started_at,observed_at,ended_at,complete) VALUES(?1,?2,?3,?4,?4,1)",params![message.id,message.session_id,start,end.min(now)])?;
                }
            }
        }
    }
    Ok(())
}

/// Parallel experts consume wall-clock time concurrently, rather than adding
/// their durations together. All intervals are clipped to the study's lifetime.
fn union_duration(mut intervals: Vec<(i64, i64)>) -> i64 {
    intervals.sort_unstable();
    let mut total = 0_i64;
    let mut end = 0_i64;
    for (start, stop) in intervals {
        if stop > start.max(end) {
            total = total.saturating_add(stop - start.max(end));
            end = stop;
        }
    }
    total
}

impl Store {
    pub(crate) fn research_metrics(
        &self,
        study: &Study,
        busy_sessions: &[String],
        now: i64,
    ) -> Result<ResearchMetrics> {
        let end = if study.status == "active" {
            now
        } else {
            study.updated_at.min(now)
        };
        let busy: HashSet<&str> = busy_sessions.iter().map(String::as_str).collect();
        let members = "WITH RECURSIVE members(id) AS (SELECT ?2 UNION SELECT session_id FROM research_sessions WHERE study_id=?1 UNION SELECT s.id FROM chat_sessions s JOIN members m ON s.parent_session_id=m.id OR s.side_parent_session_id=m.id) ";
        let mut statement = self.conn.prepare(&format!("{members} SELECT a.session_id,a.started_at,a.ended_at,a.observed_at,a.complete FROM chat_activity_spans a JOIN members m ON m.id=a.session_id WHERE COALESCE(a.ended_at,a.observed_at)>=?3"))?;
        let rows = statement.query_map(
            params![study.id, study.session_id, study.created_at],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )?;
        let mut intervals = Vec::new();
        let mut complete = true;
        let mut running = false;
        for row in rows {
            let (session, start, stopped, observed, measured) = row?;
            let observed_live = stopped.is_none() && busy.contains(session.as_str());
            let live = observed_live && study.status == "active";
            running |= live;
            complete &= measured;
            intervals.push((
                start.max(study.created_at),
                stopped
                    .unwrap_or(if observed_live { now } else { observed })
                    .min(end),
            ));
        }
        // Experiments can keep working while every agent is idle. Their
        // durable lifecycle contributes to the same wall-clock union.
        for run in self.research_runs(study)? {
            let live =
                run.ended_at.is_none() && matches!(run.status.as_str(), "starting" | "running");
            running |= live && study.status == "active";
            intervals.push((
                run.created_at.max(study.created_at),
                run.ended_at
                    .unwrap_or(if live { now } else { run.updated_at })
                    .min(end),
            ));
        }
        // Do not fabricate a duration for historical turns that predate tracking.
        let missing: bool = self.conn.query_row(&format!("{members} SELECT EXISTS(SELECT 1 FROM chat_turns t JOIN members m ON m.id=t.session_id WHERE t.updated_at>=?3 AND NOT EXISTS(SELECT 1 FROM chat_activity_spans a WHERE a.message_id=t.assistant_message_id))"),params![study.id,study.session_id,study.created_at],|row|row.get(0))?;
        let mut usage = self.conn.prepare(&format!("{members} SELECT s.usage_json,s.complete FROM chat_usage_executions e JOIN chat_turns t ON t.id=e.turn_id JOIN members m ON m.id=t.session_id LEFT JOIN chat_usage_samples s ON s.execution_id=e.execution_id WHERE t.updated_at>=?3"))?;
        let samples = usage.query_map(
            params![study.id, study.session_id, study.created_at],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<bool>>(1)?,
                ))
            },
        )?;
        let mut tokens = None::<u64>;
        let mut tokens_complete = true;
        for sample in samples {
            let (json, final_sample) = sample?;
            let count = json
                .map(|value| serde_json::from_str::<TokenUsage>(&value))
                .transpose()?
                .and_then(|value| value.total());
            if let Some(count) = count {
                tokens = Some(tokens.unwrap_or(0).saturating_add(count));
            }
            tokens_complete &= count.is_some() && final_sample == Some(true);
        }
        let has_turns: bool = self.conn.query_row(&format!("{members} SELECT EXISTS(SELECT 1 FROM chat_turns t JOIN members m ON m.id=t.session_id WHERE t.updated_at>=?3)"), params![study.id,study.session_id,study.created_at],|row|row.get(0))?;
        let unmeasured_turn: bool = self.conn.query_row(&format!("{members} SELECT EXISTS(SELECT 1 FROM chat_turns t JOIN members m ON m.id=t.session_id WHERE t.updated_at>=?3 AND NOT EXISTS(SELECT 1 FROM chat_usage_executions e WHERE e.turn_id=t.id))"),params![study.id,study.session_id,study.created_at],|row|row.get(0))?;
        tokens_complete &= !unmeasured_turn;
        if tokens.is_none() && !has_turns {
            tokens = Some(0);
        }
        Ok(ResearchMetrics {
            active_duration_ms: (complete && !missing).then(|| union_duration(intervals)),
            token_count: tokens,
            token_count_complete: tokens_complete && (tokens.is_some() || !has_turns),
            measured_at: now,
            running,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parallel_activity_is_unioned_and_pauses_are_excluded() {
        assert_eq!(
            union_duration(vec![(100, 200), (150, 250), (400, 500), (500, 550)]),
            300
        );
        assert_eq!(union_duration(vec![(200, 100), (100, 100)]), 0);
    }
    #[test]
    fn only_unresolved_prompts_pause_activity() {
        assert!(pending_prompt(
            &serde_json::json!([{"children":[{"prompt":{"resolved":false}}]}])
        ));
        assert!(!pending_prompt(
            &serde_json::json!([{"prompt":{"resolved":true}}])
        ));
    }
    #[test]
    fn activity_checkpoints_exclude_prompt_holds_and_preserve_resume_segments() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE chat_messages(id TEXT,completed_at INTEGER); CREATE TABLE chat_turns(assistant_message_id TEXT,session_id TEXT); CREATE TABLE chat_activity_spans(id INTEGER PRIMARY KEY,message_id TEXT,session_id TEXT,started_at INTEGER,observed_at INTEGER,ended_at INTEGER,complete INTEGER);
        INSERT INTO chat_messages VALUES('m',NULL); INSERT INTO chat_turns VALUES('m','s');").unwrap();
        let mut message = StoredChatMessage {
            id: "m".into(),
            session_id: "s".into(),
            role: "assistant".into(),
            parts_json: "[]".into(),
            created_at: 1000,
            completed_at: None,
            parent_id: None,
            base_native_session_id: None,
            result_native_session_id: None,
        };
        record_chat_activity_at(&conn, &message, true, 1000).unwrap();
        message.parts_json = r#"[{"prompt":{"resolved":false}}]"#.into();
        record_chat_activity_at(&conn, &message, false, 2000).unwrap();
        record_chat_activity_at(&conn, &message, false, 4000).unwrap();
        message.parts_json = r#"[{"prompt":{"resolved":true}}]"#.into();
        record_chat_activity_at(&conn, &message, false, 5000).unwrap();
        record_chat_activity_at(&conn, &message, false, 6000).unwrap();
        conn.execute("UPDATE chat_messages SET completed_at=6500", [])
            .unwrap();
        record_chat_activity_at(&conn, &message, false, 6500).unwrap();
        let spans = conn
            .prepare("SELECT started_at,ended_at FROM chat_activity_spans ORDER BY started_at")
            .unwrap()
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(spans, vec![(1000, 2000), (5000, 6500)]);
        assert_eq!(union_duration(spans), 2500);
        // Late unresolved snapshots never reopen a completed message.
        record_chat_activity_at(&conn, &message, false, 10000).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM chat_activity_spans", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}
