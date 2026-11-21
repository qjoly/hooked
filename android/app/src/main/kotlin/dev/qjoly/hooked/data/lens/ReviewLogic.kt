package dev.qjoly.hooked.data.lens

import dev.qjoly.hooked.data.str
import kotlinx.serialization.json.JsonObject
import java.net.URI

// desktop's lenses.rs and defs.rs, minus the UI: how the Review lens cuts changes into diff
// sections, keys the threads left on them, and briefs Claude.

/** Where a diff section's threads are filed: the absolute path and the web lens's section key. */
data class Anchor(val file: String, val key: String)

/** The diff sections on screen, their anchors, and (Working tree, several repos) each one's repo. */
data class DiffSet(val files: List<FileDiff>, val anchors: List<Anchor>, val repos: List<String> = emptyList())

enum class ReviewSource { CLAUDE, WORKTREE, TREE, BRANCH }

/** Rust's `str::lines`: no trailing empty line, `\r\n` folded. */
fun rustLines(s: String): List<String> {
    if (s.isEmpty()) return emptyList()
    val out = s.split('\n').map { it.removeSuffix("\r") }
    return if (s.endsWith('\n')) out.dropLast(1) else out
}

fun relative(path: String, root: String?): String =
    root?.let { r -> if (path.startsWith(r)) path.removePrefix(r).trimStart('/') else null } ?: path

/** One recorded edit replayed on `text`. */
fun applyOp(text: String, o: JsonObject): String {
    fun s(k: String) = o[k].str.orEmpty()
    return when (o["kind"].str) {
        "write" -> s("content")
        "notebook" -> text
        else -> {
            val old = s("old")
            val new = s("new")
            when {
                old.isEmpty() -> if (text.isEmpty()) new else text
                o["all"].str == "true" -> text.replace(old, new)
                else -> text.replaceFirst(old, new)
            }
        }
    }
}

/** The prompt an op belongs to: the last one sent before it. */
fun opTurn(turns: List<ChangeTurn>, o: JsonObject): Int {
    val ts = o["ts"].str.orEmpty()
    var idx = turns.firstOrNull()?.turn ?: 0
    for (t in turns) {
        if (t.ts <= ts) idx = t.turn else break
    }
    return idx
}

/** The web keys a filtered section as `sel:` plus the turns sorted as strings, the way JavaScript sorts by default. */
fun turnsKey(selected: Set<Int>): String = "sel:" + selected.map { it.toString() }.sorted().joinToString(",")

/** Claude's edits restricted to the selected prompts: one section replayed from the original when the server rebuilt it, else each op alone. */
fun filteredDiffs(changes: List<Change>, turns: List<ChangeTurn>, selected: Set<Int>, root: String?): DiffSet {
    val key = turnsKey(selected)
    val out = ArrayList<FileDiff>()
    val anchors = ArrayList<Anchor>()
    for (c in changes) {
        val path = relative(c.file, root)
        val picked = c.rawOps.indices.filter { opTurn(turns, c.rawOps[it]) in selected }
        val first = picked.firstOrNull() ?: continue
        val last = picked.last()
        val orig = c.original
        if (orig != null) {
            var text: String = orig
            var before = ""
            var after = ""
            for ((j, o) in c.rawOps.withIndex()) {
                if (j == first) before = text
                text = applyOp(text, o)
                if (j == last) after = text
            }
            out += FileDiff.fromTexts(path, before, after)
            anchors += Anchor(c.file, key)
        } else {
            for (j in picked) {
                val o = c.rawOps[j]
                out += FileDiff.fromTexts("$path · edit ${j + 1}", o["old"].str.orEmpty(), o["new"].str ?: o["content"].str.orEmpty())
                anchors += Anchor(c.file, "$key:$j")
            }
        }
    }
    return DiffSet(out, anchors)
}

/** One diff per op, anchored `(file, key:opIndex)` as the web lens files its threads. */
fun fileDiffs(changes: List<Change>, root: String?, key: String): DiffSet {
    val out = ArrayList<FileDiff>()
    val anchors = ArrayList<Anchor>()
    for (c in changes) {
        val path = relative(c.file, root)
        val n = c.ops.size
        for ((i, op) in c.ops.withIndex()) {
            val label = if (n > 1) "$path · edit ${i + 1}/$n" else path
            out += FileDiff.fromTexts(label, op["old"].str.orEmpty(), op["new"].str ?: op["content"].str.orEmpty())
            anchors += Anchor(c.file, "$key:$i")
        }
    }
    return DiffSet(out, anchors)
}

/** The uncommitted changes of every detected repo, one after the other, named when there are several. */
fun treeDiffs(repos: List<Repo>, root: String?): DiffSet {
    val several = repos.size > 1
    val files = ArrayList<FileDiff>()
    val anchors = ArrayList<Anchor>()
    val names = ArrayList<String>()
    for (r in repos) {
        val d = fileDiffs(r.changes, root, "vcs:wt")
        if (several) repeat(d.files.size) { names += r.name }
        files += d.files
        anchors += d.anchors
    }
    return DiffSet(files, anchors, names)
}

/** The web's `'wtb:' + wtd.base`, so threads land on the same sections from either client. */
fun worktreeKey(wt: BaseDiff?) = "wtb:${wt?.base.orEmpty()}"

/** What a reviewed tick signs off: the file's diff as shown, so a later edit clears it. */
fun fingerprint(f: FileDiff): String {
    var h = 0x811c9dc5.toInt()
    var len = 0L
    fun feed(b: Int) {
        h = h xor (b and 0xff)
        h *= 0x01000193
        len++
    }
    for (l in f.hunks.flatMap { it.lines }) {
        feed(l.kind.ordinal)
        for (b in l.text.toByteArray(Charsets.UTF_8)) feed(b.toInt())
        feed(0)
    }
    return "${Integer.toHexString(h)}-${java.lang.Long.toHexString(len)}"
}

const val REVIEWED_PER_FILE = 12

/** The anchor a thread names in prompts and lists: `+L3`, `−L4–9`. */
fun threadAnchor(t: ReviewThread, zeroEndIsLine: Boolean = true): String {
    val side = if (t.old) "−L" else "+L"
    return if (t.start == t.end || (zeroEndIsLine && t.end == 0)) "$side${t.start}" else "$side${t.start}–${t.end}"
}

data class ReviewBrief(val file: String, val anchor: String, val text: String)

private fun briefList(threads: List<ReviewBrief>) = threads.joinToString("\n") { t ->
    "- ${t.file} (${t.anchor}): ${(rustLines(t.text).firstOrNull() ?: "").take(160)}"
}

/** Where a session dials hooked: same machine, the port the app reaches it on. */
fun reviewApi(base: String?): String {
    val port = runCatching { URI(base ?: "").port }.getOrNull()?.takeIf { it > 0 } ?: 4123
    return "http://localhost:$port/api/review"
}

/** The web's `reviewRequestPrompt`, word for word. */
fun reviewRequestPrompt(session: String, scope: String, rev: String?, files: List<String>, open: List<ReviewBrief>, dismissed: List<ReviewBrief>, api: String): String {
    val list = files.joinToString("\n") { "- $it" }
    val lines = if (rev != null) "1-based lines of the file at revision $rev (git show $rev:<path>), i.e. the new side of the diff"
    else "1-based lines of the file as it is on disk now, i.e. the new side of the diff"
    val out = StringBuilder(
        "Review $scope. Files under review:\n$list\n\n" +
            "Look for real problems — bugs, wrong behaviour, unhandled cases, risky changes — and for " +
            "simplifications worth making. Check each finding against the code before reporting it; skip " +
            "style nits. Do NOT change any code: this is a review, fixes come once I answer in the threads.\n\n" +
            "Report EACH finding as its own inline thread with the hooked MCP tool " +
            "mcp__hooked__add_review_comment (id: \"$session\", file: absolute path, line / end_line: " +
            "$lines; text: what is wrong, why it matters and the fix you suggest, in Markdown). If that MCP " +
            "tool is unavailable, POST each finding to the local hooked API instead: curl -sS -X POST $api " +
            "-H 'content-type: application/json' -d '{\"id\":\"$session\",\"action\":\"claude-comment\"," +
            "\"file\":\"<path>\",\"start\":<line>,\"end\":<end_line>,\"text\":\"<finding>\"}'. " +
            "Keep your chat answer to a one-line summary (how many threads you opened) — the findings " +
            "belong in the threads.",
    )
    if (open.isNotEmpty()) out.append("\n\nThese threads are already open, do not raise them again:\n").append(briefList(open))
    if (dismissed.isNotEmpty()) out.append("\n\nThese were dismissed by the reviewer, do not raise them again:\n").append(briefList(dismissed))
    return out.toString()
}

/** The unsent comments as one prompt, in the shape the web lens sends them. */
fun sendReviewPrompt(session: String, scope: String, pending: List<ReviewThread>, api: String): String {
    val items = pending.mapIndexed { n, t ->
        val a = if (t.start == 0) 1 else t.start
        val b = if (t.end == 0) 1 else t.end
        val p = if (t.old) "−L" else "+L"
        val anchor = if (a == b) "$p$b" else "$p$a–$b"
        val body = t.text.replace("\n", "\n   > ")
        val snip = rustLines(t.snippet).joinToString("\n") { "   | $it" }
        "${n + 1}) ${t.file} ($anchor) [thread_id: ${t.id}]\n   > $body\n   Relevant code:\n$snip"
    }
    return "I reviewed $scope and left the following inline comments. Address each one, then, for each: " +
        "Reply in the thread with the hooked MCP tool mcp__hooked__reply_review_comment (id: \"$session\", thread_id above). " +
        "Do NOT close the thread — closing is the reviewer's call, and there is no tool for it. If that MCP tool is " +
        "unavailable, POST the same reply to the local hooked API instead: curl -sS -X POST $api -H 'content-type: application/json' " +
        "-d '{\"id\":\"$session\",\"action\":\"reply\",\"threadId\":\"<thread_id>\",\"text\":\"<your reply>\",\"author\":\"claude\"}'. " +
        "Keep your chat answer to a one-line summary — the details belong in the thread.\n\n" +
        items.joinToString("\n\n")
}

/** Whether a thread's section key matches an anchor's: exactly, or any section of a `base:*` scope. */
fun keyMatches(threadKey: String, anchorKey: String): Boolean {
    val scoped = threadKey.removeSuffix(":*").takeIf { threadKey.endsWith(":*") }
    return if (scoped != null) anchorKey.startsWith("$scoped:") else anchorKey == threadKey
}

/** The diff section a thread sits on, if it is on screen. */
fun anchorOf(anchors: List<Anchor>, t: ReviewThread): Int? =
    anchors.indexOfFirst { it.file == t.file && keyMatches(t.opIndex, it.key) }.takeIf { it >= 0 }

private val KEYWORDS = setOf(
    "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "crate", "def", "default", "do", "dyn",
    "else", "enum", "export", "extends", "false", "fn", "for", "from", "func", "function", "if", "impl", "import", "in",
    "interface", "let", "loop", "match", "mod", "mut", "new", "nil", "None", "null", "pub", "return", "self", "Self", "Some",
    "static", "struct", "super", "switch", "this", "throw", "trait", "true", "try", "type", "typeof", "undefined", "use",
    "var", "where", "while", "with", "yield", "Ok", "Err",
)

fun isIdent(s: String): Boolean {
    if (s.isEmpty()) return false
    val f = s[0]
    return (f.isLetter() || f == '_' || f == '$') && s.all { it.isLetterOrDigit() || it == '_' || it == '$' }
}

/** The identifiers a line mentions, in order, once, without keywords, strings or one-letter names. */
fun identifiers(line: String): List<String> {
    val out = ArrayList<String>()
    val cur = StringBuilder()
    var inStr: Char? = null
    fun flush() {
        val w = cur.toString()
        if (w.length > 1 && isIdent(w) && w !in KEYWORDS && w !in out) out += w
        cur.clear()
    }
    for (ch in line) {
        if (inStr != null) {
            if (ch == inStr) inStr = null
            continue
        }
        when {
            ch == '"' || ch == '\'' || ch == '`' -> {
                flush()
                inStr = ch
            }
            ch.isLetterOrDigit() || ch == '_' || ch == '$' -> if (!(cur.isEmpty() && ch in '0'..'9')) cur.append(ch)
            else -> flush()
        }
    }
    flush()
    return out
}

/** Lines of context the definition card opens with around its target, and adds per step. */
const val DEF_PAD = 12
const val DEF_STEP = 20
