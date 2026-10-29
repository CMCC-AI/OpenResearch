#[test]
fn research_file_hashes_preserve_binary_empty_and_buffer_boundary_contents() {
    let dir = TestDir::new();
    for size in [0, 1, 65535, 65536, 65537, 131075] {
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.path().join("output.bin"), &bytes).unwrap();
        let artifact = inspect_artifact(dir.path(), "output.bin").unwrap();
        assert_eq!(artifact.path, "output.bin");
        assert_eq!(artifact.bytes, size as u64);
        assert_eq!(artifact.sha256, digest(&bytes));
    }
    assert!(inspect_artifact(dir.path(), "missing.bin")
        .unwrap_err()
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound));
    assert!(files::FileSource::open(dir.path(), "研究产物").is_err());
}

#[test]
fn research_file_snapshot_bounds_growth_and_rejects_source_changes() {
    use std::io::{Read, Write};
    let dir = TestDir::new();
    let path = dir.path().join("log");
    std::fs::write(&path, b"original").unwrap();
    let mut source = files::FileSource::open(&path, "实验日志").unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&[b'x'; 65536])
        .unwrap();
    let mut captured = Vec::new();
    source.reader().read_to_end(&mut captured).unwrap();
    assert_eq!(captured, b"originalx");
    assert!(source.check_unchanged().is_err());

    for change in ["append", "truncate", "rewrite", "replace"] {
        std::fs::write(&path, b"original").unwrap();
        let mut source = files::FileSource::open(&path, "实验日志").unwrap();
        match change {
            "append" => {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .unwrap()
                    .write_all(b"more")
                    .unwrap();
            }
            "truncate" => {
                std::fs::write(&path, b"short").unwrap();
            }
            "rewrite" => {
                let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
                std::fs::write(&path, b"changed!").unwrap();
                // Force an observable timestamp change without a wall-clock sleep.
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_times(
                        std::fs::FileTimes::new()
                            .set_modified(modified + std::time::Duration::from_secs(2)),
                    )
                    .unwrap();
            }
            "replace" => {
                std::fs::rename(&path, dir.path().join("old-log")).unwrap();
                std::fs::write(&path, b"original").unwrap();
            }
            _ => unreachable!(),
        }
        assert!(source.hash().is_err(), "accepted {change}");
    }
}

#[test]
fn research_artifact_limit_still_accepts_exact_boundary_and_hashes_the_tail() {
    use std::io::{Seek, SeekFrom, Write};
    let dir = TestDir::new();
    let path = dir.path().join("large.bin");
    let mut file = std::fs::File::create(&path).unwrap();
    file.set_len(MAX_ARTIFACT_BYTES).unwrap();
    let first = inspect_artifact(dir.path(), "large.bin").unwrap();
    assert_eq!(first.bytes, MAX_ARTIFACT_BYTES);
    file.seek(SeekFrom::End(-1)).unwrap();
    file.write_all(b"x").unwrap();
    let second = inspect_artifact(dir.path(), "large.bin").unwrap();
    assert_ne!(first.sha256, second.sha256);
    file.set_len(MAX_ARTIFACT_BYTES + 1).unwrap();
    assert!(inspect_artifact(dir.path(), "large.bin")
        .unwrap_err()
        .to_string()
        .contains("32 MiB"));
}

#[test]
fn research_file_capacity_failure_keeps_task_and_existing_outputs_intact() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[0].outputs.push("large.bin".into());
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "expert");
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("design.md"), b"valid result").unwrap();
    std::fs::File::create(root.join("large.bin"))
        .unwrap()
        .set_len(MAX_ARTIFACT_BYTES + 1)
        .unwrap();
    assert!(store
        .research_finish(&study.id, "design", true, "checked".into())
        .is_err());
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("design").unwrap().state, "running");
    assert!(saved.task("design").unwrap().artifacts.is_empty());
    assert_eq!(
        std::fs::read(root.join("design.md")).unwrap(),
        b"valid result"
    );
}

#[test]
fn research_package_retains_full_binary_log_hashes_and_current_scope_shape() {
    let (_dir, store, study, mut input) = evidence_fixture();
    store
        .conn
        .execute(
            "UPDATE runs SET backend_json='{\"kind\":\"local\"}' WHERE id='evidence-run'",
            [],
        )
        .unwrap();
    input.support = "inference".into();
    store.research_add_claim(&study.id, input).unwrap();
    store.research_set_plan(&study.id, plan()).unwrap();
    approve(&store, &study, "G1");
    for task in ["design", "review", "audit"] {
        bind(&store, &study, task, task);
        finish(&store, &study, task);
    }
    let bytes: Vec<u8> = (0..131075).map(|i| (i % 251) as u8).collect();
    std::fs::write(store.research_log_path("evidence-run").unwrap(), &bytes).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let package: serde_json::Value =
        serde_json::from_str(&store.research_package_scope(&saved).unwrap()).unwrap();
    assert_eq!(package["runs"][0]["logHash"], digest(&bytes));
    assert_eq!(
        package["plan"],
        serde_json::to_value(saved.plan().unwrap()).unwrap()
    );
    assert_eq!(
        package["claims"],
        serde_json::to_value(&saved.claims).unwrap()
    );
}
