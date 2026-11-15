package dev.qjoly.hooked.ui.terminal

import com.termux.terminal.KeyHandler

// What a keystroke or typed text becomes on the PTY. Special keys go through Termux's KeyHandler
// (xterm sequences, cursor/keypad application modes); typed code points are mapped here.

/** Ctrl on a typed code point, as xterm and Termux map it; unchanged when Ctrl has no meaning there. */
fun ctrlOf(cp: Int): Int = when (cp) {
    in 'a'.code..'z'.code -> cp - 'a'.code + 1
    in 'A'.code..'Z'.code -> cp - 'A'.code + 1
    ' '.code, '2'.code -> 0
    '['.code, '3'.code -> 27
    '\\'.code, '4'.code -> 28
    ']'.code, '5'.code -> 29
    '^'.code, '6'.code -> 30
    '_'.code, '7'.code, '/'.code -> 31
    '8'.code -> 127
    else -> cp
}

/** Bluetooth keyboards send spacing modifier letters where terminal programs expect ASCII. */
fun asciiFold(cp: Int): Int = when (cp) {
    0x02DC -> '~'.code
    0x02CB -> '`'.code
    0x02C6 -> '^'.code
    else -> cp
}

/**
 * Text from the soft keyboard as PTY input: newlines become Enter, and latched Ctrl / Alt apply to
 * the first code point only, as Termux's extra keys do.
 */
fun encodeTyped(text: String, ctrl: Boolean, alt: Boolean): String {
    val sb = StringBuilder()
    var first = true
    var i = 0
    while (i < text.length) {
        var cp = text.codePointAt(i)
        i += Character.charCount(cp)
        if (cp == '\n'.code) cp = '\r'.code
        if (first) {
            if (ctrl) cp = ctrlOf(cp)
            if (alt) sb.append('\u001b')
            first = false
        }
        sb.appendCodePoint(cp)
    }
    return sb.toString()
}

/** Termux's key modifier bits. */
fun keyMod(ctrl: Boolean, alt: Boolean, shift: Boolean, numLock: Boolean = false): Int {
    var m = 0
    if (ctrl) m = m or KeyHandler.KEYMOD_CTRL
    if (alt) m = m or KeyHandler.KEYMOD_ALT
    if (shift) m = m or KeyHandler.KEYMOD_SHIFT
    if (numLock) m = m or KeyHandler.KEYMOD_NUM_LOCK
    return m
}

/**
 * The next request's worth of queued input, as the web panel coalesces it: plain chunks merge, a
 * chunk holding an Escape goes alone so a TUI never reads it as the start of a longer sequence.
 */
fun nextBatch(queue: ArrayDeque<String>): String? {
    val first = queue.removeFirstOrNull() ?: return null
    if ('\u001b' in first) return first
    val sb = StringBuilder(first)
    while (queue.isNotEmpty() && '\u001b' !in queue.first()) sb.append(queue.removeFirst())
    return sb.toString()
}
