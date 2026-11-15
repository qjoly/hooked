package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.FAMILY_LABELS
import dev.qjoly.hooked.state.GroupUnit
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.state.familyOf
import dev.qjoly.hooked.state.isArchived
import dev.qjoly.hooked.state.isLive
import dev.qjoly.hooked.state.isSnoozed
import dev.qjoly.hooked.state.of
import dev.qjoly.hooked.state.plain
import dev.qjoly.hooked.state.stateLabel
import dev.qjoly.hooked.state.units
import dev.qjoly.hooked.state.wheelSlices
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.KMenu
import dev.qjoly.hooked.ui.kit.KMenuItem
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.TagPill
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.panel

/** desktop-rune's Deck: what waits on you, then the fleet. Two columns once the content is 1080 wide. */
@Composable
fun DeckScreen(app: AppModel) {
    var stateFilter by rememberSaveable { mutableStateOf<Int?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val inner = maxOf(maxWidth - 48.dp, 320.dp)
        val two = inner >= 1080.dp
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
            if (two) {
                val left = (inner - 22.dp) * (1.15f / 2.05f)
                val right = inner - 22.dp - left
                Row(horizontalArrangement = Arrangement.spacedBy(22.dp), verticalAlignment = Alignment.Top) {
                    Decisions(app, Modifier.width(left), wide = false)
                    Fleet(app, Modifier.width(right), right, stateFilter, { stateFilter = it }, query, { query = it })
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(26.dp)) {
                    Decisions(app, Modifier.fillMaxWidth(), wide = true)
                    Fleet(app, Modifier.fillMaxWidth(), inner, stateFilter, { stateFilter = it }, query, { query = it })
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Decisions(app: AppModel, modifier: Modifier, wide: Boolean) {
    val c = k.c
    val now = app.now
    val waiting = app.active.filter { it.needsYou }
    val decisions = waiting.filter { !isSnoozed(it, app.meta, now) }
    val snoozed = waiting.size - decisions.size
    Column(modifier, verticalArrangement = Arrangement.spacedBy(26.dp)) {
        if (!app.connected && app.loaded) {
            Text("hooked is not answering on ${app.config?.base}.", style = k.ty.body, color = c.danger.fg)
        }
        if (decisions.isEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Dot(c.stateColor("idle"), 8.dp)
                Text("Nothing is waiting on you.", style = k.ty.body, color = c.muted)
            }
        }
        if (decisions.isNotEmpty() || snoozed > 0) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionTitle("AWAITING YOU")
                    Text(if (snoozed > 0) "${decisions.size} · $snoozed snoozed" else "${decisions.size}", style = k.ty.textXsmall, color = c.faint)
                    Spacer(Modifier.weight(1f))
                    if (decisions.size > 1) KButton("Snooze all 1h", { app.snoozeAll(decisions.map { it.id }, 1) }, variant = Variant.GHOST_MUTED, icon = Lucide.Clock)
                }
                if (wide) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        decisions.forEach { DecisionCard(app, it, Modifier.width(400.dp)) }
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { decisions.forEach { DecisionCard(app, it, Modifier.fillMaxWidth()) } }
                }
            }
        }
    }
}

private enum class Kind(val label: String, val urgent: Boolean) {
    PERMISSION("Permission", true), QUESTION("Question", true), PLAN("Plan", true), TURN("Your turn", false)
}

private fun kindOf(s: Session) = when {
    (s.hasQuestion && s.question?.isPermission == true) || (s.state == dev.qjoly.hooked.data.SessionState.ATTENTION && !s.hasQuestion) -> Kind.PERMISSION
    s.hasQuestion -> Kind.QUESTION
    s.hasPlan -> Kind.PLAN
    else -> Kind.TURN
}

/** Plans live only in the session detail: fetched once per activity change. */
private val planCache = mutableStateMapOf<String, Pair<Long?, String?>>()

@Composable
private fun DecisionCard(app: AppModel, s: Session, modifier: Modifier) {
    val c = k.c
    val kind = kindOf(s)
    val tone = if (kind.urgent) c.danger else c.warning
    Column(modifier.panel(c.surface, tone.border, k.r.lg).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Pill(kind.label, tone.fg, tone.bg)
            Pressable({ app.open(s.id) }, Modifier.weight(1f), radius = k.r.sm) {
                Text(app.title(s), style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(agoShort(s.lastActivity, app.now), style = k.ty.textXsmall, color = c.faint)
        }
        Text(s.repo ?: s.projectName ?: "?", style = k.ty.textXsmall, color = c.faint, maxLines = 1)
        val q = s.question
        when {
            kind != Kind.TURN && q != null && q.questions.size == 1 && !q.questions[0].multiSelect -> {
                Text(q.questions[0].question, style = k.ty.textSmall, color = c.fg, maxLines = 4, overflow = TextOverflow.Ellipsis)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    q.questions[0].options.forEachIndexed { i, o ->
                        KButton(o.label, {
                            app.act("Answer", "✓ Answered") { it.answer(s.id, listOf(HookedClient.Selection(false, listOf(i)))) }
                        }, Modifier.fillMaxWidth(), variant = Variant.OUTLINE)
                    }
                }
            }
            kind != Kind.TURN && q != null -> Text("Several questions: open the session to answer them.", style = k.ty.textSmall, color = c.muted)
            kind == Kind.PLAN -> PlanBody(app, s)
            else -> {
                val excerpt = plain(s.lastReply ?: s.lastPrompt ?: "", 220)
                if (excerpt.isNotEmpty()) Text(excerpt, style = k.ty.textSmall, color = c.muted, maxLines = 4, overflow = TextOverflow.Ellipsis)
                s.followup?.takeIf { it.isNotBlank() && kind == Kind.TURN }?.let { f ->
                    Row(
                        Modifier.fillMaxWidth().panel(Color.Transparent, c.border, k.r.md).padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text("Suggested follow-up", style = k.ty.textXsmallMedium, color = c.faint)
                            Text(f, style = k.ty.textSmall, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        KButton("Send this", { app.act("Send", "✓ Follow-up sent") { it.reply(s.id, f) } }, variant = Variant.CONTRAST)
                    }
                }
            }
        }
        Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            KButton(if (kind == Kind.TURN) "Reply" else "Open", { app.open(s.id) })
            Spacer(Modifier.weight(1f))
            KButton("1h", { app.snooze(s.id, System.currentTimeMillis() + 3_600_000L) }, variant = Variant.GHOST_MUTED, icon = Lucide.Clock)
            KButton("Archive", { app.toggleArchive(s.id) }, variant = Variant.GHOST_MUTED, icon = Lucide.Archive)
        }
    }
}

@Composable
private fun PlanBody(app: AppModel, s: Session) {
    val c = k.c
    val cached = planCache[s.id]
    LaunchedEffect(s.id, s.lastActivity) {
        if (cached?.first == s.lastActivity && cached?.second != null) return@LaunchedEffect
        val plan = runCatching { app.client?.detail(s.id)?.pendingPlan?.plan }.getOrNull()
        planCache[s.id] = s.lastActivity to plan
    }
    val plan = cached?.second
    if (plan == null) {
        Text("Loading the plan…", style = k.ty.textSmall, color = c.muted)
        return
    }
    Box(Modifier.fillMaxWidth().heightIn(max = 260.dp).panel(c.surface, c.border, k.r.sm).verticalScroll(rememberScrollState()).padding(8.dp)) {
        MarkdownBody(plan)
    }
    @OptIn(ExperimentalLayoutApi::class)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // The server's actions: keep, approve (accept edits), approve-auto.
        fun act(action: String, done: String) {
            planCache.remove(s.id)
            app.act("Plan", done) { it.plan(s.id, action) }
        }
        KButton("Keep planning", { act("keep", "✓ Back to planning") }, variant = Variant.OUTLINE)
        KButton("Approve · accept edits", { act("approve", "✓ Plan approved") })
        KButton("Approve · auto", { act("approve-auto", "✓ Plan approved") }, variant = Variant.CONTRAST)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Fleet(app: AppModel, modifier: Modifier, width: Dp, filter: Int?, setFilter: (Int?) -> Unit, query: String, setQuery: (String) -> Unit) {
    val c = k.c
    val now = app.now
    val active = app.active
    val needle = query.trim().lowercase()
    fun matches(s: Session) = (filter == null || familyOf(s) == filter) && (needle.isEmpty() ||
        listOfNotNull(s.repo, s.projectName, app.title(s), s.lastPrompt, s.gitBranch, app.tagsOf(s.id).joinToString(" ")).any { needle in it.lowercase() })
    val unitsAll = units(active.filter(::matches).sortedByDescending { it.lastActivity ?: 0 }, app.meta)
    val repos = unitsAll.groupBy { it.lead.repo ?: it.lead.projectName ?: "—" }
        .mapValues { (_, list) -> list.sortedWith(compareBy<GroupUnit>({ u -> u.all.none(::isLive) }, { u -> -(u.all.maxOf { it.lastActivity ?: 0 }) })) }
        .entries.sortedByDescending { e -> e.value.maxOf { u -> u.all.maxOf { it.lastActivity ?: 0 } } }
    val decisions = active.count { it.needsYou && !isSnoozed(it, app.meta, now) }
    var hovered by remember { mutableStateOf<String?>(null) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    var archivedOpen by rememberSaveable { mutableStateOf(false) }
    val grid = app.prefs.deckView != "list"
    Column(modifier, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionTitle("THE FLEET")
            val activeCount = active.count { it.state == dev.qjoly.hooked.data.SessionState.WORKING || it.state == dev.qjoly.hooked.data.SessionState.BACKGROUND }
            Text("${unitsAll.size} group${if (unitsAll.size == 1) "" else "s"} · $activeCount active", style = k.ty.textXsmall, color = c.faint)
            Spacer(Modifier.weight(1f))
            KTextInput(query, setQuery, "Filter…", Modifier.width(200.dp))
            KIconButton(Lucide.List, "List", { app.prefs.deckView("list") }, size = Size.SMALL, on = !grid)
            KIconButton(Lucide.Deck, "Grid", { app.prefs.deckView("grid") }, size = Size.SMALL, on = grid)
        }
        WheelCard(app, active, decisions, filter, setFilter, hovered) { hovered = it }
        if (unitsAll.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    when {
                        needle.isNotEmpty() -> "Nothing matches “$query”."
                        filter != null -> "No session in this state."
                        else -> "No sessions yet."
                    },
                    style = k.ty.body, color = c.muted,
                )
                if (needle.isNotEmpty() || filter != null) {
                    Pressable({ setQuery(""); setFilter(null) }, radius = k.r.sm) {
                        Text("Clear the filter", style = k.ty.textSmallMedium, color = c.accent, modifier = Modifier.padding(horizontal = 6.dp))
                    }
                }
            }
        }
        for ((repo, list) in repos) {
            val live = list.count { u -> u.all.any(::isLive) }
            val cap = maxOf(8, live)
            val shown = if (expanded[repo] == true) list else list.take(cap)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    c.lotColor(repo)?.let { Box(Modifier.size(14.dp, 7.dp).clip(RoundedCornerShape(2.dp)).background(it)) }
                    Text(repo, style = k.ty.uiMedium, color = c.fg)
                    Text("${list.size}", style = k.ty.textXsmall, color = c.faint)
                    Spacer(Modifier.weight(1f))
                    KIconButton(Lucide.Plus, "New session in this project", {
                        app.newSessionProject = list.first().lead.worktreeOf ?: list.first().lead.project
                        app.showNew = true
                    }, size = Size.SMALL)
                }
                UnitBlock(app, shown, grid, width)
                if (list.size > shown.size) {
                    val more = list.size - shown.size
                    Pressable({ expanded[repo] = true }, Modifier.fillMaxWidth().height(30.dp).panel(Color.Transparent, c.border, k.r.md), radius = k.r.md) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                            KIcon(Lucide.Plus, c.faint, 12.dp)
                            Text("$more older group${if (more == 1) "" else "s"}", style = k.ty.textXsmallMedium, color = c.muted)
                        }
                    }
                }
            }
        }
        // Archived: units whose whole group is archived, folded by default.
        val archived = units(app.visible.filter { isArchived(it, app.meta, now) && matches(it) }.sortedByDescending { it.lastActivity ?: 0 }, app.meta)
            .filter { u -> u.all.all { isArchived(it, app.meta, now) } }
        if (archived.isNotEmpty()) {
            Pressable({ archivedOpen = !archivedOpen }, Modifier.fillMaxWidth().height(28.dp), radius = k.r.sm) {
                Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    KIcon(if (archivedOpen) Lucide.ChevronDown else Lucide.ArrowRight, c.faint, 12.dp)
                    KIcon(Lucide.Archive, c.muted, 13.dp)
                    Text("Archived", style = k.ty.uiMedium, color = c.muted)
                    Text("${archived.size}", style = k.ty.textXsmall, color = c.faint)
                }
            }
            if (archivedOpen) UnitBlock(app, archived, grid, width)
        }
    }
}

/** The ring and its legend; a legend row filters the fleet to its family. */
@Composable
private fun WheelCard(app: AppModel, active: List<Session>, decisions: Int, filter: Int?, setFilter: (Int?) -> Unit, hovered: String?, setHover: (String?) -> Unit) {
    val c = k.c
    val slices = wheelSlices(active, app.meta, app.now)
    val counts = IntArray(6).also { a -> active.forEach { a[familyOf(it)]++ } }
    Row(Modifier.fillMaxWidth().panel(c.surface, c.border, k.r.lg).padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(22.dp)) {
        FleetWheel(slices, decisions, filter, hovered, setHover, { app.open(it) }, app::title)
        Box(Modifier.weight(1f)) {
        Column(Modifier.widthIn(max = 520.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (pair in listOf(0 to 1, 2 to 3, 4 to 5)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (f in listOf(pair.first, pair.second)) {
                        val on = filter == f
                        val n = counts[f]
                        Pressable(
                            { setFilter(if (on) null else f) },
                            Modifier.weight(1f).height(32.dp).then(if (on) Modifier.border(1.dp, c.border2, RoundedCornerShape(k.r.md)) else Modifier),
                            fill = if (on) c.chip else Color.Transparent, radius = k.r.md,
                        ) {
                            Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Dot(c.hues[f], 9.dp)
                                Text(FAMILY_LABELS[f], style = k.ty.ui, color = if (n == 0) c.faint else c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                Text("$n", style = if (n == 0) k.ty.ui else k.ty.uiMedium, color = if (n == 0) c.faint else c.fg)
                            }
                        }
                    }
                }
            }
        }
        }
    }
}

/** Grid cards (the web's auto-fill minmax(210, 1fr)) or one table. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UnitBlock(app: AppModel, list: List<GroupUnit>, grid: Boolean, width: Dp) {
    if (grid) {
        val cols = maxOf(1, ((width.value + 8) / 218).toInt())
        val cardW = ((width.value - 8 * (cols - 1)) / cols).dp
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            list.forEach { FleetCard(app, it, Modifier.width(cardW)) }
        }
    } else {
        FleetTable(app, list)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FleetCard(app: AppModel, u: GroupUnit, modifier: Modifier) {
    val c = k.c
    val s = u.lead
    val now = app.now
    var menu by remember { mutableStateOf(false) }
    val grouped = u.children.isNotEmpty()
    Box(modifier) {
        Pressable({ app.open(s.id) }, Modifier.fillMaxWidth().alpha(if (u.all.any(::isLive)) 1f else 0.75f).panel(c.surface, c.border, k.r.lg), onLongClick = { menu = true }, radius = k.r.lg) {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Dot(c.stateColor(s.state.name.lowercase()), 8.dp)
                    Text(
                        if (grouped) app.meta.of(s.id).groupName?.takeIf { it.isNotBlank() } ?: app.title(s) else app.title(s),
                        style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    if (grouped) {
                        KIcon(Lucide.List, c.faint, 11.dp)
                        Text("${u.children.size + 1}", style = k.ty.textXsmall, color = c.faint)
                    }
                    Text(agoShort(s.lastActivity, now), style = k.ty.textXsmall, color = c.faint)
                }
                activity(s)?.let { (text, dot) ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Dot(c.stateColor(dot), 6.dp)
                        Text(text, style = k.ty.textXsmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                s.lastPrompt?.takeIf { it.isNotBlank() }?.let {
                    Text(plain(it, 140), style = k.ty.textXsmall, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(k.r.md)).background(c.chip).padding(horizontal = 8.dp, vertical = 4.dp))
                }
                s.lastReply?.takeIf { it.isNotBlank() }?.let {
                    Text(plain(it, 140), style = k.ty.textXsmall, color = c.muted, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth().panel(Color.Transparent, c.border, k.r.md).padding(horizontal = 8.dp, vertical = 4.dp))
                }
                if (grouped) Kids(app, u)
                val tags = app.tagsOf(s.id)
                if (tags.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    tags.forEach { TagPill(it, app.prefs.tagColors, fleet = true) }
                }
            }
        }
        KMenu(menu, { menu = false }) {
            KMenuItem("Open", { menu = false; app.open(s.id) })
            KMenuItem(if (app.meta.of(s.id).archived) "Unarchive" else "Archive", { menu = false; app.toggleArchive(s.id) }, icon = if (app.meta.of(s.id).archived) Lucide.Unarchive else Lucide.Archive)
        }
    }
}

/** "{activity}…" while working, else the current task with its progress. */
private fun activity(s: Session): Pair<String, String>? = when {
    s.state == dev.qjoly.hooked.data.SessionState.WORKING && !s.activity.isNullOrBlank() -> "${s.activity}…" to "working"
    (s.todo?.total ?: 0) > 0 && s.todo?.current != null -> "${s.todo.current} (${s.todo.done}/${s.todo.total})" to "background"
    else -> null
}

@Composable
private fun Kids(app: AppModel, u: GroupUnit) {
    val c = k.c
    var all by remember { mutableStateOf(false) }
    val kids = u.children.sortedBy { !isLive(it) }
    val shown = if (all || kids.size <= 4) kids else kids.take(3)
    val line = c.border
    Column(Modifier.drawBehind { drawLine(line, Offset(0.5f, 0f), Offset(0.5f, size.height), 1.dp.toPx()) }.padding(start = 8.dp)) {
        for (kid in shown) {
            Pressable({ app.open(kid.id) }, Modifier.fillMaxWidth().height(22.dp), radius = k.r.sm) {
                Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Dot(c.stateColor(kid.state.name.lowercase()), 6.dp)
                    Text(app.title(kid), style = k.ty.textXsmallMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Text(activity(kid)?.first.orEmpty(), style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(agoShort(kid.lastActivity, app.now), style = k.ty.textXsmall, color = c.faint)
                }
            }
        }
        if (shown.size < kids.size) {
            Pressable({ all = true }, Modifier.height(22.dp), radius = k.r.sm) {
                Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("+${kids.size - shown.size}", style = k.ty.textXsmallMedium, color = c.muted)
                    kids.drop(shown.size).forEach { Dot(c.stateColor(it.state.name.lowercase()), 6.dp) }
                }
            }
        }
    }
}

/** List mode: SESSION · BRANCH · STATUS · AGE, a state bar on the left. */
@Composable
private fun FleetTable(app: AppModel, list: List<GroupUnit>) {
    val c = k.c
    val strong = c.border2
    val weak = c.border
    Column {
        Row(Modifier.fillMaxWidth().height(20.dp).drawBehind { drawLine(strong, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Spacer(Modifier.width(3.dp))
            Text("SESSION", style = k.ty.tableCaption, color = c.faint, modifier = Modifier.weight(2f))
            Text("BRANCH", style = k.ty.tableCaption, color = c.faint, modifier = Modifier.weight(1f))
            Text("STATUS", style = k.ty.tableCaption, color = c.faint, modifier = Modifier.width(130.dp))
            Text("AGE", style = k.ty.tableCaption, color = c.faint, modifier = Modifier.width(56.dp), textAlign = TextAlign.End)
        }
        list.forEachIndexed { i, u ->
            val s = u.lead
            val live = u.all.any(::isLive)
            Column(Modifier.fillMaxWidth().background(if (i % 2 == 1) c.surface else Color.Transparent)
                .drawBehind { drawLine(weak, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }) {
                Pressable({ app.open(s.id) }, Modifier.fillMaxWidth().heightIn(min = 24.dp), radius = 0.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(3.dp, 24.dp).background(c.stateColor(s.state.name.lowercase())))
                        Text(app.title(s), style = k.ty.textSmallMedium, color = if (live) c.fg else c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(2f))
                        Text(s.gitBranch.orEmpty(), style = k.ty.mono.copy(fontSize = androidx.compose.ui.unit.TextUnit(11f, androidx.compose.ui.unit.TextUnitType.Sp)), color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(stateLabel(s), style = k.ty.mono.copy(fontSize = androidx.compose.ui.unit.TextUnit(11f, androidx.compose.ui.unit.TextUnitType.Sp)), color = c.faint, maxLines = 1, modifier = Modifier.width(130.dp))
                        Text(agoShort(s.lastActivity, app.now), style = k.ty.textXsmall, color = c.faint, modifier = Modifier.width(56.dp), textAlign = TextAlign.End)
                    }
                }
                if (u.children.isNotEmpty()) Box(Modifier.padding(start = 13.dp, bottom = 4.dp)) { Kids(app, u) }
            }
        }
    }
}
