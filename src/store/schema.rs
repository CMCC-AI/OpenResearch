//! Versioned compatibility migrations. Applied batches are immutable; add a new
//! migration name for future columns rather than changing an applied batch.
use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::{anyhow, Result};

pub(super) fn migrate_columns(conn: &Connection, name: &str, statements: &[&str]) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_schema_migrations')",
        [], |row| row.get(0),
    )?;
    if exists && applied(conn, name)? {
        return Ok(());
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS product_schema_migrations (name TEXT PRIMARY KEY)",
    )?;
    // Another process may have completed this migration while we waited for the writer.
    if applied(&tx, name)? {
        return Ok(());
    }
    for ddl in statements {
        let words: Vec<_> = ddl.split_whitespace().collect();
        if words.len() < 7 || words[..2] != ["ALTER", "TABLE"] || words[3..5] != ["ADD", "COLUMN"] {
            return Err(anyhow!("Invalid column migration: {ddl}"));
        }
        let (table, column) = (words[2], words[5]);
        if ![table, column]
            .iter()
            .all(|word| word.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'))
        {
            return Err(anyhow!("Invalid migration identifier: {ddl}"));
        }
        let present = {
            let mut query = tx.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = query.query_map([], |row| row.get::<_, String>(1))?;
            columns
                .collect::<std::result::Result<Vec<_>, _>>()?
                .iter()
                .any(|existing| existing == column)
        };
        if !present {
            tx.execute(ddl, []).map_err(|error| {
                anyhow!("Schema migration {name} failed at {table}.{column}: {error}")
            })?;
        }
    }
    tx.execute(
        "INSERT INTO product_schema_migrations (name) VALUES (?1)",
        [name],
    )?;
    tx.commit()?;
    Ok(())
}

fn applied(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM product_schema_migrations WHERE name=?1)",
        [name],
        |row| row.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_columns_are_idempotent_and_preserve_rows() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE example (id TEXT, existing TEXT); INSERT INTO example VALUES ('one', 'keep')").unwrap();
        let ddl = [
            "ALTER TABLE example ADD COLUMN existing TEXT",
            "ALTER TABLE example ADD COLUMN added INTEGER NOT NULL DEFAULT 7",
        ];
        migrate_columns(&db, "v1", &ddl).unwrap();
        migrate_columns(&db, "v1", &ddl).unwrap();
        let row: (String, i64) = db
            .query_row("SELECT existing, added FROM example", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(row, ("keep".into(), 7));
    }

    #[test]
    fn failed_migration_rolls_back_columns_and_marker_then_retries() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE example (id TEXT)").unwrap();
        let ddl = [
            "ALTER TABLE example ADD COLUMN added TEXT",
            "ALTER TABLE missing ADD COLUMN added TEXT",
        ];
        let error = migrate_columns(&db, "v1", &ddl).unwrap_err();
        assert!(error.to_string().contains("missing.added"));
        assert!(db.prepare("SELECT added FROM example").is_err());
        db.execute_batch("CREATE TABLE missing (id TEXT)").unwrap();
        migrate_columns(&db, "v1", &ddl).unwrap();
        assert!(applied(&db, "v1").unwrap());
    }
}
