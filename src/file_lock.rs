use std::fs::File;

/// A locked file that unlocks when dropped. Closing alone releases the lock only once every
/// child forked meanwhile has exec'd, so until then another holder would find it taken.
pub struct FileLock(Option<File>);

impl FileLock {
    /// Takes `file` once it holds its lock.
    pub fn new(file: File) -> Self {
        Self(Some(file))
    }

    fn as_file(&self) -> &File {
        self.0.as_ref().expect("file lock active")
    }

    fn as_file_mut(&mut self) -> &mut File {
        self.0.as_mut().expect("file lock active")
    }

    /// Converts the locked file into an async reader that releases the lock explicitly on drop.
    pub fn into_async_reader(mut self) -> std::io::Result<LockedAsyncFile> {
        let file = self.0.take().expect("file lock active");
        match file.try_clone() {
            Ok(guard) => Ok(LockedAsyncFile {
                file: tokio::fs::File::from_std(file),
                _lock: Self::new(guard),
            }),
            Err(err) => {
                let _ = file.unlock();
                Err(err)
            }
        }
    }
}

impl std::ops::Deref for FileLock {
    type Target = File;

    fn deref(&self) -> &File {
        self.as_file()
    }
}

impl std::ops::DerefMut for FileLock {
    fn deref_mut(&mut self) -> &mut File {
        self.as_file_mut()
    }
}

impl std::io::Read for FileLock {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.as_file_mut().read(buf)
    }
}

impl std::io::Seek for FileLock {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.as_file_mut().seek(pos)
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        if let Some(file) = self.0.take() {
            // Closing still releases it if this fails, only later.
            let _ = file.unlock();
        }
    }
}

/// Async stream reader wrapper that keeps the explicit `FileLock` until dropped.
pub struct LockedAsyncFile {
    file: tokio::fs::File,
    _lock: FileLock,
}

impl tokio::io::AsyncRead for LockedAsyncFile {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.file).poll_read(cx, buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_releases_the_lock_a_forked_child_still_shares() {
        let path =
            std::env::temp_dir().join(format!("orx-file-lock-{}.lock", uuid::Uuid::new_v4()));
        let open = || {
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
                .unwrap()
        };
        let file = open();
        file.try_lock().unwrap();
        // What a fork leaves the child until it execs: another descriptor for the same open file.
        let child = file.try_clone().unwrap();

        drop(FileLock::new(file));

        open().try_lock().unwrap();
        drop(child);
        let _ = std::fs::remove_file(&path);
    }
}
