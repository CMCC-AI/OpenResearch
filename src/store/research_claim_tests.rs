fn claim_amendment(value: serde_json::Value) -> ClaimAmendmentInput {
    serde_json::from_value(value).unwrap()
}
fn inferred_claim(text: &str) -> ClaimInput {
    ClaimInput {
        text: text.into(),
        support: "inference".into(),
        source: "analysis".into(),
        location: None,
        run_id: None,
        line_start: None,
        line_end: None,
        material_read_id: None,
        metric: None,
    }
}
fn claim_change_count(store: &Store, study: &Study) -> i64 {
    store
        .conn
        .query_row(
            "SELECT count(*) FROM research_claim_changes WHERE study_id=?1",
            [&study.id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn claim_amendments_keep_legacy_bytes_hashes_and_views_until_first_change() {
    let (dir, store, study) = setup();
    store
        .research_add_claim(&study.id, inferred_claim("original interpretation"))
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert!(saved.claim_revision.is_none());
    assert_eq!(
        store.research_evidence(&saved).unwrap().digest().unwrap(),
        digest(&serde_json::to_vec(&saved.claims).unwrap())
    );
    assert_eq!(
        store.research_study_view(&saved).unwrap(),
        serde_json::to_value(&saved).unwrap()
    );
    let before: String = store
        .conn
        .query_row(
            "SELECT document FROM research_studies WHERE id=?1",
            [&study.id],
            |r| r.get(0),
        )
        .unwrap();
    let reopened = Store::open_at(dir.path().to_path_buf()).unwrap();
    let after: String = reopened
        .conn
        .query_row(
            "SELECT document FROM research_studies WHERE id=?1",
            [&study.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert!(!after.contains("claimRevision"));
}

#[test]
fn claim_amendments_withdraw_preserves_history_and_requires_new_independent_review() {
    let (_dir, store, study, input) = evidence_fixture();
    store
        .conn
        .execute(
            "UPDATE runs SET backend_json='{\"kind\":\"local\"}' WHERE id='evidence-run'",
            [],
        )
        .unwrap();
    store.research_add_claim(&study.id, input).unwrap();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        bind(&store, &study, task, task);
        finish(&store, &study, task);
    }
    let before = store.research_study(&study.id).unwrap();
    let old_claim = before.claims[0].clone();
    let old_scope = store.research_package_scope(&before).unwrap();
    store
        .research_update(&study.id, |s| s.request_gate("G4", old_scope.clone()))
        .unwrap();
    approve(&store, &study, "G4");
    let original_decision = store
        .research_study(&study.id)
        .unwrap()
        .decisions
        .last()
        .unwrap()
        .clone();
    let input = serde_json::json!({"action":"withdraw","version":1,"revision":0,"reason":"calibration invalidates this interpretation"});
    let receipt = store
        .research_amend_claim(
            &study.id,
            "lead",
            &old_claim.id,
            claim_amendment(input.clone()),
        )
        .unwrap();
    let amended = store.research_study(&study.id).unwrap();
    assert_eq!(amended.claims, vec![old_claim.clone()]);
    assert_eq!(amended.claim_revision, Some(1));
    let old_decision = amended
        .decisions
        .iter()
        .find(|d| d.id == original_decision.id)
        .unwrap();
    assert_eq!(old_decision.scope, old_scope);
    assert_eq!(old_decision.status, "superseded");
    let view = store.research_study_view(&amended).unwrap();
    assert_eq!(view["activeClaimIds"], serde_json::json!([]));
    assert_eq!(view["claimChanges"][0]["action"], "withdrawn");
    assert_eq!(view["evidenceReviewRequired"], true);
    assert_eq!(
        view["staleReviewTaskIds"],
        serde_json::json!(["review", "audit"])
    );
    assert_eq!(
        store
            .research_amend_claim(&study.id, "lead", &old_claim.id, claim_amendment(input))
            .unwrap(),
        receipt
    );
    assert_eq!(claim_change_count(&store, &study), 1);
    assert!(store
        .research_decide(
            &study.id,
            &original_decision.id,
            &original_decision.scope_hash,
            true,
            "old click".into()
        )
        .is_err());
    std::fs::remove_file(store.research_log_path("evidence-run").unwrap()).unwrap();
    assert!(store
        .research_package_scope(&amended)
        .unwrap_err()
        .to_string()
        .contains("重新审查"));
    store.research_set_plan(&study.id, plan()).unwrap();
    let next = store.research_study(&study.id).unwrap();
    assert_eq!(next.task("design").unwrap().state, "completed");
    assert_eq!(next.task("review").unwrap().state, "pending");
    assert_eq!(next.task("audit").unwrap().state, "pending");
    approve(&store, &study, "G1");
    for task in ["review", "audit"] {
        bind(&store, &study, task, &format!("{task}-v2"));
        finish(&store, &study, task);
        if task == "review" {
            let current = store.research_study(&study.id).unwrap();
            assert_eq!(
                store.research_study_view(&current).unwrap()["staleReviewTaskIds"],
                serde_json::json!(["audit"])
            );
        }
    }
    let reviewed = store.research_study(&study.id).unwrap();
    let scope: serde_json::Value =
        serde_json::from_str(&store.research_package_scope(&reviewed).unwrap()).unwrap();
    assert_eq!(scope["claims"], serde_json::json!([]));
    assert_eq!(scope["runs"], serde_json::json!([]));
    assert_eq!(scope["claimChanges"].as_array().unwrap().len(), 1);
    assert_eq!(
        store.research_study_view(&reviewed).unwrap()["evidenceReviewRequired"],
        false
    );
    assert_eq!(store.research_runs(&reviewed).unwrap().len(), 1);
    crate::commands::research_dispatch::reconcile_active_studies(&store).unwrap();
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .decisions
            .last()
            .unwrap()
            .status,
        "pending"
    );
    approve(&store, &study, "G4");
    store
        .conn
        .execute(
            "UPDATE runs SET status='running' WHERE id='evidence-run'",
            [],
        )
        .unwrap();
    assert!(store
        .research_package_scope(&reviewed)
        .unwrap_err()
        .to_string()
        .contains("未结束"));
}

#[test]
fn claim_amendments_replacement_chain_is_atomic_durable_and_idempotent() {
    let (dir, store, study) = setup();
    store
        .research_add_claim(&study.id, inferred_claim("first"))
        .unwrap();
    let original = store.research_study(&study.id).unwrap().claims[0].clone();
    let replacement = serde_json::json!({"action":"replace","version":0,"revision":0,"reason":"correct the assumption","replacement":inferred_claim("second")});
    let first = store
        .research_amend_claim(
            &study.id,
            "lead",
            &original.id,
            claim_amendment(replacement.clone()),
        )
        .unwrap();
    let next_id = first.replacement_id.clone().unwrap();
    assert_eq!(store.research_study(&study.id).unwrap().claims[0], original);
    let reopened = Store::open_at(dir.path().to_path_buf()).unwrap();
    assert_eq!(
        reopened
            .research_amend_claim(
                &study.id,
                "lead",
                &original.id,
                claim_amendment(replacement)
            )
            .unwrap(),
        first
    );
    assert_eq!(reopened.research_study(&study.id).unwrap().claims.len(), 2);
    let second=store.research_amend_claim(&study.id,"lead",&next_id,claim_amendment(serde_json::json!({"action":"replace","version":0,"revision":1,"reason":"more evidence","replacement":inferred_claim("third")}))).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.claims.len(), 3);
    assert_eq!(
        store.research_study_view(&saved).unwrap()["activeClaimIds"],
        serde_json::json!([second.replacement_id.unwrap()])
    );
    assert_eq!(claim_change_count(&store, &study), 2);
}

#[test]
fn claim_amendments_reject_unauthorized_stale_malformed_and_failed_replacements() {
    let (_dir, store, study) = setup();
    store
        .research_add_claim(&study.id, inferred_claim("first"))
        .unwrap();
    let before = store.research_study(&study.id).unwrap();
    let claim = &before.claims[0].id;
    for (actor, target, version, revision, reason) in [
        ("expert", claim.as_str(), 0, 0, "reason"),
        ("lead", "missing", 0, 0, "reason"),
        ("lead", claim, 1, 0, "reason"),
        ("lead", claim, 0, 1, "reason"),
        ("lead", claim, 0, 0, " "),
    ] {
        assert!(store.research_amend_claim(&study.id,actor,target,claim_amendment(serde_json::json!({"action":"withdraw","version":version,"revision":revision,"reason":reason}))).is_err());
    }
    let mut invalid = inferred_claim("bad");
    invalid.support = "experiment".into();
    assert!(store.research_amend_claim(&study.id,"lead",claim,claim_amendment(serde_json::json!({"action":"replace","version":0,"revision":0,"reason":"replace","replacement":invalid}))).is_err());
    assert_eq!(store.research_study(&study.id).unwrap(), before);
    assert_eq!(claim_change_count(&store, &study), 0);
    for bad in [
        serde_json::json!({"action":"withdraw","version":0,"reason":"missing revision"}),
        serde_json::json!({"action":"replace","version":0,"revision":0,"reason":"missing replacement"}),
        serde_json::json!({"action":"withdraw","version":0,"revision":0,"reason":"actor injection","actor":"lead"}),
    ] {
        assert!(serde_json::from_value::<ClaimAmendmentInput>(bad).is_err());
    }
    store.research_end(&study.id, 0, &[]).unwrap();
    assert!(store
        .research_amend_claim(
            &study.id,
            "lead",
            claim,
            claim_amendment(
                serde_json::json!({"action":"withdraw","version":0,"revision":0,"reason":"closed"})
            )
        )
        .is_err());
}

#[test]
fn claim_amendments_rollback_both_receipt_and_replacement_when_aggregate_write_fails() {
    let (_dir, store, study) = setup();
    store
        .research_add_claim(&study.id, inferred_claim("first"))
        .unwrap();
    let before = store.research_study(&study.id).unwrap();
    let claim = &before.claims[0].id;
    store.conn.execute_batch("CREATE TRIGGER fail_claim_save BEFORE UPDATE ON research_studies WHEN json_extract(NEW.document,'$.claimRevision')>0 BEGIN SELECT RAISE(ABORT,'injected save failure'); END;").unwrap();
    let input = serde_json::json!({"action":"replace","version":0,"revision":0,"reason":"correction","replacement":inferred_claim("second")});
    assert!(store
        .research_amend_claim(&study.id, "lead", claim, claim_amendment(input.clone()))
        .is_err());
    assert_eq!(claim_change_count(&store, &study), 0);
    assert_eq!(store.research_study(&study.id).unwrap(), before);
    store
        .conn
        .execute_batch("DROP TRIGGER fail_claim_save")
        .unwrap();
    assert_eq!(
        store
            .research_amend_claim(&study.id, "lead", claim, claim_amendment(input))
            .unwrap()
            .revision,
        1
    );
}

#[test]
fn claim_amendments_guard_legacy_writers_and_keep_audit_rows_immutable() {
    let (_dir, store, study) = setup();
    store
        .research_add_claim(&study.id, inferred_claim("first"))
        .unwrap();
    let claim = store.research_study(&study.id).unwrap().claims[0]
        .id
        .clone();
    store.research_amend_claim(&study.id,"lead",&claim,claim_amendment(serde_json::json!({"action":"withdraw","version":0,"revision":0,"reason":"wrong assumption"}))).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let mut legacy = serde_json::to_value(&saved).unwrap();
    legacy.as_object_mut().unwrap().remove("claimRevision");
    assert!(store
        .conn
        .execute(
            "UPDATE research_studies SET document=?1 WHERE id=?2",
            params![legacy.to_string(), study.id]
        )
        .unwrap_err()
        .to_string()
        .contains("支持声明修订"));
    assert!(store
        .conn
        .execute(
            "UPDATE research_claim_changes SET reason='overwrite' WHERE study_id=?1",
            [&study.id]
        )
        .is_err());
    assert!(store
        .conn
        .execute(
            "DELETE FROM research_claim_changes WHERE study_id=?1",
            [&study.id]
        )
        .is_err());
    assert_eq!(store.research_study(&study.id).unwrap(), saved);
    // Explicit project deletion can still cascade; this is not a hidden retention lock.
    store
        .conn
        .execute("DELETE FROM local_projects WHERE id='project'", [])
        .unwrap();
    assert_eq!(claim_change_count(&store, &study), 0);
}

#[test]
fn claim_amendments_recheck_revision_after_replacement_capture_without_a_write_lock() {
    let (dir, store, study, input) = evidence_fixture();
    store.research_add_claim(&study.id, input.clone()).unwrap();
    store
        .research_add_claim(&study.id, inferred_claim("other"))
        .unwrap();
    let before = store.research_study(&study.id).unwrap();
    let first = before.claims[0].id.clone();
    let other_claim = before.claims[1].id.clone();
    let other = Store::open_at(dir.path().to_path_buf()).unwrap();
    other.set_busy_timeout(std::time::Duration::ZERO).unwrap();
    let result=store.research_amend_claim_with_reader(&study.id,"lead",&first,claim_amendment(serde_json::json!({"action":"replace","version":0,"revision":0,"reason":"replace log claim","replacement":input})),|reader,start,end| {
        other.research_amend_claim(&study.id,"lead",&other_claim,claim_amendment(serde_json::json!({"action":"withdraw","version":0,"revision":0,"reason":"parallel correction"})))?;
        evidence::scan_log(reader,start,end)
    });
    assert!(result.unwrap_err().to_string().contains("版本已变化"));
    assert_eq!(
        store.research_study(&study.id).unwrap().claims,
        before.claims
    );
    assert_eq!(claim_change_count(&store, &study), 1);
}

#[test]
fn claim_amendments_proposal_cannot_skip_review_or_reuse_approved_g3() {
    let (_dir, store, mut study) = setup();
    study.mode = "proposal".into();
    store.research_save(&study).unwrap();
    store
        .research_add_claim(&study.id, inferred_claim("assumption"))
        .unwrap();
    store
        .research_set_plan(&study.id, preset_plan("proposal"))
        .unwrap();
    approve(&store, &study, "G1");
    let before = store.research_study(&study.id).unwrap();
    for task in &before.plan().unwrap().tasks {
        bind(&store, &study, &task.spec.id, &task.spec.id);
        finish(&store, &study, &task.spec.id);
    }
    let before = store.research_study(&study.id).unwrap();
    let scope = store.research_package_scope(&before).unwrap();
    store
        .research_update(&study.id, |s| s.request_gate("G3", scope))
        .unwrap();
    approve(&store, &study, "G3");
    store.research_amend_claim(&study.id, "lead", &before.claims[0].id, claim_amendment(serde_json::json!({"action":"withdraw","version":1,"revision":0,"reason":"invalid assumption"}))).unwrap();
    let changed = store.research_study(&study.id).unwrap();
    assert_eq!(changed.decisions.last().unwrap().status, "superseded");
    assert_eq!(
        store.research_study_view(&changed).unwrap()["evidenceReviewRequired"],
        true
    );
    assert!(store
        .research_package_scope(&changed)
        .unwrap_err()
        .to_string()
        .contains("独立审稿"));
    assert!(store
        .research_set_plan(&study.id, preset_plan("proposal"))
        .is_err());
    let mut revised = preset_plan("proposal");
    let deps: Vec<_> = revised.tasks.iter().map(|t| t.id.clone()).collect();
    let refs: Vec<_> = deps.iter().map(String::as_str).collect();
    revised
        .tasks
        .push(spec("new-review", "as-independent-reviewer", &refs));
    revised.tasks.push(spec(
        "new-audit",
        "as-quality-citation-auditor",
        &["new-review"],
    ));
    store.research_set_plan(&study.id, revised).unwrap();
    approve(&store, &study, "G1");
    for id in ["new-review", "new-audit"] {
        bind(&store, &study, id, id);
        finish(&store, &study, id);
    }
    let reviewed = store.research_study(&study.id).unwrap();
    assert!(store.research_package_scope(&reviewed).is_ok());
}

#[test]
fn claim_amendments_recheck_plan_end_and_run_after_capture_and_retry_parallel_duplicate() {
    for event in ["plan", "end", "run", "duplicate"] {
        let (dir, store, study, input) = evidence_fixture();
        store.research_add_claim(&study.id, input.clone()).unwrap();
        let before = store.research_study(&study.id).unwrap();
        let target = &before.claims[0].id;
        let other = Store::open_at(dir.path().to_path_buf()).unwrap();
        other.set_busy_timeout(std::time::Duration::ZERO).unwrap();
        let request = serde_json::json!({"action":"replace","version":0,"revision":0,"reason":"correction","replacement":input});
        let mut parallel = None;
        let result = store.research_amend_claim_with_reader(
            &study.id,
            "lead",
            target,
            claim_amendment(request.clone()),
            |reader, start, end| {
                match event {
                    "plan" => other.research_set_plan(&study.id, plan())?,
                    "end" => {
                        other.research_end(&study.id, 0, &[])?;
                    }
                    "run" => {
                        other.conn.execute(
                            "UPDATE runs SET commit_sha='changed' WHERE id='evidence-run'",
                            [],
                        )?;
                    }
                    "duplicate" => {
                        parallel = Some(other.research_amend_claim(
                            &study.id,
                            "lead",
                            target,
                            claim_amendment(request),
                        )?);
                    }
                    _ => unreachable!(),
                }
                evidence::scan_log(reader, start, end)
            },
        );
        if event == "duplicate" {
            assert_eq!(Some(result.unwrap()), parallel);
            assert_eq!(store.research_study(&study.id).unwrap().claims.len(), 2);
            assert_eq!(claim_change_count(&store, &study), 1);
        } else {
            assert!(result.is_err(), "{event}");
            assert_eq!(
                store.research_study(&study.id).unwrap().claims,
                before.claims
            );
            assert_eq!(claim_change_count(&store, &study), 0);
        }
    }
}

#[test]
fn claim_amendments_keep_current_task_run_logs_required_after_withdrawal() {
    let (_dir, store, study) = delivery_scope_fixture();
    store
        .research_add_claim(
            &study.id,
            ClaimInput {
                text: "interpretation".into(),
                support: "experiment".into(),
                source: "current log".into(),
                location: None,
                run_id: Some("current".into()),
                line_start: Some(1),
                line_end: Some(1),
                material_read_id: None,
                metric: None,
            },
        )
        .unwrap();
    let before = finish_delivery_scope(&store, &study);
    store.research_amend_claim(&study.id, "lead", &before.claims[0].id, claim_amendment(serde_json::json!({"action":"withdraw","version":2,"revision":0,"reason":"interpretation unsupported"}))).unwrap();
    let mut revised = plan();
    revised.tasks[0].brief = "use the revised dataset".into();
    store.research_set_plan(&study.id, revised).unwrap();
    approve(&store, &study, "G1");
    for id in ["review", "audit"] {
        bind(&store, &study, id, &format!("{id}-v3"));
        finish(&store, &study, id);
    }
    let reviewed = store.research_study(&study.id).unwrap();
    let scope: serde_json::Value =
        serde_json::from_str(&store.research_package_scope(&reviewed).unwrap()).unwrap();
    assert_eq!(scope["claims"], serde_json::json!([]));
    assert_eq!(scope["runs"][0]["id"], "current");
    std::fs::remove_file(store.research_log_path("current").unwrap()).unwrap();
    assert!(store.research_package_scope(&reviewed).is_err());
}
