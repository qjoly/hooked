package dev.qjoly.hooked.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.session.edge
import kotlinx.coroutines.flow.first

/**
 * What the panel asks of the drawer around it. `inherited`: the panel was already open when this
 * session came up, so finding no shell closes it rather than starting one.
 */
class TermHost(val inherited: Boolean = false, val close: () -> Unit)

val LocalTermHost = staticCompositionLocalOf { TermHost {} }

private class Seen(var closed: Boolean)

/** `/Users/<me>/x` as `~/x`, as rune's `pty_block` shortens a cwd. */
fun shortCwd(path: String): String {
    for (root in listOf("/Users/", "/home/")) {
        if (path.startsWith(root)) {
            val rest = path.substring(root.length)
            val i = rest.indexOf('/')
            return if (i < 0) "~" else "~" + rest.substring(i)
        }
    }
    return path
}

/** A tab's name: the shell's title, else the id's tail, as rune labels it. */
fun tabLabel(title: String, id: String, exited: Boolean): String {
    val short = title.trim().lineSequence().firstOrNull().orEmpty().let { if (it.length > 40) it.take(39) + "…" else it }.ifEmpty { id.takeLast(4) }
    return if (exited) "$short · exited" else short
}

/**
 * rune's terminal drawer (view/terminal.rs `panel`): a bar while closed, then the panel below the
 * lens with a grip to resize it. `open` is the session view's flag; the deck outlives both states.
 */
@Composable
fun TerminalDock(app: AppModel, sessionId: String, project: String?, open: Boolean, onOpen: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val client = app.client ?: return
    val deck = rememberTermDeck(app, client, sessionId)
    val c = k.c
    val seen = remember(deck) { Seen(!open) }
    if (!open) {
        seen.closed = true
        Row(
            modifier.fillMaxWidth().height(28.dp).edge(c.border, top = true).clickable {
                // rune's `toggle_terms`: with no shell yet, the drawer stays shut until one started.
                if (deck.loaded && deck.terms.isEmpty()) deck.newTerm(project, onOpened = { onOpen(true) }) else onOpen(true)
            }.padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            KIcon(Lucide.Terminal, c.muted, 13.dp)
            Text("Terminal", style = k.ty.textSmallMedium, color = c.muted)
            Text(if (deck.terms.isEmpty()) "open a shell in this project" else "${deck.terms.size} open", style = k.ty.textXsmall, color = c.faint, maxLines = 1)
            Spacer(Modifier.weight(1f))
            Text(if (deck.busy) "opening…" else "open · key 2 ↑", style = k.ty.textXsmall, color = c.faint)
        }
        return
    }
    val density = LocalDensity.current
    val window = with(density) { LocalWindowInfo.current.containerSize.height.toDp() }
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val avail = if (maxHeight == Dp.Infinity) window else maxHeight
        val maxH = avail * 0.8f
        val minH = min(120.dp, maxH)
        val h = (deck.height?.dp ?: (avail * 0.4f)).coerceIn(minH, maxH)
        val drag = rememberDraggableState { dy ->
            val now = (deck.height?.dp ?: h)
            deck.dragHeight((now - with(density) { dy.toDp() }).coerceIn(minH, maxH).value)
        }
        Column(Modifier.fillMaxWidth().height(h)) {
            // rune's 6 pt grip, with a visible handle for touch.
            Box(
                Modifier.fillMaxWidth().height(10.dp).draggable(drag, Orientation.Vertical, onDragStarted = { deck.dragHeight(h.value) }, onDragStopped = {
                    deck.height?.let(deck::saveHeight)
                }),
                contentAlignment = Alignment.Center,
            ) { Box(Modifier.size(32.dp, 3.dp).clip(RoundedCornerShape(1.5.dp)).background(c.border2)) }
            CompositionLocalProvider(LocalTermHost provides TermHost(inherited = !seen.closed) { onOpen(false) }) {
                TerminalPanel(app, sessionId, project, Modifier.weight(1f))
            }
        }
    }
}

/** rune's Terminal lens: the session's shells over hooked's PTYs. `project` is the shell's working directory. */
@Composable
fun TerminalPanel(app: AppModel, sessionId: String, project: String?, modifier: Modifier = Modifier) {
    val client = app.client ?: return
    val deck = rememberTermDeck(app, client, sessionId)
    val host = LocalTermHost.current
    val ctx = LocalContext.current
    val density = LocalDensity.current
    val focus = remember { FocusRequester() }
    val ime = remember { TermIme() }
    ime.deck = deck

    LaunchedEffect(deck) {
        snapshotFlow { deck.loaded }.first { it }
        if (deck.terms.isEmpty() && !deck.busy) {
            // rune's `load_terms` closes the panel on a session without shells; opening it on purpose starts one.
            if (host.inherited) host.close() else deck.newTerm(project, onFailed = host.close)
        }
    }
    // rune claims the keyboard for the shell when the panel opens or a tab is picked.
    LaunchedEffect(deck.current?.id) {
        if (deck.current != null) runCatching { focus.requestFocus() }
    }

    val keyboardShown = WindowInsets.ime.getBottom(density) > 0
    Column(modifier.fillMaxWidth()) {
        TermBar(deck, project, host) { runCatching { focus.requestFocus() } }
        Box(Modifier.weight(1f).fillMaxWidth().background(Color(if (k.dark) TermPalette.BG_DARK else TermPalette.BG_LIGHT))) {
            deck.current?.let { t ->
                androidx.compose.runtime.key(t.id) { TermScreen(deck, t, ime, focus, Modifier.fillMaxSize()) }
            }
        }
        // The extra keys ride with the soft keyboard, so the grid changes once when it shows.
        if (deck.focused && keyboardShown && deck.current != null) {
            ExtraKeys(
                deck, keyboardShown,
                onPaste = { clipboardText(ctx)?.let(deck::paste) },
                onKeyboard = { if (keyboardShown) ime.hide() else ime.show() },
            )
        }
    }
}

/** rune's `term-bar`: the shells as tabs, a new one, the scrollback search and the hide chevron. */
@Composable
private fun TermBar(deck: TermDeck, project: String?, host: TermHost, refocus: () -> Unit) {
    val c = k.c
    Row(
        Modifier.fillMaxWidth().height(32.dp).edge(c.border, top = true, bottom = true).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier.weight(1f, fill = false).horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            deck.terms.forEachIndexed { i, t ->
                val on = i == deck.active
                Row(
                    Modifier.height(24.dp).clip(RoundedCornerShape(k.r.sm)).background(if (on) c.chip else Color.Transparent).padding(start = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(
                        Modifier.clickable {
                            deck.pick(i)
                            refocus()
                        },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        KIcon(Lucide.Terminal, c.muted, 12.dp)
                        Text(tabLabel(t.title, t.id, t.exited), style = k.ty.textSmall, color = if (on) c.fg else c.muted, maxLines = 1)
                    }
                    if (t.exited) KIconButton(Lucide.Restart, "Restart this shell", { deck.restart(i, project) { if (deck.terms.isEmpty()) host.close() } }, size = Size.SMALL)
                    KIconButton(Lucide.Close, "Close this terminal", { if (!deck.close(i)) host.close() }, size = Size.SMALL)
                }
            }
        }
        KIconButton(Lucide.Plus, "New shell in this project", { deck.newTerm(project) }, size = Size.SMALL, enabled = !deck.busy)
        project?.let {
            Text(shortCwd(it), style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.StartEllipsis, modifier = Modifier.widthIn(max = 220.dp))
        }
        Spacer(Modifier.weight(1f))
        val s = deck.search
        if (s != null) {
            val field = remember { FocusRequester() }
            LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
            KTextInput(
                value = s.query,
                onValueChange = deck::searchChanged,
                placeholder = "Search the scrollback…",
                modifier = Modifier.width(220.dp).focusRequester(field).onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    when (e.key) {
                        Key.Enter, Key.NumPadEnter -> deck.searchStep(older = !e.isShiftPressed)
                        Key.Escape -> {
                            deck.closeSearch()
                            refocus()
                        }
                        else -> return@onPreviewKeyEvent false
                    }
                    true
                },
                onSubmit = { deck.searchStep(older = true) },
            )
            Text(s.label, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
            KIconButton(Lucide.Close, "Close the search", {
                deck.closeSearch()
                refocus()
            }, size = Size.SMALL)
        } else {
            Text("long-press selects · pinch zooms", style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            KIconButton(Lucide.Search, "Search the scrollback", deck::openSearch, size = Size.SMALL)
        }
        KIconButton(Lucide.ChevronDown, "Hide the terminal panel", host.close, size = Size.SMALL)
    }
}
