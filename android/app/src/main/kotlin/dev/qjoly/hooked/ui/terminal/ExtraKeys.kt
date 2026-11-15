package dev.qjoly.hooked.ui.terminal

import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.lucide
import dev.qjoly.hooked.ui.session.edge

/** Lucide `clipboard-paste`. */
internal val PasteGlyph by lazy {
    lucide(
        "clipboard-paste",
        "M11 14h10", "M16 4h2a2 2 0 0 1 2 2v1.344", "m17 18 4-4-4-4",
        "M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113",
        "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1z",
    )
}

/** Lucide `keyboard`. */
internal val KeyboardGlyph by lazy {
    lucide(
        "keyboard",
        "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z",
        "M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10",
    )
}

/** A key of the touch row: a sequence through Termux's encoder, plain text, or a latched modifier. */
private sealed interface XKey {
    val label: String

    data class Code(override val label: String, val keyCode: Int, val repeat: Boolean = false) : XKey
    data class Chars(override val label: String) : XKey
    data object Ctrl : XKey { override val label = "CTRL" }
    data object Alt : XKey { override val label = "ALT" }
}

private val KEYS = listOf(
    XKey.Code("ESC", KeyEvent.KEYCODE_ESCAPE),
    XKey.Code("TAB", KeyEvent.KEYCODE_TAB),
    XKey.Ctrl,
    XKey.Alt,
    XKey.Chars("|"),
    XKey.Chars("~"),
    XKey.Chars("/"),
    XKey.Chars("-"),
    XKey.Code("HOME", KeyEvent.KEYCODE_MOVE_HOME),
    XKey.Code("END", KeyEvent.KEYCODE_MOVE_END),
    XKey.Code("PGUP", KeyEvent.KEYCODE_PAGE_UP, repeat = true),
    XKey.Code("PGDN", KeyEvent.KEYCODE_PAGE_DOWN, repeat = true),
    XKey.Code("←", KeyEvent.KEYCODE_DPAD_LEFT, repeat = true),
    XKey.Code("↓", KeyEvent.KEYCODE_DPAD_DOWN, repeat = true),
    XKey.Code("↑", KeyEvent.KEYCODE_DPAD_UP, repeat = true),
    XKey.Code("→", KeyEvent.KEYCODE_DPAD_RIGHT, repeat = true),
)

/** Termux's extra-keys row for touch, styled as rune-kit key caps, with paste and the keyboard toggle. */
@Composable
internal fun ExtraKeys(deck: TermDeck, keyboardShown: Boolean, onPaste: () -> Unit, onKeyboard: () -> Unit, modifier: Modifier = Modifier) {
    val c = k.c
    Row(
        modifier.fillMaxWidth().height(40.dp).edge(c.border, top = true).background(c.bg).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            KEYS.forEach { key ->
                val on = when (key) {
                    XKey.Ctrl -> deck.ctrl
                    XKey.Alt -> deck.alt
                    else -> false
                }
                KeyCap(key.label, on, (key as? XKey.Code)?.repeat == true) {
                    when (key) {
                        XKey.Ctrl -> deck.ctrl = !deck.ctrl
                        XKey.Alt -> deck.alt = !deck.alt
                        is XKey.Chars -> deck.typeText(key.label)
                        is XKey.Code -> deck.typeKey(key.keyCode)
                    }
                }
            }
        }
        KIconButton(PasteGlyph, "Paste", onPaste, size = Size.LARGE)
        KIconButton(KeyboardGlyph, if (keyboardShown) "Hide the keyboard" else "Show the keyboard", onKeyboard, size = Size.LARGE, on = keyboardShown)
    }
}

/** A key cap that never takes focus from the terminal; arrows repeat while held. */
@Composable
private fun KeyCap(label: String, on: Boolean, repeat: Boolean, fire: () -> Unit) {
    val c = k.c
    val shape = RoundedCornerShape(k.r.sm)
    var pressed by remember { mutableStateOf(false) }
    val action by rememberUpdatedState(fire)
    Box(
        Modifier.height(28.dp).widthIn(min = 38.dp).clip(shape)
            .background(
                when {
                    on -> c.accent.copy(alpha = 0.18f)
                    pressed -> c.pressed.copy(alpha = 0.5f).compositeOver(c.chip)
                    else -> c.chip
                },
            )
            .border(0.5.dp, if (on) c.accent else c.border, shape)
            .pointerInput(repeat) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    pressed = true
                    try {
                        if (repeat) {
                            action()
                            if (withTimeoutOrNull(400) { waitForUpOrCancellation(); true } == null) {
                                while (withTimeoutOrNull(50) { waitForUpOrCancellation(); true } == null) action()
                            }
                        } else if (waitForUpOrCancellation() != null) action()
                    } finally {
                        pressed = false
                    }
                }
            }
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = k.ty.mono, color = if (on) c.accent else c.fg, maxLines = 1) }
}
