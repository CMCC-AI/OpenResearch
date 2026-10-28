use std::sync::Arc;

use crate::error::{anyhow, Result};

fn work_limit() -> Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    LIMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
        .clone()
}

/// Bounded executor for synchronous database, filesystem and git operations.
pub(crate) async fn run<T, F>(work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    run_limited(work_limit(), work).await
}

/// Lease renewal must not queue behind long filesystem/database work. Keep
/// this lane bounded too; it shares Tokio's blocking threads, not work permits.
pub(crate) async fn renew_lease<T, F>(work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    static LIMIT: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    run_limited(
        LIMIT
            .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
            .clone(),
        work,
    )
    .await
}

async fn run_limited<T, F>(limit: Arc<tokio::sync::Semaphore>, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let permit = limit
        .acquire_owned()
        .await
        .map_err(|error| anyhow!("blocking executor closed: {error}"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|error| anyhow!("blocking task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn lease_lane_runs_while_general_work_capacity_is_exhausted() {
        let all_work = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            work_limit().acquire_many_owned(8),
        )
        .await
        .unwrap()
        .unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), renew_lease(|| 42))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result, 42);
        drop(all_work);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_waiter_keeps_permit_until_worker_finishes() {
        let limit = Arc::new(tokio::sync::Semaphore::new(1));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = tokio::spawn(run_limited(limit.clone(), move || {
            let _ = started.send(());
            wait.recv_timeout(std::time::Duration::from_secs(3))
                .unwrap();
        }));
        ready.await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert_eq!(limit.available_permits(), 0);
        assert!(limit.clone().try_acquire_owned().is_err());
        release.send(()).unwrap();
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            limit.clone().acquire_owned(),
        )
        .await
        .unwrap()
        .unwrap();
        drop(permit);
        assert_eq!(limit.available_permits(), 1);
    }
}
