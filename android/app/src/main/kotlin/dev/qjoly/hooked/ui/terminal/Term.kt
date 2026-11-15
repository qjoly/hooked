package dev.qjoly.hooked.ui.terminal

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.Job

/** What a terminal hands back to whoever owns it. */
interface TermSink {
    /** Bytes for the shell: keys, pastes, mouse reports and the emulator's answers to queries. */
    fun input(t: Term, data: String)

    /** A program put text on the clipboard (OSC 52). */
    fun copy(text: String)

    /** The screen scrolled `rows` up under new output. */
    fun scrolled(t: Term, rows: Int)
}

/** A hit of the scrollback search: `row` as in [CellPos], columns `[a, b)`. */
data class Hit(val row: Int, val a: Int, val b: Int)

/**
 * One shell's screen, as rune's `Term` holds a Ghostty `Vt`: Termux's emulator parses the PTY bytes,
 * and the view reads its rows. `fresh` marks a shell this client just opened, whose first frame is
 * live output rather than a replay.
 */
class Term(val id: String, cols: Int, rows: Int, private val sink: TermSink, val fresh: Boolean = false) {
    /** Bumped on every screen change; the painter reads it so a frame follows each change. */
    var version by mutableIntStateOf(0)
        private set
    var exited by mutableStateOf(false)
    var title by mutableStateOf("")
        private set

    /** The viewport's top row: 0 at the bottom, negative into the scrollback. */
    var top by mutableIntStateOf(0)
        private set
    var bellAt by mutableLongStateOf(0L)
        private set

    /** Output arrived since the emulator was made; a reconnect must then start from a blank one. */
    var fed = false
        private set
    private var replaying = false

    // The owner's plumbing: the stream job and the ordered input queue.
    internal var stream: Job? = null
    internal val queue = ArrayDeque<String>()
    internal var sending = false

    private val output = object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            // Answers to queries replayed from the buffer were already given, by whoever watched then.
            if (replaying || exited) return
            sink.input(this@Term, String(data, offset, count, Charsets.UTF_8))
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) {
            title = newTitle.orEmpty()
        }

        override fun onCopyTextToClipboard(text: String?) {
            if (!replaying && !text.isNullOrEmpty()) sink.copy(text)
        }

        override fun onPasteTextFromClipboard() {}

        override fun onBell() {
            if (!replaying) bellAt = System.currentTimeMillis()
        }

        override fun onColorsChanged() {
            version++
        }
    }

    var emulator: TerminalEmulator = make(cols, rows)
        private set

    private fun make(cols: Int, rows: Int) = TerminalEmulator(output, cols, rows, SCROLLBACK, Quiet)

    val cols get() = emulator.mColumns
    val rows get() = emulator.mRows
    val transcript get() = emulator.screen.activeTranscriptRows
    val alt get() = emulator.isAlternateBufferActive

    /** A program is listening to the mouse. */
    val tracking get() = !exited && emulator.isMouseTrackingActive

    fun feed(bytes: ByteArray) {
        emulator.append(bytes, bytes.size)
        fed = true
        val n = emulator.scrollCounter
        if (n != 0) {
            emulator.clearScrollCounter()
            // Scrolled back, the view stays on the same text, as rune's does.
            if (top < 0) top = (top - n).coerceAtLeast(-transcript)
            if (!alt) sink.scrolled(this, n)
        }
        version++
    }

    /** The server's screen buffer, replayed on connecting: drawn, but never answered. */
    fun replay(bytes: ByteArray) {
        replaying = true
        try {
            feed(bytes)
        } finally {
            replaying = false
        }
    }

    /** A blank emulator of the same size, before a reconnect replays the buffer again. */
    fun reset() {
        emulator = make(cols, rows)
        top = 0
        title = ""
        fed = false
        version++
    }

    fun resize(cols: Int, rows: Int) {
        if (cols == this.cols && rows == this.rows) return
        emulator.resize(cols, rows)
        top = 0
        version++
    }

    fun applyPalette(colors: IntArray) {
        colors.copyInto(emulator.mColors.mCurrentColors)
        version++
    }

    /** Moves the viewport `n` rows, negative toward older output; false when it could not move. */
    fun scrollBy(n: Int): Boolean {
        val next = (top + n).coerceIn(-transcript, 0)
        if (next == top) return false
        top = next
        return true
    }

    fun scrollToBottom() {
        top = 0
    }

    /** Shows `row` in the viewport, centred when it was out of view. */
    fun reveal(row: Int) {
        if (row >= top && row < top + rows) return
        top = (row - rows / 2).coerceIn(-transcript, 0)
    }

    fun rowText(row: Int, cells: Cells = Cells()): RowText {
        val s = emulator.screen
        val line = s.allocateFullLineIfNecessary(s.externalToInternalRow(row))
        cells.scan(line.mText, line.spaceUsed, cols)
        return RowText.of(line.mText, cells)
    }

    /** Matches of `needle` across the scrollback, newest first. */
    fun search(needle: String): List<Hit> {
        if (needle.isEmpty()) return emptyList()
        val cells = Cells()
        val out = mutableListOf<Hit>()
        for (row in rows - 1 downTo -transcript) {
            matches(rowText(row, cells), needle).asReversed().forEach { (a, b) -> out += Hit(row, a, b) }
        }
        return out
    }

    fun linkAt(col: Int, row: Int): String? = links(rowText(row)).firstOrNull { col >= it.a && col < it.b }?.url

    fun wordAt(col: Int, row: Int): Pair<Int, Int>? = wordAt(rowText(row), col, cols)

    fun selectedText(sel: Sel): String? {
        val (s, e) = sel.ordered()
        val lo = -transcript
        val hi = rows - 1
        if (e.row < lo || s.row > hi) return null
        val a = if (s.row < lo) CellPos(0, lo) else s
        val b = if (e.row > hi) CellPos(cols - 1, hi) else e
        return emulator.getSelectedText(a.col, a.row, b.col.coerceAtMost(cols - 1), b.row).takeIf { it.isNotEmpty() }
    }

    /** The sequence for a special key in the terminal's current modes, else null. */
    fun keyCode(keyCode: Int, mod: Int): String? =
        KeyHandler.getCode(keyCode, mod, emulator.isCursorKeysApplicationMode, emulator.isKeypadApplicationMode)

    /** Pastes through the emulator, which strips escapes and brackets the text when the program asked. */
    fun paste(text: String) {
        if (!exited && text.isNotEmpty()) emulator.paste(text)
    }

    /** A button report at a viewport cell, for a program that tracks the mouse. */
    fun mouse(button: Int, col: Int, row: Int, pressed: Boolean) {
        if (tracking) emulator.sendMouseEvent(button, col + 1, row + 1, pressed)
    }

    companion object {
        const val SCROLLBACK = 10_000
    }
}

/** Termux wants a session client for logging and cursor style; none of it applies here. */
private object Quiet : TerminalSessionClient {
    override fun onTextChanged(changedSession: TerminalSession) {}
    override fun onTitleChanged(changedSession: TerminalSession) {}
    override fun onSessionFinished(finishedSession: TerminalSession) {}
    override fun onCopyTextToClipboard(session: TerminalSession, text: String?) {}
    override fun onPasteTextFromClipboard(session: TerminalSession?) {}
    override fun onBell(session: TerminalSession) {}
    override fun onColorsChanged(session: TerminalSession) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun getTerminalCursorStyle(): Int? = null
    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}
}
