package dev.qjoly.hooked.ui.terminal

import android.view.KeyCharacterMap
import android.view.KeyEvent
import com.termux.terminal.TerminalEmulator
import kotlin.math.abs
import kotlin.math.min

/**
 * A hardware key, or one the soft keyboard sends as an event, on the active shell: Termux's
 * `TerminalView.onKeyDown`, plus rune's ⌘ shortcuts (Ctrl+Shift also works, as on Linux terminals).
 */
internal fun TermDeck.onKey(e: KeyEvent, clipboard: () -> String?): Boolean {
    if (e.action != KeyEvent.ACTION_DOWN) return false
    val t = current ?: return false
    val code = e.keyCode
    val meta = e.isMetaPressed
    val shift = e.isShiftPressed
    if (meta || (e.isCtrlPressed && shift)) {
        when (code) {
            KeyEvent.KEYCODE_C -> return copySelection() || !meta
            KeyEvent.KEYCODE_V -> {
                clipboard()?.let(::paste)
                return true
            }
            KeyEvent.KEYCODE_F -> {
                openSearch()
                return true
            }
        }
    }
    if (meta) {
        when (code) {
            KeyEvent.KEYCODE_EQUALS, KeyEvent.KEYCODE_PLUS, KeyEvent.KEYCODE_NUMPAD_ADD -> zoom(1)
            KeyEvent.KEYCODE_MINUS, KeyEvent.KEYCODE_NUMPAD_SUBTRACT -> zoom(-1)
            KeyEvent.KEYCODE_0 -> zoom(0)
            // What a Mac terminal sends for ⌘←, ⌘→ and ⌘⌫: start of line, end of line, kill line.
            KeyEvent.KEYCODE_DPAD_LEFT -> type("\u0001")
            KeyEvent.KEYCODE_DPAD_RIGHT -> type("\u0005")
            KeyEvent.KEYCODE_DEL -> type("\u0015")
            else -> return false
        }
        return true
    }
    if (t.exited) return false

    val ctrlDown = e.isCtrlPressed || ctrl
    val leftAlt = e.metaState and KeyEvent.META_ALT_LEFT_ON != 0 || alt
    val rightAlt = e.metaState and KeyEvent.META_ALT_RIGHT_ON != 0
    val mod = keyMod(ctrlDown, e.isAltPressed || alt, shift, e.isNumLockOn)
    if (!e.isFunctionPressed) {
        t.keyCode(code, mod)?.let {
            ctrl = false
            alt = false
            type(it)
            return true
        }
    }

    // Ctrl is applied below; right Alt (AltGr) stays to compose characters.
    var clear = KeyEvent.META_CTRL_MASK
    if (!rightAlt) clear = clear or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
    var meta2 = e.metaState and clear.inv()
    if (shift) meta2 = meta2 or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
    var cp = e.getUnicodeChar(meta2)
    if (cp == 0) return false
    if (cp and KeyCharacterMap.COMBINING_ACCENT != 0) {
        if (accent != 0) typePoint(accent, ctrlDown, leftAlt)
        accent = cp and KeyCharacterMap.COMBINING_ACCENT_MASK
        return true
    }
    if (accent != 0) {
        val combined = KeyCharacterMap.getDeadChar(accent, cp)
        if (combined > 0) cp = combined
        accent = 0
    }
    typePoint(asciiFold(cp), ctrlDown, leftAlt)
    return true
}

private fun TermDeck.typePoint(cp: Int, ctrlDown: Boolean, altDown: Boolean) {
    val c = if (ctrlDown) ctrlOf(cp) else cp
    ctrl = false
    alt = false
    type((if (altDown) "\u001b" else "") + String(Character.toChars(c)))
}

/**
 * `n` rows of scrolling, positive toward older output: wheel reports for a program that tracks the
 * mouse, arrow keys on the alternate screen (Ghostty's alternate scroll), the scrollback otherwise.
 */
internal fun TermDeck.scrollLines(t: Term, n: Int, at: CellPos?): Boolean {
    if (n == 0) return false
    val times = min(abs(n), 10)
    if (t.tracking) {
        val c = at ?: CellPos(0, 0)
        repeat(times) { t.mouse(if (n > 0) TerminalEmulator.MOUSE_WHEELUP_BUTTON else TerminalEmulator.MOUSE_WHEELDOWN_BUTTON, c.col, c.row, true) }
        return true
    }
    if (t.alt) {
        if (t.exited) return false
        val key = t.keyCode(if (n > 0) KeyEvent.KEYCODE_DPAD_UP else KeyEvent.KEYCODE_DPAD_DOWN, 0) ?: return false
        send(t, key.repeat(times))
        return true
    }
    return t.scrollBy(-n)
}
