//! Observe the actual PDF executable and complete page view without exposing host paths.
use super::*;
use crate::verified_file::FileSource;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

type PdfIdentity = (Option<String>, Option<String>);

pub(super) async fn pdf(bytes: &[u8], page: u32) -> Result<(String, PdfIdentity)> {
    let path = crate::local::shell_env::find_on_process_path("pdftotext")
        .ok_or_else(|| anyhow!("PDF 文本解析不可用：执行端需安装 pdftotext"))?;
    let path = fs::canonicalize(path)?;
    pdf_at(&path, bytes, page, Duration::from_secs(30)).await
}

async fn pdf_at(
    path: &Path,
    bytes: &[u8],
    page: u32,
    budget: Duration,
) -> Result<(String, PdfIdentity)> {
    // Version probing and extraction share the original overall parser budget.
    tokio::time::timeout(budget, async {
        let mut executable = FileSource::open(path, "PDF 解析器").ok();
        let digest = match executable.as_mut() {
            Some(file) if file.bytes() <= 64 * 1024 * 1024 => Some(file.hash()?),
            _ => None,
        };
        let version = reported_version(tokio::process::Command::new(path)).await;
        if let Some(file) = &executable {
            file.check_unchanged()?;
        }
        let text = extract_pdf(tokio::process::Command::new(path), bytes, page, budget).await?;
        if let Some(file) = &executable {
            file.check_unchanged()?;
        }
        Ok((text, (version, digest)))
    })
    .await
    .map_err(|_| anyhow!("PDF 解析超时"))?
}

async fn diagnostic(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(4097).read_to_end(&mut bytes).await?;
    if bytes.len() > 4096 {
        return Err(anyhow!("PDF 解析器身份响应过长"));
    }
    Ok(bytes)
}

async fn reported_version(mut command: tokio::process::Command) -> Option<String> {
    let probe = async {
        let mut child = command
            .arg("-v")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("missing stdout"))?;
        let errors = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("missing stderr"))?;
        let (output, errors, status) =
            tokio::try_join!(diagnostic(output), diagnostic(errors), async {
                Ok::<_, crate::error::Error>(child.wait().await?)
            },)?;
        if !status.success() {
            return Err(anyhow!("PDF 解析器版本探测失败"));
        }
        // Never persist arbitrary diagnostics, paths, environment or copyright text.
        for bytes in [&output, &errors] {
            for line in std::str::from_utf8(bytes)?.lines() {
                if let Some(version) = line.strip_prefix("pdftotext version ") {
                    if !version.is_empty()
                        && version.len() <= 64
                        && version
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b".+-_".contains(&b))
                    {
                        return Ok(version.to_string());
                    }
                }
            }
        }
        Err(anyhow!("PDF 解析器未报告可识别版本"))
    };
    tokio::time::timeout(Duration::from_secs(2), probe)
        .await
        .ok()?
        .ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn command(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", script, "version-fixture"]);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parser_identity_bounds_probes_and_keeps_only_reported_version() {
        assert_eq!(
            reported_version(command(
                "printf 'pdftotext version 22.12.0\\nCopyright private-path\\n' >&2"
            ))
            .await
            .as_deref(),
            Some("22.12.0")
        );
        for script in [
            "printf 'private diagnostic' >&2",
            "printf 'pdftotext version 22.12.0'; exit 1",
            "head -c 4097 /dev/zero",
        ] {
            assert!(reported_version(command(script)).await.is_none());
        }
        assert!(reported_version(command("exec sleep 30")).await.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parser_identity_binds_executed_file_and_shares_extraction_deadline() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("orx-parser-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("parser");
        let script = b"#!/bin/sh\nif [ \"$1\" = '-v' ]; then printf 'pdftotext version fixture-1\\n'; else cat >/dev/null; printf 'page text\\n'; fi\n";
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let (text, (version, digest)) =
            pdf_at(&path, b"verified PDF bytes", 1, Duration::from_secs(5))
                .await
                .unwrap();
        assert_eq!(text, "page text\n");
        assert_eq!(version.as_deref(), Some("fixture-1"));
        assert_eq!(digest.unwrap(), format!("{:x}", Sha256::digest(script)));
        fs::write(&path, "#!/bin/sh\nexec sleep 30\n").unwrap();
        let error = pdf_at(&path, b"PDF", 1, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("解析超时"));
        fs::remove_dir_all(root).unwrap();
    }
}
