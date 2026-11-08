//! Input identity compatibility. This does not claim delivery or consumption.
use crate::{
    error::{anyhow, Error, Result},
    jobs::BackendDescriptor,
    store::StoredRun,
};
use serde::{Deserialize, Serialize};

pub(crate) const GUARD: &str = "INPUT_BINDING_GUARD";
pub(crate) const INPUT_PROTOCOL: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputSetRef {
    pub id: String,
    pub manifest_sha256: String,
}

/// A recovery file may add a provider handle, never replace the input/code
/// identity reserved in SQLite. Legacy runs without inputs retain their path.
pub(crate) fn check_descriptor(run: &StoredRun, incoming: &BackendDescriptor) -> Result<()> {
    let has_binding = serde_json::from_str::<serde_json::Value>(&run.backend_json)
        .ok()
        .and_then(|v| v.get("inputSet").cloned())
        .is_some_and(|v| !v.is_null());
    if !has_binding && incoming.input_set.is_none() {
        return Ok(());
    }
    let current = BackendDescriptor::parse(&run.backend_json)
        .map_err(|e| anyhow!("{GUARD}: reserved descriptor is unreadable: {e}"))?;
    if current.input_set.is_none()
        || current.input_set != incoming.input_set
        || current.kind != incoming.kind
        || current.source_digest != incoming.source_digest
        || current.source_size != incoming.source_size
        || current.source_path != incoming.source_path
    {
        return Err(anyhow!(
            "{GUARD}: recovery cannot change the reserved input/code identity; upgrade the CLI"
        ));
    }
    Ok(())
}

pub(crate) fn is_guard_error(error: &Error) -> bool {
    error.chain().any(|cause| cause.to_string().contains(GUARD))
}
