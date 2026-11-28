//! Stamps the build with the commit it comes from (`HOOKED_BUILD_COMMIT`, `HOOKED_BUILD_DATE`), so
//! that Settings can say which binary is running. `HOOKED_BUILD_COMMIT` set in the environment
//! wins, for a build made outside a git checkout.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

fn main() {
    let commit = std::env::var("HOOKED_BUILD_COMMIT")
        .ok()
        .filter(|c| !c.is_empty())
        .or_else(|| git(&["rev-parse", "--short=7", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    // Edits to what this crate is built from, not the rest of the repository.
    let dirty = git(&["status", "--porcelain", "--untracked-files=no", "--", "."]).is_some();
    let date = git(&["log", "-1", "--format=%cs"]).unwrap_or_default();
    println!(
        "cargo:rustc-env=HOOKED_BUILD_COMMIT={commit}{}",
        if dirty { "+" } else { "" }
    );
    println!("cargo:rustc-env=HOOKED_BUILD_DATE={date}");
    println!("cargo:rerun-if-env-changed=HOOKED_BUILD_COMMIT");
    // A new commit moves the branch's ref, not HEAD itself: both are watched.
    for path in [
        git(&["rev-parse", "--git-path", "HEAD"]),
        git(&["symbolic-ref", "-q", "HEAD"])
            .and_then(|r| git(&["rev-parse", "--git-path", &r])),
    ]
    .into_iter()
    .flatten()
    {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=ui/src");
}
