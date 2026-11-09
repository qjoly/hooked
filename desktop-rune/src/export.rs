use crate::api::{Detail, Message, Part, Tool};

fn longest_backticks(text: &str) -> usize {
    let (mut best, mut run) = (0, 0);
    for c in text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        best = best.max(run);
    }
    best
}

fn code_fence(text: &str) -> String {
    let fence = "`".repeat((longest_backticks(text) + 1).max(3));
    format!("{fence}\n{text}\n{fence}")
}

fn inline_code(text: &str) -> String {
    let d = "`".repeat(longest_backticks(text) + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{d}{pad}{text}{pad}{d}")
}

fn tool_block(t: &Tool) -> String {
    let mut out = format!("**🔧 {}**", t.name);
    if let Some(d) = t.detail.as_deref().filter(|d| !d.is_empty()) {
        out.push_str(&format!(" — {}", inline_code(d)));
    }
    if let Some(i) = t.input_text.as_deref().filter(|i| !i.is_empty()) {
        out.push_str(&format!("\n\n{}", code_fence(i)));
    }
    if let Some(r) = t.result_text().filter(|r| !r.is_empty()) {
        out.push_str(&format!(
            "\n\n<details><summary>result</summary>\n\n{}\n</details>",
            code_fence(&r)
        ));
    }
    out
}

fn message(m: &Message) -> String {
    let ts =
        m.ts.as_deref()
            .map(|t| format!(" · {t}"))
            .unwrap_or_default();
    if m.role == "system" {
        return format!("> {}{ts}\n", m.text);
    }
    let who = match (m.role.as_str(), m.auto) {
        ("user", true) => "↻ Auto-resumed",
        ("user", false) => "🧑 You",
        _ => "🤖 Claude",
    };
    let body: Vec<String> = m
        .render_parts()
        .into_iter()
        .map(|p| match p {
            Part::Text(t) => t,
            Part::Tool(t) => tool_block(&t),
        })
        .filter(|b| !b.is_empty())
        .collect();
    format!("### {who}{ts}\n\n{}\n", body.join("\n\n"))
}

/// The web's `conversationToMarkdown`, so an export reads the same from either client.
pub fn conversation(d: &Detail) -> String {
    let x = &d.session;
    let mut head = vec![
        format!("# {}", x.title.clone().unwrap_or_else(|| x.id.clone())),
        String::new(),
        format!("- **Session**: `{}`", x.id),
    ];
    if let Some(p) = x.project.as_deref() {
        head.push(format!("- **Project**: {p}"));
    }
    if let Some(m) = x.model.as_deref() {
        head.push(format!("- **Model**: {m}"));
    }
    if let Some(t) = d.start_ts.as_deref() {
        head.push(format!("- **Started**: {t}"));
    }
    if let Some(t) = d.last_ts.as_deref() {
        head.push(format!("- **Last**: {t}"));
    }
    head.extend([String::new(), "---".into(), String::new()]);
    let body: Vec<String> = d.messages.iter().map(message).collect();
    head.join("\n") + &body.join("\n---\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_outgrow_the_code() {
        assert_eq!(code_fence("a ``` b"), "````\na ``` b\n````");
        assert_eq!(inline_code("`x`"), "`` `x` ``");
    }
}
