package dev.qjoly.hooked.ui.lens

import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import dev.qjoly.hooked.data.lens.changesOf
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.SessionDetail
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.body
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.lens.Anchor
import dev.qjoly.hooked.data.lens.Annotation
import dev.qjoly.hooked.data.lens.BaseDiff
import dev.qjoly.hooked.data.lens.Change
import dev.qjoly.hooked.data.lens.ChangeTurn
import dev.qjoly.hooked.data.lens.DEF_PAD
import dev.qjoly.hooked.data.lens.DEF_STEP
import dev.qjoly.hooked.data.lens.DiffMode
import dev.qjoly.hooked.data.lens.LineRange
import dev.qjoly.hooked.data.lens.LineRef
import dev.qjoly.hooked.data.lens.REVIEWED_PER_FILE
import dev.qjoly.hooked.data.lens.Repo
import dev.qjoly.hooked.data.lens.ReviewBrief
import dev.qjoly.hooked.data.lens.ReviewSource
import dev.qjoly.hooked.data.lens.ReviewThread
import dev.qjoly.hooked.data.lens.Side
import dev.qjoly.hooked.data.lens.anchorOf
import dev.qjoly.hooked.data.lens.covered
import dev.qjoly.hooked.data.lens.fileDiffs
import dev.qjoly.hooked.data.lens.filePieces
import dev.qjoly.hooked.data.lens.filteredDiffs
import dev.qjoly.hooked.data.lens.fingerprint
import dev.qjoly.hooked.data.lens.fullChange
import dev.qjoly.hooked.data.lens.identifiers
import dev.qjoly.hooked.data.lens.isIdent
import dev.qjoly.hooked.data.lens.isMarkdown
import dev.qjoly.hooked.data.lens.pieceAt
import dev.qjoly.hooked.data.lens.reviewApi
import dev.qjoly.hooked.data.lens.reviewOp
import dev.qjoly.hooked.data.lens.reviewRequestPrompt
import dev.qjoly.hooked.data.lens.reviewThreads
import dev.qjoly.hooked.data.lens.sendReviewPrompt
import dev.qjoly.hooked.data.lens.sessionChanges
import dev.qjoly.hooked.data.lens.sourceSlice
import dev.qjoly.hooked.data.lens.symbolLookup
import dev.qjoly.hooked.data.lens.threadAnchor
import dev.qjoly.hooked.data.lens.treeDiffs
import dev.qjoly.hooked.data.lens.turnsKey
import dev.qjoly.hooked.data.lens.vcsBaseDiff
import dev.qjoly.hooked.data.lens.vcsBlame
import dev.qjoly.hooked.data.lens.vcsBranch
import dev.qjoly.hooked.data.lens.vcsBranches
import dev.qjoly.hooked.data.lens.vcsChanges
import dev.qjoly.hooked.data.lens.worktreeKey
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.span
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The definition card's steps, as defs.rs `DefState`. */
sealed interface DefState {
    data object Choose : DefState
    data object Loading : DefState
    data class Note(val msg: String) : DefState
    data class Items(val items: List<JsonElement>, val refsOnly: Boolean) : DefState
    data class Source(val target: JsonElement, val from: Int, val to: Int, val data: JsonElement? = null, val err: String? = null) : DefState
}

/** Go to definition, opened as a card under the line it was asked from. */
data class DefPeek(val file: Int, val side: Side, val line: Int, val path: String, val rev: String, val choices: List<String>, val symbol: String?, val state: DefState)

data class Draft(val range: LineRange, val text: String)

/** A scroll the lens asks of its lists; the view performs it, since it owns the frame clock. */
sealed interface ScrollTo {
    data class File(val file: Int) : ScrollTo
    data class Line(val file: Int, val at: LineRef) : ScrollTo
    data class Block(val index: Int) : ScrollTo
}

private fun sourceState(target: JsonElement): DefState.Source {
    val line = target["line"].int ?: 1
    return DefState.Source(target, maxOf(line - DEF_PAD, 1), line + DEF_PAD)
}

/** The Review lens of one session, as desktop-rune's `LensData` and its `Hooked` methods. */
class ReviewModel(val id: String, private val prefs: LensPrefs) : ViewModel() {
    private var app: AppModel? = null
    private var session: SessionModel? = null
    private val client: HookedClient? get() = app?.client
    private val detail: SessionDetail? get() = session?.detail

    private var host: LensHost? = null

    fun bind(app: AppModel, session: SessionModel, host: LensHost? = null) {
        this.app = app
        this.session = session
        this.host = host
    }

    private fun say(text: String) = app?.say(text)

    var source by mutableStateOf(ReviewSource.CLAUDE)
        private set
    val diff = DiffState(prefs.diffSplit)
    var diffSig by mutableStateOf<String?>(null)
    var diffLoading by mutableStateOf(false)
    var diffCount by mutableStateOf(0)
    var asking by mutableStateOf(false)
    var scroll by mutableStateOf<ScrollTo?>(null)

    var changes by mutableStateOf<List<Change>>(emptyList())
    var changeTurns by mutableStateOf<List<ChangeTurn>>(emptyList())

    /** The activity stamp Claude's edits were read at; null until the first read. */
    var changesAt by mutableStateOf<String?>(null)
    private var changesLoading = false
    var turns by mutableStateOf<Set<Int>>(emptySet())
    var full by mutableStateOf<Map<String, Change?>>(emptyMap())
    private var blame by mutableStateOf<Map<Pair<String, String>, JsonElement?>>(emptyMap())
    var blameAt by mutableStateOf<Triple<Int, Side, Int>?>(null)
    var def by mutableStateOf<DefPeek?>(null)
    var rendered by mutableStateOf(false)
    var renderedW by mutableStateOf(prefs.renderedW)
    val renderedList = LazyListState()
    var branches by mutableStateOf<JsonElement?>(null)
    var branchesLoading by mutableStateOf(false)
    var branch by mutableStateOf<String?>(null)
    var base by mutableStateOf<String?>(null)
    var branchRoot by mutableStateOf<String?>(null)
    var repos by mutableStateOf<List<Repo>>(emptyList())
    var fileRepos by mutableStateOf<List<String>>(emptyList())
    var worktree by mutableStateOf<BaseDiff?>(null)
    var commits by mutableStateOf<List<JsonElement>>(emptyList())
    var picked by mutableStateOf<List<String>>(emptyList())
    var branchOpen by mutableStateOf(false)
    var turnsOpen by mutableStateOf(false)
    var anchors by mutableStateOf<List<Anchor>>(emptyList())
    var threads by mutableStateOf<List<ReviewThread>>(emptyList())
    var draft by mutableStateOf<Draft?>(null)
    var replies by mutableStateOf<Map<String, String>>(emptyMap())
    var editing by mutableStateOf<Pair<String, String>?>(null)
    var threadsOpen by mutableStateOf(false)
    var deleteArmed by mutableStateOf<String?>(null)
    private var reviewed by mutableStateOf(prefs.reviewed())
    private var initialized = false

    private val fingerprints by derivedStateOf { diff.files.map(::fingerprint) }

    private fun launch(failure: String, block: suspend (HookedClient) -> Unit) {
        val c = client ?: return
        viewModelScope.launch {
            try {
                block(c)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say("✗ $failure: ${e.message}")
            }
        }
    }

    /** A worktree session opens on its Worktree scope, as rune picks on selection. */
    private fun initFor(d: SessionDetail) {
        if (initialized) return
        initialized = true
        if (d.session.worktreeOf != null) source = ReviewSource.WORKTREE
    }

    fun pickSource(src: ReviewSource) {
        if (source == src) return
        source = src
        diffSig = null
        diff.load(emptyList())
        fileRepos = emptyList()
    }

    fun setMode(mode: DiffMode) {
        diff.mode = mode
        prefs.diffSplit = mode == DiffMode.SPLIT
    }

    // Diff sources.

    fun reviewKeyBase(): String = when (source) {
        ReviewSource.CLAUDE -> if (turns.isEmpty()) "full" else turnsKey(turns)
        ReviewSource.WORKTREE -> worktreeKey(worktree)
        ReviewSource.TREE -> "vcs:wt"
        ReviewSource.BRANCH -> "br:${branchKey().orEmpty()}"
    }

    /** The picked commits as the range the server diffs, oldest first (`commits` is newest first). */
    fun branchRange(): Pair<String, String>? {
        val at = picked.mapNotNull { r -> commits.indexOfFirst { it["rev"].str == r }.takeIf { it >= 0 } }
        val lo = at.minOrNull() ?: return null
        val hi = at.max()
        val from = commits[hi]["rev"].str ?: return null
        val to = commits[lo]["rev"].str ?: return null
        return from to to
    }

    /** The web's `diffKey`: `root:base:branch`, plus `:@from..to` for a commit range. */
    fun branchKey(): String? {
        val pair = "${branchRoot ?: return null}:${base ?: return null}:${branch ?: return null}"
        return branchRange()?.let { (from, to) -> "$pair:@$from..$to" } ?: pair
    }

    /** What "Review" names in prompts, and the revision the new side's lines come from. */
    fun reviewScope(): Pair<String, String?> = when (source) {
        ReviewSource.BRANCH -> {
            val b = branch.orEmpty()
            val bs = base.orEmpty()
            branchRange()?.let { (from, to) -> "commits `${from.take(7)}`…`${to.take(7)}` of branch `$b` (based on `$bs`)" to to }
                ?: ("the full diff of branch `$b` against `$bs`" to b)
        }
        ReviewSource.WORKTREE -> "everything this worktree changed since it forked from `${worktree?.base.orEmpty()}` (commits and uncommitted edits)" to null
        ReviewSource.TREE -> "the uncommitted changes in the working tree" to null
        ReviewSource.CLAUDE -> if (turns.isNotEmpty()) {
            val labels = turns.sorted().map { "P${it + 1}" }
            "your changes for prompt${if (labels.size > 1) "s" else ""} ${labels.joinToString(", ")}" to null
        } else "your changes" to null
    }

    /** Everything `ensure` reads, so the view reruns it whenever one changes. */
    fun ensureKey(d: SessionDetail?): String = listOf(
        d?.session?.id, d?.session?.lastActivity, d?.session?.worktreeOf, source, changesAt, changes.size, turns.sorted(),
        full.values.count { it != null }, branchKey(), branches == null, branchesLoading, diffLoading, diffSig,
    ).joinToString("|")

    /** Starts whatever the lens is missing, as rune's `ensure_lens`. */
    fun ensure(d: SessionDetail?) {
        d ?: return
        initFor(d)
        if (source == ReviewSource.WORKTREE && d.session.worktreeOf == null) pickSource(ReviewSource.CLAUDE)
        val activity = d.session.lastActivity?.toString().orEmpty()
        val project = d.session.project
        // Read for every scope: the source picker counts Claude's edits.
        if (changesAt != activity && !changesLoading) loadChanges(activity)
        val sig = when (source) {
            ReviewSource.CLAUDE -> {
                if (changesAt == null) return
                "$id|claude|${changes.size}|${changes.hashCode()}|${turns.sorted()}|${full.values.count { it != null }}"
            }
            ReviewSource.WORKTREE -> "$id|worktree|$activity"
            ReviewSource.TREE -> "$id|tree|$activity"
            ReviewSource.BRANCH -> branchKey()?.let { "$id|branch|$it|$activity" } ?: run {
                if (branches == null && !branchesLoading) loadBranches(branchRoot)
                return
            }
        }
        if (diffSig == sig || diffLoading) return
        when (source) {
            ReviewSource.CLAUDE -> {
                val merged = changes.map { c -> full[c.file] ?: c }
                val set = if (turns.isEmpty()) fileDiffs(merged, project, "full") else filteredDiffs(merged, changeTurns, turns, project)
                diffCount = changes.size
                diff.load(set.files)
                anchors = set.anchors
                annotate()
                diffSig = sig
                loadThreads()
            }
            ReviewSource.BRANCH -> loadBranchDiff(sig)
            ReviewSource.TREE -> {
                val c = client ?: return
                diffLoading = true
                viewModelScope.launch {
                    try {
                        val list = c.vcsChanges(id)
                        diffCount = list.sumOf { it.changes.size }
                        val tree = treeDiffs(list, project)
                        diff.load(tree.files)
                        anchors = tree.anchors
                        fileRepos = tree.repos
                        annotate()
                        loadThreads()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        say("✗ Working tree: ${e.message}")
                    } finally {
                        diffLoading = false
                        diffSig = sig
                    }
                }
            }
            ReviewSource.WORKTREE -> {
                val c = client ?: return
                diffLoading = true
                viewModelScope.launch {
                    try {
                        val wt = c.vcsBaseDiff(id)
                        diffCount = wt.changes.size
                        val set = fileDiffs(wt.changes, wt.root, worktreeKey(wt))
                        worktree = wt
                        diff.load(set.files)
                        anchors = set.anchors
                        annotate()
                        loadThreads()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        say("✗ Worktree: ${e.message}")
                    } finally {
                        diffLoading = false
                        diffSig = sig
                    }
                }
            }
        }
    }

    private fun loadChanges(activity: String) {
        val c = client ?: return
        changesLoading = true
        viewModelScope.launch {
            try {
                // The pane already holds the session body; fetch only when it has none yet.
                val raw = session?.raw
                val (list, ts) = if (raw != null) withContext(Dispatchers.Default) { changesOf(raw) } else c.sessionChanges(id)
                changes = list
                changeTurns = ts
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            } finally {
                changesLoading = false
                changesAt = activity
            }
        }
    }

    private fun loadBranches(root: String?) {
        val c = client ?: return
        branchesLoading = true
        viewModelScope.launch {
            val v = try {
                c.vcsBranches(id, root)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                JsonObject(emptyMap())
            }
            val list = v["branches"].arr
            val names = list.mapNotNull { it["name"].str }
            val current = list.firstOrNull { it["current"].bool }?.get("name").str
            val default = v["default"].str
            if (branch == null || branch !in names) branch = current ?: default ?: names.firstOrNull()
            if (base == null || base !in names) base = default
            branchRoot = v["root"].str
            repos = v["repos"].arr.map(Repo::of)
            branches = v
            branchesLoading = false
        }
    }

    /** Branches are listed per repo, so the pair under review starts over in the new one. */
    fun selectRepo(root: String) {
        if (branchRoot == root) return
        branchRoot = root
        branches = null
        branch = null
        base = null
        picked = emptyList()
        commits = emptyList()
        diffSig = null
        diff.load(emptyList())
    }

    private fun loadBranchDiff(sig: String) {
        val b = branch ?: return
        val bs = base ?: return
        val root = branchRoot ?: return
        val range = branchRange()
        val key = branchKey().orEmpty()
        val c = client ?: return
        diffLoading = true
        viewModelScope.launch {
            try {
                val v = c.vcsBranch(id, b, bs, root, range)
                if (picked.isEmpty()) (v["commits"] as? JsonArray)?.let { commits = it }
                val list = v["changes"].arr.map(Change::of)
                diffCount = list.size
                val set = fileDiffs(list, v["root"].str, "br:$key")
                diff.load(set.files)
                anchors = set.anchors
                annotate()
                loadThreads()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say("✗ Branch: ${e.message}")
            } finally {
                diffLoading = false
                diffSig = sig
            }
        }
    }

    fun pickCommit(rev: String?) {
        picked = when {
            rev == null -> emptyList()
            rev in picked -> picked - rev
            else -> picked + rev
        }
    }

    fun setBranch(b: String?, bs: String?) {
        if (b != null) branch = b
        if (bs != null) base = bs
        picked = emptyList()
        commits = emptyList()
    }

    fun toggleTurn(turn: Int?) {
        turns = when {
            turn == null -> emptySet()
            turn in turns -> turns - turn
            else -> turns + turn
        }
    }

    /** The capped entry of a truncated file, until its full diff is loaded. */
    fun truncatedAt(file: Int): String? {
        if (source != ReviewSource.CLAUDE) return null
        val path = anchors.getOrNull(file)?.file ?: return null
        val change = changes.firstOrNull { it.file == path } ?: return null
        return path.takeIf { change.truncated && full[path] == null }
    }

    fun fullLoading(path: String) = full.containsKey(path)

    fun loadFullChange(path: String) {
        if (full.containsKey(path)) return
        full = full + (path to null)
        launch("Full diff") { c ->
            val change = runCatching { c.fullChange(id, path) }.getOrNull()
            if (change != null) {
                full = full + (path to change)
            } else {
                full = full - path
                say("✗ Could not load the full diff")
            }
        }
    }

    // Blame.

    /** Which revision a side of diff `file` comes from, when its line numbers are the file's. */
    fun blameRev(file: Int, side: Side): Pair<String, String>? {
        val a = anchors.getOrNull(file) ?: return null
        val rev = when {
            source == ReviewSource.TREE && side == Side.OLD -> "HEAD"
            (source == ReviewSource.TREE || source == ReviewSource.WORKTREE) && side == Side.NEW -> ""
            source == ReviewSource.WORKTREE -> worktree?.mergeBase ?: return null
            source == ReviewSource.CLAUDE && side == Side.NEW -> {
                val j = a.key.removePrefix("full:").takeIf { a.key.startsWith("full:") }?.toIntOrNull() ?: return null
                val c = changes.firstOrNull { it.file == a.file } ?: return null
                if (c.ops.getOrNull(j)?.get("kind").str == "write") "" else return null
            }
            else -> return null
        }
        return a.file to rev
    }

    fun blameLine(sel: LineRange?) {
        if (sel == null) {
            blameAt = null
            return
        }
        blameAt = Triple(sel.file, sel.start.side, sel.start.line)
        val key = blameRev(sel.file, sel.start.side) ?: return
        if (blame.containsKey(key)) return
        blame = blame + (key to null)
        val c = client ?: return
        viewModelScope.launch {
            val v = runCatching { c.vcsBlame(id, key.first, key.second) }.getOrNull()
            blame = blame + (key to v)
        }
    }

    /** The blame line for the selected diff line: null while nothing applies, else the text. */
    fun blameText(now: Long): String? {
        val (file, side, line) = blameAt ?: return null
        val key = blameRev(file, side) ?: return "L$line: no blame here, these line numbers are not the file's"
        val b = blame[key] ?: return "L$line: reading git blame…"
        if (!b["supported"].bool) return "L$line: not in a git repository"
        val entry = b["lines"].arr.getOrNull(maxOf(line - 1, 0))
        val shown = diff.files.getOrNull(file)?.hunks?.flatMap { it.lines }?.firstOrNull { it.number(side) == line }?.text
        if (entry == null || entry !is JsonObject || (shown != null && entry["t"].str != shown)) return "L$line: not committed yet"
        val c = b["commits"].arr.getOrNull(entry["c"].int ?: 0)
        if (c["uncommitted"].bool) return "L$line: not committed yet"
        val time = c["time"].int
        val whenAgo = time?.let { span(now - it * 1000L) + " ago" }.orEmpty()
        return "L$line · ${c["rev"].str.orEmpty()} · ${c["author"].str.orEmpty()} · $whenAgo · ${c["summary"].str.orEmpty()}"
    }

    // Rendered Markdown.

    /** A tap on a rendered block: select its source lines in the diff and scroll to them. */
    fun showMdSource(file: Int, side: Side, lines: IntRange) {
        val start = LineRef(side, lines.first)
        val sel = LineRange(file, start, LineRef(side, lines.last))
        diff.selection = sel
        scroll = ScrollTo.Line(file, start)
        blameLine(sel)
    }

    /** A tap on a line number: when the rendered Markdown shows that file, centre the block the line belongs to. */
    fun revealMdBlock(sel: LineRange?) {
        sel ?: return
        if (!rendered || sel.file != diff.visibleFile) return
        val f = diff.files.getOrNull(sel.file)?.takeIf { isMarkdown(it.path) } ?: return
        pieceAt(filePieces(f), sel.start.side, sel.start.line)?.let { scroll = ScrollTo.Block(it) }
    }

    fun onSelect(sel: LineRange?) {
        blameLine(sel)
        revealMdBlock(sel)
    }

    fun mdCovered(file: Int, pieces: List<dev.qjoly.hooked.data.lens.MdPiece>): IntRange? =
        diff.selection?.takeIf { it.file == file }?.let { covered(pieces, it) }

    // Reviewed ticks.

    private fun reviewKey(file: Int): Pair<String, String>? {
        val f = diff.files.getOrNull(file) ?: return null
        return "$id|${f.path}" to (fingerprints.getOrNull(file) ?: return null)
    }

    fun isReviewed(file: Int): Boolean = reviewKey(file)?.let { (k, fp) -> reviewed[k]?.contains(fp) == true } ?: false

    fun reviewedCount() = diff.files.indices.count(::isReviewed)

    /** Ticking a file moves on to the next one still to review, as the web lens does. */
    fun toggleReviewed(file: Int) {
        val (key, fp) = reviewKey(file) ?: return
        val seen = reviewed[key].orEmpty()
        val marking = fp !in seen
        val next = if (marking) (seen + fp).takeLast(REVIEWED_PER_FILE) else seen - fp
        reviewed = if (next.isEmpty()) reviewed - key else reviewed + (key to next)
        prefs.setReviewed(reviewed)
        if (marking) {
            val n = diff.files.size
            (1 until n).map { (file + it) % n }.firstOrNull { !isReviewed(it) }?.let { scroll = ScrollTo.File(it) }
        }
    }

    // Threads.

    fun loadThreads() {
        val c = client ?: return
        viewModelScope.launch {
            runCatching { c.reviewThreads(id) }.getOrNull()?.let {
                threads = it
                annotate()
            }
        }
    }

    /** Puts each thread, the comment being written and the definition card under the line they point at. */
    fun annotate() {
        val notes = ArrayList<Annotation>()
        for (t in threads) {
            val i = anchorOf(anchors, t) ?: continue
            val line = if (t.end > 0) t.end else if (t.start > 0) t.start else 1
            notes += Annotation(i, LineRef(if (t.old) Side.OLD else Side.NEW, line), t.id)
        }
        draft?.range?.let { r -> notes += Annotation(r.file, if (r.end.line >= r.start.line) r.end else r.start, "draft") }
        def?.let { notes += Annotation(it.file, LineRef(it.side, it.line), "def") }
        diff.annotations = notes
    }

    fun startComment(range: LineRange) {
        draft = Draft(range, "")
        annotate()
    }

    fun cancelComment() {
        draft = null
        annotate()
    }

    fun saveComment() {
        val d = draft ?: return
        draft = null
        val text = d.text.trim()
        val a = anchors.getOrNull(d.range.file) ?: return
        if (text.isEmpty()) {
            annotate()
            return
        }
        val lo = minOf(d.range.start.line, d.range.end.line)
        val hi = maxOf(d.range.start.line, d.range.end.line)
        val side = d.range.end.side
        val snippet = diff.files.getOrNull(d.range.file)?.hunks?.flatMap { it.lines }
            ?.filter { l -> l.number(side)?.let { it in lo..hi } == true }?.joinToString("\n") { it.text }.orEmpty()
        val thread = body(
            "file" to a.file, "name" to a.file.substringAfterLast('/'), "opIndex" to a.key,
            "side" to if (side == Side.OLD) "old" else "new", "start" to lo, "end" to hi, "snippet" to snippet, "text" to text,
        )
        reviewOp(body("id" to id, "action" to "comment", "thread" to thread))
    }

    private fun reviewOp(payload: JsonObject) {
        annotate()
        val c = client ?: return
        viewModelScope.launch {
            try {
                c.reviewOp(payload)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say("✗ Review: ${e.message}")
            }
            loadThreads()
        }
    }

    fun setReply(tid: String, text: String) {
        replies = replies + (tid to text)
    }

    fun replyThread(tid: String) {
        val text = replies[tid]?.trim().orEmpty()
        replies = replies - tid
        if (text.isNotEmpty()) reviewOp(body("id" to id, "action" to "reply", "threadId" to tid, "text" to text, "author" to "user"))
    }

    fun archiveThread(tid: String, archived: Boolean) = reviewOp(body("id" to id, "action" to "archive", "threadId" to tid, "archived" to archived))

    fun deleteThread(tid: String) = reviewOp(body("id" to id, "action" to "delete", "threadId" to tid))

    fun pendingThreads() = threads.filter { !it.sent && !it.archived }

    fun startEditThread(tid: String) {
        editing = tid to threads.firstOrNull { it.id == tid }?.text.orEmpty()
    }

    fun saveEditThread() {
        val (tid, text) = editing ?: return
        editing = null
        if (text.isNotBlank()) reviewOp(body("id" to id, "action" to "edit", "threadId" to tid, "text" to text.trim()))
    }

    fun jumpToThread(tid: String) {
        val t = threads.firstOrNull { it.id == tid } ?: return
        val i = anchorOf(anchors, t) ?: run {
            say("✗ That thread belongs to another diff source")
            return
        }
        scroll = ScrollTo.Line(i, LineRef(if (t.old) Side.OLD else Side.NEW, if (t.start > 0) t.start else 1))
    }

    private suspend fun sendPrompt(c: HookedClient, text: String) {
        // Through the pane's model, so the prompt shows as a queued bubble in Converse.
        val s = session
        if (s != null) {
            if (!s.sendPrompt(text)) throw IllegalStateException(s.actionError ?: "not sent")
            return
        }
        val d = detail ?: return
        if (d.session.live) c.reply(id, text) else c.resume(id, text, d.session.effort)
    }

    private val api get() = reviewApi(app?.config?.base)

    /** Claude reviews the diff on screen and opens a thread for each finding. */
    fun reviewWithClaude() {
        val base = reviewKeyBase()
        val files = anchors.map { it.file }.distinct()
        if (files.isEmpty()) return
        val here = threads.filter { it.opIndex == base || it.opIndex.startsWith("$base:") }
        fun brief(t: ReviewThread) = ReviewBrief(t.file, threadAnchor(t), t.text)
        val (scope, rev) = reviewScope()
        val prompt = reviewRequestPrompt(id, scope, rev, files, here.filter { !it.archived }.map(::brief), here.filter { it.archived }.map(::brief), api)
        asking = true
        val c = client ?: return
        viewModelScope.launch {
            try {
                c.reviewOp(body("id" to id, "action" to "start", "scope" to "$base:*", "rev" to rev))
                sendPrompt(c, prompt)
                say("✓ Claude is reviewing: its findings land here as threads")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say("✗ Review: ${e.message}")
            } finally {
                asking = false
            }
        }
    }

    /** Sends the unsent comments as one prompt, in the shape the web lens uses. */
    fun sendReview() {
        val pending = pendingThreads()
        if (pending.isEmpty() || detail == null) return
        val prompt = sendReviewPrompt(id, reviewScope().first, pending, api)
        val ids = JsonArray(pending.map { JsonPrimitive(it.id) })
        val c = client ?: return
        viewModelScope.launch {
            try {
                sendPrompt(c, prompt)
                c.reviewOp(body("id" to id, "action" to "sent", "ids" to ids))
                say("✓ Comments sent to Claude")
                host?.toConverse?.invoke()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say("✗ Send: ${e.message}")
            }
            loadThreads()
            session?.refresh()
        }
    }

    // Go to definition (defs.rs).

    private fun diffLineText(file: Int, side: Side, line: Int): String? =
        diff.files.getOrNull(file)?.hunks?.flatMap { it.lines }?.firstOrNull { it.number(side) == line }?.text

    private fun defTargetPath(file: Int, side: Side): Pair<String, String>? {
        blameRev(file, side)?.let { return it }
        val path = anchors.getOrNull(file)?.file ?: return null
        val root = branchRoot
        return (if (root != null && !path.startsWith("/")) "${root.trimEnd('/')}/$path" else path) to ""
    }

    /** The tablet's ⌘-click: a card asking which of the line's names to look up, or straight to the only one. */
    fun defClick(sel: LineRange, word: String? = null) {
        val (path, rev) = defTargetPath(sel.file, sel.start.side) ?: return
        val choices = diffLineText(sel.file, sel.start.side, sel.start.line)?.let(::identifiers).orEmpty()
        def = DefPeek(sel.file, sel.start.side, sel.start.line, path, rev, choices, null, DefState.Choose)
        val w = word?.takeIf(::isIdent)
        if (w != null) defLookup(w) else if (choices.size == 1) defLookup(choices[0])
        annotate()
    }

    fun defLookup(symbol: String) {
        val d = def ?: return
        def = d.copy(symbol = symbol, state = DefState.Loading)
        val at = Triple(d.file, d.side, d.line)
        val c = client ?: return
        viewModelScope.launch {
            val r = runCatching { c.symbolLookup(id, symbol, d.path, d.rev) }
            val cur = def?.takeIf { Triple(it.file, it.side, it.line) == at } ?: return@launch
            val word = cur.symbol.orEmpty()
            val v = r.getOrNull()
            val state: DefState = when {
                v == null -> DefState.Note("Lookup failed: ${r.exceptionOrNull()?.message}")
                !v["supported"].bool -> DefState.Note(if (v["timedOut"].bool) "Lookup timed out." else "No repository to search.")
                v["origin"] is JsonObject -> DefState.Note("$word comes from ${v["origin"]["specifier"].str ?: "a dependency"}, not in this repo.")
                v["jump"] is JsonObject -> sourceState(v["jump"]!!)
                else -> {
                    val decls = v["declarations"].arr
                    val refs = v["references"].arr
                    when {
                        decls.size == 1 -> sourceState(decls[0])
                        decls.isNotEmpty() -> DefState.Items(decls, false)
                        refs.isNotEmpty() -> DefState.Items(refs, true)
                        else -> DefState.Note("No declaration of $word found.")
                    }
                }
            }
            def = cur.copy(state = state)
            defLoadSource()
        }
    }

    fun defPick(target: JsonElement) {
        def = def?.copy(state = sourceState(target))
        defLoadSource()
    }

    fun defBack() {
        def = def?.copy(state = DefState.Choose, symbol = null)
    }

    fun defExpand(up: Boolean) {
        val d = def ?: return
        val s = d.state as? DefState.Source ?: return
        val total = s.data?.get("total")?.int ?: Int.MAX_VALUE
        def = d.copy(state = if (up) s.copy(from = maxOf(s.from - DEF_STEP, 1)) else s.copy(to = minOf(s.to + DEF_STEP, total)))
        defLoadSource()
    }

    private fun defLoadSource() {
        val d = def ?: return
        val s = d.state as? DefState.Source ?: return
        val file = s.target["file"].str.orEmpty()
        val at = Triple(d.file, d.side, d.line)
        val c = client ?: return
        viewModelScope.launch {
            val r = runCatching { c.sourceSlice(id, file, d.rev, s.from, s.to) }
            val cur = def?.takeIf { Triple(it.file, it.side, it.line) == at } ?: return@launch
            val st = cur.state as? DefState.Source ?: return@launch
            val v = r.getOrNull()
            def = cur.copy(
                state = when {
                    v != null && v["supported"].bool -> st.copy(data = v, err = null)
                    v != null -> st.copy(err = "This file is not readable from here.")
                    else -> st.copy(err = "Could not load the file: ${r.exceptionOrNull()?.message}")
                },
            )
        }
    }

    fun closeDef() {
        if (def != null) {
            def = null
            annotate()
        }
    }

    fun saveRenderedW() {
        prefs.renderedW = renderedW
    }
}
