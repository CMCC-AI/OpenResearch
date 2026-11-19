//! Local run store — orx's own truth for externally-executed runs.
//!
//! Mirrors the opencode model: state lives in a SQLite db beside the work
//! (`orx.db` under the data dir), and `orx serve` exposes it over loopback
//! HTTP/SSE. Run logs are plain append-only files under `run-logs/<runId>.log`
//! so tailing (serve) and appending (supervise) never contend on the db.
//!
//! Data dir: `$ORX_DATA_DIR`, else `$XDG_DATA_HOME/openresearch`, else
//! `~/.local/share/openresearch`.

pub(crate) mod input_sets;
pub(crate) mod material_reads;
pub(crate) mod metric_evidence;
pub(crate) mod research;
mod research_metrics;
mod schema;
pub(crate) mod steering;
pub(crate) mod storage_usage;
mod telemetry;
pub(crate) use telemetry::{InvocationIdentity, TokenUsage};

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{anyhow, Context, Result};
use crate::local::autonomy::Autonomy;
use crate::local::model::{LocalExperiment, LocalProject};
use crate::workspace_state::{GlobalWorkspaceState, WorkspaceState};

pub fn data_dir() -> PathBuf {
    // Resolution order (most to least authoritative):
    //   1. $ORX_DATA_DIR — explicit imperative override (launch.json, tests,
    //      the Codex sandbox pin). Stays on top so a forced path always wins.
    //   2. persisted user choice (config_dir()/settings.json `dataDir`) — set
    //      from the UI's Storage settings. Read fresh every call (no cache) so a
    //      just-completed data-dir move is picked up by the next Store::open().
    //   3. $XDG_DATA_HOME/openresearch — ambient system default *base*; an
    //      explicit UI choice rightly beats it, so it sits below (2).
    //   4. ~/.local/share/openresearch — hardcoded default.
    if let Some(dir) = env_path("ORX_DATA_DIR") {
        return dir;
    }
    if let Some(dir) = crate::config::settings_data_dir() {
        return dir;
    }
    xdg_default_data_dir()
}

pub(crate) fn open_lifecycle_lock() -> Result<fd_lock::RwLock<std::fs::File>> {
    open_lifecycle_lock_in(&crate::config::config_dir())
}

pub(crate) fn open_lifecycle_lock_in(config_dir: &Path) -> Result<fd_lock::RwLock<std::fs::File>> {
    // The config dir stays put while the user can move the live data directory.
    let path = lifecycle_lock_path_in(config_dir);
    let legacy = config_dir.join("orx.lifecycle.lock");
    if !path.exists() {
        drop(open_lifecycle_lock_at(&legacy)?);
        // Keep the legacy lock if this filesystem cannot share its inode.
        if std::fs::create_dir_all(path.parent().unwrap()).is_err() {
            return open_lifecycle_lock_at(&legacy);
        }
        match std::fs::hard_link(&legacy, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return open_lifecycle_lock_at(&legacy),
        }
    }
    if !same_file::is_same_file(&legacy, &path)? {
        return Err(anyhow!(
            "Lifecycle lock paths differ; refusing to run without a shared lock"
        ));
    }
    open_lifecycle_lock_at(&path)
}

pub(crate) fn lifecycle_lock_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join("locks/orx.lifecycle.lock")
}

pub(crate) fn open_lifecycle_lock_at(
    path: &std::path::Path,
) -> Result<fd_lock::RwLock<std::fs::File>> {
    if let Some(parent) = path.parent() {
        crate::paths::create_dir_all(parent)?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .with_context(|| format!("Could not open {}", path.display()))?;
    Ok(fd_lock::RwLock::new(file))
}

fn data_dir_move_lock_path() -> PathBuf {
    crate::config::config_dir().join("orx.data-dir-move.lock")
}

pub(crate) struct DataDirMoveLock {
    release: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for DataDirMoveLock {
    fn drop(&mut self) {
        self.release.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn acquire_data_dir_move_lock(path: PathBuf) -> Result<DataDirMoveLock> {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let mut lock = open_lifecycle_lock_at(&path)?;
            let _guard = lock.try_write()?;
            ready_tx
                .send(Ok(()))
                .map_err(|_| anyhow!("data-directory move lock receiver closed"))?;
            let _ = release_rx.recv();
            Ok(())
        })();
        if let Err(error) = result {
            let _ = ready_tx.send(Err(error.to_string()));
        }
    });
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(DataDirMoveLock {
            release: Some(release_tx),
            thread: Some(thread),
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(anyhow!(error))
        }
        Err(_) => {
            let _ = thread.join();
            Err(anyhow!("data-directory move lock thread exited"))
        }
    }
}

/// Read an env var as a path, treating unset **and empty** the same (an empty
/// `export ORX_DATA_DIR=` is a shell footgun that must not resolve to `""`).
fn env_path(key: &str) -> Option<PathBuf> {
    crate::local::shell_env::var(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// `$XDG_DATA_HOME/openresearch` else `~/.local/share/openresearch` — the tail
/// of the resolution chain, shared by `data_dir()` and `default_data_dir()`.
fn xdg_default_data_dir() -> PathBuf {
    let base = env_path("XDG_DATA_HOME").unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local")
            .join("share")
    });
    base.join("openresearch")
}

/// The data dir ignoring any persisted user choice — where resolution would
/// land if `settings.json` had no `dataDir`. Used by the Storage UI to show the
/// "(default)" path and offer resetting to it. `$ORX_DATA_DIR` still wins, since
/// it's a forced override.
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = env_path("ORX_DATA_DIR") {
        return dir;
    }
    xdg_default_data_dir()
}

/// Where `data_dir()`'s answer came from — surfaced by the Storage settings API
/// so the UI can explain a forced env override (read-only) vs. a user choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DataDirSource {
    /// `$ORX_DATA_DIR` is set — forces the path, UI field is read-only.
    Env,
    /// Persisted user choice in `settings.json`.
    Config,
    /// Derived from `$XDG_DATA_HOME` (no user choice).
    Xdg,
    /// Hardcoded `~/.local/share/openresearch`.
    Default,
}

/// Classify the current `data_dir()` resolution for the Storage settings UI.
pub fn data_dir_source() -> DataDirSource {
    if env_path("ORX_DATA_DIR").is_some() {
        return DataDirSource::Env;
    }
    if crate::config::settings_data_dir().is_some() {
        return DataDirSource::Config;
    }
    if env_path("XDG_DATA_HOME").is_some() {
        return DataDirSource::Xdg;
    }
    DataDirSource::Default
}

/// Compact human-readable byte size (e.g. `1.2 KB`, `3.4 MB`). Shared by the
/// artifacts listing and the data-dir move so the two don't drift.
pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if n < 1024 {
        return format!("{n} B");
    }
    let mut size = n as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    format!("{:.1} {}", size, UNITS[unit])
}

pub fn log_path(run_id: &str) -> PathBuf {
    // Sanitize the id so malformed local data cannot escape the log directory.
    let safe: String = run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    data_dir().join("run-logs").join(format!("{safe}.log"))
}

/// A locally tracked run. `backend_json` stores the backend descriptor used by
/// the detached supervisor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
    pub id: String,
    pub experiment_id: String,
    pub project_id: String,
    pub status: String,
    pub backend_json: String,
    pub command: String,
    /// Unix millis.
    pub created_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i64>,
    pub commit_sha: Option<String>,
    pub result_markdown: Option<String>,
    /// Cancel intent polled by the detached supervisor.
    pub cancel_requested: bool,
    /// Who asked for the cancel; written only by `Store::request_cancel`, never by `upsert_run`.
    pub cancel_reason: Option<String>,
    /// The `orx up` chat session that launched this run, when it was started by
    /// an agent harness child (which exports `ORX_CHAT_SESSION_ID`). `None` for
    /// CLI-launched runs. This records attribution; wake-ups are
    /// separately and explicitly registered in `chat_run_wakeups`.
    pub chat_session_id: Option<String>,
}

/// Run lifecycle: active states can finish once; terminal outcomes never change.
/// Both status updates and submission upserts enforce these transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    /// Submitted to the backend; not yet observed running.
    Starting,
    /// The backend has confirmed the job is under way.
    Running,
    /// Terminal: the job ran to completion with a successful exit.
    Done,
    /// Terminal: the job errored, or was never observed as launched.
    Failed,
    /// Terminal: cancellation was requested and honored.
    Cancelled,
}

impl RunStatus {
    #[cfg(test)]
    const ALL: [RunStatus; 5] = [
        Self::Starting,
        Self::Running,
        Self::Done,
        Self::Failed,
        Self::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// Parses the stored/wire vocabulary. `None` for anything else — callers
    /// that only need "is this finished" should prefer [`is_terminal_status`],
    /// which treats an unrecognized string the same as a non-terminal one.
    pub fn parse(status: &str) -> Option<Self> {
        Some(match status {
            "starting" => Self::Starting,
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    /// A run in a terminal state is finished and will never change again.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }

    fn can_transition_to(self, to: RunStatus) -> bool {
        use RunStatus::*;
        match self {
            Starting => true,
            Running => matches!(to, Running | Done | Failed | Cancelled),
            Done | Failed | Cancelled => false,
        }
    }
}

impl std::fmt::Display for RunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Whether a stored run status string denotes a finished run. An unrecognized
/// string is treated as non-terminal (the conservative choice: it keeps a run
/// visible as active rather than silently dropping it from "in flight" views).
pub fn is_terminal_status(status: &str) -> bool {
    RunStatus::parse(status).is_some_and(RunStatus::is_terminal)
}

#[derive(Debug, Clone)]
pub struct ProjectActivitySummary {
    pub project_id: String,
    pub total_agents: usize,
    pub running_experiments: usize,
    pub total_experiments: usize,
    pub last_message_at: Option<i64>,
    pub last_activity_at: i64,
}

#[derive(Debug, Clone)]
pub struct RunWakeup {
    pub run: StoredRun,
    pub chat_session_id: String,
    pub state: String,
    pub monitoring_alerted: bool,
    pub monitoring_delivery_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunWakeupRegistration {
    Scheduled,
    AlreadyPending,
    AlreadyDelivered,
}

/// A helper session an agent created with `orx agent spawn`, and the task it
/// was spawned to do. The CLI only writes the row; the resident `orx up`
/// watcher is what starts the child's first turn and reports back.
#[derive(Debug, Clone)]
pub struct ChatSpawn {
    pub session_id: String,
    pub parent_session_id: String,
    pub prompt: String,
    /// Whether the parent gets a wake-up once the helper finishes.
    pub wake_parent: bool,
    /// Failed attempts to start the helper's first turn.
    pub attempts: i64,
    /// Set by `finish_turn` when the helper's turn ends. Absent on a row whose
    /// turn is still running — or whose `orx up` died mid-turn, which is how a
    /// crash is told from a completion.
    pub finished_at: Option<i64>,
}

/// Lifecycle of a [`ChatSpawn`]: `Pending → Starting → Running → Waking →
/// Done`. The two `-ing` states are claims — one watcher owns the transition
/// and holds a token, so a crash mid-step is reclaimable rather than lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatSpawnState {
    /// Row written; the child's first turn has not been delivered yet.
    Pending,
    /// Claimed for delivery of the brief to the helper.
    Starting,
    /// The helper is working on its task.
    Running,
    /// Claimed for delivery of the wake-up to the parent.
    Waking,
    /// Terminal: the parent has been told, or never asked to be.
    Done,
}

impl ChatSpawnState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Waking => "waking",
            Self::Done => "done",
        }
    }
}

const RUN_WAKEUP_CLAIM_TTL_MS: i64 = 60 * 1000;
pub(crate) const CHAT_TURN_LEASE_TTL_MS: i64 = 60 * 1000;
const CHAT_SPAWN_CLAIM_TTL_MS: i64 = 60 * 1000;

/// Delete turn leases not renewed within the TTL, except `held`, the claim tokens of this
/// process's running turns: a stall or sleep leaves them stale but their turns alive.
fn expire_turn_leases(conn: &Connection, held: &[String]) -> Result<()> {
    conn.execute(
        "DELETE FROM chat_turn_leases
         WHERE heartbeat_at < ?1 AND claim_token NOT IN (SELECT value FROM json_each(?2))",
        params![
            now_ms() - CHAT_TURN_LEASE_TTL_MS,
            serde_json::to_string(held)?
        ],
    )?;
    Ok(())
}

fn migrate_chat_spawns(conn: &Connection) -> Result<()> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS product_migrations (name TEXT PRIMARY KEY)")?;
    let migrated: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM product_migrations WHERE name = 'independent-chats-v0.2.19')",
        [],
        |row| row.get(0),
    )?;
    if migrated {
        return Ok(());
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_spawns')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }
    let pending = {
        let mut statement = tx.prepare(
            "SELECT sp.session_id, sp.prompt, sp.requested_at FROM chat_spawns sp
             JOIN chat_sessions s ON s.id = sp.session_id
             WHERE sp.state IN ('pending', 'starting')
               AND NOT EXISTS (SELECT 1 FROM research_sessions rs WHERE rs.session_id = sp.session_id)
               AND NOT EXISTS (SELECT 1 FROM chat_turns t WHERE t.session_id = sp.session_id)
             ORDER BY sp.requested_at, sp.session_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (session_id, prompt, requested_at) in pending {
        let leased: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_turn_leases WHERE chat_session_id = ?1 AND heartbeat_at > ?2)",
            params![session_id, now_ms() - CHAT_TURN_LEASE_TTL_MS], |row| row.get(0),
        )?;
        if leased {
            return Err(anyhow!(
                "Stop the older OpenResearch process before migrating its pending agent chats."
            ));
        }
        let parts = {
            let mut statement = tx.prepare("SELECT role, parts_json FROM chat_messages WHERE session_id = ?1 ORDER BY created_at, rowid")?;
            let rows = statement.query_map(params![session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let brief_recorded = match parts.as_slice() {
            [] => false,
            [(role, parts)] if role == "user" => {
                let parts: Vec<crate::local::chat::WirePart> = serde_json::from_str(parts)?;
                let text = parts
                    .iter()
                    .filter(|part| part.kind == "text")
                    .filter_map(|part| part.text.as_deref())
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if text.trim() != prompt.trim() {
                    continue;
                }
                true
            }
            _ => continue,
        };
        let message = crate::local::chat::legacy_opening_message(
            &session_id,
            prompt,
            requested_at,
            brief_recorded,
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO chat_queued_messages (id, session_id, client_turn_id, request_hash, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![message.id, message.session_id, message.client_turn_id, message.request_hash, message.payload_json, message.created_at],
        )?;
    }
    // Keep the product scheduler's schema for expert tasks and binary rollback.
    // Ordinary legacy helpers no longer wake their creators, as in upstream.
    tx.execute_batch("UPDATE chat_sessions SET parent_session_id = NULL
        WHERE id IN (SELECT session_id FROM chat_spawns)
          AND NOT EXISTS (SELECT 1 FROM research_sessions rs WHERE rs.session_id = chat_sessions.id);
        UPDATE chat_spawns SET state = 'done', claim_token = NULL, claimed_at = NULL
        WHERE NOT EXISTS (SELECT 1 FROM research_sessions rs WHERE rs.session_id = chat_spawns.session_id);
        INSERT INTO product_migrations (name) VALUES ('independent-chats-v0.2.19');")?;
    tx.commit()?;
    Ok(())
}

/// Recheck current rows on every open: older writers/imports may introduce
/// retired values after initial migration. A clean store only needs reads;
/// do not take SQLite's writer lock for dozens of no-op UPDATEs.
fn normalize_permission_modes(conn: &Connection) -> Result<()> {
    // Keep these accepted values aligned with the conversions below. NULL
    // session modes are normalized; NULL preference modes remain unchanged.
    let needed: bool = conn.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM ui_state WHERE id = 1)
         OR EXISTS(SELECT 1 FROM chat_sessions WHERE
           (harness = 'claude-code' AND (permission_mode IS NULL OR permission_mode NOT IN ('manual','acceptEdits','plan','auto','bypassPermissions')))
           OR (harness = 'codex' AND (permission_mode IS NULL OR permission_mode NOT IN ('ask','approve-for-me','full-access')))
           OR (harness = 'opencode' AND (permission_mode IS NULL OR permission_mode NOT IN ('default','auto-approve'))))
         OR EXISTS(SELECT 1 FROM ui_state WHERE
           (preferred_harness = 'claude-code' AND preferred_permission_mode NOT IN ('manual','acceptEdits','auto','bypassPermissions'))
           OR (preferred_harness = 'codex' AND preferred_permission_mode NOT IN ('ask','approve-for-me','full-access'))
           OR (preferred_harness = 'opencode' AND preferred_permission_mode NOT IN ('default','auto-approve')))",
        [], |row| row.get(0),
    )?;
    if !needed {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    // Provider-owned permission ids + the independent Codex/OpenCode Plan
    // axis. These updates are idempotent and intentionally do not touch
    // Claude's native `plan`, Manual, or Accept edits modes.
    tx.execute(
        "UPDATE chat_sessions
         SET plan_mode = 1, permission_mode = 'ask'
         WHERE harness = 'codex' AND permission_mode = 'plan'",
        [],
    )?;
    tx.execute(
        "UPDATE chat_sessions
         SET plan_mode = 1, permission_mode = 'default'
         WHERE harness = 'opencode' AND permission_mode = 'plan'",
        [],
    )?;
    for (harness, old, new) in [
        ("claude-code", "ask", "manual"),
        ("claude-code", "default", "manual"),
        ("claude-code", "accept-edits", "acceptEdits"),
        ("claude-code", "bypass", "bypassPermissions"),
        ("codex", "auto", "approve-for-me"),
        ("codex", "bypass", "full-access"),
        ("codex", "accept-edits", "ask"),
        ("codex", "acceptEdits", "ask"),
        ("opencode", "auto", "default"),
        ("opencode", "bypass", "auto-approve"),
        ("opencode", "ask", "default"),
        ("opencode", "accept-edits", "default"),
        ("opencode", "acceptEdits", "default"),
    ] {
        tx.execute(
            "UPDATE chat_sessions SET permission_mode = ?3
             WHERE harness = ?1 AND permission_mode = ?2",
            params![harness, old, new],
        )?;
    }
    tx.execute(
        "UPDATE chat_sessions SET permission_mode = 'auto'
         WHERE harness = 'claude-code'
           AND (permission_mode IS NULL OR permission_mode NOT IN
                ('manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'))",
        [],
    )?;
    tx.execute(
        "UPDATE chat_sessions SET permission_mode = 'approve-for-me'
         WHERE harness = 'codex'
           AND (permission_mode IS NULL OR permission_mode NOT IN
                ('ask', 'approve-for-me', 'full-access'))",
        [],
    )?;
    tx.execute(
        "UPDATE chat_sessions SET permission_mode = 'default'
         WHERE harness = 'opencode'
           AND (permission_mode IS NULL OR permission_mode NOT IN
                ('default', 'auto-approve'))",
        [],
    )?;
    // Seed before normalizing preferences: on the first open of an older
    // database the latest session may itself carry a retired mode or Plan.
    tx.execute(
        "INSERT OR IGNORE INTO ui_state (
             id, onboarding_completed, tour_completed,
             preferred_harness, preferred_model,
             preferred_service_tier, preferred_permission_mode, preferred_reasoning_level
         )
         SELECT 1,
                EXISTS(SELECT 1 FROM local_projects),
                EXISTS(SELECT 1 FROM local_projects),
                harness, model, service_tier, permission_mode, reasoning_level
         FROM (SELECT 1) seed
         LEFT JOIN chat_sessions ON chat_sessions.id = (
             SELECT id FROM chat_sessions ORDER BY updated_at DESC LIMIT 1
         )",
        [],
    )?;
    // Preferred-agent state never carries Plan for command-activated
    // harnesses: new sessions start in Build/Default until `/plan` is used.
    tx.execute(
        "UPDATE ui_state SET preferred_permission_mode = 'ask'
         WHERE preferred_harness = 'codex' AND preferred_permission_mode = 'plan'",
        [],
    )?;
    tx.execute(
        "UPDATE ui_state SET preferred_permission_mode = 'default'
         WHERE preferred_harness = 'opencode' AND preferred_permission_mode = 'plan'",
        [],
    )?;
    tx.execute(
        "UPDATE ui_state SET preferred_permission_mode = 'auto'
         WHERE preferred_harness = 'claude-code' AND preferred_permission_mode = 'plan'",
        [],
    )?;
    for (harness, old, new) in [
        ("claude-code", "ask", "manual"),
        ("claude-code", "default", "manual"),
        ("claude-code", "accept-edits", "acceptEdits"),
        ("claude-code", "bypass", "bypassPermissions"),
        ("codex", "auto", "approve-for-me"),
        ("codex", "bypass", "full-access"),
        ("opencode", "auto", "default"),
        ("opencode", "bypass", "auto-approve"),
    ] {
        tx.execute(
            "UPDATE ui_state SET preferred_permission_mode = ?3
             WHERE preferred_harness = ?1 AND preferred_permission_mode = ?2",
            params![harness, old, new],
        )?;
    }
    tx.execute(
        "UPDATE ui_state SET preferred_permission_mode = 'auto'
         WHERE preferred_harness = 'claude-code'
           AND preferred_permission_mode NOT IN
               ('manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions')",
        [],
    )?;
    tx.execute(
        "UPDATE ui_state SET preferred_permission_mode = 'approve-for-me'
         WHERE preferred_harness = 'codex'
           AND preferred_permission_mode NOT IN ('ask', 'approve-for-me', 'full-access')",
        [],
    )?;
    tx.execute(
        "UPDATE ui_state SET preferred_permission_mode = 'default'
         WHERE preferred_harness = 'opencode'
           AND preferred_permission_mode NOT IN ('default', 'auto-approve')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

/// Default wait for ordinary SQLite writer contention.
pub(crate) const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

pub struct Store {
    conn: Connection,
    data_dir_move_lock_path: PathBuf,
}

impl Store {
    pub(crate) fn relocate_project_paths(&self, paths: &[(String, String)]) -> Result<()> {
        let tx = self.begin()?;
        for (old, new) in paths {
            tx.execute(
                "UPDATE local_projects SET repo_path = ?2 WHERE repo_path = ?1",
                params![old, new],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Open (creating dirs/schema as needed). WAL so the supervise writers and
    /// the serve readers never block each other.
    pub fn open() -> Result<Self> {
        Self::open_at_with_move_lock(data_dir(), data_dir_move_lock_path(), BUSY_TIMEOUT)
    }

    /// Open like `open`, but cap SQLite's lock wait — `orx exp wait` shrinks
    /// this to its deadline so one blocked open can't overshoot it.
    pub fn open_with_busy_timeout(busy_timeout: Duration) -> Result<Self> {
        Self::open_at_with_move_lock(data_dir(), data_dir_move_lock_path(), busy_timeout)
    }

    /// Open a store rooted at an explicit directory, bypassing `data_dir()`
    /// resolution. For tests: a throwaway temp dir here avoids mutating the
    /// process-global `$ORX_DATA_DIR`, which the localbox lifecycle test owns
    /// (tests in different modules share env under the parallel runner).
    pub fn open_at(dir: PathBuf) -> Result<Self> {
        let move_lock_path = dir.join(".orx-data-dir-move.lock");
        Self::open_at_with_move_lock(dir, move_lock_path, BUSY_TIMEOUT)
    }

    /// Opens the store for a command that only reads it. Where the store cannot be
    /// written, as in a sandboxed agent, it opens read-only and applies no schema;
    /// elsewhere it opens as `open` does, so a newer reader still finds its columns.
    pub fn open_for_reading() -> Result<Self> {
        Self::open_for_reading_within(BUSY_TIMEOUT)
    }

    /// Open like `open_for_reading`, but cap SQLite's lock wait — `orx exp wait`
    /// shrinks this to its deadline so one blocked open can't overshoot it.
    pub fn open_for_reading_within(busy_timeout: Duration) -> Result<Self> {
        let dir = data_dir();
        let db = dir.join("orx.db");
        let exists = db
            .try_exists()
            .with_context(|| format!("Could not read {}", db.display()))?;
        let writable =
            || Self::open_at_with_move_lock(data_dir(), data_dir_move_lock_path(), busy_timeout);
        if !exists {
            return writable();
        }
        // SQLite opens a file it may not write read-only.
        let conn = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .with_context(|| format!("Could not open {}", db.display()))?;
        if !conn.is_readonly(rusqlite::MAIN_DB)? {
            drop(conn);
            return writable();
        }
        conn.pragma_update(None, "busy_timeout", busy_timeout.as_millis() as u64)?;
        Ok(Self {
            conn,
            data_dir_move_lock_path: data_dir_move_lock_path(),
        })
    }

    /// Shrink this connection's lock wait (e.g. to a wait loop's remaining
    /// deadline). The next call can pass the default back to restore it.
    pub(crate) fn set_busy_timeout(&self, timeout: Duration) -> Result<()> {
        self.conn
            .pragma_update(None, "busy_timeout", timeout.as_millis() as u64)?;
        Ok(())
    }

    fn open_at_with_move_lock(
        dir: PathBuf,
        data_dir_move_lock_path: PathBuf,
        busy_timeout: Duration,
    ) -> Result<Self> {
        Self::open_profiled(dir, data_dir_move_lock_path, busy_timeout, |_| {})
    }

    fn open_profiled(
        dir: PathBuf,
        data_dir_move_lock_path: PathBuf,
        busy_timeout: Duration,
        mut phase: impl FnMut(&'static str),
    ) -> Result<Self> {
        crate::paths::create_dir_all(&dir)?;
        crate::paths::create_dir_all(&dir.join("run-logs"))?;
        let conn = Connection::open(dir.join("orx.db"))?;
        conn.busy_timeout(busy_timeout)?;
        // WAL conversion can return SQLITE_BUSY without invoking SQLite's busy handler.
        let wal_start = std::time::Instant::now();
        let mut delay = Duration::from_millis(1);
        while let Err(error) = conn.pragma_update(None, "journal_mode", "WAL") {
            let remaining = busy_timeout.saturating_sub(wal_start.elapsed());
            if remaining.is_zero()
                || error.sqlite_error_code() != Some(rusqlite::ErrorCode::DatabaseBusy)
            {
                return Err(error).with_context(|| {
                    format!(
                        "Could not prepare the database at {}. Try again.",
                        dir.join("orx.db").display()
                    )
                });
            }
            std::thread::sleep(delay.min(remaining));
            conn.busy_timeout(busy_timeout.saturating_sub(wal_start.elapsed()))?;
            delay = (delay * 2).min(Duration::from_millis(50));
        }
        conn.busy_timeout(busy_timeout)?;
        phase("connection");
        let schema =
            rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
        schema.execute_batch(
            "CREATE TABLE IF NOT EXISTS runs (
                id           TEXT PRIMARY KEY,
                experiment_id TEXT NOT NULL,
                project_id   TEXT NOT NULL,
                status       TEXT NOT NULL,
                backend_json TEXT NOT NULL,
                command      TEXT NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL,
                ended_at     INTEGER,
                exit_code    INTEGER
            );
            CREATE TABLE IF NOT EXISTS native_invocation_identities (
                harness TEXT NOT NULL,
                call_id TEXT NOT NULL,
                identity_json TEXT NOT NULL,
                PRIMARY KEY (harness, call_id)
            );
            CREATE TABLE IF NOT EXISTS run_telemetry (
                run_id TEXT PRIMARY KEY,
                identity_json TEXT,
                report_json TEXT
            );
            CREATE TABLE IF NOT EXISTS telemetry_pending_events (
                event_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS native_usage_totals (
                harness TEXT NOT NULL,
                native_scope TEXT NOT NULL,
                totals_json TEXT NOT NULL,
                PRIMARY KEY (harness, native_scope)
            );
            CREATE TABLE IF NOT EXISTS native_usage_baselines (
                execution_id TEXT NOT NULL,
                prefix TEXT NOT NULL,
                totals_json TEXT,
                PRIMARY KEY (execution_id, prefix)
            );
            CREATE TABLE IF NOT EXISTS chat_usage_executions (
                execution_id TEXT PRIMARY KEY,
                turn_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                report_id TEXT NOT NULL,
                suppressed INTEGER NOT NULL,
                outcome TEXT
            );
            CREATE TABLE IF NOT EXISTS chat_usage_samples (
                execution_id TEXT NOT NULL,
                sample_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                model TEXT,
                provider TEXT,
                usage_json TEXT NOT NULL,
                complete INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (execution_id, sample_id)
            );
            CREATE TABLE IF NOT EXISTS local_projects (
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
            CREATE TABLE IF NOT EXISTS local_experiments (
                id                   TEXT PRIMARY KEY,
                project_id           TEXT NOT NULL,
                parent_experiment_id TEXT,
                slug                 TEXT NOT NULL,
                branch_name          TEXT NOT NULL,
                title                TEXT,
                description          TEXT,
                run_command          TEXT NOT NULL,
                agent_status         TEXT NOT NULL DEFAULT 'idle',
                created_at           INTEGER NOT NULL,
                updated_at           INTEGER NOT NULL,
                chat_session_id      TEXT,
                archived             INTEGER NOT NULL DEFAULT 0,
                UNIQUE(project_id, slug)
            );
            DROP TABLE IF EXISTS local_reports;
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id                TEXT PRIMARY KEY,
                project_id        TEXT NOT NULL,
                harness           TEXT NOT NULL,
                native_session_id TEXT,
                title             TEXT,
                title_source      TEXT,
                model             TEXT,
                service_tier      TEXT,
                permission_mode   TEXT,
                plan_mode         INTEGER NOT NULL DEFAULT 0,
                plan_reset_pending INTEGER NOT NULL DEFAULT 0,
                reasoning_level   TEXT,
                archived          INTEGER NOT NULL DEFAULT 0,
                context_usage_json TEXT,
                bootstrap_context TEXT,
                parent_session_id TEXT,
                created_at        INTEGER NOT NULL,
                updated_at        INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
                id         TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role       TEXT NOT NULL,
                parts_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                parent_id                TEXT,
                base_native_session_id   TEXT,
                result_native_session_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_chat_messages_session
                ON chat_messages(session_id, created_at);
            CREATE TABLE IF NOT EXISTS chat_turns (
                id                   TEXT PRIMARY KEY,
                session_id           TEXT NOT NULL,
                user_message_id      TEXT,
                assistant_message_id TEXT NOT NULL,
                client_turn_id       TEXT NOT NULL,
                request_hash         TEXT NOT NULL,
                prepared_input       TEXT NOT NULL,
                settings_json        TEXT NOT NULL,
                state                TEXT NOT NULL,
                delivery_state       TEXT NOT NULL,
                attempt_count        INTEGER NOT NULL DEFAULT 0,
                next_retry_at        INTEGER,
                error_kind           TEXT,
                error_message        TEXT,
                recovery_action      TEXT,
                recovered_by_turn_id TEXT,
                created_at           INTEGER NOT NULL,
                updated_at           INTEGER NOT NULL,
                UNIQUE(session_id, client_turn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_turns_session
                ON chat_turns(session_id, created_at);
            CREATE TABLE IF NOT EXISTS chat_queued_messages (
                id             TEXT PRIMARY KEY,
                session_id     TEXT NOT NULL,
                client_turn_id TEXT NOT NULL,
                request_hash   TEXT NOT NULL,
                payload_json   TEXT NOT NULL,
                created_at     INTEGER NOT NULL,
                UNIQUE(session_id, client_turn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_queued_messages_session
                ON chat_queued_messages(session_id, created_at);
            CREATE TABLE IF NOT EXISTS chat_steering_requests (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                client_turn_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(session_id, client_turn_id)
            );
            CREATE TABLE IF NOT EXISTS chat_run_wakeups (
                run_id          TEXT NOT NULL,
                chat_session_id TEXT NOT NULL,
                requested_at    INTEGER NOT NULL,
                state           TEXT NOT NULL DEFAULT 'pending',
                claim_token     TEXT,
                claimed_at      INTEGER,
                delivered_at    INTEGER,
                monitoring_alerted INTEGER NOT NULL DEFAULT 0,
                monitoring_delivery_id TEXT,
                PRIMARY KEY(run_id, chat_session_id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_run_wakeups_requested
                ON chat_run_wakeups(requested_at);
            CREATE TABLE IF NOT EXISTS chat_spawns (
                session_id        TEXT PRIMARY KEY,
                parent_session_id TEXT NOT NULL,
                prompt            TEXT NOT NULL,
                wake_parent       INTEGER NOT NULL DEFAULT 1,
                state             TEXT NOT NULL DEFAULT 'pending',
                requested_at      INTEGER NOT NULL,
                claim_token       TEXT,
                claimed_at        INTEGER,
                claim_from_state  TEXT,
                attempts          INTEGER NOT NULL DEFAULT 0,
                finished_at       INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_chat_spawns_state
                ON chat_spawns(state, requested_at);
            CREATE TABLE IF NOT EXISTS chat_turn_leases (
                chat_session_id TEXT PRIMARY KEY,
                claim_token     TEXT NOT NULL,
                heartbeat_at    INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS data_dir_move_lease (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                claim_token  TEXT NOT NULL,
                heartbeat_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ssh_host_tests (
                host      TEXT PRIMARY KEY,
                reachable INTEGER NOT NULL,
                git_found INTEGER NOT NULL,
                tools_found INTEGER NOT NULL DEFAULT 0,
                missing_tools TEXT NOT NULL DEFAULT '',
                error     TEXT,
                tested_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS overleaf_links (
                project_id TEXT NOT NULL,
                tex_path   TEXT NOT NULL,
                overleaf_project_id TEXT NOT NULL,
                host       TEXT NOT NULL,
                head       TEXT NOT NULL DEFAULT '',
                baseline   TEXT NOT NULL DEFAULT '{}',
                root       TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (project_id, tex_path)
            );
            CREATE TABLE IF NOT EXISTS ui_state (
                id                       INTEGER PRIMARY KEY CHECK (id = 1),
                onboarding_completed     INTEGER NOT NULL DEFAULT 0,
                tour_completed           INTEGER NOT NULL DEFAULT 0,
                preferred_harness        TEXT,
                preferred_model          TEXT,
                preferred_service_tier   TEXT,
                preferred_permission_mode TEXT,
                preferred_reasoning_level TEXT
            );",
        )?;
        schema.commit()?;
        // Keep this applied batch immutable; future columns require a new migration.
        phase("tables");
        schema::migrate_columns(&conn, "legacy-columns-v1", &[
            "ALTER TABLE native_invocation_identities ADD COLUMN session_id TEXT",
            "ALTER TABLE native_invocation_identities ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chat_usage_samples ADD COLUMN complete INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE runs ADD COLUMN commit_sha TEXT",
            "ALTER TABLE runs ADD COLUMN result_markdown TEXT",
            "ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE runs ADD COLUMN chat_session_id TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN permission_mode TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN service_tier TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chat_sessions ADD COLUMN plan_reset_pending INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chat_sessions ADD COLUMN reasoning_level TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chat_sessions ADD COLUMN context_usage_json TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN bootstrap_context TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN title_source TEXT",
            "ALTER TABLE local_projects ADD COLUMN paper_id TEXT",
            "ALTER TABLE local_projects ADD COLUMN github_sync_enabled INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE local_projects ADD COLUMN workspace_state_json TEXT",
            "ALTER TABLE local_experiments ADD COLUMN chat_session_id TEXT",
            "ALTER TABLE local_experiments ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE ssh_host_tests ADD COLUMN tools_found INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE ssh_host_tests ADD COLUMN missing_tools TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE chat_run_wakeups ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'",
            "ALTER TABLE chat_run_wakeups ADD COLUMN claim_token TEXT",
            "ALTER TABLE chat_run_wakeups ADD COLUMN claimed_at INTEGER",
            "ALTER TABLE chat_run_wakeups ADD COLUMN delivered_at INTEGER",
            "ALTER TABLE chat_run_wakeups ADD COLUMN monitoring_alerted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chat_messages ADD COLUMN parent_id TEXT",
            "ALTER TABLE chat_messages ADD COLUMN base_native_session_id TEXT",
            "ALTER TABLE chat_messages ADD COLUMN result_native_session_id TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN active_leaf_id TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN parent_session_id TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN goal TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN autonomy TEXT",
            "ALTER TABLE chat_sessions ADD COLUMN side_parent_session_id TEXT",
            "ALTER TABLE ui_state ADD COLUMN preferred_service_tier TEXT",
            "ALTER TABLE ui_state ADD COLUMN workspace_state_json TEXT",
            "ALTER TABLE ui_state ADD COLUMN preferred_autonomy TEXT",
            "ALTER TABLE chat_spawns ADD COLUMN wake_parent INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE chat_spawns ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chat_spawns ADD COLUMN finished_at INTEGER",
            "ALTER TABLE chat_messages ADD COLUMN completed_at INTEGER",
            "ALTER TABLE runs ADD COLUMN cancel_reason TEXT",
        ])?;
        schema::migrate_columns(
            &conn,
            "persistent-side-chats-v1",
            &["ALTER TABLE chat_sessions ADD COLUMN side_parent_leaf_id TEXT"],
        )?;
        schema::migrate_columns(
            &conn,
            "spawn-claim-origin-v1",
            &["ALTER TABLE chat_spawns ADD COLUMN claim_from_state TEXT"],
        )?;
        schema::migrate_columns(
            &conn,
            "monitoring-delivery-v1",
            &["ALTER TABLE chat_run_wakeups ADD COLUMN monitoring_delivery_id TEXT"],
        )?;
        phase("columns");
        conn.execute_batch("CREATE TRIGGER IF NOT EXISTS delete_chat_invocation_identities AFTER DELETE ON chat_sessions BEGIN DELETE FROM native_invocation_identities WHERE session_id = OLD.id; END;")?;
        conn.execute(
            "DELETE FROM native_invocation_identities WHERE session_id IS NULL AND created_at < ?1",
            [now_ms() - 7 * 24 * 60 * 60 * 1000],
        )?;
        // Legacy tool failures cannot identify the missing dependency, so require one fresh check.
        conn.execute(
            "DELETE FROM ssh_host_tests
             WHERE reachable = 1 AND tools_found = 0 AND missing_tools = ''",
            [],
        )?;
        phase("cleanup");
        // Chat messages became a tree (forked turns). Legacy rows are one linear
        // chain each; after this a NULL parent_id genuinely means "branch root".
        // All-or-nothing, because a half-applied backfill that still bumped the
        // marker would leave those transcripts unparented for good.
        let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if schema_version < 1 {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "UPDATE chat_messages AS m SET parent_id = (
                     SELECT p.id FROM chat_messages p
                     WHERE p.session_id = m.session_id
                       AND (p.created_at, p.rowid) < (m.created_at, m.rowid)
                     ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1
                 ) WHERE m.parent_id IS NULL",
                [],
            )?;
            tx.execute(
                "UPDATE chat_sessions SET active_leaf_id = (
                     SELECT m.id FROM chat_messages m WHERE m.session_id = chat_sessions.id
                     ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
                 ) WHERE active_leaf_id IS NULL",
                [],
            )?;
            // Legacy turns never recorded where the harness stood, so hand the
            // session's live id to its newest message: without it, switching
            // back to a pre-upgrade branch would resume from nothing and strand
            // that conversation's harness history.
            tx.execute(
                "UPDATE chat_messages SET result_native_session_id = (
                     SELECT s.native_session_id FROM chat_sessions s WHERE s.id = session_id
                 ) WHERE id IN (
                     SELECT active_leaf_id FROM chat_sessions WHERE active_leaf_id IS NOT NULL
                 )",
                [],
            )?;
            tx.pragma_update(None, "user_version", 1)?;
            tx.commit()?;
        }
        // Older builds of this branch created a one-root-per-project unique
        // index; multiple baselines are allowed, so make sure it's gone.
        let _ = conn.execute(
            "DROP INDEX IF EXISTS uidx_local_experiments_project_baseline",
            [],
        );
        normalize_permission_modes(&conn)?;
        // NOTE: `reasoning_level` deliberately has NO migration for issue #123,
        // unlike the permission modes above. Rows written by older builds carry
        // an implicit effort (`high`), but every value the old builds wrote is
        // still a value the picker offers, so a blanket reset here would be
        // indistinguishable from — and would silently destroy — a level the user
        // just chose, on the very next open. That is the failure mode the NOTE
        // above warns about. Stale levels are reconciled where the information
        // to do it safely exists: `reconcileReasoning` in `ui/src/api.ts` drops
        // one the selected model doesn't offer, and each harness's mapper drops
        // it again before it can reach a CLI.
        phase("compatibility");
        research::migrate(&conn)?;
        material_reads::migrate(&conn)?;
        metric_evidence::migrate(&conn)?;
        input_sets::migrate(&conn)?;
        migrate_chat_spawns(&conn)?;
        phase("research-and-spawns");
        Ok(Self {
            conn,
            data_dir_move_lock_path,
        })
    }

    /// Short write transaction over this connection; rolls back when dropped
    /// without `commit()`. Keep network I/O out of the closure it guards.
    pub fn begin(&self) -> Result<rusqlite::Transaction<'_>> {
        Ok(self.conn.unchecked_transaction()?)
    }

    /// `begin` that takes the write lock up front, so a check made inside it
    /// cannot be raced by another writer between the check and the insert.
    pub fn begin_immediate(&self) -> Result<rusqlite::Transaction<'_>> {
        Ok(rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?)
    }

    /// Coalesce the WAL back into the main `orx.db` file and truncate it, so a
    /// filesystem-level copy of `orx.db` alone captures all committed data.
    /// Best-effort — used before relocating the data dir. Errors are returned so
    /// the caller can decide, but a busy checkpoint is non-fatal (the WAL sidecar
    /// gets copied too when present).
    pub fn checkpoint(&self) -> Result<()> {
        self.conn
            .pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
        Ok(())
    }

    pub fn ui_state(&self) -> Result<StoredUiState> {
        Ok(self.conn.query_row(
            "SELECT onboarding_completed, tour_completed, preferred_harness,
                    preferred_model, preferred_service_tier,
                    preferred_permission_mode, preferred_reasoning_level, workspace_state_json,
                    preferred_autonomy
             FROM ui_state WHERE id = 1",
            [],
            |row| {
                let harness = row.get::<_, Option<String>>(2)?;
                let model = row.get::<_, Option<String>>(3)?;
                let service_tier = row.get::<_, Option<String>>(4)?;
                let permission_mode = row.get::<_, Option<String>>(5)?;
                let reasoning_level = row.get::<_, Option<String>>(6)?;
                let workspace_json = row.get::<_, Option<String>>(7)?;
                Ok(StoredUiState {
                    onboarding_completed: row.get(0)?,
                    tour_completed: row.get(1)?,
                    preferred_agent: harness.map(|harness| StoredAgentSelection {
                        harness,
                        model,
                        service_tier,
                        permission_mode,
                        reasoning_level,
                    }),
                    workspace: workspace_json
                        .as_deref()
                        .and_then(GlobalWorkspaceState::from_stored),
                    preferred_autonomy: row
                        .get::<_, Option<String>>(8)?
                        .as_deref()
                        .and_then(Autonomy::from_id),
                })
            },
        )?)
    }

    pub fn set_onboarding_completed(&self, completed: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE ui_state SET onboarding_completed = ?1 WHERE id = 1",
            params![completed],
        )?;
        Ok(())
    }

    pub fn set_global_workspace_state(&self, workspace: &GlobalWorkspaceState) -> Result<()> {
        workspace.validate()?;
        self.conn.execute(
            "UPDATE ui_state SET workspace_state_json = ?1 WHERE id = 1",
            params![serde_json::to_string(workspace)?],
        )?;
        Ok(())
    }

    pub fn project_workspace_state(&self, id: &str) -> Result<Option<WorkspaceState>> {
        let json: Option<String> = self.conn.query_row(
            "SELECT workspace_state_json FROM local_projects WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        Ok(json.as_deref().and_then(WorkspaceState::from_stored))
    }

    pub fn set_project_workspace_state(
        &self,
        id: &str,
        workspace: &WorkspaceState,
    ) -> Result<bool> {
        workspace.validate()?;
        Ok(self.conn.execute(
            "UPDATE local_projects SET workspace_state_json = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(workspace)?],
        )? > 0)
    }

    pub fn set_tour_completed(&self, completed: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE ui_state SET tour_completed = ?1 WHERE id = 1",
            params![completed],
        )?;
        Ok(())
    }

    pub fn set_preferred_autonomy(&self, autonomy: Autonomy) -> Result<()> {
        self.conn.execute(
            "UPDATE ui_state SET preferred_autonomy = ?1 WHERE id = 1",
            params![autonomy.id()],
        )?;
        Ok(())
    }

    pub fn set_preferred_agent(&self, selection: &StoredAgentSelection) -> Result<()> {
        self.conn.execute(
            "UPDATE ui_state
             SET preferred_harness = ?1, preferred_model = ?2,
                 preferred_service_tier = ?3,
                 preferred_permission_mode = ?4, preferred_reasoning_level = ?5
             WHERE id = 1",
            params![
                selection.harness,
                selection.model,
                selection.service_tier,
                selection.permission_mode,
                selection.reasoning_level,
            ],
        )?;
        Ok(())
    }

    pub fn upsert_run(&self, run: &StoredRun) -> Result<()> {
        let status = RunStatus::parse(&run.status)
            .ok_or_else(|| anyhow!("Unknown run status: {}", run.status))?;
        let tx = self
            .conn
            .is_autocommit()
            .then(|| self.begin())
            .transpose()?;
        self.conn.execute(
            "INSERT INTO runs (id, experiment_id, project_id, status, backend_json, command,
                               created_at, updated_at, ended_at, exit_code,
                               commit_sha, result_markdown, cancel_requested,
                               chat_session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
               backend_json = excluded.backend_json,
               commit_sha = excluded.commit_sha",
            // chat_session_id is deliberately absent from the DO UPDATE SET:
            // run ownership is immutable, so a later status upsert never
            // rewrites (or clears) the session that launched the run.
            params![
                run.id,
                run.experiment_id,
                run.project_id,
                run.status,
                run.backend_json,
                run.command,
                run.created_at,
                run.updated_at,
                run.ended_at,
                run.exit_code,
                run.commit_sha,
                run.result_markdown,
                run.cancel_requested,
                run.chat_session_id,
            ],
        )?;
        // Late submission handles must survive even when their status update is stale.
        if self.update_status(&run.id, status, run.ended_at, run.exit_code)? {
            self.conn.execute(
                "UPDATE runs SET result_markdown = ?2, updated_at = ?3 WHERE id = ?1",
                params![run.id, run.result_markdown, run.updated_at],
            )?;
        }
        if let Some(tx) = tx {
            tx.commit()?;
        }
        Ok(())
    }

    /// Atomically apply a legal transition; false leaves the outcome untouched.
    pub fn update_status(
        &self,
        run_id: &str,
        status: RunStatus,
        ended_at: Option<i64>,
        exit_code: Option<i64>,
    ) -> Result<bool> {
        let tx = self
            .conn
            .is_autocommit()
            .then(|| self.begin())
            .transpose()?;
        let applied = self.conn.execute(
            "UPDATE runs SET status = ?2, updated_at = ?3, ended_at = COALESCE(?4, ended_at),
                             exit_code = COALESCE(?5, exit_code)
             WHERE id = ?1 AND ((status = 'starting' AND ?6) OR (status = 'running' AND ?7))",
            params![
                run_id,
                status.as_str(),
                now_ms(),
                ended_at,
                exit_code,
                RunStatus::Starting.can_transition_to(status),
                RunStatus::Running.can_transition_to(status),
            ],
        )?;
        if applied == 1 && status.is_terminal() {
            self.stage_run_terminal(run_id, status)?;
        }
        if let Some(tx) = tx {
            tx.commit()?;
        }
        Ok(applied == 1)
    }

    pub fn get_run(&self, run_id: &str) -> Result<Option<StoredRun>> {
        let run = self
            .conn
            .query_row(
                &format!("{SELECT_RUN} WHERE id = ?1"),
                params![run_id],
                row_to_run,
            )
            .optional()?;
        Ok(run)
    }

    /// Newest first (creation time).
    pub fn list_runs(&self, limit: usize) -> Result<Vec<StoredRun>> {
        let mut stmt = self
            .conn
            .prepare(&format!("{SELECT_RUN} ORDER BY created_at DESC LIMIT ?1"))?;
        let rows = stmt.query_map(params![limit as i64], row_to_run)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Count runs in an active state (`starting`/`running`) — SQL-side and
    /// unbounded, so a long-running job older than the newest N rows still
    /// counts. Used by the data-dir move's in-flight guard.
    pub fn count_active_runs(&self) -> Result<usize> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM runs WHERE status IN ('starting', 'running')",
            [],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    pub fn list_active_runs(&self) -> Result<Vec<StoredRun>> {
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT_RUN} WHERE status IN ('starting', 'running') ORDER BY created_at DESC"
        ))?;
        let rows = stmt.query_map([], row_to_run)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn list_runs_by_project(&self, project_id: &str) -> Result<Vec<StoredRun>> {
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT_RUN} WHERE project_id = ?1 ORDER BY created_at DESC"
        ))?;
        let rows = stmt.query_map(params![project_id], row_to_run)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // Consumed by later local-mode stages (supervise + `orx up` API).
    #[allow(dead_code)]
    pub fn list_runs_by_experiment(&self, experiment_id: &str) -> Result<Vec<StoredRun>> {
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT_RUN} WHERE experiment_id = ?1 ORDER BY created_at DESC"
        ))?;
        let rows = stmt.query_map(params![experiment_id], row_to_run)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn latest_run_for_experiment(&self, experiment_id: &str) -> Result<Option<StoredRun>> {
        let run = self
            .conn
            .query_row(
                &format!("{SELECT_RUN} WHERE experiment_id = ?1 ORDER BY created_at DESC LIMIT 1"),
                params![experiment_id],
                row_to_run,
            )
            .optional()?;
        Ok(run)
    }

    pub fn register_run_wakeup(
        &self,
        run_id: &str,
        chat_session_id: &str,
    ) -> Result<RunWakeupRegistration> {
        let inserted = self.conn.execute(
            "INSERT OR IGNORE INTO chat_run_wakeups (run_id, chat_session_id, requested_at)
             VALUES (?1, ?2, ?3)",
            params![run_id, chat_session_id, now_ms()],
        )?;
        if inserted == 1 {
            return Ok(RunWakeupRegistration::Scheduled);
        }
        let state: String = self.conn.query_row(
            "SELECT state FROM chat_run_wakeups WHERE run_id = ?1 AND chat_session_id = ?2",
            params![run_id, chat_session_id],
            |row| row.get(0),
        )?;
        Ok(if state == "delivered" {
            RunWakeupRegistration::AlreadyDelivered
        } else {
            RunWakeupRegistration::AlreadyPending
        })
    }

    pub fn remove_run_wakeup(&self, run_id: &str, chat_session_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM chat_run_wakeups WHERE run_id = ?1 AND chat_session_id = ?2",
            params![run_id, chat_session_id],
        )?;
        Ok(())
    }

    pub fn prune_run_wakeups(&self) -> Result<()> {
        self.clear_stale_data_dir_move_lease()?;
        let now = now_ms();
        self.conn.execute(
            "UPDATE chat_run_wakeups
             SET state = 'pending', claim_token = NULL, claimed_at = NULL
             WHERE state = 'claimed' AND claimed_at < ?1
               AND NOT EXISTS (SELECT 1 FROM data_dir_move_lease WHERE id = 1)
               AND NOT EXISTS (
                   SELECT 1 FROM chat_turn_leases l
                   WHERE l.chat_session_id = chat_run_wakeups.chat_session_id
                     AND l.heartbeat_at >= ?2
               )",
            params![now - RUN_WAKEUP_CLAIM_TTL_MS, now - CHAT_TURN_LEASE_TTL_MS],
        )?;
        self.conn.execute(
            "DELETE FROM chat_run_wakeups
             WHERE NOT EXISTS (SELECT 1 FROM data_dir_move_lease WHERE id = 1)
               AND (
                 NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = chat_run_wakeups.run_id)
                OR NOT EXISTS (
                    SELECT 1 FROM chat_sessions
                    WHERE chat_sessions.id = chat_run_wakeups.chat_session_id
                )
                OR EXISTS (
                    SELECT 1 FROM runs
                    WHERE runs.id = chat_run_wakeups.run_id
                      AND runs.status = 'cancelled'
                )
               )",
            [],
        )?;
        Ok(())
    }

    pub fn list_ready_run_wakeups(&self) -> Result<Vec<RunWakeup>> {
        self.list_run_wakeups(
            "w.state IN ('pending', 'claimed') AND r.status IN ('done', 'failed')
             ORDER BY COALESCE(r.ended_at, r.updated_at), w.requested_at, r.id",
        )
    }

    /// Pending wake-ups whose run is still live, for monitoring alerts.
    pub fn list_active_run_wakeups(&self) -> Result<Vec<RunWakeup>> {
        self.list_run_wakeups(
            "w.state = 'pending' AND r.status IN ('starting', 'running')
             ORDER BY w.requested_at, r.id",
        )
    }

    fn list_run_wakeups(&self, filter: &'static str) -> Result<Vec<RunWakeup>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT r.id, r.experiment_id, r.project_id, r.status, r.backend_json, r.command,
                    r.created_at, r.updated_at, r.ended_at, r.exit_code,
                    r.commit_sha, r.result_markdown, r.cancel_requested, r.chat_session_id,
                    r.cancel_reason, w.chat_session_id, w.state, w.monitoring_alerted, w.monitoring_delivery_id
             FROM chat_run_wakeups w
             JOIN runs r ON r.id = w.run_id
             WHERE {filter}"
        ))?;
        let rows = stmt.query_map([], |row| {
            Ok(RunWakeup {
                run: row_to_run(row)?,
                chat_session_id: row.get(15)?,
                state: row.get(16)?,
                monitoring_alerted: row.get(17)?,
                monitoring_delivery_id: row.get(18)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Flips a pending wake-up's monitoring alert flag; `true` when this call changed it,
    /// which makes setting it an atomic claim across `orx up` processes.
    pub fn set_run_wakeup_monitoring_alerted(
        &self,
        run_id: &str,
        chat_session_id: &str,
        alerted: bool,
    ) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE chat_run_wakeups SET monitoring_alerted = ?3
             WHERE run_id = ?1 AND chat_session_id = ?2
               AND state = 'pending' AND monitoring_alerted != ?3",
            params![run_id, chat_session_id, alerted],
        )?;
        Ok(changed == 1)
    }

    /// Keep the batch identity durable until a chat turn accepts its notification.
    pub fn claim_run_monitoring_delivery(
        &self,
        run_id: &str,
        session: &str,
        delivery: &str,
    ) -> Result<bool> {
        Ok(self.conn.execute(
            "UPDATE chat_run_wakeups SET monitoring_alerted=1, monitoring_delivery_id=?3
             WHERE run_id=?1 AND chat_session_id=?2 AND state='pending'
               AND monitoring_alerted=0 AND monitoring_delivery_id IS NULL",
            params![run_id, session, delivery],
        )? == 1)
    }

    pub fn complete_run_monitoring_delivery(&self, session: &str, delivery: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_run_wakeups SET monitoring_alerted=1, monitoring_delivery_id=NULL
             WHERE chat_session_id=?1 AND monitoring_delivery_id=?2",
            params![session, delivery],
        )?;
        Ok(())
    }

    pub fn clear_run_monitoring_delivery(&self, run: &str, session: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_run_wakeups SET monitoring_alerted=0, monitoring_delivery_id=NULL
             WHERE run_id=?1 AND chat_session_id=?2",
            params![run, session],
        )?;
        Ok(())
    }

    pub fn claim_run_wakeup(&self, run_id: &str, chat_session_id: &str) -> Result<Option<String>> {
        let token = uuid::Uuid::new_v4().to_string();
        let claimed = self.conn.execute(
            "UPDATE chat_run_wakeups
             SET state = 'claimed', claim_token = ?3, claimed_at = ?4
             WHERE run_id = ?1 AND chat_session_id = ?2 AND state = 'pending'",
            params![run_id, chat_session_id, token, now_ms()],
        )?;
        Ok((claimed == 1).then_some(token))
    }

    pub fn renew_run_wakeup_claim(
        &self,
        run_id: &str,
        chat_session_id: &str,
        token: &str,
    ) -> Result<bool> {
        let renewed = self.conn.execute(
            "UPDATE chat_run_wakeups SET claimed_at = ?4
             WHERE run_id = ?1 AND chat_session_id = ?2
               AND state = 'claimed' AND claim_token = ?3",
            params![run_id, chat_session_id, token, now_ms()],
        )?;
        Ok(renewed == 1)
    }

    pub fn release_run_wakeup(
        &self,
        run_id: &str,
        chat_session_id: &str,
        token: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_run_wakeups
             SET state = 'pending', claim_token = NULL, claimed_at = NULL
             WHERE run_id = ?1 AND chat_session_id = ?2
               AND state = 'claimed' AND claim_token = ?3",
            params![run_id, chat_session_id, token],
        )?;
        Ok(())
    }

    pub fn mark_run_wakeup_delivered(
        &self,
        run_id: &str,
        chat_session_id: &str,
        token: &str,
    ) -> Result<bool> {
        let delivered = self.conn.execute(
            "UPDATE chat_run_wakeups
             SET state = 'delivered', claim_token = NULL, claimed_at = NULL, delivered_at = ?4
             WHERE run_id = ?1 AND chat_session_id = ?2
               AND state = 'claimed' AND claim_token = ?3",
            params![run_id, chat_session_id, token, now_ms()],
        )?;
        Ok(delivered == 1)
    }

    pub fn create_chat_spawn(&self, spawn: &ChatSpawn) -> Result<()> {
        self.conn.execute(
            "INSERT INTO chat_spawns
                 (session_id, parent_session_id, prompt, wake_parent, state, requested_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
            params![
                spawn.session_id,
                spawn.parent_session_id,
                spawn.prompt,
                spawn.wake_parent,
                now_ms(),
            ],
        )?;
        Ok(())
    }

    /// Return abandoned claims to their prior state and drop rows whose child
    /// session is gone. A live turn lease on the delivery target protects slow
    /// starts (child) and parent wake-ups (parent) from age-only reclamation.
    /// A missing *parent* is not pruned here: the child keeps working, and the
    /// wake step retires the row on its own.
    pub fn prune_chat_spawns(&self) -> Result<()> {
        self.clear_stale_data_dir_move_lease()?;
        let now = now_ms();
        let stale = now - CHAT_SPAWN_CLAIM_TTL_MS;
        self.conn.execute(
            "UPDATE chat_spawns
             SET state = CASE WHEN state = 'starting' OR claim_from_state = 'pending' THEN 'pending' ELSE 'running' END,
                 attempts = attempts + CASE state WHEN 'starting' THEN 1 ELSE 0 END,
                 claim_token = NULL, claimed_at = NULL, claim_from_state = NULL
             WHERE state IN ('starting', 'waking') AND claimed_at < ?1
               AND NOT EXISTS (SELECT 1 FROM data_dir_move_lease WHERE id = 1)
               AND NOT EXISTS (
                   SELECT 1 FROM chat_turn_leases l
                   WHERE l.chat_session_id = CASE chat_spawns.state
                       WHEN 'starting' THEN chat_spawns.session_id
                       ELSE chat_spawns.parent_session_id END
                     AND l.heartbeat_at >= ?2
               )",
            params![stale, now - CHAT_TURN_LEASE_TTL_MS],
        )?;
        self.conn.execute(
            "DELETE FROM chat_spawns
             WHERE NOT EXISTS (SELECT 1 FROM data_dir_move_lease WHERE id = 1)
               AND NOT EXISTS (
                   SELECT 1 FROM chat_sessions WHERE chat_sessions.id = chat_spawns.session_id
               )",
            [],
        )?;
        Ok(())
    }

    /// Spawns sitting in one state, oldest request first.
    pub fn list_chat_spawns(&self, state: ChatSpawnState) -> Result<Vec<ChatSpawn>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, parent_session_id, prompt, wake_parent, attempts, finished_at
             FROM chat_spawns WHERE state = ?1 ORDER BY requested_at, session_id",
        )?;
        let rows = stmt.query_map(params![state.as_str()], row_to_chat_spawn)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_chat_spawn(&self, session_id: &str) -> Result<Option<ChatSpawn>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, parent_session_id, prompt, wake_parent, attempts, finished_at
             FROM chat_spawns WHERE session_id = ?1",
        )?;
        let mut rows = stmt.query_map(params![session_id], row_to_chat_spawn)?;
        Ok(rows.next().transpose()?)
    }

    /// Take ownership of a spawn's next step, moving it into the claimed state
    /// and returning the token that proves the claim. `None` means another
    /// watcher got there first.
    pub fn claim_chat_spawn(
        &self,
        session_id: &str,
        from: ChatSpawnState,
        to: ChatSpawnState,
    ) -> Result<Option<String>> {
        let token = uuid::Uuid::new_v4().to_string();
        let claimed = self.conn.execute(
            "UPDATE chat_spawns
             SET state = ?3, claim_token = ?4, claimed_at = ?5, claim_from_state = ?2
             WHERE session_id = ?1 AND state = ?2",
            params![session_id, from.as_str(), to.as_str(), token, now_ms()],
        )?;
        Ok((claimed == 1).then_some(token))
    }

    /// Finish (or hand back) a claimed step. `false` means the claim expired
    /// and someone else reclaimed the row, so the caller's work is NOT recorded
    /// and must not be treated as done. Returning a failed start to pending
    /// charges one attempt in the same token-guarded update.
    pub fn settle_chat_spawn(
        &self,
        session_id: &str,
        token: &str,
        to: ChatSpawnState,
    ) -> Result<bool> {
        let settled = self.conn.execute(
            "UPDATE chat_spawns
             SET state = ?3, claim_token = NULL, claimed_at = NULL, claim_from_state = NULL,
                 attempts = attempts + CASE WHEN state = 'starting' AND ?3 = 'pending' THEN 1 ELSE 0 END
             WHERE session_id = ?1 AND claim_token = ?2",
            params![session_id, token, to.as_str()],
        )?;
        Ok(settled == 1)
    }

    /// Whether any `orx up` currently holds a turn lease on this session.
    ///
    /// The durable counterpart to `ChatHost::is_busy`, which reads a map this
    /// process owns: a helper started by a different `orx up` — or by one that
    /// has since restarted — is busy without this process knowing it.
    pub fn chat_turn_leased(&self, chat_session_id: &str) -> Result<bool> {
        let leased = self.conn.query_row(
            "SELECT 1 FROM chat_turn_leases WHERE chat_session_id = ?1 AND heartbeat_at >= ?2",
            params![chat_session_id, now_ms() - CHAT_TURN_LEASE_TTL_MS],
            |_| Ok(()),
        );
        Ok(leased.optional()?.is_some())
    }

    /// Record that a spawned helper's turn ended. An unstamped row whose lease
    /// has lapsed is how the watcher recognizes an `orx up` that died mid-turn,
    /// so the parent hears "interrupted" rather than a false completion.
    pub fn mark_chat_spawn_finished(&self, chat_session_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_spawns SET finished_at = ?2
             WHERE session_id = ?1 AND finished_at IS NULL",
            params![chat_session_id, now_ms()],
        )?;
        Ok(())
    }

    /// Helpers this parent has in flight, for the fan-out cap.
    pub fn count_live_chat_spawns(&self, parent_session_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT count(*) FROM chat_spawns
             WHERE parent_session_id = ?1 AND state != 'done'",
            params![parent_session_id],
            |row| row.get(0),
        )?)
    }

    pub fn claim_chat_turn(
        &self,
        chat_session_id: &str,
        token: &str,
        held: &[String],
    ) -> Result<bool> {
        self.clear_stale_data_dir_move_lease()?;
        expire_turn_leases(&self.conn, held)?;
        self.conn.execute(
            "DELETE FROM chat_turn_leases
             WHERE NOT EXISTS (
                 SELECT 1 FROM chat_sessions
                 WHERE chat_sessions.id = chat_turn_leases.chat_session_id
             )",
            [],
        )?;
        let claimed = self.conn.execute(
            "INSERT OR IGNORE INTO chat_turn_leases
                 (chat_session_id, claim_token, heartbeat_at)
             SELECT ?1, ?2, ?3
             WHERE NOT EXISTS (SELECT 1 FROM data_dir_move_lease WHERE id = 1)",
            params![chat_session_id, token, now_ms()],
        )?;
        Ok(claimed == 1)
    }

    pub fn renew_chat_turn(&self, chat_session_id: &str, token: &str) -> Result<bool> {
        let renewed = self.conn.execute(
            "UPDATE chat_turn_leases SET heartbeat_at = ?3
             WHERE chat_session_id = ?1 AND claim_token = ?2",
            params![chat_session_id, token, now_ms()],
        )?;
        Ok(renewed == 1)
    }

    pub fn release_chat_turn(&self, chat_session_id: &str, token: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM chat_turn_leases
             WHERE chat_session_id = ?1 AND claim_token = ?2",
            params![chat_session_id, token],
        )?;
        Ok(())
    }

    pub fn claim_data_dir_move(&self, token: &str, held: &[String]) -> Result<bool> {
        expire_turn_leases(&self.conn, held)?;
        self.clear_stale_data_dir_move_lease()?;
        let claimed = self.conn.execute(
            "INSERT OR IGNORE INTO data_dir_move_lease (id, claim_token, heartbeat_at)
             SELECT 1, ?1, ?2
             WHERE NOT EXISTS (SELECT 1 FROM chat_turn_leases)",
            params![token, now_ms()],
        )?;
        Ok(claimed == 1)
    }

    pub(crate) fn acquire_data_dir_move_lock(&self) -> Result<DataDirMoveLock> {
        acquire_data_dir_move_lock(self.data_dir_move_lock_path.clone())
    }

    fn clear_stale_data_dir_move_lease(&self) -> Result<()> {
        let token = self
            .conn
            .query_row(
                "SELECT claim_token FROM data_dir_move_lease WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(token) = token else {
            return Ok(());
        };
        let mut lock = open_lifecycle_lock_at(&self.data_dir_move_lock_path)?;
        match lock.try_write() {
            Ok(_guard) => {
                self.conn.execute(
                    "DELETE FROM data_dir_move_lease WHERE id = 1 AND claim_token = ?1",
                    params![token],
                )?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    pub fn release_data_dir_move(&self, token: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM data_dir_move_lease WHERE id = 1 AND claim_token = ?1",
            params![token],
        )?;
        Ok(())
    }

    /// First requester wins; true when this call set the cancel intent.
    pub fn request_cancel(&self, run_id: &str, reason: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE runs SET cancel_requested = 1, cancel_reason = ?2, updated_at = ?3
             WHERE id = ?1 AND cancel_requested = 0 AND status IN ('starting', 'running')",
            params![run_id, reason, now_ms()],
        )?;
        Ok(changed == 1)
    }

    /// Keeps the reason: a live supervisor may already have acted on the request.
    pub fn withdraw_cancel(&self, run_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET cancel_requested = 0, updated_at = ?2 WHERE id = ?1",
            params![run_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_result_markdown(&self, run_id: &str, markdown: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET result_markdown = ?2, updated_at = ?3 WHERE id = ?1",
            params![run_id, markdown, now_ms()],
        )?;
        Ok(())
    }

    /// Update only the run's backend descriptor — for a supervisor learning
    /// more about its job mid-flight (e.g. the openresearch box's SSH
    /// endpoint) without clobbering status/markdown/cancel state.
    pub fn set_backend_json(&self, run_id: &str, backend_json: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET backend_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![run_id, backend_json, now_ms()],
        )?;
        Ok(())
    }

    // --- local projects (orx up) ---

    /// Atomically install a fully-materialized demo project. The project id is
    /// the idempotency key: a completed prior seed is left byte-for-byte intact.
    pub fn create_demo_snapshot(
        &self,
        project: &LocalProject,
        experiments: &[crate::local::model::LocalExperiment],
        run: &StoredRun,
        sessions: &[StoredChatSession],
        messages: &[StoredChatMessage],
    ) -> Result<bool> {
        let tx = self.begin()?;
        let inserted = tx.execute(
            &format!("INSERT OR IGNORE INTO local_projects ({PROJECT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"),
            params![
                project.id,
                project.name,
                project.slug,
                project.github_owner,
                project.github_repo,
                project.github_sync_enabled,
                project.baseline_branch,
                project.repo_path,
                project.run_command,
                project.paper_id,
                project.created_at,
                project.updated_at,
            ],
        )?;
        if inserted == 0 {
            tx.commit()?;
            return Ok(false);
        }
        for experiment in experiments {
            tx.execute(
                &format!("INSERT INTO local_experiments ({EXPERIMENT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"),
                params![
                    experiment.id,
                    experiment.project_id,
                    experiment.parent_experiment_id,
                    experiment.slug,
                    experiment.branch_name,
                    experiment.title,
                    experiment.description,
                    experiment.run_command,
                    experiment.agent_status,
                    experiment.created_at,
                    experiment.updated_at,
                    experiment.chat_session_id,
                    experiment.archived,
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO runs (id, experiment_id, project_id, status, backend_json, command,
                               created_at, updated_at, ended_at, exit_code, commit_sha,
                               result_markdown, cancel_requested, chat_session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                run.id,
                run.experiment_id,
                run.project_id,
                run.status,
                run.backend_json,
                run.command,
                run.created_at,
                run.updated_at,
                run.ended_at,
                run.exit_code,
                run.commit_sha,
                run.result_markdown,
                run.cancel_requested,
                run.chat_session_id,
            ],
        )?;
        for session in sessions {
            tx.execute(
                "INSERT INTO chat_sessions (id, project_id, harness, native_session_id, title,
                                            title_source, model, service_tier, permission_mode, plan_mode,
                                            plan_reset_pending, reasoning_level,
                                            archived, context_usage_json, bootstrap_context,
                                            active_leaf_id, created_at, updated_at, side_parent_session_id, side_parent_leaf_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                params![
                    session.id,
                    session.project_id,
                    session.harness,
                    session.native_session_id,
                    session.title,
                    session.title_source,
                    session.model,
                    session.service_tier,
                    session.permission_mode,
                    session.plan_mode,
                    session.plan_reset_pending,
                    session.reasoning_level,
                    session.archived,
                    session.context_usage_json,
                    session.bootstrap_context,
                    session.active_leaf_id,
                    session.created_at,
                    session.updated_at,
                    session.side_parent_session_id,
                    session.side_parent_leaf_id,
                ],
            )?;
        }
        for message in messages {
            tx.execute(
                "INSERT INTO chat_messages (id, session_id, role, parts_json, created_at,
                                            parent_id, base_native_session_id,
                                            result_native_session_id, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    message.id,
                    message.session_id,
                    message.role,
                    message.parts_json,
                    message.created_at,
                    message.parent_id,
                    message.base_native_session_id,
                    message.result_native_session_id,
                    message.completed_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn create_local_project(&self, p: &LocalProject) -> Result<()> {
        self.conn.execute(
            &format!("INSERT INTO local_projects ({PROJECT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"),
            params![
                p.id, p.name, p.slug, p.github_owner, p.github_repo,
                p.github_sync_enabled, p.baseline_branch, p.repo_path, p.run_command, p.paper_id,
                p.created_at, p.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_local_project_repo(
        &self,
        id: &str,
        repo_path: &str,
        baseline_branch: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE local_projects SET repo_path = ?1, baseline_branch = ?2, updated_at = ?3 WHERE id = ?4",
            params![repo_path, baseline_branch, now_ms(), id],
        )?;
        Ok(())
    }

    pub fn get_local_project(&self, id: &str) -> Result<Option<LocalProject>> {
        let p = self
            .conn
            .query_row(
                &format!("SELECT {PROJECT_COLS} FROM local_projects WHERE id = ?1"),
                params![id],
                LocalProject::from_row,
            )
            .optional()?;
        Ok(p)
    }

    #[allow(dead_code)]
    pub fn get_local_project_by_slug(&self, slug: &str) -> Result<Option<LocalProject>> {
        let p = self
            .conn
            .query_row(
                &format!("SELECT {PROJECT_COLS} FROM local_projects WHERE slug = ?1"),
                params![slug],
                LocalProject::from_row,
            )
            .optional()?;
        Ok(p)
    }

    pub fn list_local_projects(&self) -> Result<Vec<LocalProject>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PROJECT_COLS} FROM local_projects ORDER BY updated_at DESC"
        ))?;
        let rows = stmt.query_map([], LocalProject::from_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Delete a project and everything hanging off it (chats, runs,
    /// experiments) in one transaction. GitHub repo and cache clone are kept.
    pub fn delete_local_project(&self, id: &str) -> Result<()> {
        let tx = self.begin()?;
        tx.execute(
            "DELETE FROM overleaf_links WHERE project_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_steering_requests WHERE session_id IN
               (SELECT id FROM chat_sessions WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_queued_messages WHERE session_id IN
               (SELECT id FROM chat_sessions WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_turns WHERE session_id IN
               (SELECT id FROM chat_sessions WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_spawns WHERE session_id IN
               (SELECT id FROM chat_sessions WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_messages WHERE session_id IN
               (SELECT id FROM chat_sessions WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_sessions WHERE project_id = ?1",
            params![id],
        )?;
        self.conn
            .execute("DELETE FROM runs WHERE project_id = ?1", params![id])?;
        self.conn.execute(
            "DELETE FROM local_experiments WHERE project_id = ?1",
            params![id],
        )?;
        self.conn
            .execute("DELETE FROM local_projects WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Bump updated_at only — records a visit for the recency sort and fires
    /// the SSE project.updated diff.
    pub fn touch_local_project(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE local_projects SET updated_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )?;
        Ok(())
    }

    /// Full-row update by id (name / run_command / branch edits).
    pub fn update_local_project(&self, p: &LocalProject) -> Result<()> {
        self.conn.execute(
            "UPDATE local_projects SET name = ?2, slug = ?3, github_owner = ?4, github_repo = ?5,
                    github_sync_enabled = ?6, baseline_branch = ?7, repo_path = ?8,
                    run_command = ?9, paper_id = ?10, updated_at = ?11
             WHERE id = ?1",
            params![
                p.id,
                p.name,
                p.slug,
                p.github_owner,
                p.github_repo,
                p.github_sync_enabled,
                p.baseline_branch,
                p.repo_path,
                p.run_command,
                p.paper_id,
                now_ms(),
            ],
        )?;
        Ok(())
    }

    // --- local experiments (orx up) ---

    pub fn create_local_experiment(&self, e: &LocalExperiment) -> Result<()> {
        self.conn.execute(
            &format!("INSERT INTO local_experiments ({EXPERIMENT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"),
            params![
                e.id, e.project_id, e.parent_experiment_id, e.slug, e.branch_name,
                e.title, e.description, e.run_command, e.agent_status, e.created_at, e.updated_at,
                e.chat_session_id, e.archived,
            ],
        )?;
        Ok(())
    }

    pub fn get_local_experiment(&self, id: &str) -> Result<Option<LocalExperiment>> {
        let e = self
            .conn
            .query_row(
                &format!("SELECT {EXPERIMENT_COLS} FROM local_experiments WHERE id = ?1"),
                params![id],
                LocalExperiment::from_row,
            )
            .optional()?;
        Ok(e)
    }

    pub fn list_experiments_by_project(&self, project_id: &str) -> Result<Vec<LocalExperiment>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {EXPERIMENT_COLS} FROM local_experiments WHERE project_id = ?1 ORDER BY created_at ASC"
        ))?;
        let rows = stmt.query_map(params![project_id], LocalExperiment::from_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Full-row update by id (title / description / run_command / agent_status).
    ///
    /// `chat_session_id` is deliberately omitted: session ownership is stamped
    /// once at creation and is immutable thereafter. The parent changes only
    /// through `set_experiment_parent`, so a stale row cannot undo a move.
    pub fn update_local_experiment(&self, e: &LocalExperiment) -> Result<()> {
        self.conn.execute(
            "UPDATE local_experiments SET slug = ?2, branch_name = ?3,
                    title = ?4, description = ?5, run_command = ?6, agent_status = ?7, updated_at = ?8
             WHERE id = ?1",
            params![
                e.id, e.slug, e.branch_name,
                e.title, e.description, e.run_command, e.agent_status, now_ms(),
            ],
        )?;
        Ok(())
    }

    pub fn set_experiment_parent(&self, id: &str, parent: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE local_experiments SET parent_experiment_id = ?2, updated_at = MAX(updated_at + 1, ?3) WHERE id = ?1",
            params![id, parent, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_experiments_archived(
        &mut self,
        ids: &[String],
        archived: bool,
    ) -> Result<Vec<String>> {
        let tx = self.conn.transaction()?;
        let mut changed = Vec::new();
        for id in ids {
            let rows = tx.execute(
                "UPDATE local_experiments SET archived = ?2, updated_at = MAX(updated_at + 1, ?3) WHERE id = ?1 AND archived != ?2",
                params![id, archived, now_ms()],
            )?;
            if rows > 0 {
                changed.push(id.clone());
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    // --- chat sessions / messages ------------------------------------------

    pub fn create_chat_session(&self, s: &StoredChatSession) -> Result<()> {
        self.conn.execute(
            "INSERT INTO chat_sessions (id, project_id, harness, native_session_id, title, title_source, model,
                                        service_tier, permission_mode, plan_mode, plan_reset_pending, reasoning_level, archived, bootstrap_context,
                                        active_leaf_id, parent_session_id, created_at, updated_at, autonomy,
                                        side_parent_session_id, side_parent_leaf_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                s.id,
                s.project_id,
                s.harness,
                s.native_session_id,
                s.title,
                s.title_source,
                s.model,
                s.service_tier,
                s.permission_mode,
                s.plan_mode,
                s.plan_reset_pending,
                s.reasoning_level,
                s.archived,
                s.bootstrap_context,
                s.active_leaf_id,
                s.parent_session_id,
                s.created_at,
                s.updated_at,
                s.autonomy,
                s.side_parent_session_id,
                s.side_parent_leaf_id,
            ],
        )?;
        Ok(())
    }

    pub fn get_chat_session(&self, id: &str) -> Result<Option<StoredChatSession>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHAT_SESSION_COLS} FROM chat_sessions WHERE id = ?1"
        ))?;
        let mut rows = stmt.query_map(params![id], row_to_chat_session)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_chat_sessions_by_project(
        &self,
        project_id: &str,
    ) -> Result<Vec<StoredChatSession>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHAT_SESSION_COLS} FROM chat_sessions WHERE project_id = ?1
             ORDER BY updated_at DESC"
        ))?;
        let rows = stmt.query_map(params![project_id], row_to_chat_session)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Every project's sessions for the composer's `/resume` picker, capped so a
    /// long-lived install cannot turn one dialog open into a multi-megabyte read.
    pub fn list_all_chat_sessions(&self) -> Result<Vec<StoredChatSession>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHAT_SESSION_COLS} FROM chat_sessions WHERE side_parent_session_id IS NULL
             ORDER BY updated_at DESC LIMIT 500"
        ))?;
        let rows = stmt.query_map([], row_to_chat_session)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn list_sidebar_chat_sessions(
        &self,
        archived: Option<bool>,
        before: Option<(i64, &str)>,
    ) -> Result<Vec<StoredChatSession>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHAT_SESSION_COLS} FROM chat_sessions
             WHERE side_parent_session_id IS NULL AND parent_session_id IS NULL
               AND (?1 IS NULL OR archived = ?1)
               AND (?2 IS NULL OR updated_at < ?2 OR (updated_at = ?2 AND id < ?3))
             ORDER BY updated_at DESC, id DESC LIMIT 51"
        ))?;
        let rows = stmt.query_map(
            params![
                archived,
                before.map(|cursor| cursor.0),
                before.map(|cursor| cursor.1)
            ],
            row_to_chat_session,
        )?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn side_chats_of(&self, parent_id: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM chat_sessions WHERE side_parent_session_id = ?1")?;
        let rows = stmt.query_map(params![parent_id], |row| row.get(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// The session whose worktree `id` runs in: its side-chat parent while that
    /// parent exists, else itself.
    pub fn chat_worktree_owner(&self, id: &str) -> Result<String> {
        let owner: Option<String> = self
            .conn
            .query_row(
                "SELECT parent.id FROM chat_sessions side
                 JOIN chat_sessions parent ON parent.id = side.side_parent_session_id
                 WHERE side.id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(owner.unwrap_or_else(|| id.to_string()))
    }

    pub fn list_chat_session_project_ids(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, project_id FROM chat_sessions")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Project totals include archived sessions so the agent count reflects
    /// every agent that has worked on the project, not only the visible rail.
    pub fn list_project_activity_summaries(&self) -> Result<Vec<ProjectActivitySummary>> {
        let mut stmt = self.conn.prepare(
            "WITH agent_counts AS (
                 SELECT project_id, COUNT(*) AS total_agents
                 FROM chat_sessions
                 WHERE side_parent_session_id IS NULL
                 GROUP BY project_id
             ),
             experiment_counts AS (
                 SELECT project_id, COUNT(*) AS total_experiments
                 FROM local_experiments
                 GROUP BY project_id
             ),
             running_experiment_counts AS (
                 SELECT runs.project_id, COUNT(DISTINCT runs.experiment_id) AS running_experiments
                 FROM runs
                 JOIN local_experiments
                   ON local_experiments.id = runs.experiment_id
                  AND local_experiments.project_id = runs.project_id
                 WHERE runs.status IN ('starting', 'running')
                 GROUP BY runs.project_id
             ),
             latest_messages AS (
                 SELECT chat_sessions.project_id, MAX(chat_messages.created_at) AS last_message_at
                 FROM chat_messages
                 JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id
                 WHERE chat_messages.role IN ('user', 'assistant')
                 GROUP BY chat_sessions.project_id
             )
             , latest_activity AS (
                 SELECT project_id, MAX(updated_at) AS last_activity_at FROM (
                     SELECT id AS project_id, updated_at FROM local_projects
                     UNION ALL SELECT project_id, updated_at FROM chat_sessions
                     UNION ALL SELECT project_id, updated_at FROM local_experiments
                     UNION ALL SELECT project_id, updated_at FROM runs
                     UNION ALL
                     SELECT chat_sessions.project_id, chat_messages.created_at
                     FROM chat_messages JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id
                 ) GROUP BY project_id
             )
             SELECT local_projects.id,
                    COALESCE(agent_counts.total_agents, 0),
                    COALESCE(running_experiment_counts.running_experiments, 0),
                    COALESCE(experiment_counts.total_experiments, 0),
                    latest_messages.last_message_at,
                    latest_activity.last_activity_at
             FROM local_projects
             LEFT JOIN agent_counts ON agent_counts.project_id = local_projects.id
             LEFT JOIN experiment_counts ON experiment_counts.project_id = local_projects.id
             LEFT JOIN running_experiment_counts
               ON running_experiment_counts.project_id = local_projects.id
             LEFT JOIN latest_messages ON latest_messages.project_id = local_projects.id
             JOIN latest_activity ON latest_activity.project_id = local_projects.id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ProjectActivitySummary {
                project_id: row.get(0)?,
                total_agents: row.get::<_, i64>(1)? as usize,
                running_experiments: row.get::<_, i64>(2)? as usize,
                total_experiments: row.get::<_, i64>(3)? as usize,
                last_message_at: row.get(4)?,
                last_activity_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_chat_session(&self, id: &str) -> Result<()> {
        let tx = self.begin_immediate()?;
        if let Some(study) = self.research_for_session(id)? {
            if study.status == "active" {
                return Err(anyhow!("当前会话关联的研究仍处于活动状态，暂不能删除。"));
            }
        }
        let has_children: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE side_parent_session_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if has_children {
            return Err(anyhow!("delete side chats before deleting their parent"));
        }
        tx.execute(
            "DELETE FROM chat_queued_messages WHERE session_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_steering_requests WHERE session_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM chat_turns WHERE session_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM chat_messages WHERE session_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM chat_spawns WHERE session_id = ?1", params![id])?;
        tx.execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// `None` clears it, which a fork of the session's very first turn needs:
    /// that turn ran with no harness session to resume from.
    pub fn set_chat_session_native_id(&self, id: &str, native_id: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET native_session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, native_id, now_ms()],
        )?;
        Ok(())
    }

    /// Deliberately leaves `updated_at` alone: paging between forks is not
    /// activity, and would otherwise reorder the Recents list.
    pub fn set_chat_session_active_leaf(&self, id: &str, leaf_id: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET active_leaf_id = ?2 WHERE id = ?1",
            params![id, leaf_id],
        )?;
        Ok(())
    }

    pub fn set_chat_session_model(&self, id: &str, model: &str) -> Result<()> {
        self.set_chat_session_model_value(id, Some(model))
    }

    pub fn set_chat_session_model_value(&self, id: &str, model: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET model = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, model, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_chat_session_service_tier(&self, id: &str, tier: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET service_tier = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, tier, now_ms()],
        )?;
        Ok(())
    }

    /// Persist the latest context-window usage (serialized `ContextUsage`).
    /// Does not bump `updated_at` — usage is a passive by-product of a turn that
    /// already bumped it, and re-ordering the session on every token report would
    /// be noise.
    #[cfg(test)]
    pub fn set_chat_session_context_usage(&self, id: &str, json: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET context_usage_json = ?2 WHERE id = ?1",
            params![id, json],
        )?;
        Ok(())
    }

    /// A deferred usage write must still belong to the visible final message.
    /// Match its timestamps as a retry/stop fence, not just its reusable id.
    pub fn set_chat_session_context_usage_for_message(
        &self,
        session_id: &str,
        turn_id: &str,
        message_id: &str,
        created_at: i64,
        completed_at: i64,
        json: &str,
    ) -> Result<bool> {
        Ok(self.conn.execute(
            "UPDATE chat_sessions SET context_usage_json = ?5
             WHERE id = ?1 AND active_leaf_id = ?2
             AND EXISTS(SELECT 1 FROM chat_messages WHERE id = ?2
                 AND session_id = ?1 AND created_at = ?3 AND completed_at = ?4)
             AND EXISTS(SELECT 1 FROM chat_turns WHERE id = ?6
                 AND session_id = ?1 AND assistant_message_id = ?2
                 AND state IN ('preparing','retrying','running','completed','failed')
                 AND recovered_by_turn_id IS NULL)",
            params![
                session_id,
                message_id,
                created_at,
                completed_at,
                json,
                turn_id
            ],
        )? > 0)
    }

    /// The session bound to an agent's own chat, if one was already adopted.
    pub fn chat_session_for_native_id(&self, native_id: &str) -> Result<Option<StoredChatSession>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHAT_SESSION_COLS} FROM chat_sessions WHERE native_session_id = ?1
             ORDER BY created_at LIMIT 1"
        ))?;
        let mut rows = stmt.query_map(params![native_id], row_to_chat_session)?;
        Ok(rows.next().transpose()?)
    }

    /// Native ids orx already has a session for, so the `/resume` picker can
    /// offer each of the agent's own chats exactly once.
    pub fn native_session_ids(&self) -> Result<std::collections::HashSet<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT native_session_id FROM chat_sessions WHERE native_session_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.flatten().collect())
    }

    pub fn set_chat_session_autonomy(&self, id: &str, autonomy: Autonomy) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET autonomy = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, autonomy.id(), now_ms()],
        )?;
        Ok(())
    }

    pub fn set_chat_session_goal(&self, id: &str, goal: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET goal = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, goal, now_ms()],
        )?;
        Ok(())
    }

    /// Cleared after a compaction: the pre-compaction total would otherwise be
    /// inherited by the next turn and keep the meter pinned high.
    pub fn clear_chat_session_context_usage(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET context_usage_json = NULL WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn set_chat_session_bootstrap_context(
        &self,
        id: &str,
        context: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET bootstrap_context = ?2 WHERE id = ?1",
            params![id, context],
        )?;
        Ok(())
    }

    pub fn set_chat_session_permission_mode(&self, id: &str, mode: &str) -> Result<()> {
        self.set_chat_session_permission_mode_value(id, Some(mode))
    }

    pub fn set_chat_session_permission_mode_value(
        &self,
        id: &str,
        mode: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET permission_mode = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, mode, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_chat_session_plan_state(
        &self,
        id: &str,
        plan_mode: bool,
        reset_pending: bool,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions
             SET plan_mode = ?2, plan_reset_pending = ?3, updated_at = ?4
             WHERE id = ?1",
            params![id, plan_mode, reset_pending, now_ms()],
        )?;
        Ok(())
    }

    pub fn clear_chat_session_plan_reset(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET plan_reset_pending = 0 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn set_chat_session_reasoning_level(&self, id: &str, level: &str) -> Result<()> {
        self.set_chat_session_reasoning_level_value(id, Some(level))
    }

    pub fn set_chat_session_reasoning_level_value(
        &self,
        id: &str,
        level: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET reasoning_level = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, level, now_ms()],
        )?;
        Ok(())
    }

    /// Archive/unarchive. Doesn't bump `updated_at`, so the session keeps its
    /// place in the recency ordering when it comes back.
    pub fn set_chat_session_archived(&self, id: &str, archived: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET archived = ?2 WHERE id = ?1",
            params![id, archived],
        )?;
        Ok(())
    }

    /// Unconditional title write. `source` records who wrote it — see
    /// [`StoredChatSession::title_source`] for the vocabulary — which is what
    /// later lets auto-titling tell a placeholder from a title worth keeping.
    pub fn set_chat_session_title(&self, id: &str, title: &str, source: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET title = ?2, title_source = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, title, source, now_ms()],
        )?;
        Ok(())
    }

    /// Adopt a generated title only while the title is still unset or the
    /// first-line placeholder. Atomic check-and-set: a user Rename (`'user'`)
    /// and a legacy row (NULL source with a non-blank title) are never
    /// overwritten, and a session that already has a `'generated'` title is
    /// never re-titled. Returns true if a row was written.
    pub fn set_chat_session_title_if_placeholder(&self, id: &str, title: &str) -> Result<bool> {
        let n = self.conn.execute(
            "UPDATE chat_sessions SET title = ?2, title_source = 'generated', updated_at = ?3 \
             WHERE id = ?1 AND (title IS NULL OR trim(title) = '' OR title_source = 'fallback')",
            params![id, title, now_ms()],
        )?;
        Ok(n > 0)
    }

    pub fn touch_chat_session(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET updated_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )?;
        Ok(())
    }

    /// Insert or replace a message's parts — assistant messages are rewritten
    /// as their parts stream in.
    pub fn upsert_chat_message(&self, m: &StoredChatMessage) -> Result<()> {
        upsert_chat_message_with(&self.conn, m)
    }

    /// Persist a message on the session's active branch and report its parent.
    /// `m.parent_id` is derived from the session's leaf, not read. Immediate: a
    /// torn read-leaf/append would make a permission card and its own reply
    /// siblings, hiding one of them.
    pub fn upsert_chat_message_on_branch(&self, m: &StoredChatMessage) -> Result<Option<String>> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let parent = upsert_chat_message_on_branch_with(&tx, m)?;
        tx.commit()?;
        Ok(parent)
    }

    /// Write a queued checkpoint only while its durable turn is active. The
    /// state check and branch update share an immediate transaction: a worker
    /// left running after cancellation cannot overwrite terminal content.
    /// Outer None means skipped; inner None means a written branch root.
    pub fn checkpoint_chat_message(
        &self,
        turn_id: &str,
        m: &StoredChatMessage,
    ) -> Result<Option<Option<String>>> {
        self.write_turn_message(turn_id, m, false)
    }

    /// Persist the final snapshot without overwriting an interruption, an
    /// already-completed message, or a newer retry incarnation.
    pub fn finish_chat_message(
        &self,
        turn_id: &str,
        m: &StoredChatMessage,
    ) -> Result<Option<Option<String>>> {
        if m.completed_at.is_none() {
            return Err(anyhow!("final chat message requires completed_at"));
        }
        self.write_turn_message(turn_id, m, true)
    }

    fn write_turn_message(
        &self,
        turn_id: &str,
        m: &StoredChatMessage,
        final_write: bool,
    ) -> Result<Option<Option<String>>> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_turns WHERE id = ?1
             AND session_id = ?2 AND assistant_message_id = ?3
             AND recovered_by_turn_id IS NULL
             AND (state IN ('preparing','retrying','running')
                  OR (?5 AND state IN ('completed','failed'))))
             AND NOT EXISTS(SELECT 1 FROM chat_messages WHERE id = ?3
               AND (session_id != ?2 OR completed_at IS NOT NULL OR created_at != ?4))",
            params![turn_id, m.session_id, m.id, m.created_at, final_write],
            |row| row.get(0),
        )?;
        let parent = if active {
            Some(upsert_chat_message_on_branch_with(&tx, m)?)
        } else {
            None
        };
        tx.commit()?;
        Ok(parent)
    }

    pub fn upsert_chat_recovery_message_if_actionable(
        &self,
        turn_id: &str,
        message: &StoredChatMessage,
    ) -> Result<bool> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let actionable = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM chat_turns
               WHERE id = ?1 AND state = 'failed' AND recovery_action IS NOT NULL
                 AND recovered_by_turn_id IS NULL
             )",
            params![turn_id],
            |row| row.get::<_, bool>(0),
        )?;
        if actionable {
            let exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE id = ?1)",
                params![message.id],
                |row| row.get::<_, bool>(0),
            )?;
            upsert_chat_message_with(&transaction, message)?;
            if !exists {
                transaction.execute(
                    "UPDATE chat_sessions SET active_leaf_id = ?2 WHERE id = ?1",
                    params![message.session_id, message.id],
                )?;
            }
        }
        transaction.commit()?;
        Ok(actionable)
    }

    /// Admit one user turn and its transcript bubble as one durable operation.
    /// The `(session_id, client_turn_id)` pair is the browser-to-server
    /// idempotency key. A duplicate with the same request hash returns the
    /// existing row; a different payload is rejected without changing either
    /// the transcript or the turn.
    pub fn admit_chat_turn(
        &self,
        user_message: Option<&StoredChatMessage>,
        turn: &StoredChatTurn,
    ) -> Result<ChatTurnAdmission> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let session_exists = tx
            .query_row(
                "SELECT 1 FROM chat_sessions WHERE id = ?1",
                params![turn.session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !session_exists {
            return Err(anyhow!("chat session not found"));
        }
        let existing = tx
            .query_row(
                &format!(
                    "SELECT {CHAT_TURN_COLS} FROM chat_turns
                     WHERE session_id = ?1 AND client_turn_id = ?2"
                ),
                params![turn.session_id, turn.client_turn_id],
                row_to_chat_turn,
            )
            .optional()?;
        if let Some(existing) = existing {
            tx.commit()?;
            return Ok(if existing.request_hash == turn.request_hash {
                ChatTurnAdmission::Existing(Box::new(existing))
            } else {
                ChatTurnAdmission::Conflict
            });
        }
        let steer = tx
            .query_row(
                "SELECT id, request_hash FROM chat_steering_requests s
             WHERE s.session_id = ?1 AND s.client_turn_id = ?2
             AND NOT (s.state = 'queued' AND s.request_hash = ?3 AND EXISTS (
                 SELECT 1 FROM chat_queued_messages q WHERE q.session_id = s.session_id
                 AND q.client_turn_id = s.client_turn_id AND q.request_hash = s.request_hash))",
                params![turn.session_id, turn.client_turn_id, turn.request_hash],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((id, hash)) = steer {
            return Ok(if hash == turn.request_hash {
                ChatTurnAdmission::Steered(id)
            } else {
                ChatTurnAdmission::Conflict
            });
        }
        if let Some(message) = user_message {
            tx.execute(
                "INSERT INTO chat_messages
                 (id, session_id, role, parts_json, created_at, parent_id,
                  base_native_session_id, result_native_session_id, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    message.id,
                    message.session_id,
                    message.role,
                    message.parts_json,
                    message.created_at,
                    message.parent_id,
                    message.base_native_session_id,
                    message.result_native_session_id,
                    message.completed_at,
                ],
            )?;
            tx.execute(
                "UPDATE chat_sessions SET active_leaf_id = ?2 WHERE id = ?1",
                params![message.session_id, message.id],
            )?;
        }
        tx.execute(
            "INSERT INTO chat_turns
             (id, session_id, user_message_id, assistant_message_id, client_turn_id,
              request_hash, prepared_input, settings_json, state, delivery_state,
              attempt_count, next_retry_at, error_kind, error_message, recovery_action,
              recovered_by_turn_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                     ?14, ?15, ?16, ?17, ?18)",
            params![
                turn.id,
                turn.session_id,
                turn.user_message_id,
                turn.assistant_message_id,
                turn.client_turn_id,
                turn.request_hash,
                turn.prepared_input,
                turn.settings_json,
                turn.state,
                turn.delivery_state,
                turn.attempt_count,
                turn.next_retry_at,
                turn.error_kind,
                turn.error_message,
                turn.recovery_action,
                turn.recovered_by_turn_id,
                turn.created_at,
                turn.updated_at,
            ],
        )?;
        self.research_bind_nudge_turn_in_tx(&turn.session_id, &turn.id)?;
        tx.commit()?;
        Ok(ChatTurnAdmission::Inserted)
    }

    pub fn get_chat_turn(&self, session_id: &str, turn_id: &str) -> Result<Option<StoredChatTurn>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {CHAT_TURN_COLS} FROM chat_turns WHERE id = ?1 AND session_id = ?2"
                ),
                params![turn_id, session_id],
                row_to_chat_turn,
            )
            .optional()?)
    }

    pub fn get_chat_turn_by_client_id(
        &self,
        session_id: &str,
        client_turn_id: &str,
    ) -> Result<Option<StoredChatTurn>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {CHAT_TURN_COLS} FROM chat_turns
                     WHERE session_id = ?1 AND client_turn_id = ?2"
                ),
                params![session_id, client_turn_id],
                row_to_chat_turn,
            )
            .optional()?)
    }

    /// One indexed snapshot across queue promotion; absence is not a rejection.
    pub fn chat_submission_by_client_id(
        &self,
        session_id: &str,
        client_turn_id: &str,
    ) -> Result<Option<(String, String)>> {
        Ok(self
            .chat_submission(session_id, client_turn_id)?
            .map(|receipt| (receipt.kind, receipt.id)))
    }

    pub fn chat_native_thread_has_named_model(
        &self,
        session_id: &str,
        native_session_id: &str,
    ) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (
                SELECT 1 FROM chat_turns t
                JOIN chat_messages m ON m.id = t.assistant_message_id
                WHERE t.session_id = ?1 AND m.result_native_session_id = ?2
                  AND json_extract(t.settings_json, '$.model') IS NOT NULL
            )",
            params![session_id, native_session_id],
            |row| row.get(0),
        )?)
    }

    pub fn insert_queued_chat_message(&self, message: &StoredQueuedChatMessage) -> Result<()> {
        let changed = self.conn.execute(
            "INSERT INTO chat_queued_messages
             (id, session_id, client_turn_id, request_hash, payload_json, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
             WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = ?2)
             AND NOT EXISTS (SELECT 1 FROM chat_steering_requests
                 WHERE session_id = ?2 AND client_turn_id = ?3)",
            params![
                message.id,
                message.session_id,
                message.client_turn_id,
                message.request_hash,
                message.payload_json,
                message.created_at,
            ],
        )?;
        if changed == 0 {
            if self
                .chat_submission(&message.session_id, &message.client_turn_id)?
                .is_some_and(|receipt| receipt.request_hash != message.request_hash)
            {
                return Err(crate::error::Error::new(steering::ClientTurnConflict));
            }
            return Err(anyhow!(
                "chat session missing or request already registered as steering"
            ));
        }
        Ok(())
    }

    pub fn update_queued_chat_message(&self, id: &str, payload_json: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_queued_messages SET payload_json = ?2 WHERE id = ?1",
            params![id, payload_json],
        )?;
        Ok(())
    }

    pub fn delete_queued_chat_message(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM chat_queued_messages WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn delete_queued_chat_messages_for_session(&self, session_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM chat_queued_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    pub fn list_queued_chat_messages(&self) -> Result<Vec<StoredQueuedChatMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, client_turn_id, request_hash, payload_json, created_at
             FROM chat_queued_messages ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(StoredQueuedChatMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                client_turn_id: row.get(2)?,
                request_hash: row.get(3)?,
                payload_json: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn list_queued_chat_messages_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<StoredQueuedChatMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, client_turn_id, request_hash, payload_json, created_at
             FROM chat_queued_messages WHERE session_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(StoredQueuedChatMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                client_turn_id: row.get(2)?,
                request_hash: row.get(3)?,
                payload_json: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn update_chat_turn_progress(
        &self,
        id: &str,
        state: &str,
        delivery_state: &str,
        attempt_count: i64,
        next_retry_at: Option<i64>,
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE chat_turns SET state = ?2, delivery_state = ?3, attempt_count = ?4,
                 next_retry_at = ?5, updated_at = ?6
             WHERE id = ?1 AND state IN ('preparing', 'retrying', 'running')",
            params![
                id,
                state,
                delivery_state,
                attempt_count,
                next_retry_at,
                now_ms()
            ],
        )?;
        if changed > 0 && (state == "running" || attempt_count > 0) {
            if let Some(session_id) = tx
                .query_row(
                    "SELECT session_id FROM chat_turns WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                self.research_confirm_turn_started_in_tx(&session_id, id)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn complete_chat_turn(&self, id: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE chat_turns SET state = 'completed', next_retry_at = NULL,
                 error_kind = NULL, error_message = NULL, recovery_action = NULL,
                 updated_at = ?2 WHERE id = ?1
                   AND state IN ('preparing', 'retrying', 'running')",
            params![id, now_ms()],
        )?;
        Ok(changed > 0)
    }

    pub fn fail_chat_turn(
        &self,
        id: &str,
        delivery_state: &str,
        error_kind: &str,
        error_message: &str,
        recovery_action: Option<&str>,
    ) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE chat_turns SET state = 'failed', delivery_state = ?2,
                 next_retry_at = NULL, error_kind = ?3, error_message = ?4,
                 recovery_action = ?5, updated_at = ?6 WHERE id = ?1
                   AND state IN ('preparing', 'retrying', 'running')",
            params![
                id,
                delivery_state,
                error_kind,
                error_message,
                recovery_action,
                now_ms(),
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn interrupt_chat_turn(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_turns SET state = 'interrupted', next_retry_at = NULL,
                 recovery_action = NULL, error_kind = 'cancelled', updated_at = ?2
             WHERE id = ?1 AND state IN ('preparing', 'retrying', 'running', 'failed')
               AND recovered_by_turn_id IS NULL",
            params![id, now_ms()],
        )?;
        Ok(())
    }

    /// Claim a terminal recovery action exactly once. `Retry` reuses this row;
    /// `Continue` records the newly-created recovery turn after admission.
    pub fn mark_chat_turn_recovered(&self, id: &str, recovered_by: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE chat_turns SET recovered_by_turn_id = ?2, recovery_action = NULL,
                 updated_at = ?3
             WHERE id = ?1 AND recovered_by_turn_id IS NULL AND state = 'failed'",
            params![id, recovered_by, now_ms()],
        )?;
        Ok(changed > 0)
    }

    pub fn mark_chat_turn_recovered_with_message(
        &self,
        id: &str,
        recovered_by: &str,
        message: &StoredChatMessage,
    ) -> Result<bool> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE chat_turns SET recovered_by_turn_id = ?2, recovery_action = NULL,
                 updated_at = ?3
             WHERE id = ?1 AND recovered_by_turn_id IS NULL AND state = 'failed'",
            params![id, recovered_by, now_ms()],
        )?;
        if changed > 0 {
            upsert_chat_message_with(&transaction, message)?;
        }
        transaction.commit()?;
        Ok(changed > 0)
    }

    pub fn reset_chat_turn_for_retry(&self, id: &str, started_at: i64) -> Result<bool> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE chat_turns SET state = 'preparing', delivery_state = 'not_sent',
                 attempt_count = 0, next_retry_at = NULL, error_kind = NULL,
                 error_message = NULL, recovery_action = NULL, updated_at = ?2
             WHERE id = ?1 AND state = 'failed' AND recovery_action = 'retry'
                   AND recovered_by_turn_id IS NULL",
            params![id, started_at],
        )?;
        if changed > 0 {
            transaction.execute("UPDATE chat_activity_spans SET ended_at=observed_at WHERE ended_at IS NULL AND message_id=(SELECT assistant_message_id FROM chat_turns WHERE id=?1)",[id])?;
            transaction.execute(
                "UPDATE chat_messages SET completed_at = NULL, created_at = ?2 WHERE id =
                 (SELECT assistant_message_id FROM chat_turns WHERE id = ?1)",
                params![id, started_at],
            )?;
        }
        transaction.commit()?;
        Ok(changed > 0)
    }

    pub fn set_chat_turn_settings(&self, id: &str, settings_json: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chat_turns SET settings_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, settings_json, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_chat_session_recovery_settings(
        &self,
        id: &str,
        model: Option<&str>,
        service_tier: Option<&str>,
        permission_mode: Option<&str>,
        plan_state: Option<(bool, bool)>,
        reasoning_level: Option<&str>,
    ) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        let (plan_mode, plan_reset_pending) = plan_state
            .map(|(mode, reset)| (Some(mode), Some(reset)))
            .unwrap_or((None, None));
        transaction.execute(
            "UPDATE chat_sessions
             SET model = ?2, service_tier = ?3, permission_mode = ?4,
                 plan_mode = COALESCE(?5, plan_mode),
                 plan_reset_pending = COALESCE(?6, plan_reset_pending),
                 reasoning_level = ?7, updated_at = ?8
             WHERE id = ?1",
            params![
                id,
                model,
                service_tier,
                permission_mode,
                plan_mode,
                plan_reset_pending,
                reasoning_level,
                now_ms()
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// On server startup no in-flight task survives. Convert unfinished rows
    /// into explicit, user-recoverable terminal states without replaying them.
    pub fn reconcile_unfinished_chat_turns(&self) -> Result<Vec<StoredChatTurn>> {
        // Sub-agent usage outliving its parent turn: its native connection died with the server.
        self.finalize_usage_turns("codex-late:", "cancelled")?;
        self.reconcile_unfinished_chat_turns_inner(true, &[])
    }

    pub fn reconcile_expired_unfinished_chat_turns(
        &self,
        held: &[String],
    ) -> Result<Vec<StoredChatTurn>> {
        self.reconcile_unfinished_chat_turns_inner(false, held)
    }

    fn reconcile_unfinished_chat_turns_inner(
        &self,
        include_existing_failures: bool,
        held: &[String],
    ) -> Result<Vec<StoredChatTurn>> {
        let now = now_ms();
        let transaction = self.conn.unchecked_transaction()?;
        expire_turn_leases(&transaction, held)?;
        transaction.execute(
            "UPDATE chat_activity_spans SET ended_at=observed_at WHERE ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM chat_turn_leases l WHERE l.chat_session_id=chat_activity_spans.session_id)", [],
        )?;
        let newly_reconciled = {
            let mut statement = transaction.prepare(
                "SELECT id FROM chat_turns
                 WHERE state IN ('preparing', 'retrying', 'running')
                   AND NOT EXISTS (
                     SELECT 1 FROM chat_turn_leases
                     WHERE chat_turn_leases.chat_session_id = chat_turns.session_id
                   )",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<std::collections::HashSet<_>, _>>()?
        };
        transaction.execute(
            "UPDATE chat_turns
             SET state = 'failed', error_kind = 'server_restarted',
                 error_message = 'ORX restarted before this turn finished',
                 recovery_action = CASE
                   WHEN delivery_state IN ('not_sent', 'rejected') THEN 'retry'
                   ELSE 'continue'
                 END,
                 next_retry_at = NULL, updated_at = ?1
             WHERE state IN ('preparing', 'retrying', 'running')
               AND NOT EXISTS (
                 SELECT 1 FROM chat_turn_leases
                 WHERE chat_turn_leases.chat_session_id = chat_turns.session_id
               )",
            params![now],
        )?;
        transaction.commit()?;
        self.recover_terminal_usage()?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHAT_TURN_COLS} FROM chat_turns
             WHERE state = 'failed' AND recovery_action IS NOT NULL
               AND recovered_by_turn_id IS NULL
             ORDER BY created_at ASC"
        ))?;
        let rows = stmt.query_map([], row_to_chat_turn)?;
        let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        if include_existing_failures {
            Ok(rows)
        } else {
            Ok(rows
                .into_iter()
                .filter(|turn| newly_reconciled.contains(&turn.id))
                .collect())
        }
    }

    pub fn list_chat_messages(&self, session_id: &str) -> Result<Vec<StoredChatMessage>> {
        let mut stmt = self.conn.prepare(
            // rowid tiebreak: a user message and its reply can share a millisecond.
            "SELECT id, session_id, role, parts_json, created_at, parent_id,
                    base_native_session_id, result_native_session_id, completed_at
             FROM chat_messages
             WHERE session_id = ?1 ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(StoredChatMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                parts_json: row.get(3)?,
                created_at: row.get(4)?,
                completed_at: row.get(8)?,
                parent_id: row.get(5)?,
                base_native_session_id: row.get(6)?,
                result_native_session_id: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn has_chat_messages(&self, session_id: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE session_id = ?1)",
            params![session_id],
            |row| row.get(0),
        )?)
    }

    /// A single chat message by id (used to reconcile a message's persisted
    /// state against an in-memory copy mid-turn). `None` if it doesn't exist.
    pub fn get_chat_message(&self, id: &str) -> Result<Option<StoredChatMessage>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, session_id, role, parts_json, created_at, parent_id,
                        base_native_session_id, result_native_session_id, completed_at
                 FROM chat_messages WHERE id = ?1",
                params![id],
                |row| {
                    Ok(StoredChatMessage {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        role: row.get(2)?,
                        parts_json: row.get(3)?,
                        created_at: row.get(4)?,
                        completed_at: row.get(8)?,
                        parent_id: row.get(5)?,
                        base_native_session_id: row.get(6)?,
                        result_native_session_id: row.get(7)?,
                    })
                },
            )
            .optional()?)
    }

    /// The Overleaf project a `.tex` in this project pushes to, if one is linked.
    pub fn overleaf_link(&self, project_id: &str, tex_path: &str) -> Result<Option<OverleafLink>> {
        Ok(self
            .conn
            .query_row(
                "SELECT overleaf_project_id, host, head, baseline, root FROM overleaf_links
                 WHERE project_id = ?1 AND tex_path = ?2",
                params![project_id, tex_path],
                |row| {
                    let baseline: String = row.get(3)?;
                    Ok(OverleafLink {
                        overleaf_project_id: row.get(0)?,
                        host: row.get(1)?,
                        head: row.get(2)?,
                        root: row.get(4)?,
                        // A baseline that will not parse is one we cannot trust
                        // to say who changed what; empty makes the next sync
                        // treat every difference as a conflict rather than
                        // guess a direction.
                        baseline: serde_json::from_str(&baseline).unwrap_or_default(),
                    })
                },
            )
            .optional()?)
    }

    pub fn set_overleaf_link(
        &self,
        project_id: &str,
        tex_path: &str,
        link: &OverleafLink,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO overleaf_links
               (project_id, tex_path, overleaf_project_id, host, head, baseline, root)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_id, tex_path) DO UPDATE SET
               overleaf_project_id = excluded.overleaf_project_id,
               host = excluded.host,
               head = excluded.head,
               baseline = excluded.baseline,
               root = excluded.root",
            params![
                project_id,
                tex_path,
                link.overleaf_project_id,
                link.host,
                link.head,
                serde_json::to_string(&link.baseline)?,
                link.root
            ],
        )?;
        Ok(())
    }

    pub fn clear_overleaf_link(&self, project_id: &str, tex_path: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM overleaf_links WHERE project_id = ?1 AND tex_path = ?2",
            params![project_id, tex_path],
        )?;
        Ok(())
    }

    pub fn upsert_ssh_host_test(&self, t: &SshHostTest) -> Result<()> {
        self.conn.execute(
            "INSERT INTO ssh_host_tests (host, reachable, git_found, tools_found, missing_tools, error, tested_at)
             VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6)
             ON CONFLICT(host) DO UPDATE SET
               reachable = excluded.reachable,
               tools_found = excluded.tools_found,
               missing_tools = excluded.missing_tools,
               error = excluded.error,
               tested_at = excluded.tested_at",
            params![
                t.host,
                t.reachable,
                t.tools_found,
                t.missing_tools.join(","),
                t.error,
                t.tested_at
            ],
        )?;
        Ok(())
    }

    pub fn list_ssh_host_tests(&self) -> Result<Vec<SshHostTest>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT host, reachable, tools_found, missing_tools, error, tested_at FROM ssh_host_tests",
            )?;
        let rows = stmt.query_map([], |row| {
            let missing_tools = row.get::<_, String>(3)?;
            Ok(SshHostTest {
                host: row.get(0)?,
                reachable: row.get(1)?,
                tools_found: row.get(2)?,
                missing_tools: missing_tools
                    .split(',')
                    .filter(|tool| !tool.is_empty())
                    .map(str::to_string)
                    .collect(),
                error: row.get(4)?,
                tested_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

/// The Overleaf project one `.tex` file pushes to. Per file, not per project:
/// a checkout can hold a paper and a rebuttal, and they are different Overleaf
/// projects.
#[derive(Debug, Clone)]
pub struct OverleafLink {
    pub overleaf_project_id: String,
    /// `www.overleaf.com`, or a Server Pro site.
    pub host: String,
    /// Overleaf's HEAD at the last sync. A poll that sees the same sha knows
    /// nothing moved there, and can skip the clone.
    pub head: String,
    /// What both sides agreed on at the last sync (path to content hash) — the
    /// only thing that gives a later difference a direction.
    pub baseline: std::collections::BTreeMap<String, String>,
    /// The checkout the baseline was taken from. A session worktree and the hub
    /// clone hold different copies of the same path, and an agreement made
    /// against one says nothing about the other.
    pub root: String,
}

impl OverleafLink {
    pub fn project(&self) -> crate::local::overleaf::Project {
        crate::local::overleaf::Project {
            id: self.overleaf_project_id.clone(),
            host: self.host.clone(),
        }
    }
}

/// Most recent preflight result per ssh host alias (Settings → Compute → SSH).
/// Serializes to the wire shape the UI's `SshPreflight` type expects; `host`
/// is the row key only (the API embeds results under their host entry).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostTest {
    #[serde(skip_serializing)]
    pub host: String,
    pub reachable: bool,
    pub tools_found: bool,
    pub missing_tools: Vec<String>,
    pub error: Option<String>,
    /// Unix millis.
    pub tested_at: i64,
}

/// One chat thread with a harness. `native_session_id` is the harness's own
/// session/rollout id (set after the first turn for CLIs that mint it lazily).
#[derive(Debug, Clone)]
pub struct StoredChatSession {
    pub id: String,
    pub project_id: String,
    pub harness: String,
    pub native_session_id: Option<String>,
    pub title: Option<String>,
    /// Who wrote `title`: `"fallback"` (first-line placeholder), `"generated"`
    /// (harness auto-title), `"user"` (explicitly chosen — a rename, or an
    /// agent's `orx agent spawn --title`, neither of which auto-titling may
    /// overwrite). NULL on legacy rows, which the conditional setter treats as
    /// "unknown, don't overwrite".
    pub title_source: Option<String>,
    pub model: Option<String>,
    /// Codex processing tier (`"default"` or `"priority"`); None uses CLI configuration.
    pub service_tier: Option<String>,
    /// Permission-mode wire id (`"auto"` / `"plan"` / …); None = harness default.
    pub permission_mode: Option<String>,
    /// Independent Plan state for Codex/OpenCode. Claude keeps Plan in
    /// `permission_mode`, matching its native permission-mode model.
    pub plan_mode: bool,
    /// Codex must send one `collaborationMode: default` after leaving Plan;
    /// persisted so a restart cannot strand the native thread in Plan.
    pub plan_reset_pending: bool,
    /// Reasoning-level wire id (`"low"` / `"medium"` / `"high"`); None = default.
    pub reasoning_level: Option<String>,
    /// Hidden from the default Recents list, but fully intact and resumable.
    pub archived: bool,
    /// Serialized `ContextUsage` for the latest turn; None until first reported.
    pub context_usage_json: Option<String>,
    /// Hidden context prepended only when a seeded transcript starts its first
    /// real native harness session. Never serialized to the UI.
    pub bootstrap_context: Option<String>,
    /// What the user asked the agent to keep working toward (`/goal`), carried
    /// into every turn until they clear it.
    pub goal: Option<String>,
    /// Research autonomy level id (`crate::local::autonomy`); `None` is the default.
    pub autonomy: Option<String>,
    /// Tip of the branch the UI is currently showing. Forked turns make the
    /// transcript a tree; this picks which path through it is live.
    pub active_leaf_id: Option<String>,
    /// Session that spawned this one with `orx agent spawn`. `None` for
    /// sessions the user started from the dashboard.
    pub parent_session_id: Option<String>,
    /// Chat this side chat branched from. Side chats share that chat's
    /// worktree, stay out of history, and are deleted with it.
    pub side_parent_session_id: Option<String>,
    /// Parent branch tip captured when this side chat was created.
    pub side_parent_leaf_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAgentSelection {
    pub harness: String,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredUiState {
    pub onboarding_completed: bool,
    pub tour_completed: bool,
    pub preferred_agent: Option<StoredAgentSelection>,
    pub workspace: Option<GlobalWorkspaceState>,
    pub preferred_autonomy: Option<Autonomy>,
}

/// Normalized transcript entry; `parts_json` is the wire-format parts array
/// the UI renders (orx is the system of record for transcripts, not the
/// harness's own storage).
#[derive(Debug, Clone)]
pub struct StoredChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub parts_json: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    /// Message this one follows on its branch. NULL only for a branch root.
    pub parent_id: Option<String>,
    /// Harness session id current *before* this turn ran. Re-sampling a turn
    /// resumes from it, so a fork branches the harness's own history instead of
    /// appending onto the sibling's.
    pub base_native_session_id: Option<String>,
    /// Harness session id this turn ended at, recorded on the assistant reply.
    /// Selecting a branch restores it, so the next message continues the branch
    /// on screen rather than whichever fork ran most recently.
    pub result_native_session_id: Option<String>,
}

fn upsert_chat_message_on_branch_with(
    tx: &Connection,
    m: &StoredChatMessage,
) -> Result<Option<String>> {
    // Outer None = no such row yet; inner None = a row that is a branch root.
    let known: Option<Option<String>> = tx
        .query_row(
            "SELECT parent_id FROM chat_messages WHERE id = ?1",
            params![m.id],
            |row| row.get(0),
        )
        .optional()?;
    let parent = match &known {
        Some(parent) => parent.clone(),
        None => tx
            .query_row(
                "SELECT active_leaf_id FROM chat_sessions WHERE id = ?1",
                params![m.session_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten(),
    };
    upsert_chat_message_with(
        tx,
        &StoredChatMessage {
            parent_id: parent.clone(),
            ..m.clone()
        },
    )?;
    if known.is_none() {
        tx.execute(
            "UPDATE chat_sessions SET active_leaf_id = ?2 WHERE id = ?1",
            params![m.session_id, m.id],
        )?;
    }
    Ok(parent)
}

fn upsert_chat_message_with(conn: &Connection, m: &StoredChatMessage) -> Result<()> {
    let first_seen = m.role == "assistant"
        && !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE id=?1)",
            [&m.id],
            |row| row.get::<_, bool>(0),
        )?;
    conn.execute(
        // A streaming message is written many times; only its parts and a
        // late-arriving harness session id may change, never its place in
        // the tree.
        "INSERT INTO chat_messages
                 (id, session_id, role, parts_json, created_at, parent_id,
                  base_native_session_id, result_native_session_id, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 parts_json = excluded.parts_json,
                 completed_at = COALESCE(excluded.completed_at, completed_at),
                 result_native_session_id = COALESCE(
                     excluded.result_native_session_id, result_native_session_id)",
        params![
            m.id,
            m.session_id,
            m.role,
            m.parts_json,
            m.created_at,
            m.parent_id,
            m.base_native_session_id,
            m.result_native_session_id,
            m.completed_at
        ],
    )?;
    if let Err(error) = research_metrics::record_chat_activity(conn, m, first_seen) {
        eprintln!("orx: could not record chat activity: {error}");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredChatTurn {
    pub id: String,
    pub session_id: String,
    pub user_message_id: Option<String>,
    pub assistant_message_id: String,
    pub client_turn_id: String,
    pub request_hash: String,
    pub prepared_input: String,
    pub settings_json: String,
    pub state: String,
    pub delivery_state: String,
    pub attempt_count: i64,
    pub next_retry_at: Option<i64>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub recovery_action: Option<String>,
    pub recovered_by_turn_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct StoredQueuedChatMessage {
    pub id: String,
    pub session_id: String,
    pub client_turn_id: String,
    pub request_hash: String,
    pub payload_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatTurnAdmission {
    Inserted,
    Existing(Box<StoredChatTurn>),
    Steered(String),
    Conflict,
}

const CHAT_TURN_COLS: &str = "id, session_id, user_message_id, assistant_message_id, \
    client_turn_id, request_hash, prepared_input, settings_json, state, delivery_state, \
    attempt_count, next_retry_at, error_kind, error_message, recovery_action, \
    recovered_by_turn_id, created_at, updated_at";

fn row_to_chat_turn(
    row: &rusqlite::Row<'_>,
) -> std::result::Result<StoredChatTurn, rusqlite::Error> {
    Ok(StoredChatTurn {
        id: row.get(0)?,
        session_id: row.get(1)?,
        user_message_id: row.get(2)?,
        assistant_message_id: row.get(3)?,
        client_turn_id: row.get(4)?,
        request_hash: row.get(5)?,
        prepared_input: row.get(6)?,
        settings_json: row.get(7)?,
        state: row.get(8)?,
        delivery_state: row.get(9)?,
        attempt_count: row.get(10)?,
        next_retry_at: row.get(11)?,
        error_kind: row.get(12)?,
        error_message: row.get(13)?,
        recovery_action: row.get(14)?,
        recovered_by_turn_id: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

const CHAT_SESSION_COLS: &str = "id, project_id, harness, native_session_id, title, model, service_tier, \
     permission_mode, plan_mode, plan_reset_pending, reasoning_level, archived, context_usage_json, \
     created_at, updated_at, title_source, bootstrap_context, active_leaf_id, parent_session_id, \
     goal, autonomy, side_parent_session_id, side_parent_leaf_id";

fn row_to_chat_spawn(row: &rusqlite::Row<'_>) -> std::result::Result<ChatSpawn, rusqlite::Error> {
    Ok(ChatSpawn {
        session_id: row.get(0)?,
        parent_session_id: row.get(1)?,
        prompt: row.get(2)?,
        wake_parent: row.get(3)?,
        attempts: row.get(4)?,
        finished_at: row.get(5)?,
    })
}

fn row_to_chat_session(
    row: &rusqlite::Row<'_>,
) -> std::result::Result<StoredChatSession, rusqlite::Error> {
    Ok(StoredChatSession {
        id: row.get(0)?,
        project_id: row.get(1)?,
        harness: row.get(2)?,
        native_session_id: row.get(3)?,
        title: row.get(4)?,
        model: row.get(5)?,
        service_tier: row.get(6)?,
        permission_mode: row.get(7)?,
        plan_mode: row.get(8)?,
        plan_reset_pending: row.get(9)?,
        reasoning_level: row.get(10)?,
        archived: row.get(11)?,
        context_usage_json: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        title_source: row.get(15)?,
        bootstrap_context: row.get(16)?,
        active_leaf_id: row.get(17)?,
        parent_session_id: row.get(18)?,
        goal: row.get(19)?,
        autonomy: row.get(20)?,
        side_parent_session_id: row.get(21)?,
        side_parent_leaf_id: row.get(22)?,
    })
}

const SELECT_RUN: &str = "SELECT id, experiment_id, project_id, status, backend_json, command,
                                 created_at, updated_at, ended_at, exit_code,
                                 commit_sha, result_markdown, cancel_requested,
                                 chat_session_id, cancel_reason FROM runs";

const PROJECT_COLS: &str = "id, name, slug, github_owner, github_repo, github_sync_enabled, \
                            baseline_branch, repo_path, run_command, paper_id, created_at, updated_at";

const EXPERIMENT_COLS: &str = "id, project_id, parent_experiment_id, slug, branch_name, \
                               title, description, run_command, agent_status, created_at, \
                               updated_at, chat_session_id, archived";

fn row_to_run(row: &rusqlite::Row<'_>) -> std::result::Result<StoredRun, rusqlite::Error> {
    Ok(StoredRun {
        id: row.get(0)?,
        experiment_id: row.get(1)?,
        project_id: row.get(2)?,
        status: row.get(3)?,
        backend_json: row.get(4)?,
        command: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        ended_at: row.get(8)?,
        exit_code: row.get(9)?,
        commit_sha: row.get(10)?,
        result_markdown: row.get(11)?,
        cancel_requested: row.get(12)?,
        chat_session_id: row.get(13)?,
        cancel_reason: row.get(14)?,
    })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "store/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "store/steering_tests.rs"]
mod steering_tests;
