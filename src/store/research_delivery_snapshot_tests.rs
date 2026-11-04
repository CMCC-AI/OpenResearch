fn snapshot_fixture() -> (TestDir, Store, Study, PathBuf, String) {
    let (dir, store, study, root, event) = material_citation_fixture();
    store
        .research_commit_claim(
            &study.id,
            prepare_material_citation(&store, &study, &root, &event).unwrap(),
        )
        .unwrap();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        bind(&store, &study, task, task);
        finish(&store, &study, task);
    }
    let study = store.research_study(&study.id).unwrap();
    (dir, store, study, root, event)
}
fn request_snapshot(store: &Store, study: &Study, prepared: &PreparedDelivery) {
    store
        .research_update(&study.id, |s| {
            store.research_apply_delivery(s, prepared)?;
            s.request_gate("G4", prepared.scope.clone())
        })
        .unwrap();
}
fn approve_snapshot(store: &Store, study: &Study, prepared: PreparedDelivery) {
    let current = store.research_study(&study.id).unwrap();
    let decision = current.decisions.last().unwrap();
    store
        .research_commit_decision(
            &study.id,
            &decision.id,
            &decision.scope_hash,
            true,
            "verified archive".into(),
            Some(prepared),
        )
        .unwrap();
}

#[test]
fn delivery_snapshot_archives_verified_originals_and_is_stable_after_approval_and_end() {
    use std::io::Read;
    let (_dir, store, study, root, event) = snapshot_fixture();
    let first = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    let scope: serde_json::Value = serde_json::from_str(&first.scope).unwrap();
    assert_eq!(scope["materialSources"].as_array().unwrap().len(), 1);
    assert!(scope["deliveryBundle"]["sha256"].is_string());
    assert!(store.research_download_package(&study.id).is_err());
    request_snapshot(&store, &study, &first);
    assert!(store.research_download_package(&study.id).is_err());
    let second = store
        .research_prepare_delivery_at(&store.research_study(&study.id).unwrap(), &root, |_| Ok(()))
        .unwrap();
    assert_eq!(first.scope, second.scope);
    approve_snapshot(&store, &study, second);
    let (mut file, snapshot) = store.research_download_package(&study.id).unwrap();
    let mut bytes = vec![];
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(digest(&bytes), snapshot.archive.sha256);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    let archive_path = scope["materialSources"][0]["archivePath"].as_str().unwrap();
    let mut original = String::new();
    zip.by_name(archive_path)
        .unwrap()
        .read_to_string(&mut original)
        .unwrap();
    assert_eq!(original, "trusted source\nsecond line\n");
    let mut manifest = vec![];
    zip.by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut manifest)
        .unwrap();
    assert_eq!(digest(&manifest), snapshot.archive.manifest_sha256);
    let manifest: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    for item in manifest["files"].as_array().unwrap() {
        let mut content = vec![];
        zip.by_name(item["path"].as_str().unwrap())
            .unwrap()
            .read_to_end(&mut content)
            .unwrap();
        assert_eq!(digest(&content), item["sha256"]);
        assert_eq!(content.len() as u64, item["bytes"].as_u64().unwrap());
    }
    assert!(zip.by_name(&format!("read-receipts/{event}.json")).is_ok());
    let citation = store.material_citation("project", &event).unwrap();
    std::fs::remove_file(root.join(citation.package_id).join("originals/notes.txt")).unwrap();
    let (mut archived, again) = store.research_download_package(&study.id).unwrap();
    let mut unchanged = vec![];
    archived.read_to_end(&mut unchanged).unwrap();
    assert_eq!(bytes, unchanged);
    assert_eq!(snapshot, again);
    store.research_end(&study.id, 1, &[]).unwrap();
    assert!(store.research_download_package(&study.id).is_ok());
}

#[test]
fn delivery_snapshot_preparation_has_no_sqlite_transaction_and_rejects_racing_inputs() {
    let (dir, store, study, root, _event) = snapshot_fixture();
    let other = Store::open_at(dir.path().to_path_buf()).unwrap();
    other.set_busy_timeout(std::time::Duration::ZERO).unwrap();
    let mut wrote = false;
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| {
            if !wrote {
                other.research_add_claim(&study.id, inferred_claim("parallel observation"))?;
                wrote = true;
            }
            Ok(())
        })
        .unwrap();
    assert!(wrote);
    assert!(store
        .research_update(&study.id, |s| store.research_apply_delivery(s, &prepared))
        .is_err());
    let current = store.research_study(&study.id).unwrap();
    assert!(current.delivery_snapshot.is_none());
    assert!(!current.decisions.iter().any(|d| d.gate == "G4"));
    let tx = store.begin_immediate().unwrap();
    assert!(store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .err()
        .unwrap()
        .to_string()
        .contains("事务外"));
    drop(tx);
}

#[test]
fn delivery_snapshot_rechecks_material_files_and_manifest_at_the_commit_boundary() {
    for change in ["source", "manifest", "plan", "end"] {
        let (_dir, store, study, root, event) = snapshot_fixture();
        let prepared = store
            .research_prepare_delivery_at(&study, &root, |_| Ok(()))
            .unwrap();
        let citation = store.material_citation("project", &event).unwrap();
        match change {
            "source" => std::fs::write(
                root.join(&citation.package_id).join("originals/notes.txt"),
                b"changed\n",
            )
            .unwrap(),
            "manifest" => {
                std::fs::write(root.join(&citation.package_id).join("manifest.json"), b"{}")
                    .unwrap()
            }
            "plan" => store.research_set_plan(&study.id, plan()).unwrap(),
            "end" => {
                store.research_end(&study.id, 1, &[]).unwrap();
            }
            _ => unreachable!(),
        }
        let current = store.research_study(&study.id).unwrap();
        let result = store.research_update(&study.id, |s| {
            s.ensure_active()?;
            store.research_apply_delivery(s, &prepared)
        });
        assert!(result.is_err(), "{change}");
        assert_eq!(store.research_study(&study.id).unwrap(), current);
    }
}

#[test]
fn delivery_snapshot_rejects_cache_corruption_legacy_writers_and_active_historical_runs() {
    let (_dir, store, study, root, _event) = snapshot_fixture();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    request_snapshot(&store, &study, &prepared);
    approve_snapshot(&store, &study, prepared);
    let saved = store.research_study(&study.id).unwrap();
    let mut legacy = serde_json::to_value(&saved).unwrap();
    legacy.as_object_mut().unwrap().remove("deliverySnapshot");
    assert!(store
        .conn
        .execute(
            "UPDATE research_studies SET document=?1 WHERE id=?2",
            params![legacy.to_string(), study.id]
        )
        .unwrap_err()
        .to_string()
        .contains("支持快照"));
    store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('historical-active','exp','project','running','{\"kind\":\"local\"}',1,1)",[]).unwrap();
    store
        .research_update(&study.id, |s| {
            s.task_mut("design")?
                .previous_run_ids
                .push("historical-active".into());
            Ok(())
        })
        .unwrap();
    assert!(store
        .research_download_package(&study.id)
        .err()
        .unwrap()
        .to_string()
        .contains("未结束"));
    store
        .research_update(&study.id, |s| {
            s.task_mut("design")?.previous_run_ids.clear();
            Ok(())
        })
        .unwrap();
    store
        .conn
        .execute("DELETE FROM runs WHERE id='historical-active'", [])
        .unwrap();
    let snapshot = saved.delivery_snapshot.unwrap();
    let archive = store
        .research_root(&study)
        .unwrap()
        .parent()
        .unwrap()
        .join(".delivery-bundles")
        .join(&study.id)
        .join(format!("{}.zip", snapshot.archive.sha256));
    std::fs::write(archive, b"corrupted").unwrap();
    assert!(store.research_download_package(&study.id).is_err());
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .decisions
            .last()
            .unwrap()
            .status,
        "approved"
    );
}

#[test]
fn delivery_snapshot_failed_copy_cleans_temporary_archives_and_leaves_study_unchanged() {
    let (_dir, store, study, root, _event) = snapshot_fixture();
    assert!(store
        .research_prepare_delivery_at(&study, &root, |_| Err(anyhow!("injected storage failure")))
        .is_err());
    assert_eq!(store.research_study(&study.id).unwrap(), study);
    let path = store
        .research_root(&study)
        .unwrap()
        .parent()
        .unwrap()
        .join(".delivery-bundles")
        .join(&study.id);
    assert!(std::fs::read_dir(path).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".prepare-")));
}

#[test]
fn delivery_snapshot_preserves_legacy_scope_and_selected_runs_without_backend_configuration() {
    use std::io::Read;
    let (_dir, store, study) = delivery_scope_fixture();
    store.conn.execute("UPDATE runs SET command='private-command-token',backend_json='{\"kind\":\"local\",\"privateConfig\":\"private-backend-token\"}' WHERE id='current'",[]).unwrap();
    let completed = finish_delivery_scope(&store, &study);
    let legacy = store.research_package_scope(&completed).unwrap();
    let prepared = store.research_prepare_delivery(&completed).unwrap();
    assert_eq!(legacy, prepared.scope);
    request_snapshot(&store, &study, &prepared);
    approve_snapshot(&store, &study, prepared);
    let (mut file, _) = store.research_download_package(&study.id).unwrap();
    let mut bytes = vec![];
    file.read_to_end(&mut bytes).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("private-backend-token"));
    assert!(!String::from_utf8_lossy(&bytes).contains("private-command-token"));
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert!(zip.by_name("runs/current/log.txt").is_ok());
    assert!(zip.by_name("runs/historical/log.txt").is_err());
    assert!(zip.by_name("runs/previous/log.txt").is_err());
}

#[test]
fn delivery_snapshot_stale_approval_rolls_back_but_rejection_needs_no_originals() {
    let (_dir, store, study, root, event) = snapshot_fixture();
    let prepared = store
        .research_prepare_delivery_at(&study, &root, |_| Ok(()))
        .unwrap();
    request_snapshot(&store, &study, &prepared);
    let pending = store.research_study(&study.id).unwrap();
    let gate = pending.decisions.last().unwrap();
    let citation = store.material_citation("project", &event).unwrap();
    std::fs::remove_file(root.join(&citation.package_id).join("originals/notes.txt")).unwrap();
    assert!(store
        .research_commit_decision(
            &study.id,
            &gate.id,
            &gate.scope_hash,
            true,
            "stale".into(),
            Some(prepared)
        )
        .is_err());
    assert_eq!(store.research_study(&study.id).unwrap(), pending);
    assert!(store.research_download_package(&study.id).is_err());
    store
        .research_decide(
            &study.id,
            &gate.id,
            &gate.scope_hash,
            false,
            "original missing".into(),
        )
        .unwrap();
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .decisions
            .last()
            .unwrap()
            .status,
        "rejected"
    );
}
