package dev.qjoly.hooked.data.dock

import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.str
import kotlinx.serialization.json.JsonElement

// desktop's ghdetail.rs, ghrun.rs and the link helpers of fmt.rs / app.rs, kept pure.

/** A pull or merge request link, as the dock's Links card tells them from issues. */
fun isPullLink(url: String) = "/pull/" in url || "/merge_requests/" in url

/** "repo #12" for a GitHub link, "repo !12" for a GitLab merge request, as the web's `prLabel`. */
fun linkLabel(url: String): String {
    val segs = url.split('/')
    val gh = segs.indexOfFirst { it.endsWith("github.com") }
    if (gh >= 0) {
        val repo = segs.getOrNull(gh + 2)
        val kind = segs.getOrNull(gh + 3)
        val n = segs.getOrNull(gh + 4)
        if (repo != null && n != null && (kind == "pull" || kind == "issues")) return "$repo #$n"
    }
    val dash = segs.indexOf("-")
    if (dash > 0) {
        val kind = segs.getOrNull(dash + 1)
        val n = segs.getOrNull(dash + 2)
        if (kind != null && n != null) {
            val sigil = when (kind) {
                "merge_requests" -> "!"
                "issues", "work_items" -> "#"
                else -> return url
            }
            return "${segs[dash - 1]} $sigil$n"
        }
    }
    return url
}

/** The number a nav tab shows: "#" and the last path segment. */
fun linkNumber(url: String) = "#" + url.substringAfterLast('/')

/** Failed first, then cancelled, then running, then the rest. */
fun checkRank(status: String) = when (status) {
    "failed" -> 0
    "cancelled" -> 1
    "pending" -> 2
    else -> 9
}

/** The dock's coarser order: failing, running, done. */
fun dockCheckRank(status: String) = when (status) {
    "failed", "cancelled" -> 0
    "pending" -> 1
    else -> 2
}

fun checkLabel(status: String) = when (status) {
    "passed" -> "Passed"
    "failed" -> "Failed"
    "cancelled" -> "Cancelled"
    "pending" -> "Running"
    "skipped" -> "Skipped"
    else -> "Neutral"
}

/** The state dot of a check, a run, a job or a step (`view/ghrun.rs::state_of`). */
fun checkState(status: String) = when (status) {
    "failed", "cancelled" -> "attention"
    "pending" -> "background"
    "passed" -> "working"
    else -> "idle"
}

/** A one-line check summary and its tone: "ko", "wait" or "ok". */
data class ChecksSummary(val label: String, val tone: String)

/** The detail header's wording; `dock` is the inline Links card's longer one. */
fun checksSummary(statuses: List<String>, dock: Boolean = false): ChecksSummary? {
    if (statuses.isEmpty()) return null
    val n = statuses.size
    val failing = statuses.count { it == "failed" || it == "cancelled" }
    val running = statuses.count { it == "pending" }
    val noun = if (dock) " checks" else ""
    return when {
        failing > 0 -> ChecksSummary("$failing of $n$noun failing", "ko")
        running > 0 -> ChecksSummary("$running of $n$noun running", "wait")
        else -> ChecksSummary("All checks passed", "ok")
    }
}

/** The state badge of a detail: label and tone (open, merged, closed, muted). A closed issue reads as done. */
fun detailState(kind: String, state: String): Pair<String, String> = when {
    state == "CLOSED" && kind == "issue" -> "Closed" to "merged"
    state == "OPEN" -> "Open" to "open"
    state == "DRAFT" -> "Draft" to "muted"
    state == "MERGED" -> "Merged" to "merged"
    state == "CLOSED" -> "Closed" to "closed"
    state == "NOT_PLANNED" -> "Not planned" to "muted"
    else -> "Unknown" to "muted"
}

/** The review decision as a badge, or null. */
fun decisionBadge(decision: String): Pair<String, String>? = when (decision) {
    "APPROVED" -> "Approved" to "ok"
    "CHANGES_REQUESTED" -> "Changes requested" to "ko"
    "REVIEW_REQUIRED" -> "Review required" to "wait"
    else -> null
}

/** What the dock sends when "Fix in this thread" is pressed, word for word as the web. */
fun fixPrompt(name: String, checkUrl: String, prUrl: String): String {
    val logs = if (checkUrl.isEmpty()) "" else " (logs: $checkUrl)"
    return "The CI check \"$name\" fails on $prUrl$logs. Investigate why and fix it."
}

/** A comment's folded preview: markdown marks dropped, whitespace flattened, 120 characters. */
fun commentExcerpt(body: String) =
    body.filter { it !in "#*`>_[]" }.map { if (it.isWhitespace()) ' ' else it }.take(120).joinToString("")

fun changeLetter(change: String) = when (change) {
    "ADDED" -> "A"
    "DELETED" -> "D"
    "RENAMED" -> "R"
    "MODIFIED" -> "M"
    else -> "·"
}

/** The verb of a timeline event and its tint ("ok", "ko" or "faint"). */
fun timelineVerb(kind: String, state: String): Pair<String, String> = when (kind) {
    "commit" -> "committed" to "faint"
    "review" -> when (state) {
        "APPROVED" -> "approved" to "ok"
        "CHANGES_REQUESTED" -> "requested changes" to "ko"
        "DISMISSED" -> "dismissed" to "faint"
        "COMMENTED" -> "reviewed" to "faint"
        else -> state.lowercase() to "faint"
    }
    else -> "commented" to "faint"
}

enum class PatchKind { META, HUNK, ADD, DEL, CTX }

data class PatchLine(val kind: PatchKind, val text: String) {
    val sign get() = when (kind) {
        PatchKind.ADD -> "+"
        PatchKind.DEL -> "-"
        else -> " "
    }
}

/** A unified diff split into typed lines; the `+`/`-`/` ` prefix is stripped inside hunks. */
fun patchLines(patch: String): List<PatchLine> {
    var inHunk = false
    val lines = patch.lines().let { if (it.lastOrNull()?.isEmpty() == true) it.dropLast(1) else it }
    return lines.map { l ->
        when {
            l.startsWith("@@") -> {
                inHunk = true
                PatchLine(PatchKind.HUNK, l)
            }
            l.startsWith("diff --git ") -> {
                inHunk = false
                PatchLine(PatchKind.META, l)
            }
            !inHunk -> PatchLine(PatchKind.META, l)
            l.startsWith("+") -> PatchLine(PatchKind.ADD, l.substring(1))
            l.startsWith("-") -> PatchLine(PatchKind.DEL, l.substring(1))
            else -> PatchLine(PatchKind.CTX, l.removePrefix(" "))
        }
    }
}

const val MAX_PATCH_LINES = 2000

/** `https://github.com/o/r/actions/runs/1[/job/2]` → the job id, empty for a bare run; null otherwise. */
fun parseRunUrl(url: String): String? {
    val rest = url.removePrefix("https://github.com/").takeIf { it != url } ?: return null
    val parts = rest.split('?', '#').first().trimEnd('/').split('/')
    fun digits(s: String) = s.isNotEmpty() && s.all { it.isDigit() }
    return when {
        parts.size == 5 && parts[2] == "actions" && parts[3] == "runs" && digits(parts[4]) -> ""
        parts.size == 7 && parts[2] == "actions" && parts[3] == "runs" && digits(parts[4]) && parts[5] == "job" && digits(parts[6]) -> parts[6]
        else -> null
    }
}

/** Where a link goes: a hooked session opens here, a GitHub Actions run in the run window, the rest outside. */
sealed interface LinkTarget {
    data class Session(val id: String) : LinkTarget
    data class Run(val url: String) : LinkTarget
    data class Open(val url: String) : LinkTarget
}

fun linkTarget(raw: String, base: String): LinkTarget {
    val url = raw.trim()
    if (parseRunUrl(url) != null) return LinkTarget.Run(url)
    if (url.startsWith("/session/")) {
        val id = url.removePrefix("/session/").split('?', '#', '/').first()
        if (id.isNotEmpty()) return LinkTarget.Session(id)
    }
    return LinkTarget.Open(
        when {
            "://" in url || url.startsWith("mailto:") -> url
            url.startsWith("/") -> base.trimEnd('/') + url
            else -> "https://$url"
        },
    )
}

data class RunStep(val name: String, val status: String, val startedAt: Long?, val completedAt: Long?) {
    val duration get() = runDuration(startedAt, completedAt)
}

data class RunJob(val id: String, val name: String, val url: String, val status: String, val startedAt: Long?, val completedAt: Long?, val steps: List<RunStep>) {
    val duration get() = runDuration(startedAt, completedAt)
}

/** GET /api/github/run: a GitHub Actions run and its jobs. */
data class GhRun(
    val title: String, val workflow: String, val status: String, val url: String,
    val branch: String, val event: String, val attempt: Int, val updatedAt: Long?, val jobs: List<RunJob>,
) {
    /** The job the window shows: the picked one, else the first failing, running, or any. */
    fun job(picked: String?): RunJob? =
        picked?.let { id -> jobs.firstOrNull { it.id == id } }
            ?: jobs.firstOrNull { it.status == "failed" }
            ?: jobs.firstOrNull { it.status == "pending" }
            ?: jobs.firstOrNull()

    companion object {
        fun of(j: JsonElement?) = GhRun(
            title = j["title"].str.orEmpty(),
            workflow = j["workflow"].str.orEmpty(),
            status = j["status"].str.orEmpty(),
            url = j["url"].str.orEmpty(),
            branch = j["branch"].str.orEmpty(),
            event = j["event"].str.orEmpty(),
            attempt = j["attempt"].int ?: 1,
            updatedAt = j["updatedAt"].millis,
            jobs = j["jobs"].arr.map { job ->
                RunJob(
                    id = job["id"].str.orEmpty(),
                    name = job["name"].str.orEmpty(),
                    url = job["url"].str.orEmpty(),
                    status = job["status"].str.orEmpty(),
                    startedAt = job["startedAt"].millis,
                    completedAt = job["completedAt"].millis,
                    steps = job["steps"].arr.map { RunStep(it["name"].str.orEmpty(), it["status"].str.orEmpty(), it["startedAt"].millis, it["completedAt"].millis) },
                )
            },
        )
    }
}

/** A run duration between two instants, "" when either is missing. */
fun runDuration(start: Long?, end: Long?): String = if (start == null || end == null) "" else span(end - start)
