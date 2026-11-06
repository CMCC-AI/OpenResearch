fn archive_clock() -> (i64, i64) {
    let now = now_ms();
    (now + 2 * 86_400_000, now + 30 * 86_400_000)
}
fn archive_orphan(store: &Store, study: &Study, root: &Path) -> String {
    let prepared = store
        .research_prepare_delivery_at(study, root, |_| Ok(()))
        .unwrap();
    let hash = serde_json::from_str::<serde_json::Value>(&prepared.scope).unwrap()
        ["deliveryBundle"]["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    drop(prepared);
    hash
}
#[test]
fn archive_retention_locks_prepared_files_and_keeps_every_published_snapshot() {
    let (_dir, store, study, root, _) = snapshot_fixture();
    let (before, now) = archive_clock();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap()
        .candidates
        .is_empty());
    request_snapshot(&store, &study, &prepared);
    drop(prepared);
    let prepared = store
        .research_prepare_delivery_at(&store.research_study(&study.id).unwrap(), &root, |_| Ok(()))
        .unwrap();
    approve_snapshot(&store, &study, prepared);
    let (file, _) = store.research_download_package(&study.id).unwrap();
    let current = store.research_study(&study.id).unwrap();
    let old = current.delivery_snapshot.unwrap().archive.sha256;
    // Replacement of even an unapproved snapshot must not remove its retention.
    store
        .research_update(&study.id, |s| {
            s.plans.last_mut().unwrap().summary = "second snapshot".into();
            Ok(())
        })
        .unwrap();
    let study = store.research_study(&study.id).unwrap();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    request_snapshot(&store, &study, &prepared);
    drop(prepared);
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap()
        .candidates
        .is_empty());
    let catalog = store.research_archives("project", &study.id, 0, 1).unwrap();
    assert_eq!(catalog["hasMore"], true);
    assert_eq!(catalog["items"][0]["sha256"], old);
    assert_eq!(catalog["items"][0]["referenceProtected"], true);
    let next = catalog["nextCursor"].as_i64().unwrap();
    assert_eq!(
        store
            .research_archives("project", &study.id, next, 1)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(file);
    assert!(store
        .research_archives("foreign", &study.id, 0, 100)
        .is_err());
}
#[test]
fn archive_retention_collects_only_unused_verified_objects_with_exact_review_token() {
    let (_dir, store, study, root, _) = snapshot_fixture();
    let hash = archive_orphan(&store, &study, &root);
    let (before, now) = archive_clock();
    let unknown = store
        .archive_dir(&study)
        .unwrap()
        .join(format!("{}.zip", "f".repeat(64)));
    std::fs::write(&unknown, b"unregistered").unwrap();
    let preview = store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].sha256, hash);
    assert!(store
        .archive_apply_at("project", &study.id, before, "stale", now, |_| Ok(()))
        .is_err());
    let result = store
        .archive_apply_at(
            "project",
            &study.id,
            before,
            &preview.preview_hash,
            now,
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(result.removed, vec![hash.clone()]);
    assert!(result.failed.is_empty());
    assert!(result.logical_bytes_removed > 0);
    assert!(unknown.exists());
    assert_eq!(
        store
            .research_archives("project", &study.id, 0, 100)
            .unwrap()["items"][0]["regularFilePresent"],
        false
    );
    assert_eq!(
        store
            .conn
            .query_row(
                "SELECT count(*) FROM research_archive_gc WHERE status='removed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}
#[test]
fn archive_retention_recovers_both_crash_windows_without_deleting_again() {
    for crash in ["planned", "unlinked"] {
        let (_dir, store, study, root, _) = snapshot_fixture();
        let hash = archive_orphan(&store, &study, &root);
        let (before, now) = archive_clock();
        let preview = store
            .archive_preview_at("project", &study.id, before, now)
            .unwrap();
        assert!(store
            .archive_apply_at(
                "project",
                &study.id,
                before,
                &preview.preview_hash,
                now,
                |stage| {
                    if stage == crash {
                        Err(anyhow!("simulated crash"))
                    } else {
                        Ok(())
                    }
                }
            )
            .is_err());
        assert_eq!(
            store
                .conn
                .query_row("SELECT status FROM research_archive_gc", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "planned"
        );
        // Even direct old-version SQL cannot attach a pending deletion target.
        let mut body = serde_json::to_value(&study).unwrap();
        body["deliverySnapshot"] = serde_json::json!({"catalogVersion":1,"scopeHash":"scope","identityHash":"identity","archive":{"formatVersion":1,"sha256":hash,"bytes":1,"manifestSha256":"manifest"}});
        assert!(store
            .conn
            .execute(
                "UPDATE research_studies SET document=?2 WHERE id=?1",
                params![study.id, body.to_string()]
            )
            .is_err());
        let recovered = store
            .research_archive_recover("project", &study.id)
            .unwrap();
        assert_eq!(recovered["deletedFiles"], 0);
        assert_eq!(
            recovered["items"][0]["status"],
            if crash == "planned" {
                "aborted"
            } else {
                "absent"
            }
        );
        assert_eq!(
            store
                .archive_dir(&study)
                .unwrap()
                .join(format!("{hash}.zip"))
                .exists(),
            crash == "planned"
        );
        assert!(store
            .research_archive_recover("project", &study.id)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
#[test]
fn archive_retention_rejects_changed_content_recent_files_and_busy_sessions() {
    let (_dir, store, study, root, _) = snapshot_fixture();
    let hash = archive_orphan(&store, &study, &root);
    assert!(store
        .research_archive_gc_preview("project", &study.id, now_ms())
        .is_err());
    let (before, now) = archive_clock();
    let preview = store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap();
    let path = store
        .archive_dir(&study)
        .unwrap()
        .join(format!("{hash}.zip"));
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] ^= 1;
    std::fs::write(&path, &bytes).unwrap();
    let newer = store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap();
    assert!(store
        .archive_apply_at(
            "project",
            &study.id,
            before,
            &newer.preview_hash,
            now,
            |_| Ok(())
        )
        .is_err());
    assert!(path.exists());
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM research_archive_gc", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    store
        .research_update(&study.id, |s| {
            s.objective = "changed after preview".into();
            Ok(())
        })
        .unwrap();
    assert!(store
        .archive_apply_at(
            "project",
            &study.id,
            before,
            &preview.preview_hash,
            now,
            |_| Ok(())
        )
        .is_err());
    store
        .research_update(&study.id, |s| {
            s.plans.last_mut().unwrap().tasks[0].state = "running".into();
            Ok(())
        })
        .unwrap();
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .is_err());
}
#[test]
fn archive_retention_legacy_is_permanent_and_old_writers_cannot_drop_catalog_version() {
    let (_dir, store, study, root, _) = snapshot_fixture();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    request_snapshot(&store, &study, &prepared);
    let mut body: serde_json::Value = serde_json::from_str(
        &store
            .conn
            .query_row(
                "SELECT document FROM research_studies WHERE id=?1",
                [&study.id],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    body["deliverySnapshot"]
        .as_object_mut()
        .unwrap()
        .remove("catalogVersion");
    assert!(store
        .conn
        .execute(
            "UPDATE research_studies SET document=?2 WHERE id=?1",
            params![study.id, body.to_string()]
        )
        .is_err());
    body["deliverySnapshot"]["catalogVersion"] = 2.into();
    assert!(store
        .conn
        .execute(
            "UPDATE research_studies SET document=?2 WHERE id=?1",
            params![study.id, body.to_string()]
        )
        .is_err());
    assert!(store
        .conn
        .execute(
            "DELETE FROM research_archive_history WHERE study_id=?1",
            [&study.id]
        )
        .is_err());
    assert!(store
        .conn
        .execute(
            "UPDATE research_archive_objects SET legacy=1 WHERE study_id=?1",
            [&study.id]
        )
        .is_err());
    drop(prepared);
    // A pre-existing uncatalogued ZIP is forever legacy, even if later prepared.
    let (_d, store, study) = setup();
    let descriptor = delivery::ArchiveDescriptor {
        format_version: 1,
        sha256: "a".repeat(64),
        bytes: 1,
        manifest_sha256: "b".repeat(64),
    };
    store
        .research_register_archive(&study, &descriptor, true, "scope")
        .unwrap();
    store
        .research_register_archive(&study, &descriptor, false, "scope")
        .unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT legacy FROM research_archive_objects", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    store
        .conn
        .execute("DELETE FROM local_projects WHERE id='project'", [])
        .unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM research_archive_objects", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}
#[test]
fn archive_retention_backfill_preserves_legacy_and_malformed_documents() {
    let (_dir, store, study) = setup();
    // Simulate a pre-catalog database, including a malformed historical row.
    store.conn.execute_batch("DROP TRIGGER research_archive_reference_guard_update; DROP TRIGGER research_archive_capture_update; DELETE FROM research_archive_migrations;").unwrap();
    let mut body = serde_json::to_value(&study).unwrap();
    body["deliverySnapshot"] = serde_json::json!({"scopeHash":"legacy","identityHash":"id","archive":{"formatVersion":1,"sha256":"c".repeat(64),"bytes":42,"manifestSha256":"d".repeat(64)}});
    store
        .conn
        .execute(
            "UPDATE research_studies SET document=?2 WHERE id=?1",
            params![study.id, body.to_string()],
        )
        .unwrap();
    store.conn.execute("INSERT INTO research_studies(id,project_id,session_id,document) VALUES('broken','project','broken','malformed')",[]).unwrap();
    archive_retention::migrate(&store.conn).unwrap();
    archive_retention::migrate(&store.conn).unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT legacy FROM research_archive_objects", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM research_archive_history", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        1
    );
}

#[test]
fn archive_retention_rechecks_references_after_hashing_without_holding_sqlite_writer() {
    let (dir, store, study, root, _) = snapshot_fixture();
    archive_orphan(&store, &study, &root);
    let other = Store::open_at(dir.path().to_path_buf()).unwrap();
    other.set_busy_timeout(std::time::Duration::ZERO).unwrap();
    let (before, now) = archive_clock();
    let preview = store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap();
    let mut observed = false;
    let result = store.archive_apply_at(
        "project",
        &study.id,
        before,
        &preview.preview_hash,
        now,
        |stage| {
            if stage == "verified" {
                assert!(store.conn.is_autocommit());
                other.research_update(&study.id, |s| {
                    s.objective = "concurrent edit".into();
                    Ok(())
                })?;
                observed = true;
            }
            Ok(())
        },
    );
    assert!(observed);
    assert!(result.is_err());
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM research_archive_gc", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn archive_retention_blocks_descendant_leases_and_keeps_download_lock_until_close() {
    let (_dir, store, study, root, _) = snapshot_fixture();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    request_snapshot(&store, &study, &prepared);
    approve_snapshot(&store, &study, prepared);
    let (file, snapshot) = store.research_download_package(&study.id).unwrap();
    let source = files::FileSource::open(
        &store
            .archive_dir(&study)
            .unwrap()
            .join(format!("{}.zip", snapshot.archive.sha256)),
        "test archive",
    )
    .unwrap();
    assert!(source.lock_exclusive().is_err());
    drop(file);
    assert!(source.lock_exclusive().is_ok());
    let (before, now) = archive_clock();
    // The membership includes former-plan experts and all their descendants.
    store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,parent_session_id,created_at,updated_at) VALUES('gc-child','project','codex',?1,1,1)",[&study.session_id]).unwrap();
    store.conn.execute("INSERT INTO chat_turn_leases(chat_session_id,claim_token,heartbeat_at) VALUES('gc-child','busy',?1)",[now]).unwrap();
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .is_err());
    store
        .conn
        .execute(
            "DELETE FROM chat_turn_leases WHERE chat_session_id='gc-child'",
            [],
        )
        .unwrap();
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .is_ok());
}
#[cfg(unix)]
#[test]
fn archive_retention_refuses_linked_archives_and_linked_cache_directories() {
    let (dir, store, study, root, _) = snapshot_fixture();
    let hash = archive_orphan(&store, &study, &root);
    let (before, now) = archive_clock();
    let archive = store.archive_dir(&study).unwrap();
    let path = archive.join(format!("{hash}.zip"));
    let external = dir.path().join("retained-external");
    std::fs::rename(&path, &external).unwrap();
    std::os::unix::fs::symlink(&external, &path).unwrap();
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap()
        .candidates
        .is_empty());
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_file(archive.join("prepare.lock")).unwrap();
    std::fs::remove_dir(&archive).unwrap();
    std::os::unix::fs::symlink(dir.path(), &archive).unwrap();
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .is_err());
    assert!(external.exists());
}

#[test]
fn archive_retention_preserves_legacy_decisions_after_their_snapshot_pointer_is_lost() {
    let (_dir, store, study, root, _) = snapshot_fixture();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    let scope = prepared.scope.clone();
    let scope_hash = digest(scope.as_bytes());
    drop(prepared);
    let (before, now) = archive_clock();
    assert_eq!(
        store
            .archive_preview_at("project", &study.id, before, now)
            .unwrap()
            .candidates
            .len(),
        1
    );
    // An older database can retain a decision with no surviving snapshot pointer.
    store.conn.execute_batch("DROP TRIGGER research_archive_capture_update; DELETE FROM research_archive_migrations;").unwrap();
    store
        .research_update(&study.id, |s| {
            s.decisions.push(HumanDecision {
                id: "old-approval".into(),
                gate: "G4".into(),
                scope: scope.clone(),
                scope_hash: scope_hash.clone(),
                version: 1,
                status: "approved".into(),
                reason: None,
                approver: None,
                requested_at: 1,
                decided_at: Some(2),
            });
            Ok(())
        })
        .unwrap();
    archive_retention::migrate(&store.conn).unwrap();
    // A subsequent writer losing the old decision cannot erase its retention.
    store
        .research_update(&study.id, |s| {
            s.decisions.retain(|d| d.id != "old-approval");
            Ok(())
        })
        .unwrap();
    assert!(store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap()
        .candidates
        .is_empty());
    assert_eq!(store.conn.query_row("SELECT count(*) FROM research_archive_decision_scopes WHERE study_id=?1 AND scope_hash=?2",params![study.id,scope_hash],|r|r.get::<_,i64>(0)).unwrap(),1);
}
#[test]
fn archive_retention_pending_intents_block_legacy_scope_only_approvals() {
    let (_dir, store, study, root, _) = snapshot_fixture();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    let scope_hash = digest(prepared.scope.as_bytes());
    drop(prepared);
    let (before, now) = archive_clock();
    let preview = store
        .archive_preview_at("project", &study.id, before, now)
        .unwrap();
    let result = store.archive_apply_at(
        "project",
        &study.id,
        before,
        &preview.preview_hash,
        now,
        |stage| {
            if stage == "planned" {
                let mut body = serde_json::to_value(&study)?;
                body["decisions"] =
                    serde_json::json!([{"scopeHash":scope_hash,"status":"approved"}]);
                assert!(store
                    .conn
                    .execute(
                        "UPDATE research_studies SET document=?2 WHERE id=?1",
                        params![study.id, body.to_string()]
                    )
                    .is_err());
                return Err(anyhow!("interrupted before deletion"));
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(
        store
            .research_archive_recover("project", &study.id)
            .unwrap()["items"][0]["status"],
        "aborted"
    );
}
