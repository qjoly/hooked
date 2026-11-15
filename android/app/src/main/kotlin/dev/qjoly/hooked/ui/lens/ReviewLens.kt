package dev.qjoly.hooked.ui.lens

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.SessionDetail
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.firstLine
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.lens.DiffMode
import dev.qjoly.hooked.data.lens.MdKind
import dev.qjoly.hooked.data.lens.ReviewSource
import dev.qjoly.hooked.data.lens.ReviewThread
import dev.qjoly.hooked.data.lens.filePieces
import dev.qjoly.hooked.data.lens.isMarkdown
import dev.qjoly.hooked.data.lens.opTurn
import dev.qjoly.hooked.data.lens.threadAnchor
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.ui.MarkdownBody
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Spinner
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.pages.PageChip
import dev.qjoly.hooked.ui.pages.PageSegmented
import dev.qjoly.hooked.ui.pages.bottomRule
import dev.qjoly.hooked.ui.pages.endRule
import androidx.compose.ui.draw.drawBehind

/** rune's Review lens (view/lenses.rs `review`): the diff of a scope, its files, comments and Claude's review. */
@Composable
fun ReviewLens(app: AppModel, model: SessionModel, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current.applicationContext
    val review: ReviewModel = viewModel(key = "review:${model.id}") { ReviewModel(model.id, LensPrefs(ctx)) }
    review.bind(app, model, LocalLensHost.current)
    val d = model.detail
    if (d == null) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner() }
        return
    }
    val key = review.ensureKey(d)
    LaunchedEffect(key) { review.ensure(model.detail) }
    val target = review.scroll
    LaunchedEffect(target) {
        when (target) {
            is ScrollTo.File -> review.diff.scrollToFile(target.file)
            is ScrollTo.Line -> review.diff.scrollToLine(target.file, target.at)
            is ScrollTo.Block -> runCatching { review.renderedList.animateScrollToItem(maxOf(target.index - 2, 0)) }
            null -> {}
        }
        if (target != null) review.scroll = null
    }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    LaunchedEffect(focus) { runCatching { focus.requestFocus() } }
    // rune's diff keys, for a tablet with a keyboard: j/k hunks, [/] files, v reviewed, Esc clears the selection.
    val keys = Modifier.focusRequester(focus).focusable().onKeyEvent { e ->
        if (e.type != KeyEventType.KeyDown || e.isMetaPressed || e.isCtrlPressed || e.isAltPressed) return@onKeyEvent false
        when (e.key) {
            Key.J, Key.K -> scope.launch { review.diff.step(hunks = true, forward = e.key == Key.J) }
            Key.RightBracket, Key.LeftBracket -> scope.launch { review.diff.step(hunks = false, forward = e.key == Key.RightBracket) }
            Key.V -> if (review.diff.files.isNotEmpty()) review.toggleReviewed(review.diff.visibleFile) else return@onKeyEvent false
            Key.Escape -> if (review.diff.selection != null) {
                review.diff.selection = null
                review.onSelect(null)
            } else return@onKeyEvent false
            else -> return@onKeyEvent false
        }
        true
    }
    Column(modifier.fillMaxSize().then(keys)) {
        ReviewBar(review, d)
        review.blameText(System.currentTimeMillis())?.let { BlameRow(review, it) }
        if (review.turnsOpen && review.source == ReviewSource.CLAUDE) TurnsPanel(review)
        if (review.branchOpen && review.source == ReviewSource.BRANCH) BranchPanel(review, app.now)
        if (review.diff.files.isEmpty()) {
            LensEmpty(emptyMessage(review))
        } else {
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                val maxW = maxWidth
                Row(Modifier.fillMaxSize()) {
                    FilesRail(review)
                    Box(Modifier.weight(1f).fillMaxHeight().clipToBounds()) {
                        DiffView(
                            review.diff,
                            Modifier.fillMaxSize(),
                            annotation = { ReviewAnnotation(app, review, it) },
                            onComment = review::startComment,
                            onSelect = review::onSelect,
                            headerActions = { FileActions(review, it) },
                        )
                    }
                    if (review.rendered) RenderedPanel(review, maxW)
                    if (review.threadsOpen) ThreadsPanel(review)
                }
            }
        }
    }
}

private fun emptyMessage(r: ReviewModel): String = when {
    r.diffLoading -> "Reading the working tree…"
    r.source == ReviewSource.BRANCH -> when {
        r.branches?.let { it["branches"].arr.isEmpty() } == true -> "No local branches in this repository."
        r.branch == null -> "Reading the branches…"
        else -> "No difference between the branch and its base."
    }
    r.source == ReviewSource.TREE -> "The working tree is clean."
    r.source == ReviewSource.WORKTREE -> {
        val w = r.worktree
        when {
            w == null -> "Reading the worktree…"
            w.base == null -> "No base recorded for this worktree."
            w.mergeBase == null -> "No common history with the base to compare against."
            else -> "Nothing changed since this worktree forked from its base."
        }
    }
    r.changesAt == null -> "Reading the changes…"
    else -> "No file changes in this session yet."
}

@Composable
private fun ReviewBar(r: ReviewModel, d: SessionDetail) {
    val sources = ReviewSource.entries.filter { it != ReviewSource.WORKTREE || d.session.worktreeOf != null }
    val labels = sources.map {
        when (it) {
            ReviewSource.CLAUDE -> "Claude's edits · ${r.changes.size}"
            ReviewSource.WORKTREE -> "Worktree"
            ReviewSource.TREE -> "Working tree"
            ReviewSource.BRANCH -> "Branch"
        }
    }
    LensBar {
        PageSegmented(labels, sources.indexOf(r.source).takeIf { it >= 0 }, { sources.getOrNull(it)?.let(r::pickSource) })
        val hunks = r.diff.files.sumOf { it.hunks.size }
        Text("${r.diffCount} file${if (r.diffCount == 1) "" else "s"} · $hunks hunks", style = k.ty.textSmall, color = k.c.faint, maxLines = 1)
        Spacer(Modifier.width(24.dp))
        if (r.diffLoading) Spinner()
        if (r.source == ReviewSource.BRANCH) {
            val b = r.branch
            val bs = r.base
            var label = if (b != null && bs != null) {
                val n = r.picked.size
                "$b vs $bs" + if (n == 0) "" else " · $n commit${if (n == 1) "" else "s"}"
            } else "Loading branches…"
            val repo = r.repos.firstOrNull { it.root == r.branchRoot }
            if (repo != null && r.repos.size > 1) label += " · ${repo.name}"
            KButton(label, { r.branchOpen = !r.branchOpen }, variant = if (r.branchOpen) Variant.OUTLINE else Variant.GHOST_MUTED, size = Size.REGULAR, icon = Lucide.GitBranch)
        }
        val wt = r.worktree
        if (r.source == ReviewSource.WORKTREE && wt?.mergeBase != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                KIcon(Lucide.GitBranch, k.c.muted, 12.dp)
                Text(
                    "${wt.branch ?: "HEAD"} vs ${wt.base.orEmpty()} · ${wt.commits} commit${if (wt.commits == 1) "" else "s"} + uncommitted${if (wt.truncated) " · truncated" else ""}",
                    style = k.ty.textSmall, color = k.c.muted, maxLines = 1,
                )
            }
        }
        if (r.source == ReviewSource.CLAUDE && r.changeTurns.isNotEmpty()) {
            val label = if (r.turns.isEmpty()) "All prompts" else r.turns.sorted().joinToString(", ") { "P${it + 1}" }
            KButton(label, { r.turnsOpen = !r.turnsOpen }, variant = if (r.turns.isEmpty()) Variant.GHOST_MUTED else Variant.OUTLINE, size = Size.REGULAR, icon = Lucide.ChevronDown)
        }
        if (r.diff.files.isNotEmpty()) {
            KButton(if (r.asking) "Asking…" else "Review with Claude", r::reviewWithClaude, variant = Variant.OUTLINE, size = Size.REGULAR, icon = Lucide.Bot, enabled = !r.asking)
        }
        val live = r.threads.count { !it.archived }
        KButton("Comments · $live", { r.threadsOpen = !r.threadsOpen }, variant = if (r.threadsOpen) Variant.OUTLINE else Variant.GHOST_MUTED, size = Size.REGULAR, icon = Lucide.Converse)
        val pending = r.pendingThreads().size
        if (pending > 0) {
            KButton("Send $pending comment${if (pending == 1) "" else "s"} to Claude", r::sendReview, variant = Variant.CONTRAST, size = Size.REGULAR, icon = Lucide.ArrowUp)
        }
        Text("Tap a number to select · hold to extend · + comments", style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
        PageSegmented(listOf("Unified", "Split"), if (r.diff.mode == DiffMode.SPLIT) 1 else 0, { r.setMode(if (it == 1) DiffMode.SPLIT else DiffMode.UNIFIED) })
    }
}

/** The blame of the selected line, plus the tablet's way into go to definition. */
@Composable
private fun BlameRow(r: ReviewModel, text: String) {
    Row(
        Modifier.fillMaxWidth().height(26.dp).bottomRule(k.c.border).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KIcon(Lucide.GitBranch, k.c.muted, 12.dp)
        Text(text, style = k.ty.textXsmall, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        val clipboard = LocalClipboard.current
        val scope = rememberCoroutineScope()
        r.diff.selection?.let { sel ->
            KButton("Copy", {
                r.diff.layout.selectedText(sel)?.let { text -> scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("lines", text))) } }
            }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Copy)
            KButton("Go to definition", { r.defClick(sel) }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Code)
        }
    }
}

@Composable
private fun CheckRow(on: Boolean, height: Int, fill: Color = Color.Transparent, onClick: () -> Unit, content: @Composable () -> Unit) {
    Pressable(onClick, Modifier.fillMaxWidth().height(height.dp), fill = fill, radius = k.r.sm) {
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KIcon(if (on) Lucide.CircleCheck else Lucide.Circle, if (on) k.c.accent else k.c.faint, 13.dp)
            content()
        }
    }
}

@Composable
private fun TurnsPanel(r: ReviewModel) {
    val files = remember(r.changes, r.changeTurns) {
        r.changeTurns.associate { t -> t.turn to r.changes.count { c -> c.rawOps.any { opTurn(r.changeTurns, it) == t.turn } } }
    }
    Column(
        Modifier.fillMaxWidth().heightIn(max = 280.dp).bottomRule(k.c.border).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        CheckRow(r.turns.isEmpty(), 28, onClick = { r.toggleTurn(null) }) {
            Text("The whole conversation (net change)", style = k.ty.textSmallMedium, color = k.c.fg, maxLines = 1)
        }
        for (t in r.changeTurns) {
            val n = files[t.turn] ?: 0
            if (n == 0) continue
            CheckRow(t.turn in r.turns, 28, onClick = { r.toggleTurn(t.turn) }) {
                Text("P${t.turn + 1}", style = k.ty.textSmallMedium, color = k.c.muted, modifier = Modifier.width(34.dp), maxLines = 1)
                Text(firstLine(t.prompt, 140), style = k.ty.textSmall, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text("$n file${if (n == 1) "" else "s"}", style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BranchPanel(r: ReviewModel, now: Long) {
    val names = r.branches?.get("branches").arr.mapNotNull { it["name"].str }
    Column(
        Modifier.fillMaxWidth().heightIn(max = 340.dp).bottomRule(k.c.border).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (r.repos.size > 1) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionTitle("REPOSITORY")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (repo in r.repos) PageChip(if (repo.primary) "${repo.name} · primary" else repo.name, r.branchRoot == repo.root) { r.selectRepo(repo.root) }
                }
            }
        }
        for ((title, isBase) in listOf("BRANCH" to false, "BASE" to true)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionTitle(title)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val current = if (isBase) r.base else r.branch
                    for (n in names) PageChip(n, current == n) { if (isBase) r.setBranch(null, n) else r.setBranch(n, null) }
                }
            }
        }
        if (r.commits.isNotEmpty()) {
            SectionTitle("COMMITS · pick one or more to review just that range")
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                CheckRow(r.picked.isEmpty(), 26, onClick = { r.pickCommit(null) }) {
                    Text("All ${r.commits.size} commits", style = k.ty.textSmallMedium, color = k.c.fg, maxLines = 1)
                }
                val range = r.branchRange()
                val span = range?.let { (from, to) ->
                    val at = { rev: String -> r.commits.indexOfFirst { it["rev"].str == rev }.takeIf { it >= 0 } }
                    val lo = at(to)
                    val hi = at(from)
                    if (lo != null && hi != null) lo..hi else null
                }
                for ((i, cm) in r.commits.withIndex()) {
                    val rev = cm["rev"].str.orEmpty()
                    val inside = span?.contains(i) == true
                    CheckRow(rev in r.picked, 26, fill = if (inside) k.c.chip else Color.Transparent, onClick = { r.pickCommit(rev) }) {
                        Text(rev.take(7), style = k.ty.mono, color = k.c.muted, maxLines = 1)
                        Text(cm["subject"].str.orEmpty(), style = k.ty.textSmall, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(agoShort(cm["ts"].millis, now), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun FilesRail(r: ReviewModel) {
    val files = r.diff.files
    val visible = r.diff.visibleFile
    // A load still in flight when the source changed would leave the previous tree's repos behind.
    val repos = if (r.source == ReviewSource.TREE) r.fileRepos else emptyList()
    Column(Modifier.width(240.dp).fillMaxHeight().endRule(k.c.border)) {
        Row(Modifier.fillMaxWidth().height(32.dp).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            SectionTitle("FILES")
            Spacer(Modifier.weight(1f))
            Text("${r.reviewedCount()}/${files.size} reviewed", style = k.ty.textXsmall, color = k.c.faint)
        }
        LazyColumn(Modifier.fillMaxWidth().weight(1f).padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            itemsIndexed(files) { i, f ->
                val repo = repos.getOrNull(i)
                if (repo != null && (i == 0 || repos.getOrNull(i - 1) != repo)) {
                    Row(Modifier.fillMaxWidth().height(24.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        KIcon(Lucide.Folder, k.c.muted, 11.dp)
                        Text(repo, style = k.ty.textSmallMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                val reviewed = r.isReviewed(i)
                val path = f.path
                val file = path.substringBefore(" · ")
                val part = path.substringAfter(" · ", "")
                val base = file.substringAfterLast('/')
                val name = if (part.isEmpty()) base else "$base · ${part.removePrefix("edit ")}"
                Row(
                    Modifier.fillMaxWidth().height(28.dp).background(if (i == visible) k.c.chip else Color.Transparent, androidx.compose.foundation.shape.RoundedCornerShape(k.r.sm)).padding(start = 4.dp, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Pressable({ r.toggleReviewed(i) }, Modifier.size(22.dp), radius = k.r.sm) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            KIcon(if (reviewed) Lucide.CircleCheck else Lucide.Circle, if (reviewed) k.c.success.icon else k.c.faint, 13.dp, label = "$name reviewed")
                        }
                    }
                    Pressable({ r.scroll = ScrollTo.File(i) }, Modifier.weight(1f).fillMaxHeight(), radius = k.r.sm) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(name, style = k.ty.textSmall, color = if (reviewed) k.c.faint else k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text("+${f.additions}", style = k.ty.textXsmall, color = k.c.success.fg)
                            Text("−${f.deletions}", style = k.ty.textXsmall, color = k.c.danger.fg)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FileActions(r: ReviewModel, i: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (r.diff.files.getOrNull(i)?.let { isMarkdown(it.path) } == true) {
            KButton("Rendered", {
                r.rendered = !r.rendered
                r.scroll = ScrollTo.File(i)
            }, variant = if (r.rendered) Variant.OUTLINE else Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Eye)
        }
        r.truncatedAt(i)?.let { path ->
            val loading = r.fullLoading(path)
            KButton(if (loading) "Loading…" else "Truncated · load the full diff", { r.loadFullChange(path) }, variant = Variant.WARNING, size = Size.SMALL, enabled = !loading)
        }
        val on = r.isReviewed(i)
        KButton(if (on) "Reviewed" else "Mark reviewed", { r.toggleReviewed(i) }, variant = if (on) Variant.OUTLINE else Variant.GHOST_MUTED, size = Size.SMALL, icon = if (on) Lucide.CircleCheck else Lucide.Circle)
    }
}

@Composable
private fun RenderedPanel(r: ReviewModel, maxW: Dp) {
    val file = r.diff.visibleFile
    // Like rune, the column only shows while the file in view is Markdown.
    val f = r.diff.files.getOrNull(file)?.takeIf { isMarkdown(it.path) } ?: return
    val width = r.renderedW.dp.coerceIn(240.dp, maxOf(240.dp, maxW * 0.6f))
    Row(Modifier.width(width).fillMaxHeight().startRule(k.c.border)) {
        ColumnGrip(width, 240.dp, maxW * 0.6f, { r.renderedW = it.value }, r::saveRenderedW)
        Column(Modifier.weight(1f).fillMaxHeight()) {
            Row(Modifier.fillMaxWidth().height(32.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                SectionTitle("RENDERED")
                Spacer(Modifier.weight(1f))
                Text(f.path.substringAfterLast('/'), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
            }
            val pieces = remember(f) { filePieces(f) }
            val lit = r.mdCovered(file, pieces)
            LazyColumn(Modifier.fillMaxWidth().weight(1f).padding(end = 16.dp), r.renderedList, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (pieces.isEmpty()) item { Text("Empty document.", style = k.ty.textSmall, color = k.c.faint) }
                itemsIndexed(pieces) { i, p ->
                    val tint = when (p.kind) {
                        MdKind.ADD -> k.c.success
                        MdKind.DEL -> k.c.danger
                        MdKind.CTX -> null
                    }
                    val fill = if (lit?.contains(i) == true) k.c.info else tint
                    val source = p.source()
                    val sign = when (p.kind) {
                        MdKind.ADD -> "+"
                        MdKind.DEL -> "−"
                        MdKind.CTX -> ""
                    }
                    Pressable(
                        { source?.let { (side, lines) -> r.showMdSource(file, side, lines) } },
                        Modifier.fillMaxWidth().then(
                            if (fill != null) Modifier.background(fill.bg).drawBehind { drawRect(fill.icon, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) } else Modifier,
                        ).padding(vertical = 2.dp),
                        radius = 0.dp,
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(sign, style = k.ty.mono, color = tint?.fg ?: k.c.faint, modifier = Modifier.width(14.dp).padding(start = 4.dp))
                            Box(Modifier.weight(1f)) { MarkdownBody(p.text, color = k.c.fg) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadsPanel(r: ReviewModel) {
    Column(Modifier.width(300.dp).fillMaxHeight().startRule(k.c.border).verticalScroll(rememberScrollState()).padding(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (archived in listOf(false, true)) {
            val list = r.threads.filter { it.archived == archived }
            if (list.isEmpty()) continue
            SectionTitle(if (archived) "ARCHIVED" else "COMMENTS")
            for (f in list.map { it.file }.distinct()) {
                Text(f.substringAfterLast('/'), style = k.ty.textXsmallMedium, color = k.c.faint, maxLines = 1)
                for (t in list.filter { it.file == f }.sortedWith(compareBy({ it.sent }, { it.start }))) ThreadRow(r, t, archived)
            }
        }
        if (r.threads.isEmpty()) Text("No comments yet. Select a line, then + starts one.", style = k.ty.textSmall, color = k.c.faint)
    }
}

@Composable
private fun ThreadRow(r: ReviewModel, t: ReviewThread, archived: Boolean) {
    val armed = r.deleteArmed == t.id
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Pressable({ r.jumpToThread(t.id) }, Modifier.weight(1f), radius = k.r.sm) {
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(threadAnchor(t), style = k.ty.textXsmallMedium, color = k.c.muted)
                    Text(if (archived) "" else if (t.sent) "sent" else "pending", style = k.ty.textXsmall, color = if (t.sent) k.c.info.fg else k.c.warning.fg)
                }
                Text(firstLine(t.text, 90), style = k.ty.textSmall, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (archived) KButton("Restore", { r.archiveThread(t.id, false) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
        KButton(if (armed) "Delete?" else "×", {
            if (armed) {
                r.deleteArmed = null
                r.deleteThread(t.id)
            } else {
                r.deleteArmed = t.id
            }
        }, variant = if (armed) Variant.DANGER else Variant.GHOST_FAINT, size = Size.SMALL)
    }
}
