package dev.qjoly.hooked.ui.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.core.AnimationState
import androidx.compose.animation.core.animateDecay
import androidx.compose.animation.splineBasedDecay
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.isPrimaryPressed
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.isShiftPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.termux.terminal.TerminalEmulator
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.panel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/** rune's TERM_PAD: the padding around the cells. */
internal const val PAD_DP = 8f

internal fun copyToClipboard(ctx: Context, text: String) {
    ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Terminal", text))
}

internal fun clipboardText(ctx: Context): String? =
    ctx.getSystemService(ClipboardManager::class.java)?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString()

/** The font of the deck's size, in pixels: rune's `term_style` (size, line height `round(size × 1.5)`). */
@Composable
internal fun rememberTermFont(size: Float): TermFont {
    val ctx = LocalContext.current
    val d = LocalDensity.current
    return remember(size, d.density, d.fontScale) {
        with(d) { TermFont.of(ctx, size.sp.toPx(), Math.round(size * 1.5f).toFloat().sp.toPx()) }
    }
}

/**
 * view/terminal.rs `screen` and its handlers: the shell's cells on rune's ground, with touch
 * scrolling, long-press selection, pinch zoom, a mouse when one is plugged in, and the keyboard.
 */
@Composable
internal fun TermScreen(deck: TermDeck, t: Term, ime: TermIme, focus: FocusRequester, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val density = LocalDensity.current
    val kit = k
    val uri = LocalUriHandler.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val font = rememberTermFont(deck.font)
    val painter = remember { TermPainter() }
    val pad = with(density) { PAD_DP.dp.toPx() }

    LaunchedEffect(kit.dark) {
        TermPalette.install(kit.dark)
        val p = TermPalette.colors(kit.dark)
        deck.terms.forEach { it.applyPalette(p) }
    }
    var px by remember { mutableStateOf(IntSize.Zero) }
    LaunchedEffect(px, font) {
        if (px.width > 0 && px.height > 0) {
            val (cols, rows) = fitGrid(px.width.toFloat(), px.height.toFloat(), font.cellW, font.cellH, pad)
            deck.fit(cols, rows)
        }
    }
    var bell by remember { mutableStateOf(false) }
    LaunchedEffect(t.bellAt) {
        if (System.currentTimeMillis() - t.bellAt < 250) {
            bell = true
            delay(250)
            bell = false
        }
    }

    val selColor = kit.c.accent.copy(alpha = 0.3f).toArgb()
    val matchColor = kit.c.warning.hue.copy(alpha = 0.45f).toArgb()
    val handleColor = kit.c.accent.toArgb()
    val showKeyboard = {
        runCatching { focus.requestFocus() }
        ime.show()
    }
    // Gestures read the font through this, so a pinch that changes it keeps running.
    val fontNow by rememberUpdatedState(font)
    fun cell(p: Offset) = CellPos(
        ((p.x - pad) / fontNow.cellW).toInt().coerceIn(0, t.cols - 1),
        ((p.y - pad) / fontNow.cellH).toInt().coerceIn(0, t.rows - 1),
    )

    Box(
        modifier
            .fillMaxSize()
            .onSizeChanged { px = it }
            .termIme(ime)
            .onFocusChanged { deck.focused = it.isFocused }
            .focusRequester(focus)
            .focusTarget()
            .onKeyEvent { deck.onKey(it.nativeKeyEvent) { clipboardText(ctx) } }
            .pointerInput(t) {
                touchAndMouse(
                    deck, t, { fontNow }, pad, ::cell,
                    onTap = { p ->
                        if (deck.sel != null || deck.menuAt != null) deck.clearSel()
                        else if (t.tracking) {
                            val c = cell(p)
                            t.mouse(TerminalEmulator.MOUSE_LEFT_BUTTON, c.col, c.row, true)
                            t.mouse(TerminalEmulator.MOUSE_LEFT_BUTTON, c.col, c.row, false)
                        }
                        showKeyboard()
                    },
                    onLongPress = { haptics.performHapticFeedback(HapticFeedbackType.LongPress) },
                    onFling = { v ->
                        deck.fling?.cancel()
                        deck.fling = scope.launch {
                            var last = 0f
                            var acc = 0f
                            AnimationState(0f, v).animateDecay(splineBasedDecay(density)) {
                                acc += value - last
                                last = value
                                val n = (acc / fontNow.cellH).toInt()
                                if (n != 0) {
                                    acc -= n * fontNow.cellH
                                    if (!t.scrollBy(-n)) cancelAnimation()
                                }
                            }
                        }
                    },
                    focus = { runCatching { focus.requestFocus() } },
                    openUrl = { runCatching { uri.openUri(it) } },
                )
            }
            .pointerInput(t) {
                awaitPointerEventScope {
                    while (true) {
                        val e = awaitPointerEvent()
                        if (e.type != PointerEventType.Scroll) continue
                        val c = e.changes.firstOrNull() ?: continue
                        // A wheel notch is three rows; a positive delta scrolls toward newer output.
                        val n = -(c.scrollDelta.y * 3).roundToInt()
                        if (n != 0) deck.scrollLines(t, n, cell(c.position))
                        e.changes.forEach { it.consume() }
                    }
                }
            }
            .drawBehind {
                // Reading the state here ties every change to a frame, not a recomposition.
                t.version
                val state = PaintState(
                    pad, density.density, deck.sel, deck.search?.query.orEmpty(), deck.preedit,
                    selColor, matchColor, handleColor,
                )
                drawIntoCanvas { painter.paint(it.nativeCanvas, t, font, state, size.width, size.height) }
            }
            .border(1.dp, if (bell) kit.c.warning.border else Color.Transparent),
    ) {
        if (t.top < 0) Below(-t.top) { t.scrollToBottom() }
        deck.menuAt?.let { at -> SelMenu(deck, t, at, font, pad, ctx, uri::openUri) }
    }
}

/** rune's "↓ N lines below" chip over the bottom right; a tap goes back down. */
@Composable
private fun BoxScope.Below(n: Int, onClick: () -> Unit) {
    val c = k.c
    Row(
        Modifier.align(Alignment.BottomEnd).padding(end = 14.dp, bottom = 8.dp).height(22.dp)
            .clip(RoundedCornerShape(11.dp)).background(c.bg.copy(alpha = 0.9f)).clickable(onClick = onClick).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { Text("↓ $n lines below", style = k.ty.textXsmall, color = c.muted, maxLines = 1) }
}

/** Copy, paste and open-link actions over a selection, kept inside the screen. */
@Composable
private fun BoxScope.SelMenu(deck: TermDeck, t: Term, at: CellPos, font: TermFont, pad: Float, ctx: Context, open: (String) -> Unit) {
    val c = k.c
    val gap = with(LocalDensity.current) { 8.dp.toPx() }
    val x = pad + at.col * font.cellW
    val rowTop = pad + (at.row - t.top) * font.cellH
    Layout(
        content = {
            Row(
                Modifier.shadow(6.dp, RoundedCornerShape(k.r.md)).panel(c.surface, c.border, k.r.md, 0.5.dp).padding(2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (deck.sel != null) KButton("Copy", { deck.copySelection() }, variant = Variant.GHOST, icon = Lucide.Copy)
                KButton("Paste", {
                    clipboardText(ctx)?.let(deck::paste)
                    deck.clearSel()
                }, variant = Variant.GHOST, icon = PasteGlyph)
                deck.selLink?.let { url ->
                    KButton("Open link", {
                        runCatching { open(url) }
                        deck.clearSel()
                    }, variant = Variant.GHOST, icon = Lucide.Link)
                }
            }
        },
        modifier = Modifier.matchParentSize(),
    ) { ms, cs ->
        val p = ms.first().measure(Constraints())
        val above = rowTop - gap - p.height
        val y = if (above >= 0) above else rowTop + font.cellH * 2 + gap
        layout(cs.maxWidth, cs.maxHeight) {
            p.place(
                x.roundToInt().coerceIn(0, (cs.maxWidth - p.width).coerceAtLeast(0)),
                y.roundToInt().coerceIn(0, (cs.maxHeight - p.height).coerceAtLeast(0)),
            )
        }
    }
}

private enum class Press { TAP, TAKEN, DRAG, PINCH, LONG }

/**
 * Touch: a tap focuses (and clicks for a program that tracks the mouse), a drag scrolls and flings,
 * two fingers zoom, a long press selects the word and drags the selection, handles move its ends.
 * A mouse selects by dragging as on the desktop, with double and triple clicks, and right-clicks
 * into the program or the menu.
 */
private suspend fun PointerInputScope.touchAndMouse(
    deck: TermDeck,
    t: Term,
    fontOf: () -> TermFont,
    pad: Float,
    cell: (Offset) -> CellPos,
    onTap: (Offset) -> Unit,
    onLongPress: () -> Unit,
    onFling: (Float) -> Unit,
    focus: () -> Unit,
    openUrl: (String) -> Unit,
) {
    val handleHit = 28.dp.toPx()
    var lastClick = 0L
    var clicks = 0
    // Rows past the top or bottom edge while selecting scroll the scrollback, as rune's drag does.
    fun edgeScroll(y: Float) {
        if (y < pad) t.scrollBy(-1) else if (y > pad + t.rows * fontOf().cellH) t.scrollBy(1)
    }
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        deck.fling?.cancel()
        // A button over the screen took it.
        if (down.isConsumed) return@awaitEachGesture
        val font = fontOf()

        if (down.type == PointerType.Mouse) {
            val ev = currentEvent
            val mods = ev.keyboardModifiers
            val p = cell(down.position)
            val row = t.top + p.row
            if (ev.buttons.isSecondaryPressed) {
                if (t.tracking) {
                    t.mouse(2, p.col, p.row, true)
                    t.mouse(2, p.col, p.row, false)
                } else deck.menuAt = deck.sel?.ordered()?.first ?: CellPos(p.col, row)
                return@awaitEachGesture
            }
            if (!ev.buttons.isPrimaryPressed) return@awaitEachGesture
            focus()
            if (mods.isCtrlPressed || mods.isMetaPressed) {
                t.linkAt(p.col, row)?.let {
                    openUrl(it)
                    return@awaitEachGesture
                }
            }
            if (t.tracking && !mods.isShiftPressed) {
                deck.clearSel()
                t.mouse(TerminalEmulator.MOUSE_LEFT_BUTTON, p.col, p.row, true)
                var last = p
                while (true) {
                    val e = awaitPointerEvent()
                    val c = e.changes.firstOrNull { it.id == down.id } ?: break
                    val q = cell(c.position)
                    if (!c.pressed) {
                        t.mouse(TerminalEmulator.MOUSE_LEFT_BUTTON, q.col, q.row, false)
                        break
                    }
                    if (q != last) {
                        last = q
                        t.mouse(TerminalEmulator.MOUSE_LEFT_BUTTON_MOVED, q.col, q.row, true)
                    }
                    c.consume()
                }
                return@awaitEachGesture
            }
            clicks = if (down.uptimeMillis - lastClick < viewConfiguration.doubleTapTimeoutMillis) clicks + 1 else 1
            lastClick = down.uptimeMillis
            deck.menuAt = null
            deck.selLink = null
            deck.sel = when {
                clicks >= 3 -> Sel(CellPos(0, row), CellPos(t.cols - 1, row))
                clicks == 2 -> t.wordAt(p.col, row)?.let { (a, b) -> Sel(CellPos(a, row), CellPos(b, row)) }
                else -> Sel(CellPos(p.col, row), CellPos(p.col, row))
            }
            drag(down.id) { c ->
                if (clicks <= 1) {
                    edgeScroll(c.position.y)
                    val q = cell(c.position)
                    deck.sel = deck.sel?.copy(head = CellPos(q.col, t.top + q.row))
                }
                c.consume()
            }
            if (clicks <= 1 && deck.sel?.empty == true) deck.sel = null
            return@awaitEachGesture
        }

        // A selection handle under the finger moves that end.
        deck.sel?.takeIf { !it.empty }?.ordered()?.let { (a, b) ->
            fun near(c: CellPos, right: Boolean): Boolean {
                val hx = pad + (c.col + if (right) 1 else 0) * font.cellW
                val hy = pad + (c.row - t.top + 1) * font.cellH
                return (Offset(hx, hy) - down.position).getDistance() < handleHit
            }
            val start = near(a, false)
            if (start || near(b, true)) {
                deck.menuAt = null
                drag(down.id) { c ->
                    edgeScroll(c.position.y)
                    val q = cell(c.position)
                    val at = CellPos(q.col, t.top + q.row)
                    val (s0, e0) = deck.sel?.ordered() ?: (a to b)
                    deck.sel = if (start) Sel(e0, at) else Sel(s0, at)
                    c.consume()
                }
                deck.menuAt = deck.sel?.ordered()?.first
                return@awaitEachGesture
            }
        }

        val press = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
            var kind: Press? = null
            while (kind == null) {
                val ev = awaitPointerEvent()
                val c = ev.changes.firstOrNull { it.id == down.id }
                kind = when {
                    ev.changes.count { it.pressed } > 1 -> Press.PINCH
                    // A button over the screen (the menu, the "lines below" chip) took this tap.
                    c == null || !c.pressed -> if (c?.isConsumed == true) Press.TAKEN else Press.TAP
                    (c.position - down.position).getDistance() > viewConfiguration.touchSlop -> Press.DRAG
                    else -> null
                }
            }
            kind
        } ?: Press.LONG

        when (press) {
            Press.TAP -> onTap(down.position)
            Press.TAKEN -> {}
            Press.DRAG -> {
                val v = VelocityTracker()
                v.addPosition(down.uptimeMillis, down.position)
                var acc = 0f
                var at = cell(down.position)
                drag(down.id) { c ->
                    acc += c.positionChange().y
                    v.addPosition(c.uptimeMillis, c.position)
                    at = cell(c.position)
                    val n = (acc / font.cellH).toInt()
                    if (n != 0) {
                        acc -= n * font.cellH
                        deck.scrollLines(t, n, at)
                    }
                    c.consume()
                }
                val vy = v.calculateVelocity().y
                if (!t.tracking && !t.alt && abs(vy) > 300f) onFling(vy)
            }
            Press.PINCH -> {
                val from = deck.font
                var start: Float? = null
                while (true) {
                    val ev = awaitPointerEvent()
                    val pressed = ev.changes.filter { it.pressed }
                    if (pressed.isEmpty()) break
                    if (pressed.size >= 2) {
                        val d = (pressed[0].position - pressed[1].position).getDistance()
                        val s = start ?: d.also { start = it }
                        if (s > 0f) deck.setFont((from * d / s).roundToInt().toFloat(), save = false)
                    }
                    ev.changes.forEach { it.consume() }
                }
                deck.setFont(deck.font, save = true)
            }
            Press.LONG -> {
                onLongPress()
                val p = cell(down.position)
                val row = t.top + p.row
                deck.selectWord(t, p.col, row)
                val word = deck.sel?.ordered()
                drag(down.id) { c ->
                    edgeScroll(c.position.y)
                    val q = cell(c.position)
                    val at = CellPos(q.col, t.top + q.row)
                    val (ws, we) = word ?: (CellPos(p.col, row) to CellPos(p.col, row))
                    val back = at.row < ws.row || (at.row == ws.row && at.col < ws.col)
                    val ahead = at.row > we.row || (at.row == we.row && at.col > we.col)
                    deck.sel = when {
                        back -> Sel(we, at)
                        ahead -> Sel(ws, at)
                        else -> word?.let { Sel(it.first, it.second) }
                    }
                    c.consume()
                }
                deck.menuAt = deck.sel?.ordered()?.first ?: CellPos(p.col, row)
            }
        }
    }
}
