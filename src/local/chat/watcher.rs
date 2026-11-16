use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use crate::error::{anyhow, Result};
use crate::store::{ChatSpawnState, Store, StoredChatSession};

use super::{active_path, ChatHost, MessagePhase, TurnGuard, TurnSubmission, WirePart};

pub(super) fn run_wakeup_text(run: &crate::store::StoredRun) -> Option<String> {
    matches!(run.status.as_str(), "done" | "failed").then(|| {
        format!(
            "[orx] Run `{}` finished with status **{}**. You can compare this result with other \
             project runs using `orx runs {}` and inspect the file located by `orx logs {}`.",
            run.id, run.status, run.project_id, run.id
        )
    })
}

// Only local identifiers here: the error text includes remote ssh stderr, so the agent reads it
// as command output instead of inside an `[orx]` instruction.
pub(super) fn run_monitoring_text(runs: &[crate::store::StoredRun]) -> String {
    let lines = runs
        .iter()
        .map(|run| {
            format!(
                "- run `{}` of experiment `{}` (still **{}**)",
                run.id, run.experiment_id, run.status
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "[orx] orx can no longer monitor these live runs:\n{lines}\nRun `orx exp status <expId>` \
         for the reason and tell the user so they can fix it. orx wakes you once it can see a run \
         finish; until then each run keeps its current status."
    )
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) struct Notification {
    pub(super) session: String,
    pub(super) client_turn_id: String,
    pub(super) text: String,
}

pub(super) fn run_notification_id(run: &str) -> String {
    format!("orx-run-wakeup-{run}")
}

pub(super) fn spawn_notification_id(child: &str, from: ChatSpawnState) -> String {
    format!("orx-spawn-wakeup-{}-{child}", from.as_str())
}

/// A durable turn is acceptance, including a recoverable preparing/failed turn.
/// Replays finish bookkeeping without launching another model turn.
pub(super) async fn deliver_notification(
    chat: &Arc<ChatHost>,
    store: Store,
    notification: Notification,
    mut guard: TurnGuard,
    gate: WatchGate,
) -> Result<(Store, bool)> {
    let session = notification.session.clone();
    let key = notification.client_turn_id.clone();
    let (store, existing) = spawn_store_stage(store, gate.clone(), move |s| {
        Ok(s.get_chat_turn_by_client_id(&session, &key)?.is_some())
    })
    .await?;
    if existing {
        guard.release().await;
        return Ok((store, true));
    }
    let result = chat
        .send_hidden_message_with_id(
            &notification.session,
            notification.text,
            guard,
            Some(notification.client_turn_id.clone()),
        )
        .await;
    // Setup can fail after admission; the receipt remains authoritative.
    let (store, accepted) = spawn_store_stage(store, gate, move |s| {
        Ok(
            s.get_chat_turn_by_client_id(&notification.session, &notification.client_turn_id)?
                .is_some(),
        )
    })
    .await?;
    if !accepted {
        if let Err(error) = result {
            eprintln!("orx up: notification was not admitted: {error:#}");
        }
    }
    Ok((store, accepted))
}

pub(super) fn first_wakeup_per_session(
    wakeups: Vec<crate::store::RunWakeup>,
) -> Vec<crate::store::RunWakeup> {
    let mut seen_sessions = HashSet::new();
    wakeups
        .into_iter()
        .filter(|wakeup| seen_sessions.insert(wakeup.chat_session_id.clone()))
        .collect()
}

#[cfg(test)]
pub(super) async fn process_run_wakeups(
    chat: &Arc<ChatHost>,
    store: Store,
    moving: Option<&std::sync::atomic::AtomicBool>,
) -> Result<()> {
    process_run_wakeups_guarded(chat, store, moving, None).await
}

async fn process_run_wakeups_guarded(
    chat: &Arc<ChatHost>,
    store: Store,
    data_dir_move_in_progress: Option<&std::sync::atomic::AtomicBool>,
    gate: WatchGate,
) -> Result<()> {
    let moving = || {
        data_dir_move_in_progress.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst))
    };
    if moving() {
        return Ok(());
    }
    let (mut store, wakeups) = spawn_store_stage(store, gate.clone(), |s| {
        s.prune_run_wakeups()?;
        Ok(first_wakeup_per_session(s.list_ready_run_wakeups()?))
    })
    .await?;
    for wakeup in wakeups {
        if wakeup.state != "pending" {
            continue;
        }
        let Some(mut guard) = TurnGuard::claim_hidden(chat, &wakeup.chat_session_id).await else {
            continue;
        };
        if moving() {
            guard.release().await;
            return Ok(());
        }
        let snapshot = wakeup.clone();
        let (next_store, token) = spawn_store_stage(store, gate.clone(), move |s| {
            let Some(token) = s.claim_run_wakeup(&snapshot.run.id, &snapshot.chat_session_id)?
            else {
                return Ok(None);
            };
            if !s.renew_run_wakeup_claim(&snapshot.run.id, &snapshot.chat_session_id, &token)? {
                return Ok(None);
            }
            Ok(Some(token))
        })
        .await?;
        store = next_store;
        let Some(token) = token else {
            guard.release().await;
            continue;
        };
        let accepted;
        if let Some(text) = run_wakeup_text(&wakeup.run) {
            (store, accepted) = deliver_notification(
                chat,
                store,
                Notification {
                    session: wakeup.chat_session_id.clone(),
                    client_turn_id: run_notification_id(&wakeup.run.id),
                    text,
                },
                guard,
                gate.clone(),
            )
            .await?;
        } else {
            guard.release().await;
            accepted = false;
        }
        (store, ()) = spawn_store_stage(store, gate.clone(), move |s| {
            if accepted {
                if !s.mark_run_wakeup_delivered(&wakeup.run.id, &wakeup.chat_session_id, &token)? {
                    return Err(anyhow!(
                        "run wake-up claim expired before delivery was recorded"
                    ));
                }
            } else {
                s.release_run_wakeup(&wakeup.run.id, &wakeup.chat_session_id, &token)?;
            }
            Ok(())
        })
        .await?;
    }
    process_run_monitoring_alerts(chat, store, data_dir_move_in_progress, gate).await
}

pub(super) async fn process_run_monitoring_alerts(
    chat: &Arc<ChatHost>,
    store: Store,
    data_dir_move_in_progress: Option<&std::sync::atomic::AtomicBool>,
    gate: WatchGate,
) -> Result<()> {
    let (mut store, by_session) = spawn_store_stage(store, gate.clone(), |s| {
        let mut by_session: HashMap<String, Vec<crate::store::RunWakeup>> = HashMap::new();
        for wakeup in s.list_active_run_wakeups()? {
            let unmonitored = crate::jobs::BackendDescriptor::parse(&wakeup.run.backend_json)
                .is_ok_and(|d| d.monitoring_error.is_some());
            if unmonitored
                && (!wakeup.monitoring_alerted || wakeup.monitoring_delivery_id.is_some())
            {
                by_session
                    .entry(wakeup.chat_session_id.clone())
                    .or_default()
                    .push(wakeup);
            } else if !unmonitored
                && (wakeup.monitoring_alerted || wakeup.monitoring_delivery_id.is_some())
            {
                s.clear_run_monitoring_delivery(&wakeup.run.id, &wakeup.chat_session_id)?;
            }
        }
        Ok(by_session)
    })
    .await?;
    for (session_id, alerts) in by_session {
        let Some(mut guard) = TurnGuard::claim_hidden(chat, &session_id).await else {
            continue;
        };
        if data_dir_move_in_progress
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst))
        {
            guard.release().await;
            return Ok(());
        }
        let id = session_id.clone();
        let (next_store, (delivery, claimed)) = spawn_store_stage(store, gate.clone(), move |s| {
            // Resume one durable batch before grouping any newly arrived alerts.
            if let Some(delivery) = alerts.iter().find_map(|w| w.monitoring_delivery_id.clone()) {
                let runs = alerts
                    .into_iter()
                    .filter(|w| w.monitoring_delivery_id.as_deref() == Some(&delivery))
                    .map(|w| w.run)
                    .collect::<Vec<_>>();
                return Ok((delivery, runs));
            }
            let tx = s.begin_immediate()?;
            let delivery = format!("orx-monitoring-{}", uuid::Uuid::new_v4());
            let mut claimed = Vec::new();
            for wakeup in alerts {
                if s.claim_run_monitoring_delivery(&wakeup.run.id, &id, &delivery)? {
                    claimed.push(wakeup.run);
                }
            }
            tx.commit()?;
            Ok((delivery, claimed))
        })
        .await?;
        store = next_store;
        if claimed.is_empty() {
            guard.release().await;
            continue;
        }
        let accepted;
        (store, accepted) = deliver_notification(
            chat,
            store,
            Notification {
                session: session_id.clone(),
                client_turn_id: delivery.clone(),
                text: run_monitoring_text(&claimed),
            },
            guard,
            gate.clone(),
        )
        .await?;
        (store, ()) = spawn_store_stage(store, gate.clone(), move |s| {
            if accepted {
                s.complete_run_monitoring_delivery(&session_id, &delivery)?;
            } else {
                // Keep the batch ID even if rearming fails; it remains retryable.
                let tx = s.begin_immediate()?;
                for run in claimed {
                    s.set_run_wakeup_monitoring_alerted(&run.id, &session_id, false)?;
                }
                tx.commit()?;
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}

// --- spawned agents -------------------------------------------------------------

/// How much of a helper's closing reply, and of the brief echoed back with it,
/// rides into the parent's context. Both are agent-authored and unbounded; the
/// user can open the helper's session for the rest.
pub(super) const SPAWN_REPORT_LIMIT: usize = 4000;
pub(super) const SPAWN_BRIEF_LIMIT: usize = 500;

/// Give up starting a helper after this many failed attempts, so a permanently
/// failing spawn reports once instead of retrying every tick forever.
const SPAWN_START_ATTEMPTS: i64 = 3;

fn truncated(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect::<String>() + "… (truncated)"
}

/// What the helper left behind on the branch on screen.
#[cfg_attr(test, derive(Debug, PartialEq))]
pub(super) enum SpawnOutcome {
    Reply(String),
    Failed(String),
    /// The turn was stopped — by the user, or by an `orx up` that died holding
    /// it. Whatever text is there is half-written, not an answer.
    Interrupted,
    Silent,
}

/// Read the helper's closing words. Walks back from the tip rather than reading
/// only the last assistant row: an answered prompt card rides its own
/// text-less assistant message and would otherwise mask the real reply.
pub(super) fn spawn_outcome(store: &Store, session: &StoredChatSession) -> Result<SpawnOutcome> {
    let messages = store.list_chat_messages(&session.id)?;
    let path = active_path(&messages, session.active_leaf_id.as_deref());
    let mut failure = None;
    // Stop at the newest user message: anything above it belongs to an earlier
    // turn and is not this task's answer.
    for message in path.iter().rev().take_while(|m| m.role != "user") {
        let parts: Vec<WirePart> = serde_json::from_str(&message.parts_json)?;
        // A user Stop persists this marker and no text; the half-written text
        // above it must not be handed back as a closing reply.
        if parts
            .iter()
            .any(|part| part.tool.as_deref() == Some("interrupted"))
        {
            return Ok(SpawnOutcome::Interrupted);
        }
        let joined = |final_only: bool| {
            parts
                .iter()
                .filter(|part| part.kind == "text")
                .filter(|part| !final_only || part.phase == Some(MessagePhase::FinalAnswer))
                .filter_map(|part| part.text.as_deref())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        };
        let mut text = joined(false);
        // A turn that resumed after background work can bury its answer under progress.
        if text.chars().count() > SPAWN_REPORT_LIMIT {
            let answer = joined(true);
            if !answer.is_empty() {
                text = answer;
            }
        }
        if !text.is_empty() {
            return Ok(SpawnOutcome::Reply(truncated(&text, SPAWN_REPORT_LIMIT)));
        }
        // Keep the newest error, but keep looking: a harness that errors after
        // answering should still hand the answer back.
        if failure.is_none() {
            failure = parts
                .iter()
                .find(|part| part.tool.as_deref() == Some("error"))
                .and_then(|part| part.state.as_ref())
                .and_then(|state| state.error.clone().or_else(|| state.output.clone()));
        }
    }
    Ok(match failure {
        Some(error) => SpawnOutcome::Failed(truncated(error.trim(), SPAWN_REPORT_LIMIT)),
        None => SpawnOutcome::Silent,
    })
}

/// Where the helper's work is. Deliberately claims no branch: session worktrees
/// start detached, so a helper only has one if it ran `orx create-experiment`.
fn spawn_workspace(store: &Store, session: &StoredChatSession) -> String {
    let Ok(Some(project)) = store.get_local_project(&session.project_id) else {
        return String::new();
    };
    let path = crate::local::git::existing_session_worktree_path(&project, &session.id);
    if !path.exists() {
        return String::new();
    }
    format!(
        "\n\nIts edits are in its own worktree at `{}` — read them there. Nothing was merged \
         into yours.",
        path.display()
    )
}

pub(super) fn spawn_report_text(
    store: &Store,
    spawn: &crate::store::ChatSpawn,
    interrupted: bool,
) -> Result<String> {
    let child = store
        .get_chat_session(&spawn.session_id)?
        .ok_or_else(|| anyhow!("spawned session disappeared"))?;
    let named = child
        .title
        .as_deref()
        .map(|title| format!(" (\"{title}\")"))
        .unwrap_or_default();
    let brief = truncated(spawn.prompt.trim(), SPAWN_BRIEF_LIMIT);
    let stopped = "Its session holds however far it got. Re-delegate it if you still need the \
                   task done.";
    let (headline, closing) = if interrupted {
        ("was interrupted before it finished", stopped.to_string())
    } else {
        match spawn_outcome(store, &child)? {
            SpawnOutcome::Reply(reply) => {
                ("has finished", format!("Its closing reply:\n\n{reply}"))
            }
            SpawnOutcome::Failed(error) => (
                "failed",
                format!("It ended on an error and did NOT do the task:\n\n{error}"),
            ),
            SpawnOutcome::Interrupted => ("was stopped before it finished", stopped.to_string()),
            SpawnOutcome::Silent => (
                "has finished",
                "It wrote no reply, so treat the task as unconfirmed and check its session."
                    .to_string(),
            ),
        }
    };
    Ok(format!(
        "[orx] The agent you spawned for `{}`{named} {headline}.\n\nIt was asked to: {brief}\n\n\
         {closing}{}",
        spawn.session_id,
        spawn_workspace(store, &child),
    ))
}

fn spawn_start_failure_text(spawn: &crate::store::ChatSpawn) -> String {
    format!(
        "[orx] The agent you spawned for `{}` could NOT be started, so the task was not done. \
         It was asked to: {}\n\nDo the task here, or delegate it again.",
        spawn.session_id,
        truncated(spawn.prompt.trim(), SPAWN_BRIEF_LIMIT),
    )
}

/// A Store is never borrowed across await. Its worker also retains the data
/// directory gate if the watcher is cancelled while synchronous work runs.
pub(super) type WatchGate = Option<Arc<tokio::sync::OwnedMutexGuard<()>>>;
pub(super) async fn spawn_store_stage<T: Send + 'static>(
    store: Store,
    gate: WatchGate,
    work: impl FnOnce(&Store) -> Result<T> + Send + 'static,
) -> Result<(Store, T)> {
    crate::local::blocking::run(move || {
        let _gate = gate;
        let value = work(&store)?;
        Ok((store, value))
    })
    .await?
}

fn retire_spawn(store: &Store, id: &str, from: ChatSpawnState) -> Result<()> {
    if let Some(token) = store.claim_chat_spawn(id, from, ChatSpawnState::Waking)? {
        store.settle_chat_spawn(id, &token, ChatSpawnState::Done)?;
    }
    Ok(())
}

pub(super) fn settle_spawn_start(
    store: &Store,
    id: &str,
    token: &str,
    next: ChatSpawnState,
) -> Result<()> {
    if !store.settle_chat_spawn(id, token, next)? {
        return Err(anyhow!("spawn claim expired before startup was recorded"));
    }
    Ok(())
}

async fn start_pending_chat_spawns(
    chat: &Arc<ChatHost>,
    store: Store,
    data_dir_move_in_progress: Option<&std::sync::atomic::AtomicBool>,
    gate: WatchGate,
) -> Result<Store> {
    let moving = || {
        data_dir_move_in_progress.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst))
    };
    let (mut store, pending) = spawn_store_stage(store, gate.clone(), |s| {
        s.list_chat_spawns(ChatSpawnState::Pending)
    })
    .await?;
    for spawn in pending {
        if moving() {
            return Ok(store);
        }
        if spawn.attempts >= SPAWN_START_ATTEMPTS {
            if !spawn.wake_parent {
                let id = spawn.session_id.clone();
                (store, ()) = spawn_store_stage(store, gate.clone(), move |s| {
                    retire_spawn(s, &id, ChatSpawnState::Pending)
                })
                .await?;
            } else {
                let text = spawn_start_failure_text(&spawn);
                store = deliver_wake_up(
                    chat,
                    store,
                    &spawn,
                    ChatSpawnState::Pending,
                    text,
                    gate.clone(),
                )
                .await?;
            }
            continue;
        }
        let Some(mut guard) = TurnGuard::claim_hidden(chat, &spawn.session_id).await else {
            continue;
        };
        let id = spawn.session_id.clone();
        let (next_store, token) = spawn_store_stage(store, gate.clone(), move |s| {
            s.claim_chat_spawn(&id, ChatSpawnState::Pending, ChatSpawnState::Starting)
        })
        .await?;
        store = next_store;
        let Some(token) = token else {
            guard.release().await;
            continue;
        };
        let id = spawn.session_id.clone();
        let (next_store, (session, record_brief)) =
            spawn_store_stage(store, gate.clone(), move |s| {
                Ok((
                    s.get_chat_session(&id)?,
                    s.list_chat_messages(&id)?.is_empty(),
                ))
            })
            .await?;
        store = next_store;
        chat.emit_session(session).await;
        let started = chat
            .send_spawn_task(&spawn.session_id, spawn.prompt.clone(), record_brief, guard)
            .await;
        let next = match started {
            Ok(TurnSubmission::Started(_)) => ChatSpawnState::Running,
            outcome => {
                if let Err(error) = outcome {
                    eprintln!(
                        "orx up: could not start spawned agent {}: {error}",
                        spawn.session_id
                    );
                }
                ChatSpawnState::Pending
            }
        };
        let id = spawn.session_id;
        (store, ()) = spawn_store_stage(store, gate.clone(), move |s| {
            settle_spawn_start(s, &id, &token, next)
        })
        .await?;
    }
    Ok(store)
}

#[cfg(test)]
pub(super) async fn process_chat_spawns(
    chat: &Arc<ChatHost>,
    store: Store,
    moving: Option<&std::sync::atomic::AtomicBool>,
) -> Result<()> {
    process_chat_spawns_guarded(chat, store, moving, None, &mut Default::default()).await
}

async fn process_chat_spawns_guarded(
    chat: &Arc<ChatHost>,
    store: Store,
    data_dir_move_in_progress: Option<&std::sync::atomic::AtomicBool>,
    gate: WatchGate,
    checks: &mut crate::commands::research_dispatch::PackageChecks,
) -> Result<()> {
    let moving = || {
        data_dir_move_in_progress.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst))
    };
    if moving() {
        return Ok(());
    }
    let mut owned_checks = std::mem::take(checks);
    let (store, updated_checks) =
        spawn_store_stage(store, gate.clone(), move |s| {
            s.prune_chat_spawns()?;
            if let Err(error) =
                crate::commands::research_dispatch::reconcile_active_studies_with_checks(
                    s,
                    &mut owned_checks,
                )
            {
                eprintln!("orx up: research reconcile: {error}");
            }
            Ok(owned_checks)
        })
        .await?;
    *checks = updated_checks;
    let store =
        start_pending_chat_spawns(chat, store, data_dir_move_in_progress, gate.clone()).await?;
    let (mut store, running) = spawn_store_stage(store, gate.clone(), |s| {
        s.list_chat_spawns(ChatSpawnState::Running)
    })
    .await?;
    for spawn in running {
        if moving() {
            return Ok(());
        }
        if chat.is_busy(&spawn.session_id).await {
            continue;
        }
        let snapshot = spawn.clone();
        let (next_store, action) = spawn_store_stage(store, gate.clone(), move |s| {
            let result = (|| -> Result<_> {
                if s.get_chat_turn_by_client_id(
                    &snapshot.parent_session_id,
                    &spawn_notification_id(&snapshot.session_id, ChatSpawnState::Running),
                )?
                .is_some()
                {
                    retire_spawn(s, &snapshot.session_id, ChatSpawnState::Running)?;
                    return Ok(None);
                }
                if s.chat_turn_leased(&snapshot.session_id)?
                    || s.research_session_has_active_runs(&snapshot.session_id)?
                {
                    return Ok(None);
                }
                if !snapshot.wake_parent
                    || s.get_chat_session(&snapshot.parent_session_id)?.is_none()
                {
                    retire_spawn(s, &snapshot.session_id, ChatSpawnState::Running)?;
                    return Ok(None);
                }
                let interrupted = s
                    .get_chat_spawn(&snapshot.session_id)?
                    .is_some_and(|row| row.finished_at.is_none());
                let (reply, failed) = match s
                    .get_chat_session(&snapshot.session_id)?
                    .map(|child| spawn_outcome(s, &child))
                    .transpose()?
                {
                    Some(SpawnOutcome::Reply(text)) => (Some(text), false),
                    Some(SpawnOutcome::Failed(error)) => (Some(error), true),
                    Some(SpawnOutcome::Interrupted) => (None, true),
                    Some(SpawnOutcome::Silent) | None => (None, false),
                };
                let action = crate::commands::research_dispatch::on_research_spawn_finished(
                    s,
                    &snapshot.session_id,
                    interrupted,
                    reply,
                    failed,
                )?;
                if let Some(action) = action {
                    return Ok(Some(action));
                }
                match spawn_report_text(s, &snapshot, interrupted) {
                    Ok(text) => Ok(Some(
                        crate::commands::research_dispatch::ResearchWakeAction::WakeLead(text),
                    )),
                    Err(error) => {
                        eprintln!("orx up: could not summarize spawned agent: {error}");
                        retire_spawn(s, &snapshot.session_id, ChatSpawnState::Running)?;
                        Ok(None)
                    }
                }
            })();
            Ok(result)
        })
        .await?;
        store = next_store;
        let action = match action {
            Ok(action) => action,
            Err(error) => {
                eprintln!(
                    "orx up: could not settle spawned agent {}: {error:#}",
                    spawn.session_id
                );
                // SQL failures can affect every row. Invalid research data is
                // local to this helper: retain it and continue unrelated work.
                if error.downcast_ref::<rusqlite::Error>().is_some() {
                    return Err(error);
                }
                continue;
            }
        };
        match action {
            None => {}
            Some(crate::commands::research_dispatch::ResearchWakeAction::RetireSilently) => {
                let id = spawn.session_id;
                (store, ()) = spawn_store_stage(store, gate.clone(), move |s| {
                    retire_spawn(s, &id, ChatSpawnState::Running)
                })
                .await?;
            }
            Some(crate::commands::research_dispatch::ResearchWakeAction::NudgeHelper(text)) => {
                if let Some(guard) = TurnGuard::claim_hidden(chat, &spawn.session_id).await {
                    if let Ok(TurnSubmission::Started(turn_id)) = chat
                        .send_hidden_message(&spawn.session_id, text, guard)
                        .await
                    {
                        let id = spawn.session_id;
                        (store, ()) = spawn_store_stage(store, gate.clone(), move |s| {
                            s.research_mark_nudge_delivered(&id, Some(&turn_id))
                        })
                        .await?;
                    }
                }
            }
            Some(crate::commands::research_dispatch::ResearchWakeAction::WakeLead(text)) => {
                store = deliver_wake_up(
                    chat,
                    store,
                    &spawn,
                    ChatSpawnState::Running,
                    text,
                    gate.clone(),
                )
                .await?;
            }
        }
    }
    start_pending_chat_spawns(chat, store, data_dir_move_in_progress, gate).await?;
    Ok(())
}

/// Claim, deliver and settle without retaining a Store borrow across await.
async fn deliver_wake_up(
    chat: &Arc<ChatHost>,
    store: Store,
    spawn: &crate::store::ChatSpawn,
    from: ChatSpawnState,
    text: String,
    gate: WatchGate,
) -> Result<Store> {
    let Some(guard) = TurnGuard::claim_hidden(chat, &spawn.parent_session_id).await else {
        return Ok(store);
    };
    let id = spawn.session_id.clone();
    let (store, token) = spawn_store_stage(store, gate.clone(), move |s| {
        s.claim_chat_spawn(&id, from, ChatSpawnState::Waking)
    })
    .await?;
    let Some(token) = token else {
        return Ok(store);
    };
    let (store, accepted) = deliver_notification(
        chat,
        store,
        Notification {
            session: spawn.parent_session_id.clone(),
            client_turn_id: spawn_notification_id(&spawn.session_id, from),
            text,
        },
        guard,
        gate.clone(),
    )
    .await?;
    let next = if accepted { ChatSpawnState::Done } else { from };
    let id = spawn.session_id.clone();
    let (store, ()) = spawn_store_stage(store, gate, move |s| {
        if !s.settle_chat_spawn(&id, &token, next)? {
            return Err(anyhow!(
                "spawn claim expired before the parent wake-up was recorded"
            ));
        }
        Ok(())
    })
    .await?;
    Ok(store)
}

/// Resume explicitly subscribed agent sessions after a run finishes. Busy and
/// draining sessions retain their durable wake-up until they become idle.
pub async fn watch_runs(
    chat: Arc<ChatHost>,
    data_dir_move_in_progress: Arc<std::sync::atomic::AtomicBool>,
    data_dir_gate: Arc<tokio::sync::Mutex<()>>,
) {
    let mut package_checks = Default::default();
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if data_dir_move_in_progress.load(std::sync::atomic::Ordering::SeqCst) {
            continue;
        }
        let data_dir_guard = data_dir_gate.clone().lock_owned().await;
        if data_dir_move_in_progress.load(std::sync::atomic::Ordering::SeqCst) {
            continue;
        }
        let data_dir_guard = Arc::new(data_dir_guard);
        let gate = data_dir_guard.clone();
        let Ok(Ok(store)) = crate::local::blocking::run(move || {
            let _gate = gate;
            Store::open()
        })
        .await
        else {
            continue;
        };
        if let Err(err) = process_run_wakeups_guarded(
            &chat,
            store,
            Some(data_dir_move_in_progress.as_ref()),
            Some(data_dir_guard.clone()),
        )
        .await
        {
            eprintln!("orx up: run watcher: {err}");
        }
        let gate = data_dir_guard.clone();
        let Ok(Ok(store)) = crate::local::blocking::run(move || {
            let _gate = gate;
            Store::open()
        })
        .await
        else {
            continue;
        };
        if let Err(err) = process_chat_spawns_guarded(
            &chat,
            store,
            Some(data_dir_move_in_progress.as_ref()),
            Some(data_dir_guard.clone()),
            &mut package_checks,
        )
        .await
        {
            eprintln!("orx up: spawn watcher: {err}");
        }
    }
}
