#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct Sandbox(PathBuf);
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn wait_for(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// A product build must ignore official update receipts and keep its own backend.
#[test]
fn product_orx_up_ignores_installed_official_updates() {
    let root = std::env::temp_dir().join(format!("orx-up-restart-{}", uuid::Uuid::new_v4()));
    let _sandbox = Sandbox(root.clone());
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let orx = bin.join("orx");
    std::fs::copy(env!("CARGO_BIN_EXE_orx"), &orx).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();

    let mut up = Command::new(&orx)
        .args(["--no-telemetry", "up", "--no-browser", "--port"])
        .arg(port.to_string())
        .env("HOME", &root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("share"))
        .env("ORX_DATA_DIR", root.join("data"))
        .env("PATH", "/usr/bin:/bin")
        .env("GITHUB_TOKEN", "")
        // Keep the startup release check off the network.
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("ALL_PROXY", "http://127.0.0.1:9")
        .env_remove("ORX_NO_UPDATE_CHECK")
        .env_remove("NO_UPDATE_NOTIFIER")
        .env_remove("OPENRESEARCH_CLI_DISABLE_UPDATE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let serving = wait_for(Duration::from_secs(60), || {
        std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
    });

    // What the installer does: rename a newer orx over the running one, then record it.
    let marker = root.join("relaunched");
    let next = bin.join("orx.next");
    std::fs::write(
        &next,
        format!(
            "#!/bin/sh\n[ \"$1\" = --version ] && echo 'orx 99.0.0' && exit 0\necho \"$@\" > '{}'\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(&next, &orx).unwrap();
    let config = root.join("config/openresearch");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("update-check-unknown.json"),
        r#"{"checked_at":4102444800,"latest":"99.0.0","installed_version":"99.0.0"}"#,
    )
    .unwrap();

    assert!(serving, "orx up never started serving");
    let mut connection = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        connection,
        "GET /api/update HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    connection.read_to_string(&mut response).unwrap();
    let status: serde_json::Value =
        serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(status["channel"], "product");
    assert_eq!(status["selfUpdates"], false);
    assert_eq!(status["restartRequired"], false);
    let relaunched = wait_for(Duration::from_secs(10), || marker.exists());
    let still_running = up.try_wait().unwrap().is_none();
    let _ = up.kill();
    let _ = up.wait();
    assert!(
        !relaunched,
        "product backend relaunched into an official update"
    );
    assert!(still_running, "product backend stopped serving");
}
