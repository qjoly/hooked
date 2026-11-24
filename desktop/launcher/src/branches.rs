//! The branch list, built from git's output without touching git.

/// `git for-each-ref --format` matching `parse_refs`: fields split by the unit separator, which
/// cannot appear in a ref name or a one-line subject.
pub const REF_FORMAT: &str =
    "%(refname:lstrip=3)%1f%(objectname)%1f%(subject)%1f%(authorname)%1f%(committerdate:unix)";

pub const MAIN: &str = "main";

#[derive(Clone, Debug, PartialEq)]
pub struct Branch {
    pub name: String,
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// Commit time, Unix seconds.
    pub time: i64,
}

pub fn parse_refs(out: &str) -> Vec<Branch> {
    out.lines()
        .filter_map(|line| {
            let mut f = line.split('\x1f');
            let b = Branch {
                name: f.next()?.to_string(),
                sha: f.next()?.to_string(),
                subject: f.next()?.to_string(),
                author: f.next()?.to_string(),
                time: f.next()?.trim().parse().ok()?,
            };
            // `origin/HEAD` is a pointer to the default branch, not a branch.
            (b.name != "HEAD").then_some(b)
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub branch: Branch,
    /// The service runs a build of this branch.
    pub running: bool,
    /// Running, and the branch has commits the build lacks.
    pub update: bool,
}

/// What the service runs: the checkout's branch (None when detached) and the commit its build was
/// made from (`build/.hooked-src-commit`).
#[derive(Clone, Debug, Default)]
pub struct Running {
    pub branch: Option<String>,
    pub commit: Option<String>,
}

/// `main` first, then the unmerged branches, newest first. The running branch stays listed even
/// once merged, so the list always says what runs. `behind(commit, tip)` says whether `tip`
/// descends from `commit` (git merge-base --is-ancestor).
pub fn rows(
    all: Vec<Branch>,
    unmerged: &[String],
    running: &Running,
    behind: impl Fn(&str, &str) -> bool,
) -> Vec<Row> {
    let is_running = |b: &Branch| match (&running.branch, &running.commit) {
        (Some(name), _) => *name == b.name,
        (None, Some(commit)) => *commit == b.sha,
        (None, None) => false,
    };
    let mut rows: Vec<Row> = all
        .into_iter()
        .filter(|b| b.name == MAIN || unmerged.contains(&b.name) || is_running(b))
        .map(|b| {
            let running_here = is_running(&b);
            let update = running_here
                && running
                    .commit
                    .as_deref()
                    .is_some_and(|c| c != b.sha && behind(c, &b.sha));
            Row { branch: b, running: running_here, update }
        })
        .collect();
    rows.sort_by(|a, b| {
        (b.branch.name == MAIN)
            .cmp(&(a.branch.name == MAIN))
            .then(b.branch.time.cmp(&a.branch.time))
    });
    rows
}

pub fn ago(now: i64, then: i64) -> String {
    let s = (now - then).max(0);
    match s {
        0..60 => "just now".into(),
        60..3600 => format!("{} min ago", s / 60),
        3600..86_400 => format!("{} h ago", s / 3600),
        86_400..2_592_000 => format!("{} d ago", s / 86_400),
        _ => format!("{} mo ago", s / 2_592_000),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branch(name: &str, sha: &str, time: i64) -> Branch {
        Branch { name: name.into(), sha: sha.into(), subject: String::new(), author: String::new(), time }
    }

    #[test]
    fn parses_for_each_ref_output_and_drops_head() {
        let out = "HEAD\x1fa\x1fs\x1fme\x1f1\n\
                   feat/x\x1fb\x1ffeat: x\x1fAda\x1f1700000000\n\
                   broken line\n";
        assert_eq!(
            parse_refs(out),
            [Branch {
                name: "feat/x".into(),
                sha: "b".into(),
                subject: "feat: x".into(),
                author: "Ada".into(),
                time: 1_700_000_000,
            }]
        );
    }

    #[test]
    fn lists_main_first_then_unmerged_branches_newest_first() {
        let all = vec![
            branch("old", "1", 10),
            branch("main", "2", 5),
            branch("merged", "3", 50),
            branch("new", "4", 30),
        ];
        let unmerged = ["old".to_string(), "new".to_string()];
        let names: Vec<_> = rows(all, &unmerged, &Running::default(), |_, _| false)
            .into_iter()
            .map(|r| r.branch.name)
            .collect();
        assert_eq!(names, ["main", "new", "old"]);
    }

    #[test]
    fn marks_the_running_branch_even_merged_and_flags_an_update() {
        let all = vec![branch("main", "2", 5), branch("merged", "3", 50)];
        let running = Running { branch: Some("merged".into()), commit: Some("0".into()) };
        let rows = rows(all, &[], &running, |c, tip| c == "0" && tip == "3");
        let r = rows.iter().find(|r| r.branch.name == "merged").unwrap();
        assert!(r.running && r.update);
        assert!(!rows[0].running);
    }

    #[test]
    fn no_update_when_the_build_is_ahead_of_its_branch() {
        let running = Running { branch: Some("main".into()), commit: Some("local".into()) };
        let rows = rows(vec![branch("main", "2", 5)], &[], &running, |_, _| false);
        assert!(rows[0].running && !rows[0].update);
    }

    #[test]
    fn detached_checkout_is_found_by_its_commit() {
        let running = Running { branch: None, commit: Some("4".into()) };
        let rows = rows(vec![branch("main", "2", 5), branch("x", "4", 1)], &["x".into()], &running, |_, _| false);
        assert!(rows[1].running && !rows[1].update);
    }

    #[test]
    fn says_how_long_ago() {
        assert_eq!(ago(100, 90), "just now");
        assert_eq!(ago(4000, 0), "1 h ago");
        assert_eq!(ago(3 * 86_400, 0), "3 d ago");
    }
}
