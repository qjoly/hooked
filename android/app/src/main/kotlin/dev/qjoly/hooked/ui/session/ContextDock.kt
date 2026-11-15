package dev.qjoly.hooked.ui.session

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dock.DockAgent
import dev.qjoly.hooked.data.dock.DockChange
import dev.qjoly.hooked.data.dock.DockData
import dev.qjoly.hooked.data.dock.DockJob
import dev.qjoly.hooked.data.dock.checkState
import dev.qjoly.hooked.data.dock.checksSummary
import dev.qjoly.hooked.data.dock.dockCheckRank
import dev.qjoly.hooked.data.dock.firstLine
import dev.qjoly.hooked.data.dock.isPullLink
import dev.qjoly.hooked.data.dock.linkLabel
import dev.qjoly.hooked.data.dock.logTail
import dev.qjoly.hooked.data.dock.reviewLinkLabel
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.of
import dev.qjoly.hooked.state.wakeLabel
import dev.qjoly.hooked.ui.SidebarModal
import dev.qjoly.hooked.ui.SidebarModals
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KMenu
import dev.qjoly.hooked.ui.kit.KMenuItem
import dev.qjoly.hooked.ui.kit.KMenuSeparator
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.panel
import dev.qjoly.hooked.state.snoozePresets
import dev.qjoly.hooked.state.clockLabel

/** What the session view lends the dock: the lens switch behind "Open Review". */
class DockHost(val openReview: () -> Unit)

/** Provided by the session view around [ContextDock]. */
val LocalDockHost = staticCompositionLocalOf<DockHost?> { null }

/**
 * rune's right-hand "Session context" column (`view/dock.rs`): collapsible cards for the session's tasks,
 * changes, workflows, agents, sub-sessions, background jobs, links and screenshots, then the optional
 * actions. It paints its own fill and left rule, and emits nothing when there is nothing to show.
 */
@Composable
fun ContextDock(app: AppModel, model: SessionModel, modifier: Modifier = Modifier) {
    val client = app.client ?: return
    val dock: DockModel = viewModel()
    val id = model.id
    LaunchedEffect(client) { dock.bind(client) }
    DisposableEffect(id) {
        dock.onSession(id)
        onDispose { dock.leave(id) }
    }
    val key = model.detail?.session?.changeKey
    LaunchedEffect(id, key) { dock.want(id, key) }
    DockOverlays(app, dock, id)
    val d = dock.data[id]
    val withActions = app.settings["featureFlags"]["dockActions"].bool
    if (!withActions && d?.hasContent != true) return
    val c = k.c
    Column(modifier.fillMaxHeight().background(c.bg).leftRule(c.border)) {
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 12.dp)) { SectionTitle("SESSION CONTEXT") }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
            if (d != null) Cards(app, dock, id, d)
        }
        if (withActions) DockActions(app, id)
    }
}

@Composable
private fun Cards(app: AppModel, dock: DockModel, session: String, d: DockData) {
    Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (d.todos.isNotEmpty()) TasksCard(dock, d)
        if (d.changes.isNotEmpty()) ChangesCard(app, dock, d)
        if (d.workflows.isNotEmpty()) WorkflowsCard(dock, d)
        if (d.subagents.isNotEmpty()) AgentsCard(dock, session, d)
        if (d.subSessions.isNotEmpty()) SubSessionsCard(app, dock, d)
        if (d.bgJobs.isNotEmpty()) JobsCard(dock, session, d)
        if (d.links.isNotEmpty()) LinksCard(app, dock, session, d)
        if (d.screenshots.isNotEmpty()) ShotsCard(dock, session, d)
    }
}

/** A card whose header toggles it open: the count on the right, then the chevron. */
@Composable
private fun Card(dock: DockModel, key: String, icon: ImageVector, title: String, count: String, content: @Composable ColumnScope.(open: Boolean) -> Unit) {
    val open = key in dock.cards
    val c = k.c
    Column(Modifier.fillMaxWidth().panel(c.surface, c.border, k.r.md).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Pressable({ dock.toggleCard(key) }, Modifier.fillMaxWidth(), radius = k.r.sm) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                KIcon(icon, c.muted, 13.dp)
                Text(title, style = k.ty.uiMedium, color = c.fg, maxLines = 1)
                Spacer(Modifier.weight(1f))
                Text(count, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                KIcon(if (open) Lucide.ChevronDown else Lucide.ArrowRight, c.faint, 11.dp)
            }
        }
        content(open)
    }
}

/** A marked line: the glyph sits on the first text line. */
@Composable
private fun Item(mark: ImageVector, markColor: Color, label: String, strong: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        KIcon(mark, markColor, 12.dp, Modifier.padding(top = 3.75.dp))
        Text(label, style = k.ty.textSmall, color = if (strong) k.c.fg else k.c.muted, modifier = Modifier.weight(1f))
    }
}

/** Long press shows `hint`, the tablet's stand-in for rune's hover help. */
private fun Modifier.longPress(key: Any?, onLong: () -> Unit) = pointerInput(key) { detectTapGestures(onLongPress = { onLong() }) }

@Composable
private fun TasksCard(dock: DockModel, d: DockData) {
    val c = k.c
    Card(dock, "dock-todos", Lucide.Tasks, "Tasks", d.todoCount) { open ->
        val bar = RoundedCornerShape(1.5.dp)
        Box(Modifier.fillMaxWidth().height(3.dp).clip(bar).background(c.border)) {
            Box(Modifier.fillMaxWidth(d.todoProgress).height(3.dp).clip(bar).background(c.success.hue))
        }
        for (t in d.shownTodos(open)) {
            when (t.status) {
                "completed" -> Item(Lucide.CircleCheck, c.success.hue, t.label, false)
                "in_progress" -> Item(Lucide.CircleDot, c.info.hue, t.label, true)
                else -> Item(Lucide.Circle, c.faint, t.label, false)
            }
        }
    }
}

@Composable
private fun ChangesCard(app: AppModel, dock: DockModel, d: DockData) {
    val host = LocalDockHost.current
    Card(dock, "dock-changes", Lucide.Diff, "Changes", d.changeCount) { open ->
        for (ch in d.changes.take(if (open) 200 else DockData.CHANGES_FOLDED)) ChangeRow(ch)
        Pressable(
            { host?.openReview?.invoke() ?: app.say("✗ The Review lens is not available here") },
            Modifier.height(24.dp),
            radius = k.r.sm,
        ) {
            Text(reviewLinkLabel(d.changes.size, open), style = k.ty.textSmallMedium, color = k.c.accent, modifier = Modifier.padding(horizontal = 6.dp), maxLines = 1)
        }
    }
}

@Composable
private fun ChangeRow(ch: DockChange) {
    var hint by remember { mutableStateOf<String?>(null) }
    Row(
        Modifier.fillMaxWidth().longPress(ch.file) { hint = ch.file },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(ch.label, style = k.ty.textSmall, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (ch.edits > 1) Text("${ch.edits} edits", style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
        Hint(hint) { hint = null }
    }
}

@Composable
private fun WorkflowsCard(dock: DockModel, d: DockData) {
    val c = k.c
    Card(dock, "dock-workflows", Lucide.Activity, "Workflows", d.workflowCount) {
        for (w in d.workflows) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Dot(c.stateColor(w.state), 7.dp)
                Text(w.name, style = k.ty.mono, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(w.progress, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
            }
        }
    }
}

@Composable
private fun AgentsCard(dock: DockModel, session: String, d: DockData) {
    Card(dock, "dock-agents", Lucide.Bot, "Agents", d.agentCount) { open ->
        for (a in d.subagents.take(if (open) 100 else DockData.AGENTS_FOLDED)) {
            if (open) AgentEntry(dock, session, a) else Item(Lucide.Bot, k.c.faint, a.label, false)
        }
    }
}

@Composable
private fun AgentEntry(dock: DockModel, session: String, a: DockAgent) {
    val c = k.c
    val expanded = dock.agentOpen == a.id
    Column(Modifier.fillMaxWidth().topRule(c.border).padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Pressable({ dock.toggleAgent(a.id) }, Modifier.fillMaxWidth(), radius = 0.dp) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(a.label, style = k.ty.textSmallMedium, color = c.fg)
                Text(a.meta, style = k.ty.textXsmall, color = c.faint)
            }
        }
        if (expanded) {
            SectionTitle("PROMPT")
            Text(firstLine(a.prompt, 2000), style = k.ty.textSmall, color = c.muted)
            SectionTitle("REPORT")
            SelectionContainer { DockMarkdown(a.result) }
            a.agentId?.let { agent ->
                KButton("Transcript", { dock.openAgent(session, agent, a.label) }, variant = Variant.OUTLINE, size = Size.SMALL, icon = Lucide.Converse)
            }
        }
    }
}

@Composable
private fun SubSessionsCard(app: AppModel, dock: DockModel, d: DockData) {
    val c = k.c
    Card(dock, "dock-subs", Lucide.Link, "Sub-sessions", d.subSessions.size.toString()) {
        for (sub in d.subSessions) {
            val known = app.session(sub.id)
            val label = sub.label ?: known?.let(app::title) ?: sub.id
            val state = known?.state?.name?.lowercase() ?: "idle"
            Pressable({ app.open(sub.id) }, Modifier.fillMaxWidth(), radius = k.r.sm) {
                Row(
                    Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Dot(c.stateColor(state), 7.dp)
                    Text(label, style = k.ty.textSmall, color = c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun JobsCard(dock: DockModel, session: String, d: DockData) {
    Card(dock, "dock-jobs", Lucide.Terminal, "Background", d.jobCount) { open ->
        for (j in d.sortedJobs.take(if (open) 100 else DockData.JOBS_FOLDED)) {
            JobRow(dock, session, j)
            dock.jobLog?.takeIf { j.taskId.isNotEmpty() && it.first == j.taskId }?.let { JobLog(it.second) }
        }
    }
}

@Composable
private fun JobRow(dock: DockModel, session: String, j: DockJob) {
    val c = k.c
    var hint by remember { mutableStateOf<String?>(null) }
    val showHint = { if (j.command.isNotEmpty()) hint = j.command }
    val body: @Composable RowScope.() -> Unit = {
        Dot(c.stateColor(j.state), 7.dp)
        Text(j.title, style = k.ty.textSmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(j.status, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
        Hint(hint) { hint = null }
    }
    if (j.taskId.isEmpty()) {
        Row(Modifier.fillMaxWidth().longPress(j.command) { showHint() }, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, content = body)
    } else {
        Pressable({ dock.toggleJobLog(session, j.taskId) }, Modifier.fillMaxWidth(), onLongClick = showHint, radius = 0.dp) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, content = body)
        }
    }
}

/** The tail of a job's output, following the end while the reader is there. */
@Composable
private fun JobLog(text: String) {
    val scroll = rememberScrollState()
    LaunchedEffect(scroll) {
        var last = 0
        snapshotFlow { scroll.maxValue }.collect { max ->
            if (scroll.value >= last - 4) scroll.scrollTo(max)
            last = max
        }
    }
    Column(
        Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(k.r.sm)).background(k.c.chip).verticalScroll(scroll).padding(8.dp),
    ) {
        SelectionContainer { Text(logTail(text), style = k.ty.mono, color = k.c.muted) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LinksCard(app: AppModel, dock: DockModel, session: String, d: DockData) {
    val c = k.c
    val links = d.links
    Column(Modifier.fillMaxWidth().panel(c.surface, c.border, k.r.md).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            KIcon(Lucide.Github, c.muted, 13.dp)
            Text("Links", style = k.ty.uiMedium, color = c.fg)
            Spacer(Modifier.weight(1f))
            Text(links.size.toString(), style = k.ty.textXsmall, color = c.faint)
        }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (l in links) LinkPill(dock, l, d.prLinks)
        }
        dock.ghOpen?.takeIf { it in links }?.let { LinkDetail(app, dock, session, it) }
    }
}

@Composable
private fun LinkPill(dock: DockModel, url: String, prLinks: List<String>) {
    val c = k.c
    val on = dock.ghOpen == url
    var hint by remember { mutableStateOf<String?>(null) }
    val state = if (url in prLinks) dock.gh[url]?.getOrNull()?.get("state")?.str.orEmpty().uppercase() else ""
    val tint = when (state) {
        "" -> null
        "MERGED" -> c.stateColor("background")
        "CLOSED" -> c.danger.hue
        else -> c.success.hue
    }
    Pressable(
        { dock.openGh(url) },
        Modifier.height(22.dp).border(1.dp, if (on) c.accent else c.border, RoundedCornerShape(k.r.sm)),
        onLongClick = { hint = if (state.isEmpty()) url else "${state.lowercase()} · $url" },
        fill = if (on) c.chip else Color.Transparent,
        radius = k.r.sm,
    ) {
        Row(Modifier.padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            KIcon(if (isPullLink(url)) Lucide.PullRequest else Lucide.CircleDot, tint ?: c.muted, 12.dp)
            Text(linkLabel(url), style = k.ty.textSmallMedium, color = tint ?: c.fg, maxLines = 1)
        }
        Hint(hint) { hint = null }
    }
}

/** The pill's inline summary: title, state, review decision, author, checks, then the way to the full detail. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LinkDetail(app: AppModel, dock: DockModel, session: String, url: String) {
    val c = k.c
    val uri = LocalUriHandler.current
    Column(Modifier.fillMaxWidth().topRule(c.border).padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val r = dock.gh[url]
        val v = r?.getOrNull()
        when {
            r == null -> Text("Loading…", style = k.ty.textSmall, color = c.faint)
            r.isFailure -> Text(r.exceptionOrNull()?.message ?: "Could not load this link", style = k.ty.textSmall, color = c.danger.fg)
            v == null -> Text("No details for this link.", style = k.ty.textSmall, color = c.faint)
            else -> {
                val state = v["state"].str.orEmpty()
                val tone = when (state) {
                    "MERGED" -> c.info
                    "CLOSED" -> c.danger
                    else -> c.success
                }
                Text(v["title"].str.orEmpty(), style = k.ty.textSmallMedium, color = c.fg)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Pill(state.lowercase(), tone.fg, tone.bg)
                    when (v["reviewDecision"].str) {
                        "APPROVED" -> Pill("approved", c.success.fg, c.success.bg)
                        "CHANGES_REQUESTED" -> Pill("changes requested", c.danger.fg, c.danger.bg)
                        "REVIEW_REQUIRED" -> Pill("review required", c.muted, c.chip)
                    }
                }
                Text("by ${v["author"].str.orEmpty()}", style = k.ty.textXsmall, color = c.faint)
            }
        }
        dock.ghChecks[url]?.takeIf { it.isNotEmpty() }?.let { raw ->
            val checks = raw.sortedBy { dockCheckRank(it["status"].str.orEmpty()) }
            checksSummary(checks.map { it["status"].str.orEmpty() }, dock = true)?.let { s ->
                Text(s.label, style = k.ty.textXsmallMedium, color = if (s.tone == "ko") c.danger.fg else c.muted)
            }
            for (ch in checks) {
                var hint by remember { mutableStateOf<String?>(null) }
                val link = ch["url"].str.orEmpty()
                Pressable(
                    { if (link.isNotEmpty()) openLink(app, dock, uri, session, link) },
                    Modifier.fillMaxWidth(),
                    onLongClick = { ch["workflow"].str?.takeIf { it.isNotEmpty() }?.let { hint = it } },
                    radius = 0.dp,
                ) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Dot(c.stateColor(checkState(ch["status"].str.orEmpty())), 7.dp)
                        Text(ch["name"].str.orEmpty(), style = k.ty.textSmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    }
                    Hint(hint) { hint = null }
                }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            KButton("Details", { dock.openGhFull(url, session) }, variant = Variant.OUTLINE, size = Size.SMALL, icon = Lucide.PanelRight)
            KButton("Open on GitHub", { runCatching { uri.openUri(url) } }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Link)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ShotsCard(dock: DockModel, session: String, d: DockData) {
    val c = k.c
    Card(dock, DockModel.SHOTS, Lucide.Image, "Screenshots", d.screenshots.size.toString()) { open ->
        val shots = d.sortedShots
        val all = shots.map { it.path }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            shots.take(if (open) DockData.SHOTS_OPEN else DockData.SHOTS_FOLDED).forEachIndexed { i, shot ->
                var hint by remember { mutableStateOf<String?>(null) }
                val shape = RoundedCornerShape(k.r.sm)
                Pressable(
                    { dock.openImage(session, all, i) },
                    Modifier.size(122.dp, 76.dp).border(1.dp, c.border, shape),
                    onLongClick = { hint = shot.name },
                    fill = c.chip,
                    radius = k.r.sm,
                ) {
                    dock.thumbs[shot.path]?.let { Image(it, shot.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                    Hint(hint) { hint = null }
                }
            }
        }
    }
}

/** The 56-high action tiles under the cards (`dockActions` feature flag). */
@Composable
private fun RowScope.ActionTile(
    icon: ImageVector, label: String, help: String, on: Boolean, danger: Boolean,
    modifier: Modifier = Modifier, onClick: () -> Unit,
) {
    val c = k.c
    val fill = if (on) c.border else c.surface
    val border = if (on) c.border2 else c.border
    val fg = if (on) c.fg else c.muted
    var hint by remember { mutableStateOf<String?>(null) }
    Pressable(
        onClick,
        modifier.weight(1f).height(56.dp).border(1.dp, border, RoundedCornerShape(k.r.md)),
        onLongClick = { hint = help },
        fill = fill,
        radius = k.r.md,
    ) {
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(5.dp)) {
            KIcon(icon, if (danger) c.danger.hue else fg, 17.dp, label = label)
            Text(label, style = k.ty.textXsmallMedium, color = if (danger) c.danger.fg else fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 4.dp))
        }
        Hint(hint) { hint = null }
    }
}

@Composable
internal fun DockActions(app: AppModel, id: String) {
    val m = app.meta.of(id)
    val pinned = id in app.prefs.pinned
    val wake = m.snoozeUntil?.takeIf { it > app.now }
    var modal by remember { mutableStateOf<SidebarModal?>(null) }
    var snooze by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().topRule(k.c.border).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ActionTile(Lucide.List, "Group", "Move to group…", on = false, danger = false) { modal = SidebarModal.Group(id) }
            ActionTile(Lucide.Tag, "Tags", "Edit tags", on = false, danger = false) { modal = SidebarModal.Tags(id) }
            ActionTile(Lucide.Pin, if (pinned) "Pinned" else "Pin", if (pinned) "Unpin" else "Pin to the top of the sidebar", on = pinned, danger = false) {
                app.prefs.togglePin(id)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ActionTile(
                if (m.incognito) Lucide.EyeOff else Lucide.Eye, "Incognito",
                if (m.incognito) "Remove from incognito: hidden while incognito mode is on" else "Mark incognito: keep it visible in incognito mode",
                on = m.incognito, danger = false,
            ) { app.toggleIncognito(id) }
            if (!m.archived) {
                Box(Modifier.weight(1f)) {
                    Row(Modifier.fillMaxWidth()) {
                        ActionTile(Lucide.Snooze, wake?.let { wakeLabel(it, app.now) } ?: "Snooze", if (wake != null) "Change or end the snooze" else "Snooze…", on = wake != null, danger = false) {
                            snooze = !snooze
                        }
                    }
                    KMenu(snooze, { snooze = false }, minWidth = 200.dp) {
                        wake?.let { until ->
                            KMenuItem("Wake now", { snooze = false; app.snooze(id, null) }, icon = Lucide.Bell, description = "Snoozed until ${wakeLabel(until, app.now)}")
                            KMenuSeparator()
                        }
                        snoozePresets(System.currentTimeMillis()).forEach { (label, until) ->
                            KMenuItem(label, { snooze = false; app.snooze(id, until) }, trailing = clockLabel(until))
                        }
                    }
                }
            }
            ActionTile(
                if (m.archived) Lucide.Unarchive else Lucide.Archive, if (m.archived) "Unarchive" else "Archive",
                if (m.archived) "Restore this session to the live fleet" else "Stop the session and move it to Archived",
                on = false, danger = !m.archived,
            ) { app.toggleArchive(id) }
        }
    }
    modal?.let { SidebarModals(app, it) { modal = null } }
}
