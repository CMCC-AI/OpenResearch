fn aggregate_write_count(store: &Store) -> i64 {
    store
        .conn
        .query_row("SELECT COUNT(*) FROM aggregate_writes", [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn observe_aggregate_writes(store: &Store) {
    store
        .conn
        .execute_batch(
            "CREATE TEMP TABLE aggregate_writes(n INTEGER);
        CREATE TEMP TRIGGER aggregate_updated AFTER UPDATE ON main.research_studies
        BEGIN INSERT INTO aggregate_writes VALUES(1); END;",
        )
        .unwrap();
}

#[test]
fn research_aggregate_updates_preserve_legacy_noops_and_rollback_errors() {
    let (_dir, store, mut study) = setup();
    study.updated_at = 1;
    let mut legacy = serde_json::to_value(&study).unwrap();
    legacy.as_object_mut().unwrap().remove("deliveryError");
    legacy["unknownLegacyField"] = serde_json::json!({"keep":"until a real update"});
    let original = format!("\n{}\n", serde_json::to_string_pretty(&legacy).unwrap());
    store
        .conn
        .execute(
            "UPDATE research_studies SET document=?2 WHERE id=?1",
            params![study.id, original],
        )
        .unwrap();
    observe_aggregate_writes(&store);
    assert_eq!(store.research_update(&study.id, |_| Ok(17)).unwrap(), 17);
    assert!(store
        .research_update::<()>(&study.id, |s| {
            s.delivery_error = Some("must roll back".into());
            Err(anyhow!("injected update error"))
        })
        .is_err());
    assert_eq!(aggregate_write_count(&store), 0);
    let raw: String = store
        .conn
        .query_row(
            "SELECT document FROM research_studies WHERE id=?1",
            [&study.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(raw, original);
    assert_eq!(store.research_study(&study.id).unwrap().updated_at, 1);
    assert!(store.conn.is_autocommit());
    store
        .research_update(&study.id, |s| {
            s.delivery_error = Some("real update".into());
            Ok(())
        })
        .unwrap();
    assert_eq!(aggregate_write_count(&store), 1);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.delivery_error.as_deref(), Some("real update"));
    assert!(saved.updated_at > 1);
}

#[test]
fn research_aggregate_updates_preserve_json_number_representation_changes() {
    for (before, after) in [
        (serde_json::json!(-0.0), serde_json::json!(0.0)),
        (serde_json::json!(1), serde_json::json!(1.0)),
        (
            serde_json::json!({"nested":[-0.0]}),
            serde_json::json!({"nested":[0.0]}),
        ),
    ] {
        let (_dir, store, study) = setup();
        store.research_set_plan(&study.id, plan()).unwrap();
        let mut saved = store.research_study(&study.id).unwrap();
        saved.task_mut("design").unwrap().run_contract = Some(RunContract {
            experiment_id: "exp".into(),
            revision: "abc".into(),
            command: "python main.py".into(),
            options: before,
        });
        store.research_save(&saved).unwrap();
        observe_aggregate_writes(&store);
        store.research_update(&study.id, |_| Ok(())).unwrap();
        assert_eq!(aggregate_write_count(&store), 0);
        store
            .research_update(&study.id, |s| {
                s.task_mut("design")?.run_contract.as_mut().unwrap().options = after.clone();
                Ok(())
            })
            .unwrap();
        assert_eq!(aggregate_write_count(&store), 1);
        let saved = store.research_study(&study.id).unwrap();
        assert_eq!(
            serde_json::to_string(
                &saved
                    .task("design")
                    .unwrap()
                    .run_contract
                    .as_ref()
                    .unwrap()
                    .options
            )
            .unwrap(),
            serde_json::to_string(&after).unwrap()
        );
    }
}

#[test]
fn research_active_index_migrates_legacy_rows_and_preserves_bad_documents() {
    let (dir, store, mut study) = setup();
    store
        .conn
        .execute_batch("DROP INDEX idx_research_studies_active")
        .unwrap();
    let bad = "{broken-json";
    store
        .conn
        .execute(
            "INSERT INTO research_studies VALUES('bad','project','bad-session',?1)",
            [bad],
        )
        .unwrap();
    store.conn.execute("INSERT INTO research_studies VALUES('incomplete','project','incomplete-session','{\"status\":\"active\"}')", []).unwrap();
    let escaped = serde_json::to_string(&study)
        .unwrap()
        .replace("\"active\"", "\"\\u0061ctive\"");
    store
        .conn
        .execute(
            "UPDATE research_studies SET document=?2 WHERE id=?1",
            params![study.id, escaped],
        )
        .unwrap();
    let mut escaped_key = study.clone();
    escaped_key.id = "escaped-key".into();
    escaped_key.session_id = "escaped-key-session".into();
    let escaped_key_json = serde_json::to_string(&escaped_key)
        .unwrap()
        .replace("\"status\"", "\"\\u0073tatus\"");
    store
        .conn
        .execute(
            "INSERT INTO research_studies VALUES('escaped-key','project','escaped-key-session',?1)",
            [&escaped_key_json],
        )
        .unwrap();
    study.id = "ended".into();
    study.session_id = "ended-session".into();
    study.status = "stopped".into();
    let ended = serde_json::to_string(&study).unwrap();
    store
        .conn
        .execute(
            "INSERT INTO research_studies VALUES('ended','project','ended-session',?1)",
            [&ended],
        )
        .unwrap();
    drop(store);
    let store = Store::open_at(dir.path().to_path_buf()).unwrap();
    let active = store.research_active_studies().unwrap();
    assert_eq!(active.len(), 2);
    assert!(active.iter().any(|study| study.session_id == "lead"));
    assert!(active
        .iter()
        .any(|study| study.session_id == "escaped-key-session"));
    for (id, expected) in [("bad", bad), ("ended", ended.as_str())] {
        let original: String = store
            .conn
            .query_row(
                "SELECT document FROM research_studies WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original, expected);
    }
    assert_eq!(store.research_study("ended").unwrap().status, "stopped");
    assert!(store.research_study("bad").is_err());
}

#[test]
fn research_active_index_tracks_status_and_transaction_rollback() {
    let (_dir, store, study) = setup();
    assert_eq!(store.research_active_studies().unwrap().len(), 1);
    {
        let _tx = store.begin_immediate().unwrap();
        store
            .research_update_in_tx(&study.id, |s| {
                s.status = "stopped".into();
                Ok(())
            })
            .unwrap();
        assert!(store.research_active_studies().unwrap().is_empty());
    }
    assert_eq!(store.research_active_studies().unwrap().len(), 1);
    store.research_end(&study.id, 0, &[]).unwrap();
    assert!(store.research_active_studies().unwrap().is_empty());
    assert_eq!(store.research_study(&study.id).unwrap().status, "stopped");
    // An older writer/import updates only the canonical document; SQLite keeps
    // the derived index current without a synchronized status column.
    store.conn.execute("UPDATE research_studies SET document=json_set(document,'$.status','active') WHERE id=?1", [&study.id]).unwrap();
    assert_eq!(store.research_active_studies().unwrap().len(), 1);
    let plan: Vec<String> = store
        .conn
        .prepare(&format!(
            "EXPLAIN QUERY PLAN SELECT document FROM research_studies WHERE {ACTIVE_STUDY_FILTER}"
        ))
        .unwrap()
        .query_map([], |row| row.get(3))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(
        plan.iter()
            .any(|detail| detail.contains("idx_research_studies_active")),
        "{plan:?}"
    );
}

#[test]
fn research_active_index_warm_migration_does_not_require_writer_lock() {
    let (dir, store, _) = setup();
    store.set_busy_timeout(std::time::Duration::ZERO).unwrap();
    let writer = rusqlite::Connection::open(dir.path().join("orx.db")).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    migrate(&store.conn).unwrap();
    assert_eq!(store.research_active_studies().unwrap().len(), 1);
    writer.execute_batch("ROLLBACK").unwrap();
}

#[test]
#[ignore = "synthetic aggregate I/O benchmark; run explicitly with --ignored --nocapture"]
fn research_aggregate_update_benchmark() {
    for claims in [64, 512] {
        let (_dir, store, mut study) = setup();
        for index in 0..claims {
            study.claims.push(EvidenceClaim {
                id: format!("claim-{index}"),
                input: ClaimInput {
                    text: "x".repeat(16 * 1024),
                    support: "inference".into(),
                    source: "synthetic benchmark".into(),
                    location: None,
                    run_id: None,
                    line_start: None,
                    line_end: None,
                },
                commit_sha: None,
                log_sha256: None,
                excerpt: None,
                created_at: 1,
            });
        }
        store.research_save(&study).unwrap();
        let bytes = serde_json::to_vec(&study).unwrap().len();
        let mut noops = Vec::new();
        let mut changes = Vec::new();
        for index in 0..5 {
            let start = std::time::Instant::now();
            store.research_update(&study.id, |_| Ok(())).unwrap();
            noops.push(start.elapsed());
            let start = std::time::Instant::now();
            store
                .research_update(&study.id, |s| {
                    s.delivery_error = Some(format!("measured-{index}"));
                    Ok(())
                })
                .unwrap();
            changes.push(start.elapsed());
        }
        noops.sort();
        changes.sort();
        eprintln!(
            "aggregate bytes={bytes} no_op_median_us={} changed_median_us={}",
            noops[2].as_micros(),
            changes[2].as_micros()
        );
    }
}

#[test]
#[ignore = "synthetic history scan benchmark; run explicitly with --ignored --nocapture"]
fn research_active_scan_benchmark() {
    let (_dir, store, mut study) = setup();
    study.status = "stopped".into();
    store.research_save(&study).unwrap();
    for index in 0..64 {
        study.claims.push(EvidenceClaim {
            id: format!("claim-{index}"),
            input: ClaimInput {
                text: "x".repeat(16 * 1024),
                support: "inference".into(),
                source: "synthetic history".into(),
                location: None,
                run_id: None,
                line_start: None,
                line_end: None,
            },
            commit_sha: None,
            log_sha256: None,
            excerpt: None,
            created_at: 1,
        });
    }
    for index in 0..32 {
        study.id = format!("scan-{index}");
        study.session_id = format!("session-{index}");
        study.status = if index < 2 { "active" } else { "stopped" }.into();
        store
            .conn
            .execute(
                "INSERT INTO research_studies VALUES(?1,'project',?2,?3)",
                params![
                    study.id,
                    study.session_id,
                    serde_json::to_string(&study).unwrap()
                ],
            )
            .unwrap();
    }
    let mut samples = Vec::new();
    for _ in 0..5 {
        let start = std::time::Instant::now();
        assert_eq!(store.research_active_studies().unwrap().len(), 2);
        samples.push(start.elapsed());
    }
    samples.sort();
    eprintln!(
        "active_scan studies=33 active=2 document_bytes={} median_us={}",
        serde_json::to_vec(&study).unwrap().len(),
        samples[2].as_micros()
    );
}
