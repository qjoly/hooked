package dev.qjoly.hooked.state

// rune's export.rs, itself the web's `conversationToMarkdown`: an export reads the same from every client.

private fun longestBackticks(text: String): Int {
    var best = 0
    var run = 0
    for (c in text) {
        run = if (c == '`') run + 1 else 0
        best = maxOf(best, run)
    }
    return best
}

fun codeFence(text: String): String {
    val fence = "`".repeat(maxOf(longestBackticks(text) + 1, 3))
    return "$fence\n$text\n$fence"
}

fun inlineCode(text: String): String {
    val d = "`".repeat(longestBackticks(text) + 1)
    val pad = if (text.startsWith('`') || text.endsWith('`')) " " else ""
    return "$d$pad$text$pad$d"
}

private fun toolBlock(t: ToolCall): String {
    val out = StringBuilder("**🔧 ${t.name}**")
    t.detail?.takeIf { it.isNotEmpty() }?.let { out.append(" — ${inlineCode(it)}") }
    t.inputText?.takeIf { it.isNotEmpty() }?.let { out.append("\n\n${codeFence(it)}") }
    t.result?.takeIf { it.isNotEmpty() }?.let { out.append("\n\n<details><summary>result</summary>\n\n${codeFence(it)}\n</details>") }
    return out.toString()
}

private fun message(m: Turn): String {
    val ts = m.tsRaw?.let { " · $it" }.orEmpty()
    if (m.role == "system") return "> ${m.text}$ts\n"
    val who = when {
        m.user && m.auto -> "↻ Auto-resumed"
        m.user -> "🧑 You"
        else -> "🤖 Claude"
    }
    val body = m.parts.map { p ->
        when (p) {
            is TurnPart.Text -> p.text
            is TurnPart.Call -> toolBlock(p.tool)
        }
    }.filter { it.isNotEmpty() }
    return "### $who$ts\n\n${body.joinToString("\n\n")}\n"
}

fun conversationMarkdown(c: Conversation): String {
    val head = mutableListOf("# ${c.title ?: c.id}", "", "- **Session**: `${c.id}`")
    c.project?.let { head += "- **Project**: $it" }
    c.model?.let { head += "- **Model**: $it" }
    c.startTs?.let { head += "- **Started**: $it" }
    c.lastTs?.let { head += "- **Last**: $it" }
    head += listOf("", "---", "")
    return head.joinToString("\n") + c.turns.joinToString("\n---\n\n", transform = ::message)
}
