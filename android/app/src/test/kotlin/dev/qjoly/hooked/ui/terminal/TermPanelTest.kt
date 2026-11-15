package dev.qjoly.hooked.ui.terminal

import org.junit.Assert.assertEquals
import org.junit.Test

class TermPanelTest {
    @Test
    fun cwdShortensTheHomeFolder() {
        assertEquals("~/code/hooked", shortCwd("/Users/me/code/hooked"))
        assertEquals("~", shortCwd("/home/me"))
        assertEquals("/tmp/x", shortCwd("/tmp/x"))
    }

    @Test
    fun tabsNameTheShell() {
        assertEquals("a1b2", tabLabel("", "term_0000a1b2", false))
        assertEquals("vim · exited", tabLabel("vim\nsecond", "term_x", true))
        assertEquals(40, tabLabel("x".repeat(60), "term_x", false).length)
    }

    @Test
    fun searchLabelCountsMatches() {
        assertEquals("", TermSearch().label)
        assertEquals("no match", TermSearch("zz").label)
        assertEquals("2/3", TermSearch("a", listOf(Hit(0, 0, 1), Hit(1, 0, 1), Hit(2, 0, 1)), 1).label)
    }
}
