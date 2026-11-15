package dev.qjoly.hooked.ui.terminal

import android.view.KeyEvent
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TermTest {
    private class Recorder : TermSink {
        val sent = StringBuilder()
        val copied = mutableListOf<String>()
        var scrolled = 0

        override fun input(t: Term, data: String) {
            sent.append(data)
        }

        override fun copy(text: String) {
            copied += text
        }

        override fun scrolled(t: Term, rows: Int) {
            scrolled += rows
        }
    }

    private fun term(cols: Int = 20, rows: Int = 3, fresh: Boolean = true): Pair<Term, Recorder> {
        val r = Recorder()
        return Term("term_abc", cols, rows, r, fresh) to r
    }

    private fun Term.write(s: String) = feed(s.toByteArray())

    private fun Term.line(row: Int) = rowText(row).text.trimEnd()

    @Test
    fun outputBecomesStyledRows() {
        val (t, _) = term()
        t.write("hi \u001b[1;31mred\u001b[0m\r\nnext")
        assertEquals("hi red", t.line(0))
        assertEquals("next", t.line(1))
        val style = t.emulator.screen.getStyleAt(0, 3)
        assertEquals(1, TextStyle.decodeForeColor(style))
        assertTrue(TextStyle.decodeEffect(style) and TextStyle.CHARACTER_ATTRIBUTE_BOLD != 0)
        assertEquals(1 to 4, t.emulator.cursorRow to t.emulator.cursorCol)
    }

    @Test
    fun queriesAreAnsweredButNotWhenReplayed() {
        val (t, r) = term()
        t.write("\u001b[6n")
        assertEquals("\u001b[1;1R", r.sent.toString())
        r.sent.clear()
        t.replay("\u001b[6n".toByteArray())
        assertEquals("", r.sent.toString())
    }

    @Test
    fun theViewStaysOnScrolledBackText() {
        val (t, r) = term()
        repeat(10) { t.write("line $it\r\n") }
        assertEquals(8, t.transcript)
        assertTrue(t.scrollBy(-2))
        assertEquals("line 6", t.line(t.top))
        t.write("more\r\n")
        assertEquals(-3, t.top)
        assertEquals("line 6", t.line(t.top))
        assertTrue(r.scrolled > 0)
        t.scrollToBottom()
        assertFalse(t.scrollBy(5))
    }

    @Test
    fun searchRunsNewestFirstAcrossTheScrollback() {
        val (t, _) = term()
        t.write("needle one\r\n")
        repeat(5) { t.write("x $it\r\n") }
        t.write("Needle two")
        val hits = t.search("NEEDLE")
        assertEquals(2, hits.size)
        assertEquals(2, hits[0].row)
        assertTrue(hits[1].row < 0)
        t.reveal(hits[1].row)
        assertTrue(hits[1].row >= t.top && hits[1].row < t.top + t.rows)
    }

    @Test
    fun selectionReadsAcrossTheScrollback() {
        val (t, _) = term(10, 3)
        t.write("one\r\ntwo\r\nthree\r\nfour\r\nfive")
        assertEquals("one\ntwo", t.selectedText(Sel(CellPos(0, -2), CellPos(2, -1))))
        assertEquals("wo\nthree", t.selectedText(Sel(CellPos(1, -1), CellPos(4, 0))))
        assertNull(t.selectedText(Sel(CellPos(0, -50), CellPos(3, -40))))
    }

    @Test
    fun linksAndWordsUnderACell() {
        val (t, _) = term(40, 3)
        t.write("open https://example.com/x now")
        assertEquals("https://example.com/x", t.linkAt(10, 0))
        assertNull(t.linkAt(2, 0))
        assertEquals(0 to 3, t.wordAt(1, 0))
    }

    @Test
    fun keysFollowTheTerminalModes() {
        val (t, _) = term()
        assertEquals("\u001b[A", t.keyCode(KeyEvent.KEYCODE_DPAD_UP, 0))
        t.write("\u001b[?1h")
        assertEquals("\u001bOA", t.keyCode(KeyEvent.KEYCODE_DPAD_UP, 0))
        assertEquals("\r", t.keyCode(KeyEvent.KEYCODE_ENTER, 0))
        assertNull(t.keyCode(KeyEvent.KEYCODE_A, 0))
    }

    @Test
    fun pasteIsBracketedWhenAsked() {
        val (t, r) = term()
        t.paste("ls\n")
        assertEquals("ls\r", r.sent.toString())
        r.sent.clear()
        t.write("\u001b[?2004h")
        t.paste("ls")
        assertEquals("\u001b[200~ls\u001b[201~", r.sent.toString())
    }

    @Test
    fun clicksReachProgramsThatTrackTheMouse() {
        val (t, r) = term()
        assertFalse(t.tracking)
        t.mouse(TerminalEmulator.MOUSE_LEFT_BUTTON, 0, 0, true)
        assertEquals("", r.sent.toString())
        t.write("\u001b[?1000h\u001b[?1006h")
        t.mouse(TerminalEmulator.MOUSE_LEFT_BUTTON, 0, 0, true)
        assertEquals("\u001b[<0;1;1M", r.sent.toString())
    }

    @Test
    fun titleResetAndExit() {
        val (t, r) = term()
        t.write("\u001b]0;build\u0007abc")
        assertEquals("build", t.title)
        assertTrue(t.fed)
        t.reset()
        assertEquals("", t.title)
        assertEquals("", t.line(0))
        assertFalse(t.fed)
        t.exited = true
        t.paste("x")
        assertEquals("", r.sent.toString())
    }

    @Test
    fun resizeKeepsTheText() {
        val (t, _) = term()
        t.write("hello")
        t.resize(40, 10)
        assertEquals(40 to 10, t.cols to t.rows)
        assertEquals("hello", t.line(0))
    }
}
