use super::*;
use crate::local::model::LocalProject;
use crate::store::material_reads::ReadFilter;

struct Fixture {
    root: PathBuf,
    materials: PathBuf,
    store: Store,
    package: Package,
}
impl Fixture {
    fn new(name: &str, bytes: &[u8]) -> Self {
        let root =
            std::env::temp_dir().join(format!("orx-reading-events-{}", uuid::Uuid::new_v4()));
        let store = Store::open_at(root.join("data")).unwrap();
        store
            .create_local_project(&LocalProject {
                id: "project".into(),
                name: "test".into(),
                slug: "test".into(),
                github_owner: "".into(),
                github_repo: "".into(),
                github_sync_enabled: false,
                baseline_branch: "main".into(),
                repo_path: root.to_string_lossy().into(),
                run_command: None,
                paper_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        let materials = root.join("materials");
        let package = create_at(&materials, "project").unwrap();
        upload_at(&materials, &package.id, "project", name, bytes).unwrap();
        let package = finalize_at(&materials, &package.id, "project").unwrap();
        Self {
            root,
            materials,
            store,
            package,
        }
    }
    async fn read(
        &self,
        offset: usize,
        limit: usize,
        page: Option<u32>,
    ) -> Result<serde_json::Value> {
        let context = self
            .store
            .material_read_context("project", None, &self.package.id)?;
        read_recorded_at(
            &self.store,
            context,
            ReadRequest {
                package: self.package.id.clone(),
                source: self.package.files[0].id.clone(),
                offset,
                limit,
                page,
            },
            &self.materials,
        )
        .await
    }
    fn events(&self) -> serde_json::Value {
        self.store
            .material_read_events("project", &ReadFilter::default(), 0, 200)
            .unwrap()
    }
    fn conn(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.root.join("data/orx.db")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn material_read_events_bind_exact_selection_and_survive_reopen_without_source_text() {
    let f = Fixture::new("notes.txt", "第一行\n秘密正文🙂\nthird\n".as_bytes());
    let result = f.read(2, 1, None).await.unwrap();
    assert_eq!(result["content"], "2: 秘密正文🙂\n");
    let events = f.events();
    let event = &events["events"][0];
    let receipt = &event["receipt"];
    assert_eq!(event["id"], result["readEventId"]);
    assert_eq!(event["outputState"], "pending");
    assert_eq!(receipt["sha256"], f.package.files[0].sha256);
    assert_eq!(receipt["verified"], true);
    assert_eq!(receipt["selection"]["lineCount"], 1);
    assert_eq!(receipt["selection"]["offset"], 2);
    assert_eq!(receipt["selection"]["nextOffset"], 3);
    assert_eq!(
        receipt["selection"]["contentBytes"],
        result["content"].as_str().unwrap().len()
    );
    assert_eq!(
        receipt["selection"]["contentSha256"],
        format!(
            "{:x}",
            Sha256::digest(result["content"].as_str().unwrap().as_bytes())
        )
    );
    assert!(!events.to_string().contains("秘密正文"));
    let mut output = Vec::new();
    crate::commands::materials::write_result(&f.store, "project", &result, &mut output).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output).unwrap(),
        result
    );
    let reopened = Store::open_at(f.root.join("data")).unwrap();
    let saved = reopened
        .material_read_events("project", &ReadFilter::default(), 0, 200)
        .unwrap();
    assert_eq!(saved["events"][0]["outputState"], "written");
    assert!(saved["events"][0]["outputAt"].is_i64());
    assert_eq!(saved["events"][0]["receipt"], *receipt);
}

#[tokio::test]
async fn material_read_events_keep_empty_and_byte_limited_outputs_honest() {
    let f = Fixture::new("empty.txt", b"");
    let result = f.read(1, 200, None).await.unwrap();
    assert_eq!(result["lineCount"], 0);
    assert_eq!(
        f.events()["events"][0]["receipt"]["selection"]["contentBytes"],
        0
    );
    let f = Fixture::new(
        "large.txt",
        format!("{}\n{}\n", "字".repeat(11000), "字".repeat(11000)).as_bytes(),
    );
    let result = f.read(1, 200, None).await.unwrap();
    assert_eq!(result["lineCount"], 1);
    assert_eq!(
        f.events()["events"][0]["receipt"]["selection"]["nextOffset"],
        2
    );
    assert_eq!(f.events()["events"][0]["receipt"]["requestedLimit"], 200);
}

#[tokio::test]
async fn material_read_events_record_verification_and_read_failures_without_coverage() {
    let f = Fixture::new("notes.txt", b"trusted\n");
    assert!(f
        .read(1, 1, Some(1))
        .await
        .unwrap_err()
        .to_string()
        .contains("仅用于 PDF"));
    let events = f.events();
    let event = &events["events"][0];
    assert_eq!(event["receipt"]["verified"], true);
    assert_eq!(event["receipt"]["outcome"], "failed");
    assert!(event["receipt"]["selection"].is_null());
    assert_eq!(event["outputState"], "notApplicable");
    let original = dir_at(&f.materials, &f.package.id)
        .unwrap()
        .join("originals/notes.txt");
    fs::write(original, b"changed\n").unwrap();
    assert!(f.read(1, 1, None).await.is_err());
    let events = f.events();
    let event = &events["events"][1];
    assert_eq!(event["receipt"]["verified"], false);
    assert!(event["receipt"]["selection"].is_null());
    let f = Fixture::new("image.png", b"\x89PNG\r\n\x1a\n");
    assert!(f
        .read(1, 1, None)
        .await
        .unwrap_err()
        .to_string()
        .contains("专用或视觉"));
    assert_eq!(f.events()["events"][0]["receipt"]["outcome"], "failed");
}

#[tokio::test]
async fn material_read_events_fail_closed_when_receipt_cannot_be_saved() {
    let f = Fixture::new("notes.txt", b"trusted\n");
    f.conn().execute_batch("CREATE TRIGGER reject_read_event BEFORE INSERT ON material_read_events BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;").unwrap();
    assert!(f
        .read(1, 1, None)
        .await
        .unwrap_err()
        .to_string()
        .contains("injected receipt failure"));
    assert!(f.events()["events"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn material_read_events_distinguish_partial_output_and_flush_failure() {
    struct Broken {
        flush: bool,
        wrote: bool,
    }
    impl std::io::Write for Broken {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.flush {
                Ok(bytes.len())
            } else if !self.wrote {
                self.wrote = true;
                Ok(bytes.len().min(7))
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "partial output",
                ))
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("flush failed"))
        }
    }
    let f = Fixture::new("notes.txt", b"trusted\n");
    for flush in [false, true] {
        let result = f.read(1, 1, None).await.unwrap();
        assert!(crate::commands::materials::write_result(
            &f.store,
            "project",
            &result,
            Broken {
                flush,
                wrote: false
            }
        )
        .is_err());
    }
    for event in f.events()["events"].as_array().unwrap() {
        assert_eq!(event["outputState"], "failed");
        assert_eq!(event["receipt"]["outcome"], "prepared");
        assert!(
            event["outputError"].as_str().unwrap().contains("failed")
                || event["outputError"].as_str().unwrap().contains("partial")
        );
    }
}

#[tokio::test]
async fn material_read_events_reject_unregistered_context_without_receipts() {
    let f = Fixture::new("notes.txt", b"trusted\n");
    let mut context = f
        .store
        .material_read_context("project", None, &f.package.id)
        .unwrap();
    context.project_id = "other".into();
    let request = || ReadRequest {
        package: f.package.id.clone(),
        source: f.package.files[0].id.clone(),
        offset: 1,
        limit: 1,
        page: None,
    };
    assert!(read_recorded_at(&f.store, context, request(), &f.materials)
        .await
        .is_err());
    let context = f
        .store
        .material_read_context("project", None, "other")
        .unwrap();
    assert!(read_recorded_at(&f.store, context, request(), &f.materials)
        .await
        .is_err());
    let context = f
        .store
        .material_read_context("project", None, &f.package.id)
        .unwrap();
    let mut missing = request();
    missing.source = "SRC-9999".into();
    assert!(
        read_recorded_at(&f.store, context.clone(), missing, &f.materials)
            .await
            .is_err()
    );
    let mut unsealed = f.package.clone();
    unsealed.ready = false;
    fs::write(
        dir_at(&f.materials, &f.package.id)
            .unwrap()
            .join("manifest.json"),
        serde_json::to_vec(&unsealed).unwrap(),
    )
    .unwrap();
    assert!(read_recorded_at(&f.store, context, request(), &f.materials)
        .await
        .is_err());
    assert!(f.events()["events"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn material_read_events_leave_output_pending_when_confirmation_fails() {
    let f = Fixture::new("notes.txt", b"trusted\n");
    let result = f.read(1, 1, None).await.unwrap();
    f.conn().execute_batch("CREATE TRIGGER reject_output BEFORE UPDATE ON material_read_events BEGIN SELECT RAISE(ABORT,'injected output receipt failure'); END;").unwrap();
    let mut bytes = Vec::new();
    assert!(
        crate::commands::materials::write_result(&f.store, "project", &result, &mut bytes).is_err()
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        result
    );
    assert_eq!(f.events()["events"][0]["outputState"], "pending");
}

#[tokio::test]
async fn material_read_events_keep_notebook_view_lines_and_pdf_failures_distinct() {
    let f = Fixture::new(
        "notes.ipynb",
        br#"{"cells":[{"cell_type":"markdown","source":["Notebook text"],"outputs":[]}]}"#,
    );
    let result = f.read(3, 2, None).await.unwrap();
    assert_eq!(
        result["content"],
        "3: ## Cell 1 (markdown)\n4: Notebook text\n"
    );
    assert_eq!(f.events()["events"][0]["receipt"]["format"], "notebook");
    assert_eq!(f.events()["events"][0]["receipt"]["selection"]["offset"], 3);
    let f = Fixture::new("paper.pdf", b"%PDF-fake");
    let error = f.read(1, 200, None).await.unwrap_err();
    assert!(error.to_string().contains("PDF 请指定"));
    let events = f.events();
    let receipt = &events["events"][0]["receipt"];
    assert_eq!(receipt["verified"], true);
    assert_eq!(receipt["outcome"], "failed");
    assert!(receipt["selection"].is_null());
}

#[tokio::test]
async fn material_read_coverage_deduplicates_written_ranges_and_excludes_other_outcomes() {
    let f = Fixture::new("notes.txt", b"one\ntwo\nthree\nfour\nfive\n");
    let filter = ReadFilter {
        package: Some(f.package.id.clone()),
        ..Default::default()
    };
    for (offset, limit) in [(1, 2), (2, 2), (5, 1), (1, 2)] {
        let result = f.read(offset, limit, None).await.unwrap();
        crate::commands::materials::write_result(&f.store, "project", &result, Vec::new()).unwrap();
    }
    let pending = f.read(4, 1, None).await.unwrap();
    let failed = f.read(4, 1, None).await.unwrap();
    f.store
        .material_read_output(
            "project",
            failed["readEventId"].as_str().unwrap(),
            Some("broken stream"),
        )
        .unwrap();
    assert!(f.read(9, 1, None).await.is_err());
    let before = f.events();
    let coverage = f.store.material_read_coverage("project", &filter).unwrap();
    assert_eq!(coverage["consideredEvents"], 7);
    assert_eq!(
        coverage["groups"][0]["ranges"],
        serde_json::json!([[1, 3], [5, 5]])
    );
    assert_eq!(coverage["groups"][0]["coveredLines"], 4);
    assert_eq!(coverage["groups"][0]["viewTotalLines"], 5);
    assert_eq!(
        coverage["groups"][0]["scope"]["view"]["textSha256"],
        format!("{:x}", Sha256::digest(b"one\ntwo\nthree\nfour\nfive\n"))
    );
    for key in ["outputPending", "outputFailed", "readFailed"] {
        assert_eq!(coverage["excluded"][key], 1);
    }
    assert_eq!(
        f.events(),
        before,
        "coverage never writes receipts or gates"
    );
    assert!(pending["view"]["parserVersion"].is_null());
    assert!(f
        .store
        .material_read_coverage("project", &ReadFilter::default())
        .is_err());
    assert!(f.store.material_read_coverage("other", &filter).is_err());
}

#[tokio::test]
async fn material_read_views_keep_legacy_unknown_and_separate_task_plan_and_parser_changes() {
    let f = Fixture::new("notes.txt", b"one\ntwo\nthree\n");
    let result = f.read(1, 1, None).await.unwrap();
    let receipt = f.events()["events"][0]["receipt"].clone();
    for variant in [
        "legacy", "parser", "producer", "plan", "task", "source", "page",
    ] {
        let mut receipt = receipt.clone();
        match variant {
            "legacy" => {
                receipt.as_object_mut().unwrap().remove("view");
            }
            "producer" => receipt["view"]["producerVersion"] = "next-version".into(),
            "parser" => receipt["view"]["textSha256"] = "c".repeat(64).into(),
            "plan" => receipt["context"]["planVersion"] = 2.into(),
            "task" => {
                receipt["context"]["studyId"] = "study".into();
                receipt["context"]["planVersion"] = 1.into();
                receipt["context"]["taskId"] = "worker".into();
                receipt["context"]["taskSessionId"] = "task-session".into();
            }
            "source" => receipt["sha256"] = "b".repeat(64).into(),
            // A PDF version is not enough without an observed executable hash.
            "page" => {
                receipt["format"] = "pdf".into();
                receipt["requestedPage"] = 1.into();
                receipt["selection"]["page"] = 1.into();
                receipt["view"]["parser"] = "pdftotext-layout".into();
                receipt["view"]["parserVersion"] = "22.12.0".into();
            }
            _ => unreachable!(),
        }
        let receipt: ReadReceipt = serde_json::from_value(receipt).unwrap();
        let id = f.store.record_material_read(&receipt).unwrap();
        f.store.material_read_output("project", &id, None).unwrap();
    }
    f.store
        .material_read_output("project", result["readEventId"].as_str().unwrap(), None)
        .unwrap();
    let coverage = f
        .store
        .material_read_coverage(
            "project",
            &ReadFilter {
                package: Some(f.package.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(coverage["groups"].as_array().unwrap().len(), 5);
    assert_eq!(coverage["excluded"]["unknownView"], 2);
    assert!(coverage["groups"]
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["producerVersions"].as_array().unwrap().len() == 2));
    assert!(coverage["groups"]
        .as_array()
        .unwrap()
        .iter()
        .all(|g| g["coveredLines"] == 1));
}

#[tokio::test]
async fn material_read_views_reject_stale_full_view_before_recording_prepared_replay() {
    let f = Fixture::new("notes.txt", b"one\ntwo\nthree\n");
    let result = f.read(1, 1, None).await.unwrap();
    let mut receipt = f.events()["events"][0]["receipt"].clone();
    receipt["view"]["textSha256"] = "a".repeat(64).into();
    let receipt: ReadReceipt = serde_json::from_value(receipt).unwrap();
    let event = f.store.record_material_read(&receipt).unwrap();
    f.store
        .material_read_output("project", &event, None)
        .unwrap();
    let citation = f.store.material_citation("project", &event).unwrap();
    let context = f
        .store
        .material_read_context("project", None, &f.package.id)
        .unwrap();
    let error = read_expected_at(
        &f.store,
        context,
        ReadRequest {
            package: f.package.id.clone(),
            source: f.package.files[0].id.clone(),
            offset: 1,
            limit: 1,
            page: None,
        },
        &f.materials,
        Some(&citation),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("完整视图"));
    let events = f.events();
    assert_eq!(events["events"][2]["receipt"]["outcome"], "failed");
    assert_eq!(events["events"][2]["outputState"], "notApplicable");
    assert!(result["view"]["textSha256"].is_string());
}

#[tokio::test]
async fn material_read_views_allow_cli_upgrade_when_parser_and_view_are_identical() {
    let f = Fixture::new("notes.txt", b"one\ntwo\nthree\n");
    f.read(1, 1, None).await.unwrap();
    let mut receipt = f.events()["events"][0]["receipt"].clone();
    receipt["view"]["producerVersion"] = "older-cli-version".into();
    let receipt: ReadReceipt = serde_json::from_value(receipt).unwrap();
    let event = f.store.record_material_read(&receipt).unwrap();
    f.store
        .material_read_output("project", &event, None)
        .unwrap();
    let citation = f.store.material_citation("project", &event).unwrap();
    let context = f
        .store
        .material_read_context("project", None, &f.package.id)
        .unwrap();
    let replay = read_expected_at(
        &f.store,
        context,
        ReadRequest {
            package: f.package.id.clone(),
            source: f.package.files[0].id.clone(),
            offset: 1,
            limit: 1,
            page: None,
        },
        &f.materials,
        Some(&citation),
    )
    .await
    .unwrap();
    assert_eq!(replay["content"], "1: one\n");
    assert_ne!(replay["view"]["producerVersion"], "older-cli-version");
}
