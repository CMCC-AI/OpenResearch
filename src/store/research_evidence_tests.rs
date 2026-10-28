fn evidence_fixture() -> (TestDir, Store, Study, ClaimInput) {
    let (dir, store, study) = setup();
    store.conn.execute("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at,commit_sha) VALUES('evidence-run','exp','project','done','{}',1,2,'abc')", []).unwrap();
    let path = store.research_log_path("evidence-run").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, b"first\r\nresult\r\nlast\n").unwrap();
    let input = ClaimInput {
        text: "observed result".into(),
        support: "experiment".into(),
        source: "run log".into(),
        location: None,
        run_id: Some("evidence-run".into()),
        line_start: Some(2),
        line_end: Some(2),
    };
    (dir, store, study, input)
}

#[test]
fn evidence_stream_preserves_line_and_hash_semantics_across_read_boundaries() {
    struct ShortRead<'a>(&'a [u8]);
    impl std::io::Read for ShortRead<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let n = buffer.len().min(1);
            std::io::Read::read(&mut self.0, &mut buffer[..n])
        }
    }
    for bytes in [
        b"\n".as_slice(),
        b"\r\n\nlast",
        "头\r\n结果🙂\n结尾\r".as_bytes(),
        b"a\xff\xfe\r\nb\n\n",
        b"last\r",
        b"\xff\nend\n",
    ] {
        let decoded = String::from_utf8_lossy(bytes);
        let lines: Vec<_> = decoded.lines().collect();
        for start in 1..=lines.len() {
            for end in start..=lines.len() {
                let (hash, excerpt) = evidence::scan_log(ShortRead(bytes), start, end).unwrap();
                assert_eq!(hash, digest(bytes));
                assert_eq!(excerpt, lines[start - 1..end].join("\n"));
            }
        }
    }
    for (start, end) in [(0, 1), (2, 1), (1, 202), (usize::MAX, 0)] {
        struct Unread;
        impl std::io::Read for Unread {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                panic!("invalid ranges must not read")
            }
        }
        assert!(evidence::scan_log(Unread, start, end).is_err());
    }
    assert!(evidence::scan_log(&b""[..], 1, 1).is_err());
    assert!(evidence::scan_log(&b"a\n"[..], 2, 2).is_err());
    let lines = "x\n".repeat(201);
    assert!(evidence::scan_log(lines.as_bytes(), 1, 201).is_ok());
}

#[test]
fn evidence_stream_bounds_selected_bytes_and_hashes_huge_unselected_lines() {
    use std::io::Read;
    let reader = std::io::repeat(b'x')
        .take(2 * 1024 * 1024)
        .chain(std::io::Cursor::new(b"\nselected\n"))
        .chain(std::io::repeat(b'z').take(3 * 1024 * 1024));
    let (hash, excerpt) = evidence::scan_log(reader, 2, 2).unwrap();
    let mut expected = Sha256::new();
    for _ in 0..512 {
        expected.update([b'x'; 4096]);
    }
    expected.update(b"\nselected\n");
    for _ in 0..768 {
        expected.update([b'z'; 4096]);
    }
    assert_eq!(hash, format!("{:x}", expected.finalize()));
    assert_eq!(excerpt, "selected");
    struct Counted(usize);
    impl Read for Counted {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.0 += buffer.len();
            buffer.fill(b'x');
            Ok(buffer.len())
        }
    }
    let mut infinite_line = Counted(0);
    assert!(evidence::scan_log(&mut infinite_line, 1, 1)
        .unwrap_err()
        .to_string()
        .contains("64 KiB"));
    assert!(infinite_line.0 <= 2 * evidence::MAX_EXCERPT_BYTES);
    let expanded = vec![0xff; evidence::MAX_EXCERPT_BYTES / 2];
    assert!(evidence::scan_log(expanded.as_slice(), 1, 1).is_err());
    let boundary = vec![b'x'; evidence::MAX_EXCERPT_BYTES];
    assert!(evidence::scan_log(boundary.as_slice(), 1, 1).is_ok());
}

#[test]
fn evidence_capture_allows_concurrent_writes_and_preserves_new_claims() {
    let (dir, store, study, input) = evidence_fixture();
    let other = Store::open_at(dir.path().to_path_buf()).unwrap();
    other.set_busy_timeout(std::time::Duration::ZERO).unwrap();
    let prepared = store
        .research_prepare_claim_with_reader(&study.id, input, |reader, start, end| {
            // This would fail immediately if log reading held BEGIN IMMEDIATE.
            other.research_add_claim(
                &study.id,
                ClaimInput {
                    text: "independent inference".into(),
                    support: "inference".into(),
                    source: "analysis".into(),
                    location: None,
                    run_id: None,
                    line_start: None,
                    line_end: None,
                },
            )?;
            evidence::scan_log(reader, start, end)
        })
        .unwrap();
    store.research_commit_claim(&study.id, prepared).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.claims.len(), 2);
    assert_eq!(saved.claims[0].input.text, "independent inference");
    assert_eq!(saved.claims[1].excerpt.as_deref(), Some("result"));
    assert_eq!(saved.claims[1].commit_sha.as_deref(), Some("abc"));
    assert_eq!(
        saved.claims[1].log_sha256.as_deref(),
        Some(digest(b"first\r\nresult\r\nlast\n").as_str())
    );
}

#[test]
fn evidence_commit_rejects_changed_run_study_or_log_without_appending() {
    for case in [
        "stopped",
        "run-commit",
        "run-project",
        "log-append",
        "log-replace",
    ] {
        let (_dir, store, study, input) = evidence_fixture();
        let prepared = store
            .research_prepare_claim_with_reader(&study.id, input, |r, s, e| {
                evidence::scan_log(r, s, e)
            })
            .unwrap();
        match case {
            "stopped" => store
                .research_update(&study.id, |s| {
                    s.status = "stopped".into();
                    Ok(())
                })
                .unwrap(),
            "run-commit" => {
                store
                    .conn
                    .execute(
                        "UPDATE runs SET commit_sha='new' WHERE id='evidence-run'",
                        [],
                    )
                    .unwrap();
            }
            "run-project" => {
                store
                    .conn
                    .execute(
                        "UPDATE runs SET project_id='other' WHERE id='evidence-run'",
                        [],
                    )
                    .unwrap();
            }
            "log-append" => {
                use std::io::Write;
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(store.research_log_path("evidence-run").unwrap())
                    .unwrap()
                    .write_all(b"appended\n")
                    .unwrap();
            }
            "log-replace" => {
                let path = store.research_log_path("evidence-run").unwrap();
                std::fs::rename(&path, path.with_extension("old")).unwrap();
                std::fs::write(path, b"first\r\nresult\r\nlast\n").unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            store.research_commit_claim(&study.id, prepared).is_err(),
            "{case}"
        );
        assert!(
            store.research_study(&study.id).unwrap().claims.is_empty(),
            "{case}"
        );
    }
}

#[test]
fn evidence_capture_rejects_mutating_log_and_oversized_inputs_without_writes() {
    let (_dir, store, study, input) = evidence_fixture();
    let before = serde_json::to_value(store.research_study(&study.id).unwrap()).unwrap();
    let path = store.research_log_path("evidence-run").unwrap();
    assert!(store
        .research_prepare_claim_with_reader(&study.id, input.clone(), |r, s, e| {
            let result = evidence::scan_log(r, s, e)?;
            std::fs::write(&path, b"changed after scan\n")?;
            Ok(result)
        })
        .is_err());
    let mut large = input.clone();
    large.source = "x".repeat(evidence::MAX_CLAIM_INPUT_BYTES + 1);
    assert!(store.research_add_claim(&study.id, large).is_err());
    std::fs::write(&path, vec![b'x'; evidence::MAX_EXCERPT_BYTES + 1]).unwrap();
    let mut oversized_excerpt = input;
    oversized_excerpt.line_start = Some(1);
    oversized_excerpt.line_end = Some(1);
    assert!(store
        .research_add_claim(&study.id, oversized_excerpt)
        .is_err());
    assert_eq!(
        serde_json::to_value(store.research_study(&study.id).unwrap()).unwrap(),
        before
    );
}
