package dev.qjoly.hooked.ui.terminal

import com.termux.terminal.KeyHandler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TermInputTest {
    @Test
    fun ctrlMapsLettersAndPunctuation() {
        assertEquals(3, ctrlOf('c'.code))
        assertEquals(3, ctrlOf('C'.code))
        assertEquals(0, ctrlOf(' '.code))
        assertEquals(27, ctrlOf('['.code))
        assertEquals(31, ctrlOf('/'.code))
        assertEquals(127, ctrlOf('8'.code))
        assertEquals('é'.code, ctrlOf('é'.code))
    }

    @Test
    fun typedTextTakesLatchesOnItsFirstCodePoint() {
        assertEquals("ls\r", encodeTyped("ls\n", ctrl = false, alt = false))
        assertEquals("\u0003c", encodeTyped("cc", ctrl = true, alt = false))
        assertEquals("\u001bb", encodeTyped("b", ctrl = false, alt = true))
        assertEquals("😀", encodeTyped("😀", ctrl = false, alt = false))
    }

    @Test
    fun bluetoothSpacingLettersFoldToAscii() {
        assertEquals('~'.code, asciiFold(0x02DC))
        assertEquals('a'.code, asciiFold('a'.code))
    }

    @Test
    fun inputCoalescesAroundEscapes() {
        val q = ArrayDeque(listOf("l", "s", "\u001b[A", "x", "y", "\u001b"))
        assertEquals("ls", nextBatch(q))
        assertEquals("\u001b[A", nextBatch(q))
        assertEquals("xy", nextBatch(q))
        assertEquals("\u001b", nextBatch(q))
        assertNull(nextBatch(q))
    }

    @Test
    fun modifiersUseTermuxBits() {
        assertEquals(KeyHandler.KEYMOD_CTRL or KeyHandler.KEYMOD_SHIFT, keyMod(ctrl = true, alt = false, shift = true))
        assertEquals(0, keyMod(ctrl = false, alt = false, shift = false))
    }
}
