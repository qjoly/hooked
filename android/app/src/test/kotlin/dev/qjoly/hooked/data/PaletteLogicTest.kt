package dev.qjoly.hooked.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaletteLogicTest {
    private val cmds = listOf(
        "Go to Deck" to "Navigation",
        "New session" to "Navigation",
        "Theme: Dark" to "Appearance",
        "Toggle the sidebar" to "Actions",
    )
    private val sessions = listOf(
        PaletteSession("a", "Fix the deck hooked fix it"),
        PaletteSession("b", "Bump charts infra"),
    )

    @Test fun `an empty query offers New session and every session`() {
        val h = paletteHits("", cmds, sessions, null, false, null)
        assertEquals(listOf(PaletteHit.Command(1), PaletteHit.Session("a"), PaletteHit.Session("b")), h)
    }

    @Test fun `a query matches command labels and every word of a session`() {
        assertEquals(listOf(PaletteHit.Command(0), PaletteHit.Session("a")), paletteHits("deck", cmds, sessions, null, false, null))
        assertEquals(listOf(PaletteHit.Session("b")), paletteHits("CHARTS bump", cmds, sessions, null, false, null))
        // The section only counts in command mode.
        assertTrue(paletteHits("appearance", cmds, sessions, null, false, null).isEmpty())
    }

    @Test fun `a leading chevron lists commands only, matched on label and section`() {
        assertEquals(cmds.indices.map { PaletteHit.Command(it) }, paletteHits(">", cmds, sessions, null, false, null))
        assertEquals(listOf(PaletteHit.Command(2)), paletteHits("> appearance dark", cmds, sessions, null, false, null))
    }

    @Test fun `sessions stop at forty`() {
        val many = (1..60).map { PaletteSession("s$it", "same") }
        assertEquals(PALETTE_SESSIONS, paletteHits("same", emptyList(), many, null, false, null).size)
    }

    @Test fun `five citations, then a row for the rest unless all are open`() {
        val cites = (1..8).map { Cite("s$it", "hit $it") }
        val h = paletteHits("zzz", emptyList(), emptyList(), cites, false, null)
        assertEquals(CITATIONS_SHOWN + 1, h.size)
        assertEquals(PaletteHit.More(3), h.last())
        assertEquals(8, paletteHits("zzz", emptyList(), emptyList(), cites, true, null).size)
        // No citations until the search for this query came back.
        assertTrue(paletteHits("zzz", emptyList(), emptyList(), null, false, null).isEmpty())
    }

    @Test fun `incognito drops citations of hidden sessions`() {
        val cites = listOf(Cite("a", "x"), Cite("hidden", "y"))
        val h = paletteHits("x", emptyList(), emptyList(), cites, false, setOf("a"))
        assertEquals(listOf(PaletteHit.Citation("a", "x")), h)
    }

    @Test fun `only plain non-empty queries go to the transcript search`() {
        assertTrue(paletteSearchable(" deck "))
        assertFalse(paletteSearchable("  "))
        assertFalse(paletteSearchable("> theme"))
    }

    @Test fun `snippets lose their marks and line breaks`() {
        assertEquals("…the new palette, state dots…", snippetLine("…the new <mark>palette</mark>,\n  state   dots…"))
        assertEquals("x".repeat(140) + "…", snippetLine("x".repeat(200)))
    }

    @Test fun `search results parse into citations`() {
        val j = Json.parseToJsonElement("""{"q":"p","results":[{"sessionId":"s1","snippet":"a <mark>p</mark>","score":-1}]}""")
        assertEquals(listOf(Cite("s1", "a <mark>p</mark>")), parseCites(j))
    }
}
