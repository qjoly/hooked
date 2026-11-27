//! The web's `extensions/flows/lib/flows.js`, the parts the native Flows page needs: the pipeline's columns
//! (a stage's depth in the graph) and how a stage or a run reads at a glance.

use serde_json::Value;
use std::collections::HashMap;

/// Tone of a status, mapped to theme colours by the view.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tone {
    Ok,
    Run,
    Warn,
    Bad,
    Loop,
    Idle,
}

fn after(stage: &Value) -> Vec<&str> {
    stage["after"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

/// Stage keys grouped by column, in declaration order: 0 for roots, else one past the deepest
/// stage it waits on. A cycle (the server refuses one) flattens to a single column.
pub fn columns(stages: &[Value]) -> Vec<Vec<String>> {
    let keys: Vec<&str> = stages.iter().filter_map(|s| s["key"].as_str()).collect();
    let by: HashMap<&str, &Value> = stages
        .iter()
        .filter_map(|s| Some((s["key"].as_str()?, s)))
        .collect();
    let mut depth: HashMap<&str, usize> = HashMap::new();
    fn visit<'a>(
        k: &'a str,
        by: &HashMap<&'a str, &'a Value>,
        depth: &mut HashMap<&'a str, usize>,
        stack: &mut Vec<&'a str>,
    ) -> Option<usize> {
        if let Some(d) = depth.get(k) {
            return Some(*d);
        }
        if stack.contains(&k) {
            return None;
        }
        stack.push(k);
        let mut d = 0;
        for a in after(by.get(k)?) {
            if by.contains_key(a) {
                d = d.max(visit(a, by, depth, stack)? + 1);
            }
        }
        stack.pop();
        depth.insert(k, d);
        Some(d)
    }
    for k in &keys {
        if visit(k, &by, &mut depth, &mut Vec::new()).is_none() {
            return vec![keys.iter().map(|k| k.to_string()).collect()];
        }
    }
    let mut cols: Vec<Vec<String>> = Vec::new();
    for k in &keys {
        let d = depth[k];
        if cols.len() <= d {
            cols.resize(d + 1, Vec::new());
        }
        cols[d].push(k.to_string());
    }
    cols.retain(|c| !c.is_empty());
    cols
}

/// How a stage of a run reads: a short label and its tone.
pub fn stage_look(st: &Value) -> (&'static str, Tone) {
    let status = st["status"].as_str().unwrap_or("pending");
    if st["starting"] == true || status == "starting" {
        return ("starting", Tone::Run);
    }
    match status {
        "done" => match st["report"]["verdict"].as_str() {
            Some("loop") => ("looped back", Tone::Loop),
            Some("escalate") => ("escalated", Tone::Warn),
            _ if st["report"]["byUser"] == true => ("done (by you)", Tone::Ok),
            _ => ("done", Tone::Ok),
        },
        "stalled" => ("stalled: needs you", Tone::Warn),
        "lost" => ("session lost", Tone::Bad),
        "running" if st["waiting"] == true => ("waiting on you", Tone::Warn),
        "running" if st["report"].is_object() => ("reported, wrapping up", Tone::Run),
        "running" => ("working", Tone::Run),
        _ => ("pending", Tone::Idle),
    }
}

/// The run's badge, as the web's `runBadge`.
pub fn run_badge(run: &Value) -> (&'static str, Tone) {
    match run["status"].as_str().unwrap_or("") {
        "done" => ("done", Tone::Ok),
        "stopped" => ("stopped", Tone::Idle),
        "failed" => ("failed", Tone::Bad),
        "needs-you" => ("needs you", Tone::Warn),
        _ => {
            let stuck = run["stages"]
                .as_object()
                .into_iter()
                .flatten()
                .any(|(_, s)| {
                    matches!(s["status"].as_str(), Some("stalled" | "lost")) || s["waiting"] == true
                });
            if stuck {
                ("needs you", Tone::Warn)
            } else {
                ("running", Tone::Run)
            }
        }
    }
}

/// The run's stage definitions, in order.
pub fn stages(run: &Value) -> Vec<Value> {
    run["flow"]["stages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

pub fn decider(run: &Value) -> Option<Value> {
    stages(run).into_iter().find(|s| s["decider"] == true)
}

/// Whether some stage still has to run (Continue only makes sense then).
pub fn has_pending(run: &Value) -> bool {
    run["stages"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(_, s)| s["status"].as_str() != Some("done"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feature() -> Vec<Value> {
        json!([
            { "key": "pilot", "after": [] },
            { "key": "build", "after": ["pilot"] },
            { "key": "review", "after": ["build"] },
            { "key": "challenge", "after": ["build"] },
            { "key": "decide", "after": ["review", "challenge"], "decider": true },
        ])
        .as_array()
        .cloned()
        .unwrap()
    }

    #[test]
    fn lays_out_the_feature_pipeline() {
        assert_eq!(
            columns(&feature()),
            vec![
                vec!["pilot"],
                vec!["build"],
                vec!["review", "challenge"],
                vec!["decide"]
            ]
        );
    }

    #[test]
    fn flattens_a_cycle() {
        let s = json!([{ "key": "a", "after": ["b"] }, { "key": "b", "after": ["a"] }]);
        assert_eq!(columns(s.as_array().unwrap()), vec![vec!["a", "b"]]);
    }

    #[test]
    fn reads_stage_states() {
        assert_eq!(stage_look(&json!({ "status": "pending" })).1, Tone::Idle);
        assert_eq!(
            stage_look(&json!({ "status": "running", "waiting": true })).0,
            "waiting on you"
        );
        assert_eq!(
            stage_look(&json!({ "status": "done", "report": { "verdict": "loop" } })).1,
            Tone::Loop
        );
        assert_eq!(
            stage_look(&json!({ "status": "pending", "starting": true })).0,
            "starting"
        );
    }

    #[test]
    fn flags_a_stuck_run() {
        let run = json!({ "status": "running", "stages": { "a": { "status": "stalled" } } });
        assert_eq!(run_badge(&run).0, "needs you");
        let run = json!({ "status": "running", "stages": { "a": { "status": "running" } } });
        assert_eq!(run_badge(&run).0, "running");
    }
}
