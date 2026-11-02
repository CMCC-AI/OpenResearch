// Synthetic snapshots and parser pipes; no user documents or real model calls.
fn prepared_fixture(name: &str, bytes: &[u8]) -> (PathBuf, PreparedRead) {
    let root = temp();
    let package = create_at(&root, "project").unwrap();
    upload_at(&root, &package.id, "project", name, bytes).unwrap();
    let sealed = finalize_at(&root, &package.id, "project").unwrap();
    let prepared = prepare_read_at(&root, &package.id, "project", &sealed.files[0].id).unwrap();
    (root, prepared)
}

#[cfg(unix)]
#[tokio::test]
async fn material_read_snapshot_pdf_uses_verified_stdin_and_preserves_failures() {
    fn parser(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", script, "parser-fixture"]);
        command
    }
    let deadline = std::time::Duration::from_secs(5);
    let (root, prepared) = prepared_fixture("paper.pdf", b"%PDF-trusted");
    fs::write(&prepared.original, b"%PDF-altered").unwrap();
    let text = extract_pdf(parser(r#"[ "$1 $2 $3 $4 $5 $6 $7" = '-f 3 -l 3 -layout - -' ] || exit 9; value=$(cat); [ "$value" = '%PDF-trusted' ] || exit 10; printf 'verified page\n'"#), &prepared.bytes, 3, deadline).await.unwrap();
    assert_eq!(text, "verified page\n");
    let error = extract_pdf(
        parser("printf 'encrypted input' >&2; exit 3"),
        &prepared.bytes,
        1,
        deadline,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("encrypted input"));
    assert!(extract_pdf(
        parser("cat >/dev/null; printf '  \\n'"),
        &prepared.bytes,
        1,
        deadline
    )
    .await
    .unwrap_err()
    .to_string()
    .contains("没有提取到文本"));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn material_read_snapshot_pdf_bounds_pipes_and_times_out_blocked_input() {
    fn parser(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", script, "parser-fixture"]);
        command
    }
    for script in ["head -c 8388609 /dev/zero", "head -c 65537 /dev/zero >&2"] {
        let error = extract_pdf(
            parser(script),
            b"%PDF-fixture",
            1,
            std::time::Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("读取上限"), "{error}");
    }
    // exec keeps the fixture one process, and large input fills stdin if
    // writing is accidentally moved outside the common deadline.
    let error = extract_pdf(
        parser("exec sleep 30"),
        &vec![b'x'; 1024 * 1024],
        1,
        std::time::Duration::from_millis(200),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("解析超时"));
}

#[tokio::test]
async fn material_read_snapshot_reports_actual_ranges_and_preserves_project_checks() {
    let (root, prepared) = prepared_fixture("notes.txt", "头\r\n结果🙂\r\n结尾\n".as_bytes());
    let result = prepared.read(2, 1, None).await.unwrap();
    assert_eq!(result["content"], "2: 结果🙂\n");
    assert_eq!(result["lineCount"], 1);
    assert_eq!(result["nextOffset"], 3);
    assert_eq!(result["totalLines"], 3);
    assert!(prepared.read(4, 1, None).await.is_err());
    for (offset, limit) in [(0, 1), (1, 0), (1, 1001)] {
        assert!(prepared.read(offset, limit, None).await.is_err());
    }
    assert!(prepare_read_at(&root, &prepared.id, "other-project", &prepared.entry.id).is_err());
    assert!(prepare_read_at(&root, &prepared.id, "project", "SRC-9999").is_err());
    fs::remove_dir_all(root).unwrap();
    let (root, empty) = prepared_fixture("empty.txt", b"");
    let result = empty.read(1, 200, None).await.unwrap();
    assert_eq!(result["lineCount"], 0);
    assert_eq!(result["content"], "");
    assert!(result["nextOffset"].is_null());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn material_read_snapshot_returns_the_verified_text_after_path_replacement() {
    let (root, prepared) = prepared_fixture("facts.txt", b"trusted\n");
    fs::write(&prepared.original, b"altered\n").unwrap();
    let result = prepared.read(1, 200, None).await.unwrap();
    assert_eq!(result["content"], "1: trusted\n");
    assert_eq!(
        result["sha256"],
        format!("{:x}", Sha256::digest(b"trusted\n"))
    );
    assert!(prepare_read_at(&root, &prepared.id, "project", &prepared.entry.id).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn material_read_snapshot_keeps_notebook_content_bound_to_its_hash() {
    let notebook = br#"{"cells":[{"cell_type":"markdown","source":["trusted"],"outputs":[]}]}"#;
    let (root, prepared) = prepared_fixture("analysis.ipynb", notebook);
    fs::write(
        &prepared.original,
        br#"{"cells":[{"cell_type":"markdown","source":["altered"],"outputs":[]}]}"#,
    )
    .unwrap();
    let result = prepared.read(1, 200, None).await.unwrap();
    assert!(result["content"].as_str().unwrap().contains("trusted"));
    assert!(!result["content"].as_str().unwrap().contains("altered"));
    assert_eq!(result["sha256"], format!("{:x}", Sha256::digest(notebook)));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn material_read_snapshot_bounds_numbered_output_and_keeps_the_next_line() {
    let text = format!("{}\nb\n", "a".repeat(64 * 1024 - 6));
    let (root, prepared) = prepared_fixture("long.txt", text.as_bytes());
    let result = prepared.read(1, 200, None).await.unwrap();
    assert!(result["content"].as_str().unwrap().len() <= 64 * 1024);
    assert_eq!(result["nextOffset"], 2);
    assert_eq!(
        prepared.read(2, 200, None).await.unwrap()["content"],
        "2: b\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn material_read_snapshot_counts_prefix_bytes_at_the_first_line_boundary() {
    let (root, prepared) = prepared_fixture("boundary.txt", &vec![b'x'; 64 * 1024 - 4]);
    assert_eq!(
        prepared.read(1, 1, None).await.unwrap()["content"]
            .as_str()
            .unwrap()
            .len(),
        64 * 1024
    );
    fs::remove_dir_all(root).unwrap();
    let (root, prepared) = prepared_fixture("oversized.txt", &vec![b'x'; 64 * 1024]);
    assert!(prepared.read(1, 1, None).await.is_err());
    fs::remove_dir_all(root).unwrap();
}
