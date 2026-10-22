//! Dashboard snapshots, bounded polling and connection-local SSE cursors.
use super::*;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::Stream;
use std::convert::Infallible;

#[derive(Default, Deserialize)]
pub(super) struct EventOptions {
    #[serde(default)]
    deltas: bool,
}

pub(super) async fn events(
    State(state): State<AppState>,
    Query(options): Query<EventOptions>,
) -> Sse<impl Stream<Item = std::result::Result<Event, Infallible>>> {
    // Small buffer on purpose: run.log events can carry ~MB payloads, and a
    // stalled client must backpressure the loop, not queue hundreds of MB.
    let (tx, rx) = mpsc::channel::<Event>(16);
    tokio::spawn(event_loop(tx.clone()));
    // Chat events ride the same stream: chat.session / chat.message / chat.busy.
    tokio::spawn(forward_chat_events_with_deltas(
        state.chat.subscribe(),
        tx,
        options.deltas,
    ));
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|ev| (Ok(ev), rx))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[cfg(test)]
pub(super) async fn forward_chat_events(
    chat_rx: tokio::sync::broadcast::Receiver<(&'static str, Value)>,
    tx: mpsc::Sender<Event>,
) {
    forward_chat_events_with_deltas(chat_rx, tx, false).await;
}

async fn forward_chat_events_with_deltas(
    mut chat_rx: tokio::sync::broadcast::Receiver<(&'static str, Value)>,
    tx: mpsc::Sender<Event>,
    deltas: bool,
) {
    let mut encoder = message_delta::MessageEncoder::default();
    loop {
        let event = tokio::select! {
            _ = tx.closed() => return,
            event = chat_rx.recv() => event,
        };
        match event {
            Ok((name, data)) => {
                let (name, data) = if deltas && name == "chat.message" {
                    encoder.encode(data)
                } else {
                    (name, data)
                };
                if tx.send(json_event(name, &data)).await.is_err() {
                    return;
                }
            }
            // The client must repair snapshots after missed edge-only events.
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                encoder.clear();
                if tx
                    .send(json_event("resync.required", &json!({})))
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Diff state for one SSE subscriber.
#[derive(Clone, Default)]
struct EventCursor {
    projects: HashMap<String, i64>,
    experiments: HashMap<String, i64>,
    files: HashMap<String, u64>,
    runs: HashMap<String, (String, i64)>,
    log_offsets: HashMap<String, u64>,
    /// Last update status sent. Unlike the rest of the cursor this isn't store
    /// state — the updater is a separate process, so its progress reaches the UI
    /// through the same diff the store changes do.
    update: Option<updates::UpdateStatus>,
    update_sampled_at: Option<std::time::Instant>,
}

/// How often the event loop re-reads update status. The 500ms store cadence is
/// there for run logs; nothing about an update needs that resolution.
pub(super) const UPDATE_SAMPLE_INTERVAL: Duration = Duration::from_secs(10);

/// 500ms poll loop: diff the store + log files, push named events into the
/// channel. Ends when the subscriber disconnects (send fails). Same idiom as
/// serve.rs, extended with project/experiment diffs.
async fn event_loop(tx: mpsc::Sender<Event>) {
    let mut cursor = EventCursor::default();
    let mut first = true;
    let mut attempted = false;
    loop {
        if attempted {
            // An idle store never sends, so a failed send can't be the only
            // disconnect signal — watch the receiver side too or the loop
            // (and its 2Hz store polling) leaks per closed EventSource.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                _ = tx.closed() => return,
            }
        }
        if tx.is_closed() {
            return;
        }
        attempted = true;
        // Retry a failed snapshot without consuming its baseline or advancing cursors.
        let (next_cursor, result) = match blocking_task(move || {
            let result = collect_events(&mut cursor, first);
            (cursor, result)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => {
                eprintln!("dashboard event worker failed: {error}");
                cursor = EventCursor::default();
                first = true;
                continue;
            }
        };
        cursor = next_cursor;
        let batch = match result {
            Ok(batch) => batch,
            Err(error) => {
                eprintln!("dashboard event snapshot failed: {error}");
                continue;
            }
        };
        first = false;
        for ev in batch {
            if tx.send(ev).await.is_err() {
                return;
            }
        }
    }
}

fn json_event(name: &str, data: &Value) -> Event {
    Event::default().event(name).data(data.to_string())
}

/// One diff pass. On the first pass everything is "changed", so a fresh
/// subscriber gets a full snapshot and needs no separate baseline fetches.
fn collect_events(cursor: &mut EventCursor, first: bool) -> Result<Vec<Event>> {
    collect_event_batch(cursor, |pending| collect_events_into(pending, first))
}

/// Commit every cursor together only after the complete snapshot succeeds.
fn collect_event_batch<T>(
    cursor: &mut EventCursor,
    collect: impl FnOnce(&mut EventCursor) -> Result<T>,
) -> Result<T> {
    let mut pending = cursor.clone();
    let batch = collect(&mut pending)?;
    *cursor = pending;
    Ok(batch)
}

/// Shared entity snapshot: database queries and artifact scans run once per
/// polling window, while subscribers retain independent log/baseline cursors.
struct EventEntity {
    id: String,
    updated_at: i64,
    data: Value,
}
struct EventProject {
    entity: EventEntity,
    experiments: Vec<EventEntity>,
    fingerprint: u64,
}
struct EventSnapshot {
    projects: Vec<EventProject>,
    runs: Vec<StoredRun>,
}
#[derive(Default)]
struct EventSnapshotCache {
    entry: Option<(std::path::PathBuf, std::time::Instant, Arc<EventSnapshot>)>,
}
impl EventSnapshotCache {
    fn get(
        &mut self,
        dir: std::path::PathBuf,
        now: std::time::Instant,
        collect: impl FnOnce() -> Result<EventSnapshot>,
    ) -> Result<Arc<EventSnapshot>> {
        if let Some((path, sampled, snapshot)) = &self.entry {
            if *path == dir && now.saturating_duration_since(*sampled) < Duration::from_millis(500)
            {
                return Ok(snapshot.clone());
            }
        }
        let snapshot = Arc::new(collect()?);
        self.entry = Some((dir, now, snapshot.clone()));
        Ok(snapshot)
    }
}
fn event_snapshot() -> Result<Arc<EventSnapshot>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<EventSnapshotCache>> =
        std::sync::OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.get(crate::store::data_dir(), std::time::Instant::now(), || {
        let store = Store::open()?;
        let mut projects = Vec::new();
        for project in store.list_local_projects()? {
            let mut experiments = Vec::new();
            for experiment in store.list_experiments_by_project(&project.id)? {
                experiments.push(EventEntity {
                    id: experiment.id.clone(),
                    updated_at: experiment.updated_at,
                    data: serde_json::to_value(experiment)?,
                });
            }
            projects.push(EventProject {
                fingerprint: local::files::fingerprint(&project),
                entity: EventEntity {
                    id: project.id.clone(),
                    updated_at: project.updated_at,
                    data: project_json(&project),
                },
                experiments,
            });
        }
        Ok(EventSnapshot {
            projects,
            runs: store.list_runs(200)?,
        })
    })
}

fn collect_events_into(cursor: &mut EventCursor, first: bool) -> Result<Vec<Event>> {
    let mut out = Vec::new();

    // Sampled far below the 2Hz loop — the updater works on the scale of
    // minutes, and this reads files. `cursor.update` is committed only once the
    // batch is certain: every `?` below discards it (`event_loop` swallows the
    // error), and a cursor that had already moved would never re-emit, leaving
    // the restart banner permanently unshown for that subscriber.
    let sampled_update = cursor
        .update_sampled_at
        .is_none_or(|at| at.elapsed() >= UPDATE_SAMPLE_INTERVAL)
        .then(|| {
            cursor.update_sampled_at = Some(std::time::Instant::now());
            updates::status()
        })
        .filter(|update| cursor.update.as_ref() != Some(update));
    if let Some(update) = &sampled_update {
        out.push(json_event("update.status", &json!(update)));
    }

    let snapshot = event_snapshot()?;
    let mut log_budget: u64 = 2_000_000;
    for project in &snapshot.projects {
        let entity = &project.entity;
        if cursor.projects.get(&entity.id) != Some(&entity.updated_at) {
            cursor.projects.insert(entity.id.clone(), entity.updated_at);
            out.push(json_event(
                "project.updated",
                &json!({ "project": entity.data }),
            ));
        }
        for experiment in &project.experiments {
            if cursor.experiments.get(&experiment.id) != Some(&experiment.updated_at) {
                cursor
                    .experiments
                    .insert(experiment.id.clone(), experiment.updated_at);
                out.push(json_event(
                    "experiment.updated",
                    &json!({ "experiment": experiment.data }),
                ));
            }
        }
        if cursor.files.get(&entity.id) != Some(&project.fingerprint) {
            cursor.files.insert(entity.id.clone(), project.fingerprint);
            out.push(json_event(
                "files.updated",
                &json!({ "projectId": entity.id }),
            ));
        }
    }

    for run in &snapshot.runs {
        let changed = match cursor.runs.get(&run.id) {
            None => true,
            Some((status, updated)) => *status != run.status || *updated != run.updated_at,
        };
        if changed {
            cursor
                .runs
                .insert(run.id.clone(), (run.status.clone(), run.updated_at));
            out.push(json_event(
                "run.updated",
                &json!({ "run": ApiRun::from(run) }),
            ));
        }
        if first {
            // Live runs replay their whole log through the stream (chunked per
            // tick); terminal runs start at EOF — backfill is /api/runs/{id}/log.
            let start = if is_terminal(&run.status) {
                log_size(&run.id)
            } else {
                0
            };
            cursor.log_offsets.insert(run.id.clone(), start);
        }
        // Terminal runs were seeded at EOF above, so this is a no-op for them.
        push_log_delta(run, cursor, &mut out, &mut log_budget);
    }
    // Committed only now that the batch is certain to be returned.
    if let Some(update) = sampled_update {
        cursor.update = Some(update);
    }
    Ok(out)
}

fn push_log_delta(
    run: &StoredRun,
    cursor: &mut EventCursor,
    out: &mut Vec<Event>,
    budget: &mut u64,
) {
    let offset = *cursor.log_offsets.entry(run.id.clone()).or_insert(0);
    let size = log_size(&run.id);
    if size <= offset || *budget == 0 {
        return;
    }
    let chunk = read_log_from(&run.id, offset, *budget);
    *budget -= chunk.len() as u64;
    cursor
        .log_offsets
        .insert(run.id.clone(), offset + chunk.len() as u64);
    // base64: chunk boundaries are arbitrary byte positions, and exact byte
    // lengths are what lets the client dedup replays.
    out.push(json_event(
        "run.log",
        &json!({
            "runId": run.id,
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(&chunk),
            "offset": offset,
        }),
    ));
}

pub(super) fn log_size(run_id: &str) -> u64 {
    std::fs::metadata(log_path(run_id))
        .map(|m| m.len())
        .unwrap_or(0)
}

pub(super) fn read_log_from(run_id: &str, offset: u64, max: u64) -> Vec<u8> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(log_path(run_id)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if f.seek(SeekFrom::Start(offset)).is_ok() {
        let _ = f.take(max).read_to_end(&mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entity_snapshots_are_shared_until_expiry_and_scoped_to_data_directory() {
        let now = std::time::Instant::now();
        let empty = || {
            Ok(EventSnapshot {
                projects: Vec::new(),
                runs: Vec::new(),
            })
        };
        let mut cache = EventSnapshotCache::default();
        let first = cache.get("one".into(), now, empty).unwrap();
        let cached = cache
            .get("one".into(), now + Duration::from_millis(499), || {
                panic!("must reuse snapshot")
            })
            .unwrap();
        assert!(Arc::ptr_eq(&first, &cached));
        assert!(cache
            .get("one".into(), now + Duration::from_millis(500), || Err(
                anyhow!("snapshot failure")
            ))
            .is_err());
        let refreshed = cache
            .get("one".into(), now + Duration::from_millis(501), empty)
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &refreshed));
        let changed_dir = cache
            .get("two".into(), now + Duration::from_millis(502), empty)
            .unwrap();
        assert!(!Arc::ptr_eq(&refreshed, &changed_dir));
    }
    #[test]
    fn failed_event_batch_preserves_all_cursors_for_retry() {
        let mut cursor = EventCursor::default();
        cursor.log_offsets.insert("run".into(), 10);
        let failed: Result<()> = collect_event_batch(&mut cursor, |pending| {
            pending.projects.insert("project".into(), 1);
            pending.experiments.insert("experiment".into(), 2);
            pending.files.insert("project".into(), 3);
            pending.log_offsets.insert("run".into(), 20);
            pending.update_sampled_at = Some(std::time::Instant::now());
            Err(anyhow!("injected failure after collecting a project"))
        });
        assert!(failed.is_err());
        assert!(cursor.projects.is_empty());
        assert!(cursor.experiments.is_empty());
        assert!(cursor.files.is_empty());
        assert_eq!(cursor.log_offsets["run"], 10);
        assert!(cursor.update_sampled_at.is_none());
        let batch = collect_event_batch(&mut cursor, |pending| {
            assert!(!pending.projects.contains_key("project"));
            pending.projects.insert("project".into(), 1);
            Ok(vec!["project.updated"])
        })
        .unwrap();
        assert_eq!(batch, vec!["project.updated"]);
        assert_eq!(cursor.projects["project"], 1);
    }
}
