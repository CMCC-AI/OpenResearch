use std::path::PathBuf;

use crate::error::{anyhow, Result};

use super::{shell_hook_dir, target_event_pointer, CHAT_TARGET_FILE_ENV, CHAT_TARGET_POINTER_ENV};

/// The PATH a child gets: this orx first, so an agent shelling out to `orx`
/// reaches the running one.
pub(super) fn child_path() -> Option<std::ffi::OsString> {
    let mut path = orx_bin_dir()?.into_os_string();
    if let Some(existing) = crate::local::shell_env::search_path().filter(|p| !p.is_empty()) {
        path.push(crate::local::shell_env::PATH_LIST_SEPARATOR);
        path.push(existing);
    }
    Some(path)
}

/// Env prep shared by the CLI adapters: this orx first on PATH (agents shell
/// out to `orx`), the shell environment app mode imported, and the
/// dashboard-managed env vars, real env winning. Only the starting order —
/// [`PATH_GUARD`] is what holds it once the child's shell reads a user profile.
pub fn prepare_env(cmd: &mut tokio::process::Command) {
    if let Some(path) = child_path() {
        cmd.env("PATH", path);
    }
    // So an agent's `orx exp run` resolves the same store the dashboard is
    // showing it, rather than re-resolving to the default.
    crate::local::shell_env::export_to(|key, value| {
        cmd.env(key, value);
    });
    // Agents open browsers and editors themselves.
    crate::local::shell_env::restore_host_gui_env(cmd.as_std_mut());
    for (key, value) in crate::config::list_synced_env() {
        if crate::local::shell_env::var(&key).is_none() {
            cmd.env(key, value);
        }
    }
    crate::jobs::ssh::prepare_sharing_env(cmd);
}

/// Env var carrying the launching chat session's id into a harness child. The
/// agent shells out `orx exp run`, a fresh `orx` subprocess that inherits this,
/// so run creation can stamp `StoredRun::chat_session_id` (see
/// `launching_chat_session`) and `orx exp wake` can register the current chat.
pub const CHAT_SESSION_ENV: &str = "ORX_CHAT_SESSION_ID";

/// Harness label paired with [`CHAT_SESSION_ENV`] for child telemetry.
pub const CHAT_HARNESS_ENV: &str = "ORX_CHAT_HARNESS";

/// Marks a process as a child of a local `orx up` harness. Separate from
/// [`CHAT_SESSION_ENV`], which the cloud box's opencode plugin also exports for
/// attribution — presence of a session id alone no longer implies local.
pub const LOCAL_SESSION_ENV: &str = "ORX_LOCAL_SESSION";

/// Loopback port of the trusted `orx up` process that owns local agent runs.
pub const UP_PORT_ENV: &str = "ORX_UP_PORT";

/// Version of that `orx up`, which keeps running its own code after an update lands on disk.
pub const UP_VERSION_ENV: &str = "ORX_UP_VERSION";

/// Route-scoped bearer for agent subprocesses calling their owning `orx up`.
pub const UP_AUTH_TOKEN_ENV: &str = "ORX_UP_AUTH_TOKEN";

static UP_AUTH_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub(crate) fn set_up_auth_token(token: String) {
    let _ = UP_AUTH_TOKEN.set(token);
}

pub(crate) fn up_auth_token() -> Option<&'static str> {
    UP_AUTH_TOKEN.get().map(String::as_str)
}

/// Directory of the `orx` running this session, for the shell hooks to restore
/// to the front of `PATH`.
pub(super) const BIN_DIR_ENV: &str = "ORX_BIN_DIR";

/// Re-front [`BIN_DIR_ENV`] on `PATH` once the user's own startup file has run:
/// a profile prepending its bin dir, or macOS `path_helper`, would otherwise
/// pick which `orx` an agent's `orx …` reaches. Every zsh mode and every
/// non-interactive bash sources a file this rides on; an interactive bash
/// ignores `BASH_ENV`. A harness that snapshots the user's shell inherits the
/// guarded order, because capturing the snapshot runs these same files.
const PATH_GUARD: &str =
    "if [ -n \"${ORX_BIN_DIR-}\" ] && [ \"${PATH%%:*}\" != \"$ORX_BIN_DIR\" ]; then\n\
     export PATH=\"$ORX_BIN_DIR${PATH:+:$PATH}\"\n\
     fi\n";

/// Directory holding the running `orx`; None if relative (PATH would resolve it against the
/// agent's cwd) or if it contains the PATH separator.
fn orx_bin_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // A rebuild under a live `orx up` leaves current_exe unresolvable on Linux;
    // the un-canonicalized path still names the right directory.
    let exe = crate::paths::canonicalize(&exe).unwrap_or(exe);
    exe.parent()
        .filter(|dir| {
            dir.is_absolute()
                && !dir
                    .to_string_lossy()
                    .contains(crate::local::shell_env::PATH_LIST_SEPARATOR)
        })
        .map(std::path::Path::to_path_buf)
}

fn shell_single_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

pub(super) fn zsh_startup_wrapper(name: &str) -> String {
    format!(
        "_ORX_CHAT_SHIM_ZDOTDIR=$ZDOTDIR\n\
         ZDOTDIR=$_ORX_CHAT_USER_ZDOTDIR\n\
         [[ -r \"$ZDOTDIR/{name}\" ]] && source \"$ZDOTDIR/{name}\"\n\
         _ORX_CHAT_USER_ZDOTDIR=$ZDOTDIR\n\
         ZDOTDIR=$_ORX_CHAT_SHIM_ZDOTDIR\n"
    ) + PATH_GUARD
}

pub(super) fn zshenv_hook(original_zdotdir: &std::path::Path) -> String {
    format!(
        "_ORX_CHAT_SHIM_ZDOTDIR=$ZDOTDIR\n\
         _ORX_CHAT_USER_ZDOTDIR={}\n\
         ZDOTDIR=$_ORX_CHAT_USER_ZDOTDIR\n\
         [[ -r \"$ZDOTDIR/.zshenv\" ]] && source \"$ZDOTDIR/.zshenv\"\n\
         _ORX_CHAT_USER_ZDOTDIR=$ZDOTDIR\n\
         ZDOTDIR=$_ORX_CHAT_SHIM_ZDOTDIR\n\
         export ORX_CHAT_TOOL_SCOPE=\"zsh-$$\"\n\
         export ORX_CHAT_TOOL_COMMAND=\"${{ZSH_EXECUTION_STRING-}}\"\n\
         if [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" && -r \"${{ORX_CHAT_TARGET_POINTER-}}\" ]]; then\n\
           export ORX_CHAT_TARGET_FILE=$(<\"$ORX_CHAT_TARGET_POINTER\")\n\
         elif [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" ]]; then\n\
           unset ORX_CHAT_TARGET_FILE\n\
         fi\n",
        shell_single_quote(original_zdotdir)
    ) + PATH_GUARD
}

pub(super) fn bash_env_hook(original: Option<String>) -> String {
    let source = original
        .map(|value| {
            format!(
                "_ORX_CHAT_USER_BASH_ENV={}\n\
                 eval \"_ORX_CHAT_USER_BASH_ENV=\\\"$_ORX_CHAT_USER_BASH_ENV\\\"\"\n\
                 [[ -r \"$_ORX_CHAT_USER_BASH_ENV\" ]] && source \"$_ORX_CHAT_USER_BASH_ENV\"\n",
                shell_single_quote(std::path::Path::new(&value))
            )
        })
        .unwrap_or_default();
    format!(
        "{source}\
         export ORX_CHAT_TOOL_SCOPE=\"bash-$$\"\n\
         export ORX_CHAT_TOOL_COMMAND=\"${{BASH_EXECUTION_STRING-}}\"\n\
         if [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" && -r \"${{ORX_CHAT_TARGET_POINTER-}}\" ]]; then\n\
           export ORX_CHAT_TARGET_FILE=$(<\"$ORX_CHAT_TARGET_POINTER\")\n\
         elif [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" ]]; then\n\
           unset ORX_CHAT_TARGET_FILE\n\
         fi\n"
    ) + PATH_GUARD
}

fn child_env_value(key: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(key).or_else(|| {
        crate::config::list_synced_env()
            .into_iter()
            .find_map(|(candidate, value)| (candidate == key).then(|| value.into()))
    })
}

/// Stamp the launching session id, this dashboard's data dir and the running orx's
/// bin dir onto a harness child's env, and write the shell hooks its tool calls source. Call *after*
/// `prepare_env` so a dashboard-synced value can't shadow either. Harness
/// children are one-per-session, so this is unambiguous.
pub fn set_chat_session_env(
    cmd: &mut tokio::process::Command,
    session_id: &str,
    harness: &str,
    up_port: Option<u16>,
) -> crate::error::Result<()> {
    cmd.env(CHAT_SESSION_ENV, session_id);
    cmd.env(CHAT_HARNESS_ENV, harness);
    // The agent's `orx` opens the store this dashboard serves, whatever a synced
    // `ORX_DATA_DIR` or the agent's own home would resolve.
    let data_dir = crate::commands::remote_host::canonical_data_dir().map_err(|error| {
        anyhow!("The agent could not be given this dashboard's data directory: {error:#}")
    })?;
    cmd.env("ORX_DATA_DIR", data_dir);
    cmd.env(LOCAL_SESSION_ENV, "1");
    // Never let a child inherit a port owned by some outer orx up process.
    match up_port {
        Some(port) => {
            cmd.env(UP_PORT_ENV, port.to_string());
            cmd.env(UP_VERSION_ENV, env!("CARGO_PKG_VERSION"));
        }
        None => {
            cmd.env_remove(UP_PORT_ENV);
            cmd.env_remove(UP_VERSION_ENV);
        }
    }
    match up_auth_token() {
        Some(token) => {
            cmd.env(UP_AUTH_TOKEN_ENV, token);
        }
        None => {
            cmd.env_remove(UP_AUTH_TOKEN_ENV);
        }
    }
    // PATH_GUARD joins on `:`, which a drive letter splits; on Windows only prepare_env's
    // fronting applies.
    #[cfg(windows)]
    cmd.env_remove(BIN_DIR_ENV);
    #[cfg(not(windows))]
    match orx_bin_dir() {
        Some(dir) => {
            cmd.env(BIN_DIR_ENV, dir);
        }
        None => {
            cmd.env_remove(BIN_DIR_ENV);
        }
    }
    cmd.env_remove(CHAT_TARGET_FILE_ENV);
    cmd.env_remove(CHAT_TARGET_POINTER_ENV);

    let shell_dir = shell_hook_dir(session_id);
    if std::fs::create_dir_all(&shell_dir).is_err() {
        return Ok(());
    }
    let original_zdotdir = child_env_value("ZDOTDIR")
        .map(PathBuf::from)
        .or_else(|| child_env_value("HOME").map(PathBuf::from));
    let Some(original_zdotdir) = original_zdotdir else {
        return Ok(());
    };
    let pointer = target_event_pointer(session_id);
    let zshenv = zshenv_hook(&original_zdotdir);
    let mut hooks = vec![(".zshenv", zshenv)];
    hooks.extend(
        [".zprofile", ".zshrc", ".zlogin", ".zlogout"]
            .into_iter()
            .map(|name| (name, zsh_startup_wrapper(name))),
    );
    if hooks
        .iter()
        .any(|(name, contents)| std::fs::write(shell_dir.join(name), contents).is_err())
    {
        return Ok(());
    }

    let bash_env = shell_dir.join("bash_env");
    let original_bash_env =
        child_env_value("BASH_ENV").map(|value| value.to_string_lossy().into_owned());
    let bash_hook = bash_env_hook(original_bash_env);
    if std::fs::write(&bash_env, bash_hook).is_err() {
        return Ok(());
    }

    cmd.env(CHAT_TARGET_POINTER_ENV, pointer);
    cmd.env("ZDOTDIR", shell_dir);
    cmd.env("BASH_ENV", bash_env);
    Ok(())
}

/// The chat session that launched this run, read from the env the harness child
/// exported (see [`set_chat_session_env`]). `None` for runs launched outside
/// chat — those intentionally poke no chat session on completion.
pub fn launching_chat_session() -> Option<String> {
    std::env::var(CHAT_SESSION_ENV)
        .ok()
        .filter(|s| !s.is_empty())
}

pub fn launching_chat_harness() -> Option<String> {
    std::env::var(CHAT_HARNESS_ENV)
        .ok()
        .filter(|harness| !harness.is_empty())
}

/// Whether this process is running inside a local `orx up` session.
/// [`LOCAL_SESSION_ENV`] is exported only by [`set_chat_session_env`] onto
/// `orx up` harness children, so its presence means this process is one (or a
/// subprocess of one). Project, experiment, and run commands resolve their ids
/// through `local::resolve`; this is for commands that take no such id.
pub fn in_local_session() -> bool {
    std::env::var(LOCAL_SESSION_ENV).is_ok_and(|v| !v.is_empty())
}

/// Resolve the trusted local server for an agent subprocess. A marked local
/// session must never silently fall back to launching workers from its sandbox.
pub fn trusted_up_port() -> Result<Option<u16>> {
    if !in_local_session() {
        return Ok(None);
    }
    let raw = std::env::var(UP_PORT_ENV).map_err(|_| {
        anyhow!("This agent session lost its link to the orx up server; restart `orx up`.")
    })?;
    let port = raw
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| {
            anyhow!("This agent session has an invalid orx up link; restart `orx up`.")
        })?;
    Ok(Some(port))
}

/// Append-only stderr sink for a harness child (startup/debug diagnostics).
pub fn harness_log(name: &str) -> Result<std::fs::File> {
    let path = crate::store::data_dir().join(format!("agent-{name}.log"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow!("Could not create {}: {}", parent.display(), e))?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| anyhow!("Could not open {}: {}", path.display(), e))
}

#[cfg(test)]
mod session_env_tests {
    use super::{
        in_local_session, launching_chat_harness, trusted_up_port, CHAT_HARNESS_ENV,
        CHAT_SESSION_ENV, LOCAL_SESSION_ENV, UP_PORT_ENV,
    };
    fn run_in_isolated_process(name: &str) -> bool {
        crate::test_support::run_isolated(
            &format!("local::chat::session_env::session_env_tests::{name}"),
            &[
                CHAT_HARNESS_ENV,
                CHAT_SESSION_ENV,
                LOCAL_SESSION_ENV,
                UP_PORT_ENV,
                "ORX_INVOCATION_CONTEXT",
            ],
        )
    }

    /// The cloud box's opencode plugin exports CHAT_SESSION_ENV for experiment
    /// attribution. That must not read as a local `orx up` session, or
    /// `orx skill` serves the Local skill bodies on every cloud box.
    #[test]
    fn chat_session_alone_is_not_a_local_session() {
        if run_in_isolated_process("chat_session_alone_is_not_a_local_session") {
            return;
        }

        std::env::set_var(CHAT_SESSION_ENV, "ses_cloud_box");
        assert!(!in_local_session());

        std::env::set_var(CHAT_HARNESS_ENV, "opencode");
        assert_eq!(launching_chat_harness().as_deref(), Some("opencode"));

        std::env::set_var(LOCAL_SESSION_ENV, "1");
        assert!(in_local_session());
    }

    /// `orx up` handling a caller's run reads launch evidence only from the request, never from
    /// its own environment.
    #[test]
    fn forwarded_runs_ignore_the_servers_launch_environment() {
        if run_in_isolated_process("forwarded_runs_ignore_the_servers_launch_environment") {
            return;
        }
        std::env::set_var(CHAT_SESSION_ENV, "server-session");
        std::env::set_var(
            "ORX_INVOCATION_CONTEXT",
            r#"{"harness":"codex","model":"gpt-6-sol","provider":null}"#,
        );
        let local = crate::compute::tests::tinker_args();
        assert_eq!(
            local.launching_chat_session().as_deref(),
            Some("server-session")
        );
        assert!(local.invocation_identity().unwrap().is_some());
        let forwarded = crate::ExpRunArgs {
            forwarded: true,
            ..crate::compute::tests::tinker_args()
        };
        assert_eq!(forwarded.launching_chat_session(), None);
        assert!(forwarded.invocation_identity().unwrap().is_none());
    }

    #[test]
    fn empty_local_marker_is_not_a_local_session() {
        if run_in_isolated_process("empty_local_marker_is_not_a_local_session") {
            return;
        }
        std::env::set_var(LOCAL_SESSION_ENV, "");
        assert!(!in_local_session());
    }

    #[test]
    fn local_session_requires_a_valid_trusted_port() {
        if run_in_isolated_process("local_session_requires_a_valid_trusted_port") {
            return;
        }
        std::env::set_var(LOCAL_SESSION_ENV, "1");
        assert!(trusted_up_port().is_err());

        std::env::set_var(UP_PORT_ENV, "5203");
        assert_eq!(trusted_up_port().unwrap(), Some(5203));
    }

    /// A data dir saved in the synced env must not split an agent's `orx` from the store
    /// this dashboard serves.
    #[test]
    fn agents_open_the_dashboards_store() {
        if crate::test_support::run_isolated(
            "local::chat::session_env::session_env_tests::agents_open_the_dashboards_store",
            &["ORX_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"],
        ) {
            return;
        }
        let home = std::env::temp_dir().join(format!("orx-test-home-{}", uuid::Uuid::new_v4()));
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_DATA_HOME", home.join("share"));
        std::env::set_var("XDG_CONFIG_HOME", home.join("config"));
        let synced = home.join(".openresearch/env");
        std::fs::create_dir_all(synced.parent().unwrap()).unwrap();
        std::fs::write(&synced, "export ORX_DATA_DIR='/elsewhere'\n").unwrap();
        let mut cmd = tokio::process::Command::new("agent");
        super::prepare_env(&mut cmd);
        super::set_chat_session_env(&mut cmd, "session", "claude", None).unwrap();
        let pinned = cmd
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == "ORX_DATA_DIR")
            .and_then(|(_, value)| value);
        let served = crate::commands::remote_host::canonical_data_dir().unwrap();
        assert_eq!(pinned, Some(served.as_os_str()));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// An agent left on whatever store its environment names could split from the dashboard.
    #[test]
    fn an_unusable_data_dir_stops_the_agent_launch() {
        if crate::test_support::run_isolated(
            "local::chat::session_env::session_env_tests::an_unusable_data_dir_stops_the_agent_launch",
            &["ORX_DATA_DIR"],
        ) {
            return;
        }
        let file = std::env::temp_dir().join(format!("orx-not-a-dir-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, "").unwrap();
        let data_dir = file.join("data");
        std::env::set_var("ORX_DATA_DIR", &data_dir);
        let mut cmd = tokio::process::Command::new("agent");
        let error = super::set_chat_session_env(&mut cmd, "session", "claude", None).unwrap_err();
        let _ = std::fs::remove_file(&file);
        assert!(
            error.to_string().contains(&data_dir.display().to_string()),
            "{error}"
        );
    }
}
