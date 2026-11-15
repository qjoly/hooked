package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.GroupUnit
import dev.qjoly.hooked.state.Section
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.state.cacheLeft
import dev.qjoly.hooked.state.isArchived
import dev.qjoly.hooked.state.isSnoozed
import dev.qjoly.hooked.state.of
import dev.qjoly.hooked.state.projectLabel
import dev.qjoly.hooked.state.recentEnough
import dev.qjoly.hooked.state.sectionOf
import dev.qjoly.hooked.state.snoozePresets
import dev.qjoly.hooked.state.sortSessions
import dev.qjoly.hooked.state.span
import dev.qjoly.hooked.state.titleOf
import dev.qjoly.hooked.state.units
import dev.qjoly.hooked.state.wakeLabel
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.KMenu
import dev.qjoly.hooked.ui.kit.KMenuGroup
import dev.qjoly.hooked.ui.kit.KMenuItem
import dev.qjoly.hooked.ui.kit.KMenuSeparator
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Spinner
import dev.qjoly.hooked.ui.kit.TagPill
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k

/** The open modal of the sidebar, if any. */
sealed interface SidebarModal {
    data class Tags(val id: String) : SidebarModal
    data class Group(val id: String) : SidebarModal
    data class RenameGroup(val id: String) : SidebarModal
    data class Filter(val tags: Boolean) : SidebarModal
}

/** What rune keeps in its app state for the sidebar: folds, windows and the Archived tab. Lives as long as the process. */
object SidebarState {
    /** Sections whose fold differs from their default (only Waiting starts open). */
    val flipped = mutableStateMapOf<Section, Boolean>()

    /** Windowed sections opened past their window. */
    val opened = mutableStateMapOf<Section, Boolean>()

    /** Project folders folded in the project layout. */
    val foldedProjects = mutableStateMapOf<String, Boolean>()
    var showArchived by mutableStateOf(false)
    var older by mutableStateOf(false)

    fun isOpen(s: Section) = (s == Section.WAITING) xor (flipped[s] == true)
    fun toggle(s: Section) {
        flipped[s] = flipped[s] != true
    }
}

/** Everything the sidebar lists, computed once per frame from the app state (`view/mod.rs::sidebar`). */
private class Lists(private val app: AppModel) {
    val now = app.now
    val meta = app.meta
    private val selected = app.selected
    private fun filtered(list: List<Session>) = list.filter { s ->
        (app.repoFilter.isEmpty() || projectLabel(s) in app.repoFilter) && app.tagFilter.all { it in app.tagsOf(s.id) }
    }
    private val vis = app.visible
    val activeCount = vis.count { !isArchived(it, meta, now) }
    val archivedCount = vis.count { isArchived(it, meta, now) }
    val live = sortSessions(
        filtered(vis.filter { !isArchived(it, meta, now) && (!app.prefs.hideOld || recentEnough(it, now, selected)) }),
        app.prefs.sortMode, app.prefs.pinned, app.prefs.names,
    )
    val gone = sortSessions(filtered(vis.filter { isArchived(it, meta, now) }), app.prefs.sortMode, app.prefs.pinned, app.prefs.names)
    val liveUnits = units(live, meta)
    val bySection: Map<Section, List<GroupUnit>> = liveUnits.groupBy { sectionOf(it, meta, now) }.mapValues { (sec, list) ->
        if (sec == Section.SNOOZED) list.sortedBy { u -> u.all.minOf { meta.of(it.id).snoozeUntil ?: Long.MAX_VALUE } } else list
    } + (Section.ARCHIVED to units(gone, meta))
    val liveUnitCount = listOf(Section.WAITING, Section.WORKING, Section.IDLE).sumOf { bySection[it]?.size ?: 0 }
}

@Composable
fun Sidebar(app: AppModel, modifier: Modifier = Modifier) {
    val c = k.c
    val lists = Lists(app)
    var modal by remember { mutableStateOf<SidebarModal?>(null) }
    val showArchived = SidebarState.showArchived
    val density = LocalDensity.current
    var width by remember { mutableStateOf(app.prefs.sidebarW) }
    val line = c.border
    Row(
        modifier.width(width.dp).fillMaxHeight().background(c.bg)
            .drawBehind { drawLine(line, Offset(size.width - 0.5f, 0f), Offset(size.width - 0.5f, size.height), 1.dp.toPx()) },
    ) {
        Column(Modifier.weight(1f).fillMaxHeight()) {
            Header(app, lists, showArchived, { SidebarState.showArchived = it }) { modal = it }
            when (app.prefs.sidebarLayout) {
                "project", "flat" -> FlatOrProject(app, lists, showArchived, Modifier.weight(1f)) { modal = it }
                else -> ByStatus(app, lists, Modifier.weight(1f)) { modal = it }
            }
        }
        // The 6 dp grip: drag to resize between 220 and 560, saved on release.
        Box(
            Modifier.width(6.dp).fillMaxHeight().pointerInput(Unit) {
                detectHorizontalDragGestures(onDragEnd = { app.prefs.sidebarW(width) }) { _, dx ->
                    width = (width + dx / density.density).coerceIn(220f, 560f)
                }
            },
        )
    }
    modal?.let { m -> SidebarModals(app, m) { modal = null } }
}

@Composable
private fun Header(app: AppModel, lists: Lists, showArchived: Boolean, setArchived: (Boolean) -> Unit, openModal: (SidebarModal) -> Unit) {
    val c = k.c
    var filterMenu by remember { mutableStateOf(false) }
    var sortMenu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 10.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        if (app.prefs.sidebarLayout == "status") {
            HeadTab("Sessions", lists.liveUnitCount, true) {}
        } else {
            HeadTab("Sessions", lists.activeCount, !showArchived) { setArchived(false) }
            HeadTab("Archived", lists.archivedCount, showArchived) { setArchived(true) }
        }
        Spacer(Modifier.weight(1f))
        KIconButton(Lucide.Clock, "Show only the last 24h", { app.prefs.hideOld(!app.prefs.hideOld) }, size = Size.SMALL, on = app.prefs.hideOld)
        val nFilters = app.repoFilter.size + app.tagFilter.size
        Box {
            KIconButton(Lucide.Filter, if (nFilters > 0) "Filter by tag or repo ($nFilters on)" else "Filter by tag or repo", { sortMenu = false; filterMenu = true }, size = Size.SMALL, on = nFilters > 0)
            KMenu(filterMenu, { filterMenu = false }, minWidth = 220.dp) {
                KMenuItem("Repo", { filterMenu = false; openModal(SidebarModal.Filter(tags = false)) }, description = summary(app.repoFilter.toList(), "repos"))
                KMenuItem("Tags", { filterMenu = false; openModal(SidebarModal.Filter(tags = true)) }, description = summary(app.tagFilter.map { "#$it" }, "tags"))
                if (nFilters > 0) {
                    KMenuSeparator()
                    KMenuItem("Clear filters", { filterMenu = false; app.repoFilter = emptySet(); app.tagFilter = emptySet() }, icon = Lucide.Close)
                }
            }
        }
        Box {
            KIconButton(Lucide.Sort, "Group and sort", { filterMenu = false; sortMenu = true }, size = Size.SMALL, on = app.prefs.sortMode != "dynamic")
            KMenu(sortMenu, { sortMenu = false }, minWidth = 240.dp) {
                KMenuGroup("Group")
                listOf(Triple("status", "By status", "Waiting, working, idle, snoozed, archived"), Triple("project", "By project", "One folder per repository"), Triple("flat", "Flat", "A single list")).forEach { (key, label, desc) ->
                    KMenuItem(label, { sortMenu = false; app.prefs.sidebarLayout(key) }, description = desc, checked = app.prefs.sidebarLayout == key)
                }
                KMenuSeparator()
                KMenuGroup("Sort")
                val sorts = mutableListOf(Triple("dynamic", "Dynamic", "Awaiting you first, then most recent"), Triple("alpha", "Alphabetical", "Projects and sessions A→Z"))
                if (app.prefs.sidebarLayout == "project") sorts += Triple("alpha-project", "Alphabetical (projects only)", "Project headers A→Z, sessions by activity")
                sorts.forEach { (key, label, desc) -> KMenuItem(label, { sortMenu = false; app.prefs.sortMode(key) }, description = desc, checked = app.prefs.sortMode == key) }
            }
        }
        KIconButton(Lucide.ArrowLeft, "Collapse sidebar (⌘B)", { app.prefs.sidebarOpen(false) }, size = Size.SMALL)
    }
}

private fun summary(values: List<String>, plural: String) = when (values.size) {
    0 -> "Any"
    1 -> values.first()
    else -> "${values.size} $plural"
}

@Composable
private fun HeadTab(label: String, count: Int, on: Boolean, onClick: () -> Unit) {
    val c = k.c
    Pressable(onClick, Modifier.height(26.dp), fill = if (on) c.chip else Color.Transparent, radius = k.r.sm) {
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(label, style = k.ty.uiMedium, color = if (on) c.fg else c.muted)
            Text("$count", style = k.ty.textXsmall, color = c.faint)
        }
    }
}

/** Waiting, Working and Idle in the list; Snoozed and Archived docked at the bottom, opening upward. */
@Composable
private fun ByStatus(app: AppModel, lists: Lists, modifier: Modifier, openModal: (SidebarModal) -> Unit) {
    val st = SidebarState
    val opened = st.opened
    fun isOpen(s: Section) = st.isOpen(s)
    val inList = listOf(Section.WAITING, Section.WORKING, Section.IDLE).filter { !lists.bySection[it].isNullOrEmpty() }
    Column(modifier) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 8.dp, end = 8.dp, bottom = 8.dp)) {
            if (inList.isEmpty()) item { Text("No sessions.", style = k.ty.ui, color = k.c.faint, modifier = Modifier.padding(8.dp)) }
            for (sec in inList) {
                val units = lists.bySection.getValue(sec)
                item(key = "h:$sec") { SectionHeader(sec.label, units.size, isOpen(sec)) { st.toggle(sec) } }
                sectionRows(app, lists, sec, units, isOpen(sec), opened[sec] == true, { opened[sec] = it }, openModal)
            }
        }
        for (sec in listOf(Section.SNOOZED, Section.ARCHIVED)) {
            val units = lists.bySection[sec].orEmpty()
            if (units.isEmpty()) continue
            Dock(app, lists, sec, units, isOpen(sec), { st.toggle(sec) }, opened[sec] == true, { opened[sec] = it }, openModal)
        }
    }
}

private fun windowOf(sec: Section) = when (sec) {
    Section.IDLE -> 15
    Section.ARCHIVED -> 25
    else -> Int.MAX_VALUE
}

/** A folded section still shows the open session's unit; long sections show a window and a "N more" button. */
private fun LazyListScope.sectionRows(
    app: AppModel, lists: Lists, sec: Section, units: List<GroupUnit>, open: Boolean, expanded: Boolean,
    setExpanded: (Boolean) -> Unit, openModal: (SidebarModal) -> Unit,
) {
    val selected = app.selected
    if (!open) {
        units.firstOrNull { u -> u.all.any { it.id == selected } }?.let { u -> item(key = "u:${u.lead.id}") { UnitRows(app, lists, u, openModal) } }
        return
    }
    val window = windowOf(sec)
    val selIndex = units.indexOfFirst { u -> u.all.any { it.id == selected } }
    val shown = if (expanded) units.size else maxOf(minOf(window, units.size), selIndex + 1)
    items(units.take(shown), key = { "u:${it.lead.id}" }) { UnitRows(app, lists, it, openModal) }
    if (units.size > window) {
        item(key = "more:$sec") {
            if (expanded) KButton("Show less", { setExpanded(false) }, variant = Variant.GHOST_MUTED, icon = Lucide.ChevronDown, modifier = Modifier.padding(4.dp))
            else KButton("${units.size - shown} more", { setExpanded(true) }, variant = Variant.GHOST_MUTED, icon = Lucide.Plus, modifier = Modifier.padding(4.dp))
        }
    }
}

@Composable
private fun SectionHeader(title: String, count: Int, open: Boolean, onClick: () -> Unit) {
    val c = k.c
    Pressable(onClick, Modifier.fillMaxWidth().padding(top = 4.dp).height(28.dp), radius = k.r.md) {
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = k.ty.textXsmallMedium, color = c.muted)
            Text("$count", style = k.ty.textXsmallMedium, color = c.faint)
            Triangle(open)
        }
    }
}

/** rune's filled disclosure triangle, 12 dp, right when folded and down when open. */
@Composable
private fun Triangle(open: Boolean) {
    val color = k.c.faint
    androidx.compose.foundation.Canvas(Modifier.size(12.dp)) {
        val p = androidx.compose.ui.graphics.Path()
        val w = size.width
        if (open) {
            p.moveTo(w * 0.25f, w * 0.38f); p.lineTo(w * 0.75f, w * 0.38f); p.lineTo(w * 0.5f, w * 0.68f)
        } else {
            p.moveTo(w * 0.38f, w * 0.25f); p.lineTo(w * 0.68f, w * 0.5f); p.lineTo(w * 0.38f, w * 0.75f)
        }
        p.close()
        drawPath(p, color)
    }
}

/** A docked section: its list sits above its head, so it grows upward. */
@Composable
private fun Dock(
    app: AppModel, lists: Lists, sec: Section, units: List<GroupUnit>, open: Boolean, toggle: () -> Unit,
    expanded: Boolean, setExpanded: (Boolean) -> Unit, openModal: (SidebarModal) -> Unit,
) {
    val c = k.c
    val line = c.border
    val maxH = (LocalConfiguration.current.screenHeightDp * 0.35f).dp
    val selected = app.selected
    Column(
        Modifier.fillMaxWidth().drawBehind { drawLine(line, Offset(0f, 0.5f), Offset(size.width, 0.5f), 1.dp.toPx()) }
            .padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        val rows = when {
            open -> {
                val window = windowOf(sec)
                if (expanded) units else units.take(window)
            }
            else -> units.filter { u -> u.all.any { it.id == selected } }
        }
        if (rows.isNotEmpty()) {
            Column(Modifier.heightIn(max = maxH).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                rows.forEach { UnitRows(app, lists, it, openModal) }
                if (open && units.size > windowOf(sec)) {
                    if (expanded) KButton("Show less", { setExpanded(false) }, variant = Variant.GHOST_MUTED, icon = Lucide.ChevronDown)
                    else KButton("${units.size - rows.size} more", { setExpanded(true) }, variant = Variant.GHOST_MUTED, icon = Lucide.Plus)
                }
            }
        }
        Pressable(toggle, Modifier.fillMaxWidth().height(28.dp), radius = k.r.md) {
            Row(Modifier.padding(horizontal = 8.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(sec.label, style = k.ty.textXsmallMedium, color = c.muted)
                Text("${units.size}", style = k.ty.textXsmallMedium, color = c.faint)
                Spacer(Modifier.weight(1f))
                KIcon(if (open) Lucide.ChevronDown else Lucide.ChevronUp, c.faint, 12.dp)
            }
        }
    }
}

/** By project (one section per repo) or flat; a window of 40 rows plus the ones that matter. */
@Composable
private fun FlatOrProject(app: AppModel, lists: Lists, showArchived: Boolean, modifier: Modifier, openModal: (SidebarModal) -> Unit) {
    val shown = if (showArchived) lists.gone else lists.live
    val folded = SidebarState.foldedProjects
    val older = SidebarState.older
    val selected = app.selected
    val keep = shown.withIndex().filter { (i, s) -> older || i < 40 || s.id in app.prefs.pinned || s.needsYou || s.state == SessionState.WORKING || s.id == selected }.map { it.value }
    val hidden = shown.size - keep.size
    LazyColumn(modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 8.dp, end = 8.dp, bottom = 8.dp)) {
        if (shown.isEmpty()) item { Text(if (showArchived) "No archived sessions." else "No sessions.", style = k.ty.ui, color = k.c.faint, modifier = Modifier.padding(8.dp)) }
        if (app.prefs.sidebarLayout == "project") {
            var groups = keep.groupBy { projectLabel(it) }.entries.toList()
            if (app.prefs.sortMode != "dynamic") groups = groups.sortedBy { it.key.lowercase() }
            for ((label, list) in groups) {
                val isFolded = folded[label] == true
                item(key = "p:$label") {
                    // A repo header takes a dragged session out of its group, as the fleet's do.
                    Pressable({ folded[label] = !isFolded }, Modifier.fillMaxWidth().padding(top = 4.dp).dropTarget("repo:sb:$label").height(28.dp), radius = k.r.md) {
                        Row(Modifier.padding(horizontal = 8.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(label, style = k.ty.textXsmallMedium, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Text("${list.size}", style = k.ty.textXsmallMedium, color = k.c.faint)
                            Triangle(!isFolded)
                            Spacer(Modifier.weight(1f))
                            KIconButton(Lucide.Plus, "New session in $label", {
                                app.openNew(list.first().worktreeOf ?: list.first().project)
                            }, size = Size.SMALL)
                        }
                    }
                }
                if (!isFolded) items(units(list, lists.meta), key = { "u:${it.lead.id}" }) { UnitRows(app, lists, it, openModal) }
            }
        } else {
            items(units(keep, lists.meta), key = { "u:${it.lead.id}" }) { UnitRows(app, lists, it, openModal) }
        }
        if (hidden > 0) item { KButton(if (hidden == 1) "1 older session" else "$hidden older sessions", { SidebarState.older = true }, variant = Variant.GHOST_MUTED, icon = Lucide.Plus, modifier = Modifier.padding(4.dp)) }
        else if (older && shown.size > 40) item { KButton("Show less", { SidebarState.older = false }, variant = Variant.GHOST_MUTED, icon = Lucide.ChevronDown, modifier = Modifier.padding(4.dp)) }
    }
}

/** A unit: its lead row, then (unless folded) its members one level in. */
@Composable
private fun UnitRows(app: AppModel, lists: Lists, u: GroupUnit, openModal: (SidebarModal) -> Unit) {
    val folded = u.lead.id in app.prefs.foldedGroups
    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(bottom = 2.dp)) {
        SessionRow(app, lists, u.lead, 0, if (u.children.isEmpty()) null else if (folded) "+${u.children.size}" else "${u.children.size + 1}", isLead = u.children.isNotEmpty(), openModal = openModal)
        if (!folded) u.children.forEach { SessionRow(app, lists, it, 1, null, isLead = false, openModal = openModal) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionRow(app: AppModel, lists: Lists, s: Session, depth: Int, groupPill: String?, isLead: Boolean, openModal: (SidebarModal) -> Unit) {
    val c = k.c
    val now = lists.now
    val meta = lists.meta
    val m = meta.of(s.id)
    // rune dims and strips the explicitly archived only; a cold session looks like any other.
    val archived = m.archived
    val snoozed = isSnoozed(s, meta, now)
    val selected = app.selected == s.id
    var menu by remember { mutableStateOf(false) }
    var snoozeMenu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<String?>(null) }
    val title = if (isLead && !m.groupName.isNullOrBlank()) m.groupName else app.title(s)
    val tags = app.tagsOf(s.id)
    val ctx = LocalContext.current
    Box {
        SessionPress(
            app, s.id,
            { app.open(s.id) },
            { menu = true },
            Modifier.fillMaxWidth().dropTarget("sb:${s.id}").alpha(if (archived || snoozed) 0.7f else 1f),
            fill = if (selected) c.pressed else Color.Transparent,
            radius = k.r.md,
        ) {
            Column(Modifier.weight(1f).padding(start = (10 + 16 * depth).dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (s.id in app.prefs.pinned) KIcon(Lucide.Pin, c.muted, 12.dp)
                        val r = renaming
                        if (r != null) {
                            val focus = remember { FocusRequester() }
                            var had by remember { mutableStateOf(false) }
                            LaunchedEffect(Unit) { focus.requestFocus() }
                            // Leaving the field cancels, as Escape does in rune.
                            KTextInput(r, { renaming = it }, "Name", Modifier.weight(1f).focusRequester(focus).onFocusChanged {
                                if (it.isFocused) had = true else if (had) renaming = null
                            }, onSubmit = {
                                app.prefs.rename(s.id, r.trim().takeIf { it.isNotEmpty() && it != titleOf(s, emptyMap()) })
                                renaming = null
                            })
                        } else {
                            Text(title, style = k.ty.textSmallMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        }
                        groupPill?.let { Pill(it, c.muted, c.chip) }
                    }
                    Text(detail(app, s, snoozed, now), style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                    Box(Modifier.width(14.dp), contentAlignment = Alignment.Center) {
                        when {
                            archived -> {}
                            snoozed -> KIcon(Lucide.Snooze, c.muted, 12.dp)
                            s.state == SessionState.WORKING -> Spinner(12.dp)
                            s.needsYou -> Dot(c.warning.hue, 7.dp)
                            else -> Dot(c.stateColor(s.state.name.lowercase()), 6.dp)
                        }
                    }
                }
                val sub = (s.gitBranch?.let { "${projectLabel(s)} · $it" } ?: projectLabel(s)) + if (!app.prefs.incognito && m.incognito) "  · incognito" else ""
                Text(sub, style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (tags.isNotEmpty()) {
                    FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        tags.forEach { TagPill(it, app.prefs.tagColors) }
                    }
                }
            }
        }
        // Long press: the hover bar's actions and the context menu, in one menu.
        KMenu(menu, { menu = false }, minWidth = 220.dp) {
            KMenuItem("Open", { menu = false; app.open(s.id) })
            KMenuItem("Open in split", {
                menu = false
                val main = app.selected
                if (main == null) app.open(s.id) else SessionUi.of(ctx).openSplit(s.id, main)
            }, icon = Lucide.Split, enabled = !archived && app.selected != s.id)
            KMenuSeparator()
            KMenuItem("Rename…", { menu = false; renaming = app.title(s) })
            KMenuItem(if (s.id in app.prefs.pinned) "Unpin" else "Pin to the top", { menu = false; app.prefs.togglePin(s.id) }, icon = Lucide.Pin, checked = s.id in app.prefs.pinned)
            KMenuItem("Edit tags…", { menu = false; openModal(SidebarModal.Tags(s.id)) }, icon = Lucide.Tag)
            KMenuItem(if (snoozed) "Change the snooze…" else "Snooze…", { menu = false; snoozeMenu = true }, icon = Lucide.Snooze, enabled = !archived)
            KMenuItem("Move to group…", { menu = false; openModal(SidebarModal.Group(s.id)) }, icon = Lucide.List)
            val grouped = m.groupOf.let { it != null && it != s.id }
            if (grouped) KMenuItem("Leave the group", { menu = false; app.groupOp("leave", s.id) })
            if (!grouped && app.sessions.any { it.id != s.id && meta.of(it.id).groupOf == s.id }) {
                KMenuItem(if (s.id in app.prefs.foldedGroups) "Unfold the group" else "Fold the group", { menu = false; app.prefs.toggleFold(s.id) })
                KMenuItem("Rename the group…", { menu = false; openModal(SidebarModal.RenameGroup(s.id)) })
            }
            KMenuItem(if (m.incognito) "Remove from incognito" else "Mark incognito", { menu = false; app.toggleIncognito(s.id) }, icon = if (m.incognito) Lucide.Eye else Lucide.EyeOff)
            KMenuSeparator()
            KMenuItem(
                when {
                    m.archived -> "Unarchive"
                    s.live -> "Stop and archive"
                    else -> "Archive"
                },
                { menu = false; app.toggleArchive(s.id) },
                icon = if (m.archived) Lucide.Unarchive else Lucide.Archive,
            )
        }
        KMenu(snoozeMenu, { snoozeMenu = false }, minWidth = 200.dp) {
            m.snoozeUntil?.takeIf { snoozed }?.let { until ->
                KMenuItem("Wake now", { snoozeMenu = false; app.snooze(s.id, null) }, icon = Lucide.Bell, description = "Snoozed until ${wakeLabel(until, now)}")
                KMenuSeparator()
            }
            snoozePresets(System.currentTimeMillis()).forEach { (label, until) ->
                KMenuItem(label, { snoozeMenu = false; app.snooze(s.id, until) }, trailing = dev.qjoly.hooked.state.clockLabel(until))
            }
        }
    }
}

/** The wake time when snoozed, else the cache countdown (per the server's sidebarCache), else the age. */
private fun detail(app: AppModel, s: Session, snoozed: Boolean, now: Long): String {
    if (snoozed) return app.meta.of(s.id).snoozeUntil?.let { wakeLabel(it, now) } ?: ""
    val left = cacheLeft(s, now)
    val window = app.cacheWindowMin
    if (left != null && (window == 0 || left <= window * 60_000L)) {
        return if (app.cacheDisplay == "replace") "⚡${span(left)}" else "⚡${span(left)} · ${agoShort(s.lastActivity, now)}"
    }
    return agoShort(s.lastActivity, now)
}

/** The folded sidebar: a 48 dp column of two-letter tiles. */
@Composable
fun Rail(app: AppModel) {
    val c = k.c
    val line = c.border
    val now = app.now
    val tiles = app.visible.filter { !isArchived(it, app.meta, now) }
        .let { list -> if (app.prefs.sidebarLayout == "status") list.sortedBy { u -> sectionOf(dev.qjoly.hooked.state.GroupUnit(u, emptyList()), app.meta, now).ordinal } else list }
        .take(30)
    Column(
        Modifier.width(48.dp).fillMaxHeight().background(c.bg)
            .drawBehind { drawLine(line, Offset(size.width - 0.5f, 0f), Offset(size.width - 0.5f, size.height), 1.dp.toPx()) }
            .padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        KIconButton(Lucide.ArrowRight, "Expand sidebar (⌘B)", { app.prefs.sidebarOpen(true) })
        Column(Modifier.verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (s in tiles) {
                val letters = s.displayTitle.filter { it.isLetterOrDigit() }.take(2).uppercase()
                Pressable({ app.open(s.id) }, Modifier.size(36.dp), fill = if (app.selected == s.id) c.chip else Color.Transparent, radius = k.r.md) {
                    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically)) {
                        Text(letters, style = k.ty.textXsmallMedium, color = c.muted)
                        Dot(c.stateColor(s.state.name.lowercase()), 5.dp)
                    }
                }
            }
        }
    }
}

/** Shared shape for small rounded fills. */
internal fun roundedSm(r: androidx.compose.ui.unit.Dp) = RoundedCornerShape(r)

@Composable
internal fun Modifier.chip(fill: Color) = clip(RoundedCornerShape(k.r.md)).background(fill)
