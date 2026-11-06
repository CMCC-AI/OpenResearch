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
}

impl FileStamp {
    fn read(metadata: Metadata, kind: &str) -> Result<Self> {
        if !metadata.is_file() {
            return Err(anyhow!("{kind}必须为普通文件"));
        }
        Ok(Self {
            bytes: metadata.len(),
            modified: metadata.modified()?,
        })
    }
}

pub(crate) struct FileSource {
    path: PathBuf,
    file: File,
    identity: same_file::Handle,
    stamp: FileStamp,
    kind: &'static str,
}

impl FileSource {
    pub(crate) fn open(path: &Path, kind: &'static str) -> Result<Self> {
        let file = File::open(path)?;
        let stamp = FileStamp::read(file.metadata()?, kind)?;
        let identity = same_file::Handle::from_file(file.try_clone()?)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            identity,
            stamp,
            kind,
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
        Ok(())
    }

    pub(crate) fn lock_exclusive(&self) -> Result<()> {
        self.file
            .try_lock()
            .map_err(|e| anyhow!("文件正在使用或无法锁定: {e}"))?;
        Ok(())
    }

    /// One extra byte detects growth without following an indefinitely appended file.
    pub(crate) fn reader(&mut self) -> Take<&mut File> {
        (&mut self.file).take(self.stamp.bytes.saturating_add(1))
    }

    pub(crate) fn check_unchanged(&self) -> Result<()> {
        if self.stamp != FileStamp::read(self.file.metadata()?, self.kind)?
            || self.identity != same_file::Handle::from_path(&self.path)?
        {
            return Err(anyhow!("{}读取期间发生变化，请重新校验", self.kind));
        }
        Ok(())
    }

    pub(crate) fn into_file(mut self) -> Result<File> {
        self.check_unchanged()?;
        self.file.rewind()?;
        Ok(self.file)
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
