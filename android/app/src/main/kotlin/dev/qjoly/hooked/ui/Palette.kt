package dev.qjoly.hooked.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.qjoly.hooked.data.Cite
import dev.qjoly.hooked.data.PaletteHit
import dev.qjoly.hooked.data.PaletteSession
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.data.openEditor
import dev.qjoly.hooked.data.openGhostty
import dev.qjoly.hooked.data.paletteHits
import dev.qjoly.hooked.data.paletteSearchable
import dev.qjoly.hooked.data.resync
import dev.qjoly.hooked.data.searchTranscripts
import dev.qjoly.hooked.data.snippetLine
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.Lens
import dev.qjoly.hooked.state.Page
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.state.isArchived
import dev.qjoly.hooked.state.projectLabel
import dev.qjoly.hooked.ui.kit.Appearance
import dev.qjoly.hooked.ui.kit.Corners
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.Scheme
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.session.copyText
import dev.qjoly.hooked.ui.session.splitWithRecent
import dev.qjoly.hooked.ui.session.toggleFocus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** A palette command (`palette.rs::Cmd`); `keys` is the shortcut that works here, empty to show the section. */
private class Cmd(val section: String, val icon: ImageVector, val label: String, val keys: String = "", val run: () -> Unit)

/** rune's command list: navigation, appearance, actions, then the open session's commands. */
private fun commands(app: AppModel, ui: SessionUi, ctx: Context, openTrash: (() -> Unit)?, requestNotifications: (() -> Unit)?): List<Cmd> {
    val nav = "Navigation"
    val out = mutableListOf(
        Cmd(nav, Lucide.Deck, "Go to Deck") { app.openDeck() },
        Cmd(nav, Lucide.List, "Go to Sessions") { app.openSessions() },
        Cmd(nav, Lucide.Plus, "New session") { app.openNew() },
        Cmd(nav, Lucide.Chart, "Go to Stats") { app.page = Page.Stats },
        Cmd(nav, Lucide.Book, "Go to Digest") { app.page = Page.Digest },
        Cmd(nav, Lucide.Brain, "Go to Memory") { app.page = Page.Memory },
        Cmd(nav, Lucide.Github, "Go to GitHub") { app.page = Page.Github },
        Cmd(nav, Lucide.Zap, "Go to Skills") { app.page = Page.Skills },
        Cmd(nav, Lucide.Clock, "Go to Cron") { app.page = Page.Cron },
        Cmd(nav, Lucide.Book, "Go to Prompts") { app.page = Page.Prompts },
        Cmd(nav, Lucide.Gear, "Go to Settings") { app.openSettings() },
    )
    val look = "Appearance"
    out += Cmd(look, Lucide.Sun, "Theme: Light") { app.prefs.appearance(Appearance.LIGHT) }
    out += Cmd(look, Lucide.Moon, "Theme: Dark") { app.prefs.appearance(Appearance.DARK) }
    out += Cmd(look, Lucide.Monitor, "Theme: System") { app.prefs.appearance(Appearance.SYSTEM) }
    out += Cmd(look, Lucide.Sun, "Cycle theme") {
        app.prefs.appearance(
            when (app.prefs.appearance) {
                Appearance.SYSTEM -> Appearance.LIGHT
                Appearance.LIGHT -> Appearance.DARK
                Appearance.DARK -> Appearance.SYSTEM
            },
        )
    }
    for (s in Scheme.entries) out += Cmd(look, Lucide.Circle, "Color scheme: ${s.label}") { app.prefs.scheme(s) }
    out += Cmd(look, Lucide.Circle, "Corners: Rounded") { app.prefs.corners(Corners.ROUND) }
    out += Cmd(look, Lucide.Circle, "Corners: Square") { app.prefs.corners(Corners.SHARP) }

    val act = "Actions"
    out += Cmd(act, Lucide.Sidebar, if (ui.focus) "Exit focus mode" else "Enter focus mode") { toggleFocus(app, ui) }
    out += Cmd(act, Lucide.Sidebar, "Toggle the sidebar") { app.prefs.sidebarOpen(!app.prefs.sidebarOpen) }
    out += Cmd(act, Lucide.PanelRight, "Toggle the context panel") { ui.toggleDock() }
    val incognito = app.prefs.incognito
    out += Cmd(act, if (incognito) Lucide.Eye else Lucide.EyeOff, if (incognito) "Leave incognito mode" else "Enter incognito mode (hide every other session)") {
        app.toggleIncognitoMode()
    }
    out += Cmd(act, if (app.notify) Lucide.BellOff else Lucide.Bell, if (app.notify) "Disable notifications" else "Enable notifications") {
        val on = !app.notify
        app.changeNotify(on)
        if (on) requestNotifications?.invoke()
    }
    openTrash?.let { out += Cmd(act, Lucide.Trash, "Open trash", run = it) }
    out += Cmd(act, Lucide.Tool, if (ui.allToolsOpen) "Tool details: collapse all" else "Tool details: expand all") { ui.allToolsOpen = !ui.allToolsOpen }
    out += Cmd(act, Lucide.Restart, "Force resync all sessions") { app.act("Resync", "✓ Live states resynced") { it.resync() } }

    val id = app.selected ?: return out
    val x = app.session(id) ?: return out
    val cur = "Current session"
    out += Cmd(cur, Lucide.Converse, "Lens: Converse", "⌘1") { ui.lens = Lens.CONVERSE }
    out += Cmd(cur, Lucide.Terminal, "Toggle the terminal", "⌘2") { ui.termOpen = !ui.termOpen }
    out += Cmd(cur, Lucide.Ship, "Lens: Review", "⌘3") { ui.lens = Lens.REVIEW }
    out += Cmd(cur, Lucide.Plug, "Lens: MCP", "⌘4") { ui.lens = Lens.MCP }
    out += Cmd(cur, Lucide.Activity, "Lens: Trace", "⌘5") { ui.lens = Lens.TRACE }
    out += Cmd(cur, Lucide.Split, "Split with the most recent session") {
        if (ui.splits.isNotEmpty()) ui.splits.clear() else splitWithRecent(app, ui, id)
    }
    out += Cmd(cur, Lucide.Copy, "Copy project path: ${projectLabel(x)}") {
        x.project?.let {
            copyText(ctx, it)
            app.say("✓ Path copied")
        }
    }
    out += Cmd(cur, Lucide.Code, "Open the project in the editor") { app.act("Editor", "✓ Opened in editor") { it.openEditor(id) } }
    out += Cmd(cur, Lucide.Terminal, "Open in Ghostty") { app.act("Ghostty", "✓ Opened in Ghostty") { it.openGhostty(id) } }
    if (x.state == SessionState.WORKING) {
        out += Cmd(cur, Lucide.Stop, "Interrupt the session", "Esc") { app.act("Interrupt", "✓ Interrupted") { it.interrupt(id) } }
    }
    val archived = isArchived(x, app.meta, app.now)
    out += Cmd(cur, if (archived) Lucide.Unarchive else Lucide.Archive, if (archived) "Unarchive the session" else "Archive the session") { app.toggleArchive(id) }
    return out
}

/** rune's command palette (`view/palette.rs`): sessions, commands and transcript hits in one list. */
@Composable
internal fun Palette(app: AppModel, openTrash: (() -> Unit)? = null, requestNotifications: (() -> Unit)? = null, close: () -> Unit) {
    val kit = k
    val density = LocalDensity.current
    val ctx = LocalContext.current
    val ui = remember { SessionUi.of(ctx) }
    var query by remember { mutableStateOf("") }
    var index by remember { mutableIntStateOf(0) }
    var cites by remember { mutableStateOf<List<Cite>>(emptyList()) }
    var citesFor by remember { mutableStateOf("") }
    var allCites by remember { mutableStateOf(false) }
    val raw = query.trim()

    LaunchedEffect(raw) {
        if (!paletteSearchable(raw)) return@LaunchedEffect
        delay(250)
        val c = app.client ?: return@LaunchedEffect
        cites = try {
            c.searchTranscripts(raw)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
        citesFor = raw
    }

    val cmds = commands(app, ui, ctx, openTrash, requestNotifications)
    val visible = app.visible
    val hits = paletteHits(
        raw,
        cmds.map { it.label to it.section },
        visible.map { PaletteSession(it.id, "${app.title(it)} ${projectLabel(it)} ${it.lastPrompt.orEmpty()}") },
        cites.takeIf { citesFor == raw },
        allCites,
        if (app.prefs.incognito) visible.mapTo(HashSet()) { it.id } else null,
    )
    val sel = index.coerceIn(0, (hits.size - 1).coerceAtLeast(0))
    val searching = paletteSearchable(raw) && citesFor != raw

    fun run(h: PaletteHit) {
        if (h is PaletteHit.More) {
            allCites = true
            return
        }
        close()
        when (h) {
            is PaletteHit.Session -> app.open(h.id)
            is PaletteHit.Citation -> app.open(h.session)
            is PaletteHit.Command -> cmds[h.index].run()
            is PaletteHit.More -> {}
        }
    }

    val list = rememberLazyListState()
    // Keyboard moves keep the picked row in view; a new query starts from the top.
    LaunchedEffect(sel, raw) {
        val info = list.layoutInfo
        if (info.visibleItemsInfo.isEmpty()) return@LaunchedEffect
        val row = info.visibleItemsInfo.firstOrNull { it.index == sel }
        when {
            row == null && sel < list.firstVisibleItemIndex -> list.scrollToItem(sel)
            row == null -> list.scrollToItem((sel - info.visibleItemsInfo.size + 1).coerceAtLeast(0))
            row.offset < info.viewportStartOffset -> list.scrollBy((row.offset - info.viewportStartOffset).toFloat())
            row.offset + row.size > info.viewportEndOffset -> list.scrollBy((row.offset + row.size - info.viewportEndOffset).toFloat())
        }
    }

    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Dialog(close, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        CompositionLocalProvider(LocalDensity provides density) {
            ProvideKit(kit) {
                val c = k.c
                BoxWithConstraints(
                    Modifier.fillMaxSize().clickable(remember { MutableInteractionSource() }, indication = null, onClick = close).imePadding(),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    val shape = RoundedCornerShape(k.r.lg)
                    Column(
                        Modifier.padding(top = 90.dp, bottom = 16.dp).width(620.dp.coerceAtMost(maxWidth - 32.dp)).heightIn(max = 560.dp)
                            .shadow(16.dp, shape, ambientColor = c.shadow, spotColor = c.shadow)
                            .clip(shape).background(c.bg).border(1.dp, c.border, shape)
                            .clickable(remember { MutableInteractionSource() }, indication = null) {}
                            .padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        KTextInput(
                            query,
                            {
                                query = it
                                index = 0
                                allCites = false
                            },
                            "Search sessions and transcripts, > for commands…",
                            Modifier.fillMaxWidth().focusRequester(focus).onPreviewKeyEvent { e ->
                                val down = e.type == KeyEventType.KeyDown
                                when (e.key) {
                                    Key.DirectionDown -> if (down) index = (sel + 1).coerceAtMost((hits.size - 1).coerceAtLeast(0))
                                    Key.DirectionUp -> if (down) index = (sel - 1).coerceAtLeast(0)
                                    Key.Enter, Key.NumPadEnter -> if (down) hits.getOrNull(sel)?.let(::run)
                                    Key.Escape -> if (down) close()
                                    Key.K -> if (e.isCtrlPressed || e.isMetaPressed) {
                                        if (down) close()
                                    } else {
                                        return@onPreviewKeyEvent false
                                    }
                                    else -> return@onPreviewKeyEvent false
                                }
                                true
                            },
                            minHeight = 32.dp,
                            style = k.ty.uiCompact,
                            onSubmit = { hits.getOrNull(sel)?.let(::run) },
                            leading = { KIcon(Lucide.Search, c.muted, 16.dp) },
                        )
                        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), state = list, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            itemsIndexed(hits) { i, h -> HitRow(app, h, cmds, i == sel) { run(h) } }
                        }
                        Row(Modifier.padding(start = 8.dp, end = 8.dp, top = 2.dp)) {
                            Text(
                                if (searching) "Searching transcripts…" else "↑↓ to move · Enter to run · start with > for commands only",
                                style = k.ty.textXsmall,
                                color = c.faint,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** `palette.rs::row_for`: a 14-wide lead (state dot or glyph), the label, a faint detail on the right. */
@Composable
private fun HitRow(app: AppModel, h: PaletteHit, cmds: List<Cmd>, on: Boolean, onClick: () -> Unit) {
    val c = k.c
    val glyph = @Composable { icon: ImageVector -> KIcon(icon, c.muted, 13.dp) }
    val label: String
    val detail: String
    val lead: @Composable () -> Unit
    when (h) {
        is PaletteHit.Session -> {
            val x = app.session(h.id)
            lead = { Dot(c.stateColor(x?.state?.name?.lowercase() ?: "idle"), 7.dp) }
            label = x?.let(app::title).orEmpty()
            detail = x?.let { "${projectLabel(it)} · ${agoShort(it.lastActivity, app.now)}" }.orEmpty()
        }
        is PaletteHit.Command -> {
            val cmd = cmds[h.index]
            lead = { glyph(cmd.icon) }
            label = cmd.label
            detail = cmd.keys.ifEmpty { cmd.section }
        }
        is PaletteHit.Citation -> {
            lead = { glyph(Lucide.Search) }
            label = snippetLine(h.snippet)
            detail = app.session(h.session)?.let(app::title) ?: h.session.take(8)
        }
        is PaletteHit.More -> {
            lead = { glyph(Lucide.ChevronDown) }
            label = "Show ${h.n} more"
            detail = "Citations"
        }
    }
    Pressable(onClick, Modifier.fillMaxWidth().height(34.dp), fill = if (on) c.chip else Color.Transparent, radius = k.r.md) {
        Row(
            Modifier.weight(1f).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.width(14.dp), contentAlignment = Alignment.Center) { lead() }
            Text(label, style = k.ty.ui, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(detail, style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp))
        }
    }
}
