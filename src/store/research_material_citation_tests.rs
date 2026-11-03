fn material_citation_fixture() -> (TestDir, Store, Study, PathBuf, String) {
    use crate::store::material_reads::ReadReceipt;
    let (dir, store, study) = setup();
    let package = uuid::Uuid::new_v4().to_string();
    let root = dir.path().join("materials");
    let path = root.join(&package);
    std::fs::create_dir_all(path.join("originals")).unwrap();
    let body = b"trusted source\nsecond line\n";
    std::fs::write(path.join("originals/notes.txt"), body).unwrap();
    let sha = digest(body);
    let manifest = serde_json::json!({"id":package,"projectId":"project","createdAt":1,"ready":true,"files":[{"id":"SRC-0001","path":"notes.txt","size":body.len(),"sha256":sha,"format":"text","status":"ready","note":null}]});
    std::fs::write(path.join("manifest.json"), manifest.to_string()).unwrap();
    store.research_set_plan(&study.id, plan()).unwrap();
    store
        .research_update(&study.id, |s| {
            s.plans[0].material_ids = Some(vec![package.clone()]);
            s.request_gate("G1", s.plan_scope()?)
        })
        .unwrap();
    let context = store
        .material_read_context("project", Some("lead"), &package)
        .unwrap();
    let content = "1: trusted source\n";
    let receipt = ReadReceipt {
        context,
        package_id: package,
        source: "SRC-0001".into(),
        path: "notes.txt".into(),
        sha256: sha,
        format: "text".into(),
        requested_offset: 1,
        requested_limit: 1,
        requested_page: None,
        verified: true,
        outcome: "prepared".into(),
        selection: Some(
            serde_json::json!({"page":null,"offset":1,"lineCount":1,"totalLines":2,"nextOffset":2,"contentBytes":content.len(),"contentSha256":digest(content.as_bytes())}),
        ),
        error: None,
        started_at: 1,
        recorded_at: 2,
    };
    let event = store.record_material_read(&receipt).unwrap();
    store.material_read_output("project", &event, None).unwrap();
    (dir, store, study, root, event)
}
fn material_claim_input(event: &str) -> ClaimInput {
    ClaimInput {
        text: "source says trusted source".into(),
        support: "paper".into(),
        source: "registered notes".into(),
        location: Some("line 1".into()),
        run_id: None,
        line_start: None,
        line_end: None,
        material_read_id: Some(event.into()),
    }
}
fn prepare_material_citation(
    store: &Store,
    study: &Study,
    root: &Path,
    event: &str,
) -> Result<evidence::PreparedClaim> {
    store.research_prepare_claim_with_root(
        &study.id,
        material_claim_input(event),
        root,
        |r, s, e| evidence::scan_log(r, s, e),
    )
}

#[test]
fn material_citation_claim_is_canonical_durable_and_legacy_hashes_stay_unchanged() {
    let (dir, store, study, root, event) = material_citation_fixture();
    let legacy = store.research_study(&study.id).unwrap();
    assert!(!serde_json::to_string(&legacy)
        .unwrap()
        .contains("materialCitationRevision"));
    assert!(!serde_json::to_string(&inferred_claim("legacy"))
        .unwrap()
        .contains("materialReadId"));
    let prepared = prepare_material_citation(&store, &study, &root, &event).unwrap();
    store.research_commit_claim(&study.id, prepared).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let canonical = saved.claims[0].material_citation.as_ref().unwrap();
    assert_eq!(canonical.read_event_id, event);
    assert_eq!(canonical.offset, 1);
    assert_eq!(canonical.line_count, 1);
    assert_eq!(canonical.reader_session_id.as_deref(), Some("lead"));
    assert_eq!(canonical.reader_plan_version, Some(1));
    assert_eq!(saved.material_citation_revision, Some(1));
    let reopened = Store::open_at(dir.path().to_path_buf()).unwrap();
    assert_eq!(reopened.research_study(&study.id).unwrap(), saved);
    let mut legacy_writer = serde_json::to_value(&saved).unwrap();
    legacy_writer
        .as_object_mut()
        .unwrap()
        .remove("materialCitationRevision");
    for claim in legacy_writer["claims"].as_array_mut().unwrap() {
        claim.as_object_mut().unwrap().remove("materialCitation");
        claim.as_object_mut().unwrap().remove("materialReadId");
    }
    assert!(store
        .conn
        .execute(
            "UPDATE research_studies SET document=?1 WHERE id=?2",
            params![legacy_writer.to_string(), study.id]
        )
        .unwrap_err()
        .to_string()
        .contains("支持材料引用"));
    assert_eq!(store.research_study(&study.id).unwrap(), saved);
}

#[test]
fn material_citation_claim_rechecks_plan_and_original_before_commit_without_partial_append() {
    for race in ["plan", "file", "end"] {
        let (_dir, store, study, root, event) = material_citation_fixture();
        let prepared = prepare_material_citation(&store, &study, &root, &event).unwrap();
        match race {
            "plan" => store.research_set_plan(&study.id, plan()).unwrap(),
            "file" => {
                let c = store.material_citation("project", &event).unwrap();
                std::fs::write(
                    root.join(c.package_id).join("originals/notes.txt"),
                    b"changed source\n",
                )
                .unwrap();
            }
            "end" => {
                store.research_end(&study.id, 1, &[]).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            store.research_commit_claim(&study.id, prepared).is_err(),
            "{race}"
        );
        let current = store.research_study(&study.id).unwrap();
        assert!(current.claims.is_empty());
        assert!(current.material_citation_revision.is_none());
    }
}

#[test]
fn material_citation_claim_rejects_foreign_pending_empty_and_changed_sources() {
    let (_dir, store, study, root, event) = material_citation_fixture();
    assert!(store.material_citation("other", &event).is_err());
    assert!(prepare_material_citation(&store, &study, &root, "missing").is_err());
    let raw: String = store
        .conn
        .query_row(
            "SELECT receipt FROM material_read_events WHERE id=?1",
            [&event],
            |r| r.get(0),
        )
        .unwrap();
    for mutation in ["pending", "failed", "empty", "badHash", "notVerified"] {
        let mut receipt: crate::store::material_reads::ReadReceipt =
            serde_json::from_str(&raw).unwrap();
        match mutation {
            "failed" => receipt.outcome = "failed".into(),
            "empty" => receipt.selection.as_mut().unwrap()["lineCount"] = 0.into(),
            "badHash" => receipt.selection.as_mut().unwrap()["contentSha256"] = "not-a-hash".into(),
            "notVerified" => receipt.verified = false,
            _ => (),
        }
        let id = store.record_material_read(&receipt).unwrap();
        if !matches!(mutation, "pending" | "failed") {
            store.material_read_output("project", &id, None).unwrap();
        }
        assert!(
            prepare_material_citation(&store, &study, &root, &id).is_err(),
            "{mutation}"
        );
    }
    let citation = store.material_citation("project", &event).unwrap();
    std::fs::write(
        root.join(citation.package_id).join("originals/notes.txt"),
        b"tampered\n",
    )
    .unwrap();
    assert!(prepare_material_citation(&store, &study, &root, &event).is_err());
    assert!(store.research_study(&study.id).unwrap().claims.is_empty());
}

#[test]
fn material_citation_claim_cannot_replace_required_experiment_run_evidence() {
    let (_dir, store, study, root, event) = material_citation_fixture();
    let mut input = material_claim_input(&event);
    input.support = "experiment".into();
    assert!(store
        .research_prepare_claim_with_root(&study.id, input, &root, |r, s, e| evidence::scan_log(
            r, s, e
        ))
        .is_err());
    assert!(store.research_study(&study.id).unwrap().claims.is_empty());
}

#[test]
fn material_citation_claim_invalidates_existing_delivery_and_binds_review_digest() {
    let (_dir, store, study, root, event) = material_citation_fixture();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        bind(&store, &study, task, task);
        finish(&store, &study, task);
    }
    let before = store.research_study(&study.id).unwrap();
    let scope = store.research_package_scope(&before).unwrap();
    store
        .research_update(&study.id, |s| s.request_gate("G4", scope))
        .unwrap();
    approve(&store, &study, "G4");
    store
        .research_commit_claim(
            &study.id,
            prepare_material_citation(&store, &study, &root, &event).unwrap(),
        )
        .unwrap();
    let after = store.research_study(&study.id).unwrap();
    assert_eq!(after.decisions.last().unwrap().status, "superseded");
    assert!(store
        .research_package_scope(&after)
        .unwrap_err()
        .to_string()
        .contains("重新审查"));
    let view = store.research_study_view(&after).unwrap();
    assert_eq!(view["evidenceReviewRequired"], true);
    assert_eq!(
        view["staleReviewTaskIds"],
        serde_json::json!(["review", "audit"])
    );
    // Current fixed-input validation also protects delivery from reusing an unrelated snapshot.
    let mut tampered = after.clone();
    tampered.claims[0]
        .material_citation
        .as_mut()
        .unwrap()
        .offset = 2;
    assert!(store
        .research_validate_material_claim(&tampered, &tampered.claims[0])
        .is_err());
}

#[test]
fn material_citation_claim_rolls_back_citation_revision_and_rejects_client_canonical_fields() {
    let (_dir, store, study, root, event) = material_citation_fixture();
    let before = store.research_study(&study.id).unwrap();
    store.conn.execute_batch("CREATE TRIGGER reject_material_save BEFORE UPDATE ON research_studies WHEN json_extract(NEW.document,'$.materialCitationRevision')>0 BEGIN SELECT RAISE(ABORT,'injected material save failure'); END;").unwrap();
    let prepared = prepare_material_citation(&store, &study, &root, &event).unwrap();
    assert!(store.research_commit_claim(&study.id, prepared).is_err());
    assert_eq!(store.research_study(&study.id).unwrap(), before);
    store
        .conn
        .execute_batch("DROP TRIGGER reject_material_save")
        .unwrap();
    store
        .research_commit_claim(
            &study.id,
            prepare_material_citation(&store, &study, &root, &event).unwrap(),
        )
        .unwrap();
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .material_citation_revision,
        Some(1)
    );
    let mut input = serde_json::to_value(material_claim_input(&event)).unwrap();
    input["materialCitation"] = serde_json::json!({"sha256":"client supplied"});
    assert!(serde_json::from_value::<ClaimInput>(input).is_err());
}
