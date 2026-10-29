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
