use super::*;
use crate::local::model::LocalProject;
struct TempDir(PathBuf);
impl std::ops::Deref for TempDir {
    type Target = PathBuf;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Fixture {
    store: Store,
    dir: TempDir,
    package: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("orx-input-set-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = Store::open_at(dir.clone()).unwrap();
        store
            .create_local_project(&LocalProject {
                id: "p".into(),
                name: "inputs".into(),
                slug: "inputs".into(),
                github_owner: String::new(),
                github_repo: String::new(),
                github_sync_enabled: false,
                baseline_branch: "main".into(),
                repo_path: dir.join("repo").to_string_lossy().into_owned(),
                run_command: None,
                paper_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        let package = uuid::Uuid::new_v4().to_string();
        let base = dir.join("materials").join(&package);
        fs::create_dir_all(base.join("originals/nested")).unwrap();
        fs::write(base.join("originals/nested/data.txt"), b"original data\n").unwrap();
        let manifest = crate::local::materials::Package {
            id: package.clone(),
            project_id: "p".into(),
            created_at: 1,
            ready: true,
            files: vec![crate::local::materials::Entry {
                id: "SRC-0001".into(),
                path: "nested/data.txt".into(),
                size: 14,
                sha256: hash(b"original data\n"),
                format: "text".into(),
                status: "ready".into(),
                note: None,
            }],
        };
        fs::write(
            base.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        Self {
            dir: TempDir(dir),
            store,
            package,
        }
    }
    fn request(&self) -> Request {
        Request {
            schema_version: 1,
            files: vec![SelectedFile {
                path: "data/材料.txt".into(),
                source: Selection::Material {
                    package_id: self.package.clone(),
                    source_id: "SRC-0001".into(),
                },
            }],
        }
    }
    fn manifest(&self) -> Manifest {
        Manifest {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            project_id: "p".into(),
            prepared_at: 1,
            producer_version: "test".into(),
            meaning: "synthetic test; no execution".into(),
            files: vec![FrozenFile {
                path: "input.txt".into(),
                sha256: hash(b"original data\n"),
                bytes: 14,
                origin: Origin::Material {
                    package_id: self.package.clone(),
                    source_id: "SRC-0001".into(),
                    original_path: "nested/data.txt".into(),
                    manifest_sha256: "a".repeat(64),
                },
            }],
        }
    }
    fn reserve(&self, m: &Manifest) -> u64 {
        let json = serde_json::to_vec(m).unwrap();
        let bytes = json.len() as u64 + 14;
        self.store
            .input_reserve(m, std::str::from_utf8(&json).unwrap(), &hash(&json), bytes)
            .unwrap();
        bytes
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.join("orx.db")).unwrap()
    }
}

#[test]
fn freezes_material_bytes_deduplicates_aliases_and_verifies_history() {
    let f = Fixture::new();
    f.store.input_budget(Some(4096)).unwrap();
    let mut request = f.request();
    request.files.push(SelectedFile {
        path: "alias.txt".into(),
        source: request.files[0].source.clone(),
    });
    let result = freeze(&f.store, "p", request).unwrap();
    let id = result["snapshot"]["id"].as_str().unwrap();
    assert_eq!(result["snapshot"]["state"], "frozen");
    assert_eq!(result["executionObserved"], false);
    let record = f.store.input_record("p", id).unwrap();
    let usage = f.store.project_storage_usage("p").unwrap();
    assert_eq!(usage["frozenInputPool"]["frozenSets"], 1);
    assert_eq!(
        usage["frozenInputPool"]["chargedBytes"],
        record.charged_bytes
    );
    assert_eq!(record.manifest.files[0].path, "data/材料.txt");
    f.store.input_budget(Some(16384)).unwrap();
    let raw = serde_json::to_string(&record.manifest).unwrap();
    assert!(f
        .store
        .input_reserve(
            &record.manifest,
            &raw,
            &hash(raw.as_bytes()),
            record.charged_bytes
        )
        .is_err());
    assert_eq!(f.store.input_record("p", id).unwrap().state, "frozen");
    let dir = f.dir.join("input-sets/sets").join(id);
    assert_eq!(fs::read_dir(dir.join("blobs")).unwrap().count(), 1);
    assert_eq!(
        record.charged_bytes,
        serde_json::to_vec(&record.manifest).unwrap().len() as u64 + 14
    );
    fs::write(
        f.dir
            .join("materials")
            .join(&f.package)
            .join("originals/nested/data.txt"),
        b"different live original",
    )
    .unwrap();
    assert_eq!(verify(&f.store, "p", id).unwrap()["copiesVerified"], true);
    fs::remove_dir_all(f.dir.join("materials").join(&f.package)).unwrap();
    assert_eq!(verify(&f.store, "p", id).unwrap()["copiesVerified"], true);
    assert!(f.store.input_record("other", id).is_err());
    assert!(recover(&f.store, "p", id, true).is_err());
    for sql in [format!("DELETE FROM frozen_input_sets WHERE id='{id}'"),format!("UPDATE frozen_input_sets SET state='cancelled',charged_bytes=0 WHERE id='{id}'"),format!("INSERT OR REPLACE INTO frozen_input_sets SELECT * FROM frozen_input_sets WHERE id='{id}'"),"DELETE FROM local_projects WHERE id='p'".into()] {assert!(f.sql().execute_batch(&sql).is_err());}
    fs::write(
        dir.join("blobs").join(&record.manifest.files[0].sha256),
        b"tamper",
    )
    .unwrap();
    assert!(verify(&f.store, "p", id).is_err());
    assert_eq!(
        f.store.input_list("p", 0, 1).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn pool_reservations_serialize_capacity_across_connections_and_require_configuration() {
    let f = Fixture::new();
    assert!(freeze(&f.store, "p", f.request()).is_err());
    let manifest = f.manifest();
    let size = serde_json::to_vec(&manifest).unwrap().len() as u64 + 14;
    f.store.input_budget(Some(size * 2 - 1)).unwrap();
    f.reserve(&manifest);
    assert!(f.sql().execute("UPDATE frozen_input_sets SET state='copying',manifest=json_set(manifest,'$.meaning','changed') WHERE id=?1",[&manifest.id]).is_err());

    let other = Store::open_at(f.dir.clone()).unwrap();
    let second = f.manifest();
    let json = serde_json::to_string(&second).unwrap();
    assert!(other
        .input_reserve(&second, &json, &hash(json.as_bytes()), size)
        .is_err());
    assert!(other.input_budget(Some(size - 1)).is_err());
    assert_eq!(other.input_budget(None).unwrap()["chargedBytes"], size);
    f.store.input_cancel("p", &manifest.id).unwrap();
    other
        .input_reserve(&second, &json, &hash(json.as_bytes()), size)
        .unwrap();
    assert!(f
        .sql()
        .execute_batch("DELETE FROM input_set_budget")
        .is_err());
    assert!(f
        .sql()
        .execute_batch("INSERT OR REPLACE INTO input_set_budget VALUES(1,1)")
        .is_err());
}
#[test]
fn failed_hashing_and_commit_races_release_only_owned_uncommitted_files() {
    for cause in ["source", "manifest", "copy", "io"] {
        let f = Fixture::new();
        f.store.input_budget(Some(8192)).unwrap();
        let result = freeze_with_check(&f.store, "p", f.request(), |m| {
            match cause {
                "source" => fs::write(
                    f.dir
                        .join("materials")
                        .join(&f.package)
                        .join("originals/nested/data.txt"),
                    b"concurrent source",
                )?,
                "manifest" => fs::write(
                    f.dir
                        .join("materials")
                        .join(&f.package)
                        .join("manifest.json"),
                    b"{}",
                )?,
                "copy" => {
                    let blob = f
                        .dir
                        .join("input-sets/sets")
                        .join(&m.id)
                        .join("blobs")
                        .join(&m.files[0].sha256);
                    fs::write(blob, b"concurrent copy")?;
                }
                "io" => return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into()),
                _ => unreachable!(),
            }
            Ok(())
        });
        assert!(result.is_err(), "{cause}");
        let list = f.store.input_list("p", 0, 50).unwrap();
        assert_eq!(list["items"][0]["state"], "cancelled", "{cause}");
        assert_eq!(f.store.input_budget(None).unwrap()["chargedBytes"], 0);
        assert_eq!(
            fs::read_dir(f.dir.join("input-sets/sets")).unwrap().count(),
            0
        );
    }
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let path = f
        .dir
        .join("materials")
        .join(&f.package)
        .join("originals/nested/data.txt");
    fs::write(path, b"wrong identity").unwrap();
    assert!(freeze(&f.store, "p", f.request()).is_err());
    assert_eq!(f.store.input_budget(None).unwrap()["chargedBytes"], 0);
}
#[test]
fn explicit_recovery_preserves_active_leases_unknown_files_and_frozen_history() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let m = f.manifest();
    let root = pool(&f.store).unwrap();
    let lock_path = root.join("locks").join(&m.id);
    let file = fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    let mut lock = fd_lock::RwLock::new(file);
    let guard = lock.write().unwrap();
    f.reserve(&m);
    let dir = root.join("sets").join(&m.id);
    fs::create_dir(&dir).unwrap();
    f.store.input_begin_copy("p", &m.id).unwrap();
    fs::create_dir(dir.join("blobs")).unwrap();
    let part = dir
        .join("blobs")
        .join(format!("{}.part", m.files[0].sha256));
    fs::write(&part, b"partial").unwrap();
    assert!(recover(&f.store, "p", &m.id, true).is_err());
    drop(guard);
    drop(lock);
    fs::write(dir.join("unknown"), b"preserve").unwrap();
    assert!(recover(&f.store, "p", &m.id, false).is_err());
    assert!(part.exists());
    assert!(recover(&f.store, "p", &m.id, true).is_err());
    assert!(part.exists());
    fs::remove_file(dir.join("unknown")).unwrap();
    assert_eq!(
        recover(&f.store, "p", &m.id, false).unwrap()["applied"],
        false
    );
    assert!(part.exists());
    recover(&f.store, "p", &m.id, true).unwrap();
    assert!(!dir.exists());
    assert_eq!(f.store.input_budget(None).unwrap()["chargedBytes"], 0);
    let uncertain = f.manifest();
    fs::write(root.join("locks").join(&uncertain.id), []).unwrap();
    f.reserve(&uncertain);
    fs::create_dir(root.join("sets").join(&uncertain.id)).unwrap();
    assert!(recover(&f.store, "p", &uncertain.id, true).is_err());
}
#[test]
fn input_paths_scopes_and_unregistered_files_fail_closed() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    for path in [
        "../outside",
        "a/../b",
        "AUX.txt",
        "a/",
        "a\\b",
        "/tmp/input",
        "file?.csv",
        "dir/a|b",
        "file.",
        "a:b",
    ] {
        let mut r = f.request();
        r.files[0].path = path.into();
        assert!(freeze(&f.store, "p", r).is_err(), "{path}");
    }
    for other in ["data/材料.txt", "DATA/材料.TXT", "data/材料.txt/nested"] {
        let mut r = f.request();
        let mut alias = r.files[0].clone();
        alias.path = other.into();
        r.files.push(alias);
        assert!(freeze(&f.store, "p", r).is_err());
    }
    assert!(freeze(&f.store, "other", f.request()).is_err());
    let good = freeze(&f.store, "p", f.request()).unwrap();
    let id = good["snapshot"]["id"].as_str().unwrap();
    let dir = f.dir.join("input-sets/sets").join(id);
    fs::write(dir.join("blobs/unregistered"), b"unknown").unwrap();
    assert!(verify(&f.store, "p", id).is_err());
    assert!(f.store.input_list("p", -1, 50).is_err());
    assert!(f.store.input_list("p", 0, 51).is_err());
}
#[cfg(unix)]
#[test]
fn source_symlink_escapes_and_project_aliases_are_rejected() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let file = f
        .dir
        .join("materials")
        .join(&f.package)
        .join("originals/nested/data.txt");
    fs::remove_file(&file).unwrap();
    fs::write(f.dir.join("outside"), b"original data\n").unwrap();
    symlink(f.dir.join("outside"), &file).unwrap();
    assert!(freeze(&f.store, "p", f.request()).is_err());
}

#[test]
fn artifact_selection_preserves_declared_association_and_rejects_run_races() {
    let f = Fixture::new();
    f.store.input_budget(Some(16384)).unwrap();
    fs::create_dir_all(f.dir.join("files/inputs")).unwrap();
    fs::write(f.dir.join("files/inputs/data.csv"), b"x,y\n1,2\n").unwrap();
    f.sql().execute_batch("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,command,created_at,updated_at,exit_code,commit_sha) VALUES('r','e','p','done','{}','synthetic command',1,1,0,'abc')").unwrap();
    let request = || Request {
        schema_version: 1,
        files: vec![SelectedFile {
            path: "data.csv".into(),
            source: Selection::Artifact {
                run_id: "r".into(),
                path: "data.csv".into(),
                sha256: hash(b"x,y\n1,2\n"),
                bytes: 8,
            },
        }],
    };
    assert!(freeze_with_check(&f.store, "p", request(), |_| {
        f.sql()
            .execute_batch("UPDATE runs SET status='running' WHERE id='r'")?;
        Ok(())
    })
    .is_err());
    assert_eq!(f.store.input_budget(None).unwrap()["chargedBytes"], 0);
    assert!(freeze(&f.store, "p", request()).is_err());
    f.sql()
        .execute_batch("UPDATE runs SET status='done' WHERE id='r'")
        .unwrap();
    let output = freeze(&f.store, "p", request()).unwrap();
    let id = output["snapshot"]["id"].as_str().unwrap();
    assert!(f.store.delete_local_project("p").is_err());
    assert!(f.store.get_run("r").unwrap().is_some());
    assert!(!output.to_string().contains("synthetic command"));
    assert!(output["snapshot"]["manifest"]["meaning"]
        .as_str()
        .unwrap()
        .contains("operator-selected"));
    f.sql()
        .execute_batch("DELETE FROM runs WHERE id='r'")
        .unwrap();
    fs::remove_file(f.dir.join("files/inputs/data.csv")).unwrap();
    assert_eq!(verify(&f.store, "p", id).unwrap()["copiesVerified"], true);
}

#[test]
fn oversized_and_malformed_requests_do_not_publish_partial_inputs() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let mut invalid = f.request();
    invalid.schema_version = 2;
    assert!(freeze(&f.store, "p", invalid).is_err());
    let mut invalid = f.request();
    invalid.files.clear();
    assert!(freeze(&f.store, "p", invalid).is_err());
    assert!(serde_json::from_value::<Request>(
        serde_json::json!({"schemaVersion":1,"files":[],"execute":"not data"})
    )
    .is_err());
    let path = f
        .dir
        .join("materials")
        .join(&f.package)
        .join("originals/nested/data.txt");
    fs::File::create(path)
        .unwrap()
        .set_len(MAX_BYTES + 1)
        .unwrap();
    assert!(freeze(&f.store, "p", f.request()).is_err());
    assert!(f.store.input_list("p", 0, 50).unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn simultaneous_reservations_cannot_overcommit_the_pool() {
    let f = Fixture::new();
    let one = f.manifest();
    let two = f.manifest();
    let charge = serde_json::to_vec(&one).unwrap().len() as u64 + 14;
    f.store.input_budget(Some(charge * 2 - 1)).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let handles = [one, two]
        .into_iter()
        .map(|manifest| {
            let dir = f.dir.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = Store::open_at(dir).unwrap();
                let json = serde_json::to_string(&manifest).unwrap();
                barrier.wait();
                store
                    .input_reserve(&manifest, &json, &hash(json.as_bytes()), charge)
                    .is_ok()
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let succeeded = handles
        .into_iter()
        .map(|h| usize::from(h.join().unwrap()))
        .sum::<usize>();
    assert_eq!(succeeded, 1);
    assert_eq!(f.store.input_budget(None).unwrap()["chargedBytes"], charge);
}
#[test]
fn actual_copying_and_hashing_allow_an_independent_database_writer() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let other = Store::open_at(f.dir.clone()).unwrap();
    let mut writer = None;
    let mut held_during_copy = false;
    let result = freeze_with_observer(&f.store, "p", f.request(), |phase, manifest| {
        match phase {
            Phase::Copying => {
                let tx = other.begin_immediate()?;
                tx.execute(
                    "UPDATE local_projects SET name='concurrent writer' WHERE id='p'",
                    [],
                )?;
                writer = Some(tx);
                held_during_copy = true;
            }
            Phase::Committing => {
                let dir = f.dir.join("input-sets/sets").join(&manifest.id);
                assert_eq!(
                    fs::read(dir.join("blobs").join(&manifest.files[0].sha256))?,
                    b"original data\n"
                );
                writer.take().unwrap().commit()?;
            }
        }
        Ok(())
    })
    .unwrap();
    assert!(held_during_copy);
    assert_eq!(result["snapshot"]["state"], "frozen");
    assert_eq!(
        other.get_local_project("p").unwrap().unwrap().name,
        "concurrent writer"
    );
}

#[test]
fn process_interruption_retains_reservation_until_operator_recovery() {
    const WORKER: &str = "ORX_TEST_INPUT_FREEZE_WORKER";
    if let Some(dir) = std::env::var_os(WORKER) {
        let dir = PathBuf::from(dir);
        let store = Store::open_at(dir.clone()).unwrap();
        let request = serde_json::from_slice(&fs::read(dir.join("request.json")).unwrap()).unwrap();
        freeze_with_check(&store, "p", request, |manifest| {
            fs::write(dir.join("checkpoint.tmp"), &manifest.id)?;
            fs::rename(dir.join("checkpoint.tmp"), dir.join("checkpoint"))?;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        })
        .unwrap();
        unreachable!();
    }
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let f = Fixture::new();
    f.store.input_budget(Some(16384)).unwrap();
    let first = freeze(&f.store, "p", f.request()).unwrap();
    let first_id = first["snapshot"]["id"].as_str().unwrap();
    fs::write(f.dir.join("request.json"),serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"files":[{"path":"data.txt","source":{"kind":"material","packageId":f.package,"sourceId":"SRC-0001"}}]})).unwrap()).unwrap();
    let mut child=ChildGuard(std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact","input_sets::tests::process_interruption_retains_reservation_until_operator_recovery","--nocapture"])
        .env(WORKER,&*f.dir).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let checkpoint = f.dir.join("checkpoint");
    while !checkpoint.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "worker exited before real staging checkpoint"
        );
        assert!(
            std::time::Instant::now() < until,
            "worker did not stage inputs"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let id = fs::read_to_string(checkpoint).unwrap();
    let row = f.store.input_record("p", &id).unwrap();
    assert_eq!(row.state, "copying");
    let dir = f.dir.join("input-sets/sets").join(&id);
    assert_eq!(
        fs::read(dir.join("blobs").join(&row.manifest.files[0].sha256)).unwrap(),
        b"original data\n"
    );
    assert!(recover(&f.store, "p", &id, true).is_err());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(
        f.store.input_budget(None).unwrap()["chargedBytes"]
            .as_u64()
            .unwrap()
            > first["snapshot"]["chargedBytes"].as_u64().unwrap()
    );
    recover(&f.store, "p", &id, true).unwrap();
    assert!(!dir.exists());
    assert_eq!(f.store.input_record("p", &id).unwrap().state, "cancelled");
    assert_eq!(
        verify(&f.store, "p", first_id).unwrap()["copiesVerified"],
        true
    );
}

#[test]
fn missing_pool_is_reported_without_recreating_data_or_releasing_retention() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let output = freeze(&f.store, "p", f.request()).unwrap();
    let id = output["snapshot"]["id"].as_str().unwrap();
    let before = f.store.input_budget(None).unwrap()["chargedBytes"].clone();
    fs::rename(f.dir.join("input-sets"), f.dir.join("preserved-input-sets")).unwrap();
    assert!(verify(&f.store, "p", id).is_err());
    assert!(!f.dir.join("input-sets").exists());
    assert_eq!(f.store.input_budget(None).unwrap()["chargedBytes"], before);
}
#[test]
fn material_scope_sealing_and_source_identifiers_are_required_before_reservation() {
    for change in ["scope", "unsealed", "duplicate"] {
        let f = Fixture::new();
        f.store.input_budget(Some(8192)).unwrap();
        let path = f
            .dir
            .join("materials")
            .join(&f.package)
            .join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match change {
            "scope" => value["projectId"] = "other".into(),
            "unsealed" => value["ready"] = false.into(),
            "duplicate" => {
                let duplicate = value["files"][0].clone();
                value["files"].as_array_mut().unwrap().push(duplicate);
            }
            _ => unreachable!(),
        }
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(freeze(&f.store, "p", f.request()).is_err());
        assert!(f.store.input_list("p", 0, 50).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
#[cfg(unix)]
#[test]
fn original_source_names_are_preserved_without_forcing_destination_rules_onto_sources() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let base = f.dir.join("materials").join(&f.package);
    fs::rename(
        base.join("originals/nested/data.txt"),
        base.join("originals/odd?.txt"),
    )
    .unwrap();
    let path = base.join("manifest.json");
    let mut manifest: crate::local::materials::Package =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest.files[0].path = "odd?.txt".into();
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let output = freeze(&f.store, "p", f.request()).unwrap();
    assert_eq!(
        output["snapshot"]["manifest"]["files"][0]["origin"]["originalPath"],
        "odd?.txt"
    );
}

#[test]
fn a_new_unregistered_file_before_commit_prevents_publication_and_preserves_every_file() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    let mut id = String::new();
    assert!(freeze_with_check(&f.store, "p", f.request(), |manifest| {
        id = manifest.id.clone();
        fs::write(
            f.dir
                .join("input-sets/sets")
                .join(&id)
                .join("blobs/unknown"),
            b"retain for inspection",
        )?;
        Ok(())
    })
    .is_err());
    let row = f.store.input_record("p", &id).unwrap();
    assert_eq!(row.state, "copying");
    assert!(row.charged_bytes > 0);
    let dir = f.dir.join("input-sets/sets").join(&id);
    assert!(dir.join("blobs/unknown").exists());
    assert!(dir
        .join("blobs")
        .join(&row.manifest.files[0].sha256)
        .exists());
    assert!(recover(&f.store, "p", &id, true).is_err());
    fs::remove_file(dir.join("blobs/unknown")).unwrap();
    recover(&f.store, "p", &id, true).unwrap();
    assert_eq!(f.store.input_budget(None).unwrap()["chargedBytes"], 0);
}
#[cfg(unix)]
#[test]
fn copied_inputs_are_inside_an_owner_private_pool() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    freeze(&f.store, "p", f.request()).unwrap();
    assert_eq!(
        fs::metadata(f.dir.join("input-sets"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[cfg(unix)]
#[test]
fn replaced_fifo_paths_fail_without_blocking_evidence_identity_checks() {
    const WORKER: &str = "ORX_TEST_INPUT_FIFO_WORKER";
    if let Some(dir) = std::env::var_os(WORKER) {
        use std::os::unix::ffi::OsStrExt;
        let root = PathBuf::from(dir);
        let path = root.join("fifo-source");
        let alias = root.join("fifo-alias");
        fs::write(&path, b"regular").unwrap();
        std::os::unix::fs::symlink("fifo-source", &alias).unwrap();
        let first = FileSource::open(&alias, "test input").unwrap();
        let mut second = FileSource::open(&path, "test input").unwrap();
        second.hash().unwrap();
        let snapshot = second.into_snapshot().unwrap();
        let fifo = |path: &Path| {
            let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            // SAFETY: name is an owned, NUL-terminated test path; no pointer escapes.
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        };
        // Retargeting the alias leaves the original descriptor's stamp intact,
        // so the path identity probe itself must reject a FIFO without opening it blocking.
        fs::remove_file(&alias).unwrap();
        fifo(&alias);
        assert!(first.check_unchanged().is_err());
        fs::remove_file(&path).unwrap();
        fifo(&path);
        assert!(snapshot.check_unchanged().is_err());
        assert!(FileSource::open(&path, "test input").is_err());
        return;
    }
    struct ChildGuard(Option<std::process::Child>);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    let f = Fixture::new();
    let mut child=ChildGuard(Some(std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact","input_sets::tests::replaced_fifo_paths_fail_without_blocking_evidence_identity_checks","--nocapture"])
        .env(WORKER,&*f.dir).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap()));
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while child.0.as_mut().unwrap().try_wait().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < until,
            "FIFO identity probe blocked"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output = child.0.take().unwrap().wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
}

#[test]
fn legacy_artifact_layout_uses_the_shared_store_bound_migration() {
    let f = Fixture::new();
    f.store.input_budget(Some(8192)).unwrap();
    fs::create_dir_all(f.dir.join("artifacts/inputs")).unwrap();
    fs::write(f.dir.join("artifacts/inputs/input.txt"), b"legacy").unwrap();
    f.sql().execute_batch("INSERT INTO runs(id,experiment_id,project_id,status,backend_json,command,created_at,updated_at,exit_code) VALUES('r','e','p','done','{}','synthetic legacy selection',1,1,0)").unwrap();
    let request = Request {
        schema_version: 1,
        files: vec![SelectedFile {
            path: "input.txt".into(),
            source: Selection::Artifact {
                run_id: "r".into(),
                path: "input.txt".into(),
                sha256: hash(b"legacy"),
                bytes: 6,
            },
        }],
    };
    let result = freeze(&f.store, "p", request).unwrap();
    let id = result["snapshot"]["id"].as_str().unwrap();
    assert!(!f.dir.join("artifacts").exists());
    assert_eq!(
        fs::read(f.dir.join("files/inputs/input.txt")).unwrap(),
        b"legacy"
    );
    assert_eq!(verify(&f.store, "p", id).unwrap()["copiesVerified"], true);
}
