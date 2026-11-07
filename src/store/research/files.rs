//! Stable reads are shared with material parser provenance.
pub(super) use crate::verified_file::FileSource;

use super::*;
use crate::verified_file::FileSnapshot;

pub(super) struct PreparedArtifact {
    pub artifact: Artifact,
    path: PathBuf,
    source: FileSnapshot,
}

fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    if !safe_relative(relative) {
        return Err(anyhow!("产物路径必须为目录内的相对路径"));
    }
    let root = root.canonicalize()?;
    let path = root.join(relative).canonicalize()?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(anyhow!("产物路径越界或不是文件"));
    }
    Ok(path)
}

pub(super) fn open_artifact(root: &Path, relative: &str) -> Result<(PathBuf, FileSource)> {
    let path = resolve(root, relative)?;
    let source = FileSource::open(&path, "研究产物")?;
    if source.bytes() > MAX_ARTIFACT_BYTES {
        return Err(anyhow!("单个研究包产物超过 32 MiB"));
    }
    Ok((path, source))
}

impl PreparedArtifact {
    pub(super) fn inspect(root: &Path, relative: &str) -> Result<Self> {
        let (path, mut source) = open_artifact(root, relative)?;
        let artifact = Artifact {
            path: relative.into(),
            sha256: source.hash()?,
            bytes: source.bytes(),
        };
        let prepared = Self {
            artifact,
            path,
            source: source.into_snapshot()?,
        };
        prepared.check_unchanged(root)?;
        Ok(prepared)
    }

    /// Resolve the original relative name again: checking only its old canonical
    /// target would miss a replaced parent symlink or a renamed project root.
    pub(super) fn check_unchanged(&self, root: &Path) -> Result<()> {
        if resolve(root, &self.artifact.path)? != self.path {
            return Err(anyhow!("研究产物路径核验后发生变化，请重新校验"));
        }
        self.source.check_unchanged()
    }
}
