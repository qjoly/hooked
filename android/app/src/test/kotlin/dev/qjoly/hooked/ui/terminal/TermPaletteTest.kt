package dev.qjoly.hooked.ui.terminal

import com.termux.terminal.TextStyle
import org.junit.Assert.assertEquals
import org.junit.Test

class TermPaletteTest {
    @Test
    fun darkIsGhosttyOnRunesGround() {
        val p = TermPalette.colors(dark = true)
        assertEquals(TextStyle.NUM_INDEXED_COLORS, p.size)
        assertEquals(0xFFE9E9F0.toInt(), p[TextStyle.COLOR_INDEX_FOREGROUND])
        assertEquals(0xFF0D0D13.toInt(), p[TextStyle.COLOR_INDEX_BACKGROUND])
        assertEquals(0xFFCC6666.toInt(), p[1])
        assertEquals(p[TextStyle.COLOR_INDEX_FOREGROUND], p[TextStyle.COLOR_INDEX_CURSOR])
    }

    @Test
    fun lightSwapsTheGroundAndTheAnsiSet() {
        val p = TermPalette.colors(dark = false)
        assertEquals(0xFF1F2328.toInt(), p[TextStyle.COLOR_INDEX_FOREGROUND])
        assertEquals(0xFFFFFFFF.toInt(), p[TextStyle.COLOR_INDEX_BACKGROUND])
        assertEquals(0xFFCF222E.toInt(), p[1])
    }

    @Test
    fun cubeAndGreysAreXterms() {
        val p = TermPalette.colors(dark = true)
        assertEquals(0xFF000000.toInt(), p[16])
        assertEquals(0xFFFF0000.toInt(), p[196])
        assertEquals(0xFF5F87AF.toInt(), p[67])
        assertEquals(0xFF080808.toInt(), p[232])
        assertEquals(0xFFEEEEEE.toInt(), p[255])
    }

    @Test
    fun resolveKeepsTrueColour() {
        val p = TermPalette.colors(dark = true)
        assertEquals(0xFF123456.toInt(), TermPalette.resolve(0xFF123456.toInt(), p))
        assertEquals(p[4], TermPalette.resolve(4, p))
    }
}
