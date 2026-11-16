//! Stable, bounded reads shared by research artifacts and evidence logs.
use std::fs::{File, Metadata};
use std::io::{Read, Seek, Take};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::error::{anyhow, Result};

#[derive(PartialEq, Eq)]
struct FileStamp {
    bytes: u64,
    modified: SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl FileStamp {
    fn read(metadata: Metadata, kind: &str) -> Result<Self> {
        if !metadata.is_file() {
            return Err(anyhow!("{kind}必须为普通文件"));
        }
        Ok(Self {
            bytes: metadata.len(),
            modified: metadata.modified()?,
            #[cfg(unix)]
            changed: {
                use std::os::unix::fs::MetadataExt;
                (metadata.ctime(), metadata.ctime_nsec())
            },
        })
    }
}

struct SourceFile {
    file: Option<File>,
    locked: std::sync::atomic::AtomicBool,
}

impl SourceFile {
    fn new(file: File) -> Self {
        Self {
            file: Some(file),
            locked: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn mark_locked(&self) {
        self.locked
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn into_locked_file(mut self) -> crate::file_lock::FileLock {
        self.locked
            .store(false, std::sync::atomic::Ordering::Relaxed);
        crate::file_lock::FileLock::new(self.file.take().expect("source file active"))
    }
}

impl std::ops::Deref for SourceFile {
    type Target = File;

    fn deref(&self) -> &File {
        self.file.as_ref().expect("source file active")
    }
}

impl std::ops::DerefMut for SourceFile {
    fn deref_mut(&mut self) -> &mut File {
        self.file.as_mut().expect("source file active")
    }
}

impl Drop for SourceFile {
    fn drop(&mut self) {
        if self.locked.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(file) = self.file.take() {
                let _ = file.unlock();
            }
        }
    }
}

pub(crate) struct FileSource {
    path: PathBuf,
    file: SourceFile,
    identity: same_file::Handle,
    stamp: FileStamp,
    kind: &'static str,
}

/// A post-hash witness for optimistic commits. Unix stores device/inode without
/// retaining descriptors; other targets retain only the portable identity handle.
/// It detects replacement and metadata changes, not hostile filesystem tampering.
pub(crate) struct FileSnapshot {
    path: PathBuf,
    stamp: FileStamp,
    kind: &'static str,
    #[cfg(unix)]
    identity: (u64, u64),
    #[cfg(not(unix))]
    identity: same_file::Handle,
}

impl FileSnapshot {
    pub(crate) fn check_unchanged(&self) -> Result<()> {
        let current = FileSource::open(&self.path, self.kind)?;
        #[cfg(unix)]
        let same_identity = {
            use std::os::unix::fs::MetadataExt;
            let metadata = current.file.metadata()?;
            self.identity == (metadata.dev(), metadata.ino())
        };
        #[cfg(not(unix))]
        let same_identity = self.identity == current.identity;
        if self.stamp != current.stamp || !same_identity {
            return Err(anyhow!("{}核验后发生变化，请重新校验", self.kind));
        }
        Ok(())
    }
}

// Preflight observed special files before opening. On Unix, O_NONBLOCK also
// prevents a regular-to-FIFO replacement race from blocking the identity probe.
fn open_regular(path: &Path, kind: &str) -> Result<File> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(anyhow!("{kind}必须为普通文件"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(anyhow!("{kind}读取期间路径类型变化"));
    }
    Ok(file)
}

impl FileSource {
    pub(crate) fn open(path: &Path, kind: &'static str) -> Result<Self> {
        let file = open_regular(path, kind)?;
        let stamp = FileStamp::read(file.metadata()?, kind)?;
        let identity = same_file::Handle::from_file(file.try_clone()?)?;
        Ok(Self {
            path: path.to_path_buf(),
            file: SourceFile::new(file),
            identity,
            stamp,
            kind,
        })
    }

    pub(crate) fn into_snapshot(self) -> Result<FileSnapshot> {
        self.check_unchanged()?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            let metadata = self.file.metadata()?;
            (metadata.dev(), metadata.ino())
        };
        #[cfg(not(unix))]
        let identity = self.identity;
        Ok(FileSnapshot {
            path: self.path,
            stamp: self.stamp,
            kind: self.kind,
            identity,
        })
    }

    pub(crate) fn bytes(&self) -> u64 {
        self.stamp.bytes
    }

    /// The owned descriptor retains this lease through `into_file` and streaming.
    pub(crate) fn lock_shared(&self) -> Result<()> {
        self.file
            .try_lock_shared()
            .map_err(|e| anyhow!("文件正在回收或无法锁定: {e}"))?;
        self.file.mark_locked();
        Ok(())
    }

    pub(crate) fn lock_exclusive(&self) -> Result<()> {
        self.file
            .try_lock()
            .map_err(|e| anyhow!("文件正在使用或无法锁定: {e}"))?;
        self.file.mark_locked();
        Ok(())
    }

    /// One extra byte detects growth without following an indefinitely appended file.
    pub(crate) fn reader(&mut self) -> Take<&mut File> {
        (&mut *self.file).take(self.stamp.bytes.saturating_add(1))
    }

    pub(crate) fn check_unchanged(&self) -> Result<()> {
        if self.stamp != FileStamp::read(self.file.metadata()?, self.kind)?
            || self.identity != same_file::Handle::from_file(open_regular(&self.path, self.kind)?)?
        {
            return Err(anyhow!("{}读取期间发生变化，请重新校验", self.kind));
        }
        Ok(())
    }

    pub(crate) fn into_file(mut self) -> Result<crate::file_lock::FileLock> {
        self.check_unchanged()?;
        self.file.rewind()?;
        Ok(self.file.into_locked_file())
    }

    pub(crate) fn hash(&mut self) -> Result<String> {
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        let mut reader = self.reader();
        loop {
            let count = match reader.read(&mut buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            bytes += count as u64;
        }
        if bytes != self.stamp.bytes {
            return Err(anyhow!("{}读取期间长度变化，请重新校验", self.kind));
        }
        self.check_unchanged()?;
        Ok(format!("{:x}", hash.finalize()))
    }
}
