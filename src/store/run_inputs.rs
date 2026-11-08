//! Database guards also cover old binaries and direct legacy SQL writers.
use crate::error::Result;
use rusqlite::Connection;

fn present(row: &str) -> String {
    format!("CASE WHEN json_valid({row}.backend_json) THEN COALESCE(json_type({row}.backend_json,'$.inputSet')!='null',0) ELSE 0 END")
}

fn same(left: &str, right: &str) -> String {
    let mut terms = [
        "id",
        "project_id",
        "experiment_id",
        "commit_sha",
        "command",
        "created_at",
        "chat_session_id",
    ]
    .into_iter()
    .map(|key| format!("{left}.{key} IS {right}.{key}"))
    .collect::<Vec<_>>();
    for key in [
        "inputSet.id",
        "inputSet.manifestSha256",
        "kind",
        "sourceDigest",
        "sourceSize",
        "sourcePath",
    ] {
        terms.push(format!("json_extract({left}.backend_json,'$.{key}') IS json_extract({right}.backend_json,'$.{key}')"));
        terms.push(format!(
            "json_type({left}.backend_json,'$.{key}') IS json_type({right}.backend_json,'$.{key}')"
        ));
    }
    terms.push(format!("json_type({right}.backend_json,'$.inputSet')='object' AND (SELECT count(*) FROM json_each({right}.backend_json,'$.inputSet'))=2"));
    format!("CASE WHEN json_valid({left}.backend_json) AND json_valid({right}.backend_json) THEN ({}) ELSE 0 END",terms.join(" AND "))
}

fn valid(row: &str) -> String {
    format!("CASE WHEN json_valid({row}.backend_json) THEN (
        json_type({row}.backend_json,'$.inputSet')='object'
        AND (SELECT count(*) FROM json_each({row}.backend_json,'$.inputSet'))=2
        AND json_type({row}.backend_json,'$.inputSet.id')='text'
        AND json_type({row}.backend_json,'$.inputSet.manifestSha256')='text'
        AND EXISTS(SELECT 1 FROM frozen_input_sets f WHERE f.id=json_extract({row}.backend_json,'$.inputSet.id')
          AND f.project_id={row}.project_id AND f.state='frozen'
          AND f.manifest_sha256=json_extract({row}.backend_json,'$.inputSet.manifestSha256'))
        AND EXISTS(SELECT 1 FROM local_experiments e WHERE e.id={row}.experiment_id AND e.project_id={row}.project_id)
        AND json_type({row}.backend_json,'$.kind')='text'
        AND length(json_extract({row}.backend_json,'$.kind'))>0
        AND json_type({row}.backend_json,'$.sourceDigest')='text'
        AND length(json_extract({row}.backend_json,'$.sourceDigest'))=64
        AND json_extract({row}.backend_json,'$.sourceDigest') NOT GLOB '*[^0-9a-f]*'
        AND json_type({row}.backend_json,'$.sourceSize')='integer'
        AND json_extract({row}.backend_json,'$.sourceSize') BETWEEN 1 AND 9007199254740991
        AND json_type({row}.backend_json,'$.sourcePath')='text'
        AND length(json_extract({row}.backend_json,'$.sourcePath'))>0
        AND {row}.commit_sha IS NOT NULL AND length({row}.commit_sha)>0
        AND length(trim({row}.command))>0
    ) ELSE 0 END")
}

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    let new_present = present("NEW");
    let old_present = present("OLD");
    let existing_present = present("r");
    let same_old = same("OLD", "NEW");
    let same_existing = same("r", "NEW");
    let valid_new = valid("NEW");
    conn.execute_batch(&format!("
    CREATE TRIGGER IF NOT EXISTS run_inputs_insert BEFORE INSERT ON runs
      WHEN ({new_present} AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.id)
          AND (COALESCE(({valid_new}),0)=0 OR NEW.status!='starting'))
        OR EXISTS(SELECT 1 FROM runs r WHERE r.id=NEW.id AND (
          ({existing_present} AND (NOT ({new_present}) OR NOT ({same_existing})))
          OR (NOT ({existing_present}) AND ({new_present}))))
      BEGIN SELECT RAISE(ABORT,'INPUT_BINDING_GUARD: cannot replace or attach input/code identity; upgrade the CLI'); END;
    CREATE TRIGGER IF NOT EXISTS run_inputs_update BEFORE UPDATE ON runs
      WHEN (({old_present}) != ({new_present}))
        OR ({old_present} AND NOT ({same_old}))
      BEGIN SELECT RAISE(ABORT,'INPUT_BINDING_GUARD: input/code identity is immutable; upgrade the CLI'); END;
    CREATE TRIGGER IF NOT EXISTS run_inputs_retention BEFORE DELETE ON runs
      WHEN {old_present}
      BEGIN SELECT RAISE(ABORT,'INPUT_BINDING_GUARD: input-bound runs are retained until lifecycle support is available'); END;
    "))?;
    Ok(())
}

#[cfg(test)]
mod tests;
