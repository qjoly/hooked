//! Effects: commands in the service's checkout, the service's HTTP API, the service manager.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::Value;

/// deploy/npm-deps.sh as of this build of the launcher, so a branch that predates the script
/// still gets the stamp rule deploy/service-run.sh applies.
pub const NPM_DEPS: &str = include_str!("../../../deploy/npm-deps.sh");

/// desktop/scripts/install-app as of this build of the launcher, so a branch that predates the
/// script still gets its desktop app installed.
pub const INSTALL_APP: &str = include_str!("../../scripts/install-app");

pub const SERVICE_LABEL: &str = "com.hooked.dashboard";

/// Whether a switch also updates the desktop app. Absent, nobody uses it here: no Rust and Zig
/// toolchain, nor a 5 GB build, is imposed for it. Its old "hooked (Rune).app" name does not count;
/// `mise run desktop` migrates it.
pub fn desktop_app_installed() -> bool {
    cfg!(target_os = "macos") && Path::new("/Applications/hooked.app").exists()
}

/// The checkout the service runs from. `HOOKED_REPO` wins; otherwise the repository this crate was
/// built in, and when that is a linked worktree, its main checkout, since that is where the service
/// lives.
pub fn repo() -> PathBuf {
    if let Ok(p) = std::env::var("HOOKED_REPO") {
        return p.into();
    }
    let built = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    // The system git (not the login environment, which takes seconds to resolve): this runs at
    // startup.
    let common = Command::new("/usr/bin/git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(&built)
        .output();
    common
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let dir = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Path::new(&dir).parent().map(Path::to_path_buf)
        })
        .unwrap_or(built)
}

/// The login shell's environment, resolved once. Started from the Finder, the app gets launchd's
/// bare PATH: no mise, node or npm. Same probe as `loginEnv()` in server/agent.js.
fn login_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.extend(probe_login_env().unwrap_or_default());
        env.retain(|k, _| {
            !matches!(k.as_str(), "PWD" | "OLDPWD" | "SHLVL" | "_")
                && !k.starts_with("TMUX")
                && !k.starts_with("__MISE_")
        });
        env
    })
}

fn probe_login_env() -> Option<HashMap<String, String>> {
    const SENTINEL: &str = "__HOOKED_LAUNCHER_ENV__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &format!("printf '{SENTINEL}\\0'; env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Its own process group, so the deadline below also kills what the profile started.
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().ok()?.is_none() {
        if Instant::now() > deadline {
            // SAFETY: plain syscall on the group this probe leads.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = String::from_utf8_lossy(&reader.join().ok()?).into_owned();
    let block = out.split_once(&format!("{SENTINEL}\0"))?.1;
    let env: HashMap<String, String> = block
        .split('\0')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    env.contains_key("PATH").then_some(env)
}

/// A command run in `repo`, with the login environment. Appends the command line and its output
/// to `log`; returns stdout, or a one-line error.
pub fn run(
    log: &mut String,
    repo: &Path,
    argv: &[&str],
    envs: &[(&str, &str)],
    input: Option<&str>,
) -> Result<String, String> {
    log.push_str(&format!("$ {}\n", argv.join(" ")));
    let mut child = Command::new(argv[0])
        .args(&argv[1..])
        .current_dir(repo)
        .env_clear()
        .envs(login_env())
        .envs(envs.iter().copied())
        // A fetch must fail rather than wait on a credential prompt nobody sees.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            log.push_str(&format!("{e}\n"));
            format!("{}: {e}", argv[0])
        })?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    log.push_str(&stdout);
    log.push_str(&String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!("`{}` failed ({})", argv.join(" "), out.status))
    }
}

pub fn git(log: &mut String, repo: &Path, args: &[&str]) -> Result<String, String> {
    let argv: Vec<&str> = std::iter::once("git").chain(args.iter().copied()).collect();
    run(log, repo, &argv, &[], None)
}

/// A git read whose output is all that matters.
pub fn query(repo: &Path, args: &[&str]) -> Result<String, String> {
    git(&mut String::new(), repo, args)
}

pub fn base_url() -> String {
    std::env::var("HOOKED_URL").unwrap_or_else(|_| "http://localhost:4123".into())
}

pub fn get_json(path: &str, timeout: Duration) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_global(Some(timeout))
        .proxy(None)
        .build()
        .into();
    agent
        .get(&format!("{}{path}", base_url()))
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())
}

/// The only place that knows the service manager: launchd on macOS. A Linux port would call
/// `systemctl --user restart hooked-dashboard` here.
pub fn restart_service(log: &mut String, repo: &Path) -> Result<(), String> {
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    let target = format!("gui/{uid}/{SERVICE_LABEL}");
    run(log, repo, &["launchctl", "kickstart", "-k", &target], &[], None).map(drop)
}

/// Waits for the service's session list to answer, which needs the whole back end up.
pub fn wait_reachable(within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if get_json("/api/sessions", Duration::from_secs(5)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_app_parses_when_fed_on_stdin() {
        let mut child = Command::new("bash")
            .args(["-n", "-s"])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(INSTALL_APP.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// Fed on stdin, bash runs each line as it reads it: a command reading stdin would swallow the
    /// rest of the script. Wrapped in `main`, the whole script is read before anything runs.
    #[test]
    fn install_app_runs_only_once_fully_read() {
        assert!(INSTALL_APP.trim_end().ends_with("\nmain \"$@\""));
    }
}
