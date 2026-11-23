package dev.qjoly.hooked.data.dock

import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.state.costLabel
import kotlinx.serialization.json.JsonElement

// What desktop's dock (`view/dock.rs`) reads from GET /api/session, and its pure helpers.

data class DockTodo(val content: String, val status: String, val activeForm: String?) {
    /** The in-progress item reads its active form, as rune does. */
    val label get() = if (status == "in_progress") activeForm ?: content else content
}

data class DockChange(val file: String, val name: String?, val edits: Int) {
    val label get() = name ?: file.substringAfterLast('/')
}

data class DockSub(val id: String, val label: String?)

data class DockAgent(
    val id: String,
    val type: String,
    val description: String,
    val prompt: String,
    val result: String,
    val model: String,
    val totalTokens: Double,
    val durationMs: Double,
    val cost: Double,
    val agentId: String?,
) {
    val kind get() = type.ifEmpty { "agent" }
    val label get() = if (description.isEmpty()) kind else "$kind · $description"

    /** "opus-4-8 · 1200 tokens · 42s · $0.12". */
    val meta get() = "${model.removePrefix("claude-")} · ${totalTokens.toLong()} tokens · ${Math.round(durationMs / 1000.0)}s · ${costLabel(cost)}"
}

data class DockWorkflow(val name: String, val status: String, val doneCount: Double, val agentCount: Double) {
    val state get() = when (status) {
        "running" -> "working"
        "failed", "error", "killed" -> "attention"
        "completed", "done" -> "ended"
        else -> "idle"
    }
    val progress get() = "${Math.round(doneCount)}/${Math.round(agentCount)}"
}

data class DockJob(
    val taskId: String,
    val description: String,
    val label: String,
    val command: String,
    val done: Boolean,
    val exitCode: Long?,
    val doneReason: String,
) {
    val title get() = description.ifEmpty { label }
    val state get() = when {
        !done -> "working"
        exitCode != null && exitCode != 0L -> "attention"
        else -> "ended"
    }
    val status get() = if (!done) "running" else exitCode?.let { "exit $it" } ?: doneReason
}

data class DockShot(val path: String, val name: String, val ts: String)

data class DockData(
    val todos: List<DockTodo> = emptyList(),
    val changes: List<DockChange> = emptyList(),
    val subagents: List<DockAgent> = emptyList(),
    val subSessions: List<DockSub> = emptyList(),
    val workflows: List<DockWorkflow> = emptyList(),
    val bgJobs: List<DockJob> = emptyList(),
    val prLinks: List<String> = emptyList(),
    val issueLinks: List<String> = emptyList(),
    val screenshots: List<DockShot> = emptyList(),
) {
    val links get() = prLinks + issueLinks

    val hasContent get() = todos.isNotEmpty() || changes.isNotEmpty() || subagents.isNotEmpty() || subSessions.isNotEmpty() ||
        workflows.isNotEmpty() || bgJobs.isNotEmpty() || links.isNotEmpty() || screenshots.isNotEmpty()

    // Card header counts, as rune words them.
    val todoCount get() = "${todos.count { it.status == "completed" }}/${todos.size}"
    val todoProgress get() = if (todos.isEmpty()) 0f else todos.count { it.status == "completed" }.toFloat() / todos.size
    val changeCount get() = "${changes.size} file${if (changes.size == 1) "" else "s"}"
    val workflowCount get() = workflows.count { it.status == "running" }.let { if (it > 0) "$it running" else workflows.size.toString() }
    val agentCount get() = "${subagents.size} · ${costLabel(subagents.sumOf { it.cost })}"
    val jobCount get() = "${bgJobs.count { !it.done }} running · ${bgJobs.size}"

    /** Folded, the card shows what is in progress then the next three pending items. */
    fun shownTodos(open: Boolean) =
        if (open) todos else todos.filter { it.status == "in_progress" } + todos.filter { it.status == "pending" }.take(3)

    /** Running jobs first, in their original order otherwise. */
    val sortedJobs get() = bgJobs.sortedBy { it.done }

    /** Newest first, by the timestamp string as rune sorts it. */
    val sortedShots get() = screenshots.sortedByDescending { it.ts }

    companion object {
        const val CHANGES_FOLDED = 6
        const val AGENTS_FOLDED = 3
        const val JOBS_FOLDED = 3
        const val SHOTS_FOLDED = 4
        const val SHOTS_OPEN = 60

        fun of(j: JsonElement?) = DockData(
            todos = j["todos"].arr.map { DockTodo(it["content"].str.orEmpty(), it["status"].str.orEmpty(), it["activeForm"].text) },
            changes = j["changes"].arr.map { DockChange(it["file"].str.orEmpty(), it["name"].text, it["ops"].arr.size) },
            subagents = j["subagents"].arr.map {
                DockAgent(
                    id = it["id"].str.orEmpty(),
                    type = it["type"].str.orEmpty(),
                    description = it["description"].str.orEmpty(),
                    prompt = it["prompt"].str.orEmpty(),
                    result = it["result"].str.orEmpty(),
                    model = it["model"].str.orEmpty(),
                    totalTokens = it["totalTokens"].dbl ?: 0.0,
                    durationMs = it["durationMs"].dbl ?: 0.0,
                    cost = it["cost"].dbl ?: 0.0,
                    agentId = it["agentId"].text,
                )
            },
            subSessions = j["subSessions"].arr.mapNotNull { s -> s["id"].text?.let { DockSub(it, s["label"].text) } },
            workflows = j["workflows"].arr.map {
                DockWorkflow(it["name"].str.orEmpty(), it["status"].str.orEmpty(), it["doneCount"].dbl ?: 0.0, it["agentCount"].dbl ?: 0.0)
            },
            bgJobs = j["bgJobs"].arr.map {
                DockJob(
                    taskId = it["taskId"].str.orEmpty(),
                    description = it["description"].str.orEmpty(),
                    label = it["label"].str.orEmpty(),
                    command = it["command"].str.orEmpty(),
                    done = it["done"].bool,
                    exitCode = it["exitCode"].dbl?.toLong(),
                    doneReason = it["doneReason"].str.orEmpty(),
                )
            },
            prLinks = j["prLinks"].arr.mapNotNull { it.text },
            issueLinks = j["issueLinks"].arr.mapNotNull { it.text },
            screenshots = j["screenshots"].arr.mapNotNull { s -> s["path"].text?.let { DockShot(it, s["name"].str.orEmpty(), s["ts"].str.orEmpty()) } },
        )
    }
}

/** "+N more · open Review →" while folded with more than six files, else "Open Review →". */
fun reviewLinkLabel(files: Int, open: Boolean) =
    if (files > DockData.CHANGES_FOLDED && !open) "+${files - DockData.CHANGES_FOLDED} more · open Review →" else "Open Review →"

/** rune's `first_line`: the first non-blank line, trimmed, cut to `max` characters. */
fun firstLine(s: String, max: Int): String {
    val line = s.lines().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    return if (line.length > max) line.take(max) + "…" else line
}

/** rune's `strip_ansi`: CSI and OSC sequences go, a lone carriage return becomes a newline. */
fun stripAnsi(s: String): String {
    val out = StringBuilder(s.length)
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            c == '\u001b' && i + 1 < s.length && s[i + 1] == '[' -> {
                i += 2
                while (i < s.length && s[i] !in '@'..'~') i++
            }
            c == '\u001b' && i + 1 < s.length && s[i + 1] == ']' -> {
                i += 2
                while (i < s.length && s[i] != '\u0007' && !(s[i] == '\u001b' && i + 1 < s.length && s[i + 1] == '\\')) i++
                if (i < s.length && s[i] == '\u001b') i++
            }
            c == '\u001b' -> {}
            c == '\r' -> if (i + 1 >= s.length || s[i + 1] != '\n') out.append('\n')
            else -> out.append(c)
        }
        i++
    }
    return out.toString()
}

const val JOB_LOG_CAP = 65_536

/** Appends a log chunk, keeping the last 64 KB. */
fun appendLog(log: String, chunk: String, cap: Int = JOB_LOG_CAP): String {
    val all = log + chunk
    return if (all.length > cap) all.substring(all.length - cap) else all
}

/** The last 200 lines of a job log, or the waiting note. */
fun logTail(log: String, lines: Int = 200): String {
    val tail = log.lines().let { if (it.lastOrNull()?.isEmpty() == true) it.dropLast(1) else it }.takeLast(lines)
    return if (tail.isEmpty()) "waiting for output…" else tail.joinToString("\n")
}

/** rune's `fmt::span`: "42s", "5min", "3h", "2d". */
fun span(ms: Long): String {
    val s = ms.coerceAtLeast(0) / 1000
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}min"
        s < 86_400 -> "${s / 3600}h"
        else -> "${s / 86_400}d"
    }
}

/** rune's `fmt::ago_short`: "—" without a time, "now" under ten seconds. */
fun agoShort(at: Long?, now: Long): String = when {
    at == null -> "—"
    now - at < 10_000 -> "now"
    else -> span(now - at)
}
