// These fixtures model an already-verified immutable registry row. The actual
// register/file verification path is exercised separately by scientific_metrics_cli.
fn metric_claim_fixture() -> (TestDir, Store, Study, ClaimInput, String) {
    let (dir, store, study, mut input) = evidence_fixture();
    let commit = "b".repeat(40);
    let source = "a".repeat(64);
    store
        .conn
        .execute(
            "UPDATE runs SET commit_sha=?1,exit_code=0,backend_json=?2 WHERE id='evidence-run'",
            params![
                commit,
                serde_json::json!({"kind":"local_process","sourceDigest":source,"sourceSize":24})
                    .to_string()
            ],
        )
        .unwrap();
    let report = serde_json::json!({"schemaVersion":1,"runId":"evidence-run","experimentId":"exp","commitSha":commit,"sourceSha256":source,"data":{"kind":"none"},"series":[{"name":"accuracy","unit":"1","split":"validation","points":[{"step":0,"value":0.8},{"step":1,"value":0.9}]}]});
    let json=serde_json::json!({"schemaVersion":1,"projectId":"project","runId":"evidence-run","command":"","status":"done","sourceBytes":24,"reportSha256":"c".repeat(64),"measuredAt":1,"report":report}).to_string();
    let id = uuid::Uuid::new_v4().to_string();
    store.conn.execute("INSERT INTO scientific_metric_evidence(id,project_id,run_id,registered_at,producer_version,snapshot_sha256,inspection) VALUES(?1,'project','evidence-run',2,'synthetic-fixture',?2,?3)",params![id,digest(json.as_bytes()),json]).unwrap();
    store.research_set_plan(&study.id, plan()).unwrap();
    let study = store.research_study(&study.id).unwrap();
    input.metric = Some(MetricSelection {
        evidence_id: id,
        name: "accuracy".into(),
        split: "validation".into(),
        step: 1,
    });
    (dir, store, study, input, json)
}

#[test]
fn metric_citation_preserves_legacy_bytes_and_binds_one_exact_registered_point() {
    let (_dir, store, study, input, _json) = metric_claim_fixture();
    assert!(!serde_json::to_string(&study)
        .unwrap()
        .contains("metricCitation"));
    assert!(!serde_json::to_string(&inferred_claim("legacy"))
        .unwrap()
        .contains("metric"));
    store.research_add_claim(&study.id, input.clone()).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let c = saved.claims[0].metric_citation.as_ref().unwrap();
    assert_eq!(c.selection, input.metric.as_ref().unwrap().clone());
    assert_eq!(c.value, 0.9);
    assert_eq!(c.unit, "1");
    assert_eq!(saved.claims[0].excerpt.as_deref(), Some("result"));
    assert_eq!(saved.metric_citation_revision, Some(1));
    assert_eq!(
        store.research_study_view(&saved).unwrap()["evidenceReviewRequired"],
        true
    );
    let mut legacy = serde_json::to_value(&saved).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("metricCitationRevision");
    assert!(store
        .conn
        .execute(
            "UPDATE research_studies SET document=?2 WHERE id=?1",
            params![study.id, legacy.to_string()]
        )
        .is_err());
    let mut client = serde_json::to_value(&saved.claims[0].input).unwrap();
    client["metricCitation"] = serde_json::json!({"value":999});
    assert!(serde_json::from_value::<ClaimInput>(client).is_err());
}

#[test]
fn metric_citation_rejects_wrong_scope_series_step_identity_and_missing_log_without_append() {
    let (_dir, store, study, input, _json) = metric_claim_fixture();
    for mode in 0..8 {
        let mut bad = input.clone();
        match mode {
            0 => bad.metric.as_mut().unwrap().evidence_id = uuid::Uuid::new_v4().to_string(),
            1 => bad.metric.as_mut().unwrap().name = "loss".into(),
            2 => bad.metric.as_mut().unwrap().split = "train".into(),
            3 => bad.metric.as_mut().unwrap().step = 99,
            4 => bad.support = "inference".into(),
            5 => bad.run_id = None,
            6 => bad.line_start = None,
            _ => bad.metric.as_mut().unwrap().name = "x".repeat(65536),
        }
        assert!(
            store.research_add_claim(&study.id, bad).is_err(),
            "mode {mode}"
        );
    }
    let mut other = store.get_local_project("project").unwrap().unwrap();
    other.id = "other".into();
    other.slug = "other".into();
    store.create_local_project(&other).unwrap();
    store.conn.execute("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES('other-lead','other','codex',1,1)",[]).unwrap();
    let foreign = store
        .research_create("other-lead", "team", "foreign")
        .unwrap();
    assert!(store
        .research_add_claim(&foreign.id, input.clone())
        .is_err());
    // A self-consistent older/unknown snapshot without code size is still
    // unknown evidence, even when the current Run also lacks that size.
    let mut legacy: serde_json::Value = serde_json::from_str(&_json).unwrap();
    legacy.as_object_mut().unwrap().remove("sourceBytes");
    let body = legacy.to_string();
    let legacy_id = uuid::Uuid::new_v4().to_string();
    store.conn.execute("INSERT INTO scientific_metric_evidence(id,project_id,run_id,registered_at,producer_version,snapshot_sha256,inspection) VALUES(?1,'project','evidence-run',2,'synthetic-legacy',?2,?3)",params![legacy_id,digest(body.as_bytes()),body]).unwrap();
    store
        .conn
        .execute(
            "UPDATE runs SET backend_json=?1 WHERE id='evidence-run'",
            [
                serde_json::json!({"kind":"local_process","sourceDigest":"a".repeat(64)})
                    .to_string(),
            ],
        )
        .unwrap();
    let mut unknown = input.clone();
    unknown.metric.as_mut().unwrap().evidence_id = legacy_id;
    assert!(store.research_add_claim(&study.id, unknown).is_err());
    store
        .conn
        .execute(
            "UPDATE runs SET commit_sha=?1 WHERE id='evidence-run'",
            ["d".repeat(40)],
        )
        .unwrap();
    assert!(store.research_add_claim(&study.id, input).is_err());
    assert!(store.research_study(&study.id).unwrap().claims.is_empty());
}

#[test]
fn metric_citation_rechecks_run_and_rolls_back_failed_claim_commit() {
    let (_dir, store, study, input, _json) = metric_claim_fixture();
    let prepare = || {
        store.research_prepare_claim_with_reader(&study.id, input.clone(), |r, s, e| {
            evidence::scan_log(r, s, e)
        })
    };
    let prepared = prepare().unwrap();
    store
        .conn
        .execute(
            "UPDATE runs SET backend_json='{}' WHERE id='evidence-run'",
            [],
        )
        .unwrap();
    assert!(store.research_commit_claim(&study.id, prepared).is_err());
    store.conn.execute("UPDATE runs SET backend_json=?1 WHERE id='evidence-run'",[serde_json::json!({"kind":"local_process","sourceDigest":"a".repeat(64),"sourceSize":24}).to_string()]).unwrap();
    store.conn.execute_batch("CREATE TRIGGER reject_metric_claim BEFORE UPDATE ON research_studies WHEN json_extract(NEW.document,'$.metricCitationRevision')>0 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    assert!(store
        .research_commit_claim(&study.id, prepare().unwrap())
        .is_err());
    let saved = store.research_study(&study.id).unwrap();
    assert!(saved.claims.is_empty());
    assert!(saved.metric_citation_revision.is_none());
    store
        .conn
        .execute_batch("DROP TRIGGER reject_metric_claim")
        .unwrap();
    store
        .research_commit_claim(&study.id, prepare().unwrap())
        .unwrap();
}

#[test]
fn metric_citation_supersedes_delivery_requires_fresh_review_and_seals_snapshot_bytes() {
    use std::io::Read;
    let (_dir, store, study, input, json) = metric_claim_fixture();
    store.research_set_plan(&study.id, plan()).unwrap();
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
    store.research_add_claim(&study.id, input).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.decisions.last().unwrap().status, "superseded");
    assert!(store
        .research_prepare_delivery_at(&saved, _dir.path(), |_| Ok(()))
        .is_err());
    let view = store.research_study_view(&saved).unwrap();
    assert_eq!(
        view["staleReviewTaskIds"],
        serde_json::json!(["review", "audit"])
    );
    let mut revised = plan();
    revised
        .tasks
        .retain(|t| t.role != "as-independent-reviewer");
    assert!(store.research_set_plan(&study.id, revised).is_err());
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        let current = store.research_study(&study.id).unwrap();
        if current.task(task).unwrap().state == "completed" {
            continue;
        }
        bind(&store, &study, task, &format!("{task}-v2"));
        finish(&store, &study, task);
    }

    let saved = store.research_study(&study.id).unwrap();
    let prepared = store
        .research_prepare_delivery_at(&saved, _dir.path(), |_| Ok(()))
        .unwrap();
    let citation = saved.claims[0].metric_citation.as_ref().unwrap();
    request_snapshot(&store, &saved, &prepared);
    approve_snapshot(&store, &saved, prepared);
    let (archive, _) = store.research_download_package(&study.id).unwrap();
    let mut zip = zip::ZipArchive::new(archive).unwrap();
    let name = format!("scientific-metrics/{}.json", citation.selection.evidence_id);
    let mut bytes = vec![];
    zip.by_name(&name).unwrap().read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, json.as_bytes());
    assert_eq!(digest(&bytes), citation.snapshot_sha256);
    let mut manifest = vec![];
    zip.by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut manifest)
        .unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    assert!(manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["path"] == name && f["sha256"] == citation.snapshot_sha256));
    // Plain interpretations also change a metric-enabled evidence scope.
    store
        .research_add_claim(&study.id, inferred_claim("new interpretation"))
        .unwrap();
    let changed = store.research_study(&study.id).unwrap();
    assert_eq!(changed.metric_citation_revision, Some(1));
    assert_eq!(changed.decisions.last().unwrap().status, "superseded");
    assert!(store.research_download_package(&study.id).is_err());
}
