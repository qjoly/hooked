package dev.qjoly.hooked.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dock.MAX_PATCH_LINES
import dev.qjoly.hooked.data.dock.PatchKind
import dev.qjoly.hooked.data.dock.PatchLine
import dev.qjoly.hooked.data.dock.agoShort
import dev.qjoly.hooked.data.dock.changeLetter
import dev.qjoly.hooked.data.dock.checkLabel
import dev.qjoly.hooked.data.dock.checkRank
import dev.qjoly.hooked.data.dock.checkState
import dev.qjoly.hooked.data.dock.checksSummary
import dev.qjoly.hooked.data.dock.commentExcerpt
import dev.qjoly.hooked.data.dock.decisionBadge
import dev.qjoly.hooked.data.dock.detailState
import dev.qjoly.hooked.data.dock.linkNumber
import dev.qjoly.hooked.data.dock.patchLines
import dev.qjoly.hooked.data.dock.timelineVerb
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.serialization.json.JsonElement

/**
 * rune's widened dock (`dock.rs::gh_full`): a link tab bar, the full pull request or issue, and the dock
 * actions. On a tablet it slides over the right of the screen instead of widening the column.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GhFullSheet(app: AppModel, dock: DockModel, session: String, view: GhView, links: List<String>, withActions: Boolean) {
    val kit = k
    Dialog({ dock.closeGhFull() }, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        ProvideKit(kit) {
            val c = k.c
            BoxWithConstraints(Modifier.fillMaxSize().clickable(remember { MutableInteractionSource() }, indication = null) { dock.closeGhFull() }) {
                val width = (maxWidth * 0.42f).coerceIn(420.dp, 720.dp).coerceAtMost(maxWidth)
                Column(
                    Modifier.align(Alignment.CenterEnd).width(width).fillMaxHeight().background(c.bg).leftRule(c.border)
                        .clickable(remember { MutableInteractionSource() }, indication = null) {}
                        .windowInsetsPadding(WindowInsets.systemBars),
                ) {
                    FlowRow(
                        Modifier.fillMaxWidth().bottomRule(c.border).padding(horizontal = 8.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        itemVerticalAlignment = Alignment.CenterVertically,
                    ) {
                        KIconButton(Lucide.ArrowLeft, "Back to the session context", { dock.closeGhFull() }, size = Size.SMALL)
                        for (l in links) {
                            val on = l == view.url
                            Pressable({ dock.openGhFull(l, session) }, Modifier.height(24.dp), fill = if (on) c.chip else Color.Transparent, radius = k.r.sm) {
                                Row(Modifier.padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    KIcon(if ("/pull/" in l) Lucide.PullRequest else Lucide.CircleDot, c.muted, 12.dp)
                                    Text(linkNumber(l), style = k.ty.textSmallMedium, color = if (on) c.fg else c.muted, maxLines = 1)
                                }
                            }
                        }
                    }
                    GhDetailPanel(app, dock, session, view, Modifier.weight(1f))
                    if (withActions) DockActions(app, session)
                }
            }
        }
    }
}

/** `view/ghdetail.rs::panel`: header, then Summary, Timeline or Code. */
@Composable
internal fun GhDetailPanel(app: AppModel, dock: DockModel, session: String, v: GhView, modifier: Modifier = Modifier, extra: @Composable () -> Unit = {}) {
    val c = k.c
    val r = dock.ghDetails[v.url]
    val d = r?.getOrNull()
    Column(modifier.fillMaxWidth()) {
        if (d == null) {
            Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 8.dp)) {
                Spacer(Modifier.weight(1f))
                extra()
            }
            val err = r?.exceptionOrNull()
            Row(Modifier.fillMaxWidth().padding(14.dp).padding(vertical = 40.dp)) {
                Text(err?.message ?: "Loading…", style = k.ty.body, color = if (err != null) c.danger.fg else c.faint)
            }
        } else {
            val isPr = (d["kind"].str ?: "pr") == "pr"
            GhHeader(app, dock, session, v, d, extra)
            val list = remember(v.url, v.tab) { LazyListState() }
            val diff = dock.ghDiffs[v.url]
            val parsed = remember(diff) { HashMap<String, List<PatchLine>>() }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), list, contentPadding = PaddingValues(14.dp)) {
                when {
                    v.tab == 1 -> item { Timeline(d, app.now) }
                    v.tab == 2 && isPr -> codeItems(dock, v, d, diff, parsed)
                    else -> item { Summary(app, dock, session, v, d) }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GhHeader(app: AppModel, dock: DockModel, session: String, v: GhView, d: JsonElement, extra: @Composable () -> Unit) {
    val c = k.c
    val uri = LocalUriHandler.current
    val kind = d["kind"].str ?: "pr"
    val isPr = kind == "pr"
    val url = d["url"].str.orEmpty()
    val (st, tone) = detailState(kind, d["state"].str.orEmpty())
    Column(
        Modifier.fillMaxWidth().bottomRule(c.border).padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Pressable({ openLink(app, dock, uri, session, url) }, Modifier.weight(1f), radius = 0.dp) {
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("#${d["number"].int ?: 0} ${d["title"].str.orEmpty()}", style = k.ty.textSmallMedium, color = c.fg, modifier = Modifier.weight(1f))
                    KIcon(Lucide.Link, c.faint, 12.dp, Modifier.padding(top = 3.75.dp))
                }
            }
            Badge(st, tone)
        }
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            Text(d["author"].str.orEmpty(), style = k.ty.textXsmallMedium, color = c.muted)
            Text(agoShort(d["createdAt"].millis, app.now), style = k.ty.textXsmall, color = c.faint)
            if (isPr) {
                Text("${d["base"].str.orEmpty()} ← ${d["head"].str.orEmpty()}", style = k.ty.mono, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                KIcon(Lucide.Diff, c.faint, 12.dp)
                Text((d["changedFiles"].int ?: 0).toString(), style = k.ty.textXsmall, color = c.muted)
                Text("+${d["additions"].int ?: 0}", style = k.ty.textXsmallMedium, color = c.success.fg)
                Text("−${d["deletions"].int ?: 0}", style = k.ty.textXsmallMedium, color = c.danger.fg)
            } else {
                Text(url.removePrefix("https://github.com/").substringBefore("/issues/"), style = k.ty.textXsmall, color = c.faint)
            }
        }
        val labels = if (isPr) listOf("Summary", "Timeline", "Code") else listOf("Summary", "Timeline")
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            Segmented(labels, v.tab.coerceAtMost(labels.size - 1)) { dock.ghTab(it) }
            decisionBadge(d["decision"].str.orEmpty())?.let { (label, t) -> Badge(label, t) }
            checksSummary(d["checks"].arr.map { it["status"].str.orEmpty() })?.let { s ->
                val ink = when (s.tone) {
                    "ko" -> c.danger.fg
                    "wait" -> c.warning.fg
                    else -> c.success.fg
                }
                Text(s.label, style = k.ty.textXsmallMedium, color = ink)
            }
            Spacer(Modifier.weight(1f))
            KIconButton(Lucide.Restart, "Refresh", { dock.ghRefresh() }, size = Size.SMALL, enabled = !dock.isLoading(v.url))
            extra()
        }
    }
}

@Composable
private fun Section(title: String, body: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(title)
        body()
    }
}

/** A `#rrggbb` label colour, or null. */
private fun hexColor(hex: String?): Color? =
    hex?.removePrefix("#")?.takeIf { it.length == 6 }?.toLongOrNull(16)?.let { Color(0xFF000000 or it) }

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Summary(app: AppModel, dock: DockModel, session: String, v: GhView, d: JsonElement) {
    val c = k.c
    val uri = LocalUriHandler.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        if ((d["kind"].str ?: "pr") == "issue") {
            val labels = d["labels"].arr
            val assignees = d["assignees"].arr.mapNotNull { it.str }
            if (labels.isNotEmpty() || assignees.isNotEmpty()) {
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    itemVerticalAlignment = Alignment.CenterVertically,
                ) {
                    for (l in labels) Pill(l["name"].str.orEmpty(), c.fg, (hexColor(l["color"].str) ?: c.muted).copy(alpha = 0.3f))
                    if (assignees.isNotEmpty()) Text("→ ${assignees.joinToString(", ")}", style = k.ty.textXsmall, color = c.faint)
                }
            }
        }
        val body = d["body"].str.orEmpty()
        Section("DESCRIPTION") {
            if (body.isBlank()) Text("No description.", style = k.ty.textSmall, color = c.faint)
            else SelectionContainer { DockMarkdown(body) }
        }
        val checks = d["checks"].arr.sortedBy { checkRank(it["status"].str.orEmpty()) }
        if (checks.isNotEmpty()) {
            Section("CHECKS") {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    for (ch in checks) CheckRow(app, dock, session, v, ch, uri)
                }
            }
        }
        val comments = d["comments"].arr
        Section("COMMENTS (${comments.size})") {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (comments.isEmpty()) Text("No comments.", style = k.ty.textSmall, color = c.faint)
                val (bots, people) = comments.reversed().partition { it["bot"].bool }
                for (cm in people) Comment(dock, v, cm, app.now)
                if (bots.isNotEmpty()) {
                    Pressable({ dock.toggleBots() }, Modifier.fillMaxWidth().height(30.dp).border(1.dp, c.border, RoundedCornerShape(k.r.sm)), radius = k.r.sm) {
                        Row(Modifier.weight(1f).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            KIcon(if (v.bots) Lucide.ChevronDown else Lucide.ArrowRight, c.faint, 12.dp)
                            KIcon(Lucide.Bot, c.muted, 13.dp)
                            Text("${bots.size} bot comment${if (bots.size > 1) "s" else ""}", style = k.ty.textSmallMedium, color = c.fg, maxLines = 1)
                            Text("latest ${agoShort(bots[0]["at"].millis, app.now)}", style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                        }
                    }
                    if (v.bots) {
                        Column(Modifier.fillMaxWidth().padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            for (cm in bots) Comment(dock, v, cm, app.now)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CheckRow(app: AppModel, dock: DockModel, session: String, v: GhView, ch: JsonElement, uri: androidx.compose.ui.platform.UriHandler) {
    val c = k.c
    val status = ch["status"].str.orEmpty()
    val name = ch["name"].str.orEmpty()
    val link = ch["url"].str.orEmpty()
    val fill = if (status == "failed") c.danger.bg.copy(alpha = 0.5f) else Color.Transparent
    var hint by remember { mutableStateOf<String?>(null) }
    val line: @Composable RowScope.() -> Unit = {
        Dot(c.stateColor(checkState(status)), 7.dp)
        Text(name, style = k.ty.textSmall, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(checkLabel(status), style = k.ty.textXsmall, color = c.faint, maxLines = 1)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (link.isEmpty()) {
            Row(
                Modifier.weight(1f).height(26.dp).clip(RoundedCornerShape(k.r.sm)).background(fill).padding(horizontal = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = line,
            )
        } else {
            Pressable({ openLink(app, dock, uri, session, link) }, Modifier.weight(1f).height(26.dp), onLongClick = { hint = link }, fill = fill, radius = k.r.sm) {
                Row(Modifier.weight(1f).padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, content = line)
                Hint(hint) { hint = null }
            }
        }
        if (v.session != null && status == "failed") {
            val state = v.fixed[name]
            val label = when (state) {
                Fix.SENT -> "Sent"
                Fix.FAILED -> "Retry"
                Fix.SENDING -> "Sending…"
                null -> "Fix in this thread"
            }
            KButton(label, { dock.fixCheck(name, link) }, variant = Variant.OUTLINE, size = Size.SMALL, icon = Lucide.Tool, enabled = state != Fix.SENT && state != Fix.SENDING)
        }
    }
}

@Composable
private fun Comment(dock: DockModel, v: GhView, cm: JsonElement, now: Long) {
    val c = k.c
    val key = "${cm["at"].str.orEmpty()}|${cm["author"].str.orEmpty()}"
    val open = key in v.comments
    val body = cm["body"].str.orEmpty()
    val shape = RoundedCornerShape(k.r.sm)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, c.border, shape)) {
        Pressable({ dock.toggleComment(key) }, Modifier.fillMaxWidth().heightIn(min = 30.dp), radius = 0.dp) {
            Row(Modifier.weight(1f).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                KIcon(if (open) Lucide.ChevronDown else Lucide.ArrowRight, c.faint, 12.dp)
                Text(cm["author"].str.orEmpty(), style = k.ty.textSmallMedium, color = c.fg, maxLines = 1)
                Text(agoShort(cm["at"].millis, now), style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                if (!open) Text(commentExcerpt(body), style = k.ty.textSmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        if (open) {
            Box(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 10.dp)) { SelectionContainer { DockMarkdown(body) } }
        }
    }
}

@Composable
private fun Timeline(d: JsonElement, now: Long) {
    val c = k.c
    val events = d["timeline"].arr
    if (events.isEmpty()) {
        Text("Nothing yet.", style = k.ty.textSmall, color = c.faint)
        return
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        for (e in events) {
            val kind = e["kind"].str.orEmpty()
            val (verb, tint) = timelineVerb(kind, e["state"].str.orEmpty())
            val icon = when (kind) {
                "commit" -> Lucide.GitBranch
                "review" -> Lucide.Eye
                else -> Lucide.Converse
            }
            val tintColor = when (tint) {
                "ok" -> c.success.hue
                "ko" -> c.danger.hue
                else -> c.faint
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(24.dp).clip(CircleShape).background(c.chip), contentAlignment = Alignment.Center) { KIcon(icon, tintColor, 13.dp) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(e["author"].str.orEmpty(), style = k.ty.textSmallMedium, color = c.fg, maxLines = 1)
                        Text(verb, style = k.ty.textSmall, color = c.faint, maxLines = 1)
                        if (kind == "commit") {
                            Box(Modifier.clip(RoundedCornerShape(k.r.sm)).background(c.chip).padding(horizontal = 5.dp)) {
                                Text(e["sha"].str.orEmpty(), style = k.ty.mono, color = c.muted, maxLines = 1)
                            }
                        }
                        Spacer(Modifier.weight(1f))
                        Text(agoShort(e["at"].millis, now), style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                    }
                    val t = e["text"].str.orEmpty()
                    if (kind == "commit") Text(t, style = k.ty.textSmall, color = c.muted)
                    else if (t.isNotBlank()) SelectionContainer { DockMarkdown(t) }
                }
            }
        }
    }
}

/** The Code tab, one lazy row per patch line so a long diff scrolls smoothly. */
private fun LazyListScope.codeItems(dock: DockModel, v: GhView, d: JsonElement, diff: Result<kotlinx.serialization.json.JsonObject>?, parsed: HashMap<String, List<PatchLine>>) {
    for (f in d["files"].arr) {
        val path = f["path"].str.orEmpty()
        val open = path in v.files
        item { FileRow(dock, path, f, open) }
        if (!open) continue
        when {
            diff == null -> item { Note("Loading the diff…", null) }
            diff.isFailure -> item { Note(diff.exceptionOrNull()?.message ?: "Could not load the diff", true) }
            else -> {
                val patch = diff.getOrNull()?.get(path)?.str
                if (patch == null) {
                    item { Note("No textual diff (binary or too large).", null) }
                } else {
                    val lines = parsed.getOrPut(path) { patchLines(patch) }
                    item { PatchEdge(top = true) }
                    items(lines.take(MAX_PATCH_LINES)) { PatchRow(it) }
                    item { PatchEdge(top = false) }
                    if (lines.size > MAX_PATCH_LINES) item { Note("${lines.size - MAX_PATCH_LINES} more lines: open the pull request on GitHub.", null) }
                }
            }
        }
    }
}

@Composable
private fun FileRow(dock: DockModel, path: String, f: JsonElement, open: Boolean) {
    val c = k.c
    Pressable({ dock.toggleFile(path) }, Modifier.fillMaxWidth().padding(bottom = 4.dp).height(28.dp), fill = if (open) c.chip else Color.Transparent, radius = k.r.sm) {
        Row(Modifier.weight(1f).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            KIcon(if (open) Lucide.ChevronDown else Lucide.ArrowRight, c.faint, 12.dp)
            Text(changeLetter(f["change"].str.orEmpty()), style = k.ty.mono, color = c.faint, modifier = Modifier.width(10.dp))
            Text(path, style = k.ty.textSmall, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("+${f["additions"].int ?: 0}", style = k.ty.textXsmallMedium, color = c.success.fg)
            Text("−${f["deletions"].int ?: 0}", style = k.ty.textXsmallMedium, color = c.danger.fg)
        }
    }
}

/** rune's `note`: an indented one-liner; `danger` true for an error, null for a faint note. */
@Composable
private fun Note(msg: String, danger: Boolean?) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 6.dp)) {
        Text(msg, style = k.ty.textSmall, color = if (danger == true) k.c.danger.fg else k.c.faint)
    }
}

private fun Modifier.sideRules(color: Color) = drawBehind {
    val w = 1.dp.toPx()
    drawLine(color, Offset(w / 2, 0f), Offset(w / 2, size.height), w)
    drawLine(color, Offset(size.width - w / 2, 0f), Offset(size.width - w / 2, size.height), w)
}

/** The top or bottom 4 dp of a patch box, closing its border. */
@Composable
private fun PatchEdge(top: Boolean) {
    val c = k.c
    Box(
        Modifier.fillMaxWidth().padding(bottom = if (top) 0.dp else 4.dp).height(4.dp).background(c.bg).sideRules(c.border)
            .then(if (top) Modifier.topRule(c.border) else Modifier.bottomRule(c.border)),
    )
}

@Composable
private fun PatchRow(l: PatchLine) {
    val c = k.c
    val (fill, ink) = when (l.kind) {
        PatchKind.META -> Color.Transparent to c.faint
        PatchKind.HUNK -> c.info.bg.copy(alpha = 0.5f) to c.info.fg
        PatchKind.ADD -> c.success.bg to c.fg
        PatchKind.DEL -> c.danger.bg to c.fg
        PatchKind.CTX -> Color.Transparent to c.muted
    }
    Row(
        Modifier.fillMaxWidth().background(c.bg).background(fill).sideRules(c.border).padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(l.sign, style = k.ty.mono, color = ink, modifier = Modifier.width(10.dp))
        Text(l.text.ifEmpty { " " }, style = k.ty.mono, color = ink, modifier = Modifier.weight(1f))
    }
}
