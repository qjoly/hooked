use std::fs;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::spool::{self, Input, Output};

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

fn read_input() -> Input {
    let raw = match arg("--input") {
        Some(p) => fs::read(p).unwrap_or_default(),
        None => {
            let mut buf = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut buf);
            buf
        }
    };
    serde_json::from_slice(&raw).unwrap_or_default()
}

fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:X}-{}", std::process::id())
}

/// Own process group, so a Ctrl-C on the waiting client doesn't take the shared window down.
fn spawn_daemon() {
    let Ok(exe) = std::env::current_exe() else { return };
    let log = fs::OpenOptions::new().create(true).append(true).open(spool::spool_dir().join("daemon.log"));
    let (out, err) = match log.and_then(|f| Ok((f.try_clone()?, f))) {
        Ok((a, b)) => (Stdio::from(a), Stdio::from(b)),
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    let _ = Command::new(exe).arg("--daemon").stdin(Stdio::null()).stdout(out).stderr(err).process_group(0).spawn();
}

pub fn run() -> ! {
    let Some(out_path) = arg("--output") else { die("missing --output") };
    let mut input = read_input();
    let id = new_id();
    input.id = Some(id.clone());

    let payload = serde_json::to_vec(&input).unwrap_or_else(|e| die(&format!("encode failed: {e}")));
    if let Err(e) = spool::write_atomic(&spool::request_path(&id), &payload) {
        die(&format!("enqueue failed: {e}"));
    }
    if !spool::daemon_alive() {
        spawn_daemon();
    }

    let result = spool::result_path(&id);
    loop {
        if let Ok(raw) = fs::read(&result)
            && let Ok(out) = serde_json::from_slice::<Output>(&raw)
        {
            let _ = fs::write(&out_path, &raw);
            let _ = fs::remove_file(&result);
            std::process::exit(spool::exit_code(&out.decision));
        }
        if !spool::daemon_alive() && !result.exists() {
            spawn_daemon();
        }
        sleep(Duration::from_millis(250));
    }
}
