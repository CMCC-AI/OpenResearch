//! Process isolation for tests which must exercise real environment lookups.

/// Return true in the parent after a successful exact child test. Callers
/// return immediately in that case; only the single-test child mutates env.
pub(crate) fn run_isolated(name: &str, clean_variables: &[&str]) -> bool {
    const CHILD: &str = "ORX_TEST_PROCESS_CHILD";
    if std::env::var(CHILD).as_deref() == Ok(name) {
        return false;
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            name,
            "--test-threads=1",
            "--nocapture",
            "--color=never",
        ])
        .env(CHILD, name);
    for key in clean_variables {
        command.env_remove(key);
    }
    let output = command.output().expect("start isolated environment test");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed; 0 failed"),
        "isolated {name} failed or did not execute: {}\n{stdout}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    true
}
