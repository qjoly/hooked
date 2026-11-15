package dev.qjoly.hooked.ui.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TermTextTest {
    private fun cells(s: String, columns: Int = 20) = Cells().scan(s.toCharArray(), s.length, columns)

    @Test
    fun wideGlyphsCoverTwoColumns() {
        val c = cells("a日b")
        assertEquals(3, c.count)
        assertEquals(listOf(0, 1, 3), (0 until c.count).map { c.col[it] })
        assertEquals(listOf(1, 2, 1), (0 until c.count).map { c.width[it] })
        assertEquals(1, c.at(2))
        assertEquals(-1, c.at(4))
    }

    @Test
    fun marksRideOnTheCodePointBefore() {
        val s = "éx"
        val c = cells(s)
        assertEquals(2, c.count)
        assertEquals(0 to 2, c.start[0] to c.end[0])
        assertEquals(1, c.col[1])
    }

    @Test
    fun surrogatePairsAreOneCell() {
        val s = "a😀b"
        val c = cells(s)
        assertEquals(3, c.count)
        assertEquals(0x1F600, c.point[1])
        assertEquals(3, c.col[2])
        val row = RowText.of(s.toCharArray(), c)
        assertEquals("😀", row.charAtCol(2))
        assertEquals(1 to 3, row.colRange(1, 3))
    }

    @Test
    fun linksDropTrailingPunctuation() {
        val l = links(RowText.plain("see https://example.com/a?b=1). ok"))
        assertEquals(listOf(Link(4, 29, "https://example.com/a?b=1")), l)
        assertEquals("https://x.y/a", links(RowText.plain("(see https://x.y/a)")).single().url)
        assertEquals("https://w.org/Foo_(bar)", links(RowText.plain("https://w.org/Foo_(bar)")).single().url)
        assertEquals(emptyList<Link>(), links(RowText.plain("http:// nothing")))
    }

    @Test
    fun matchesIgnoreCase() {
        assertEquals(listOf(0 to 6, 13 to 19), matches(RowText.plain("Needle and a needle"), "NEEDLE"))
        assertEquals(emptyList<Pair<Int, Int>>(), matches(RowText.plain("abc"), ""))
    }

    @Test
    fun matchesMapToColumnsPastWideGlyphs() {
        val s = "日x"
        assertEquals(listOf(2 to 3), matches(RowText.of(s.toCharArray(), cells(s)), "x"))
    }

    @Test
    fun selectionCoversRowsInReadingOrder() {
        val sel = Sel(CellPos(3, 2), CellPos(5, 0))
        assertEquals(CellPos(5, 0) to CellPos(3, 2), sel.ordered())
        assertEquals(5 to 10, sel.rowRange(0, 10))
        assertEquals(0 to 10, sel.rowRange(1, 10))
        assertEquals(0 to 4, sel.rowRange(2, 10))
        assertNull(sel.rowRange(3, 10))
        assertEquals(Sel(CellPos(3, -1), CellPos(5, -3)), sel.shifted(3))
    }

    @Test
    fun wordStopsAtSeparators() {
        val row = RowText.plain("ls 'my-file.txt' | wc")
        assertEquals(4 to 14, wordAt(row, 8, 21))
        assertNull(wordAt(row, 2, 21))
        assertNull(wordAt(row, 17, 21))
    }

    @Test
    fun gridFitsInsideThePadding() {
        assertEquals(80 to 24, fitGrid(816f, 448f, 10f, 18f, 8f))
        assertEquals(20 to 3, fitGrid(10f, 10f, 10f, 18f, 8f))
    }

    @Test
    fun scrollPositionCountsRowsBelow() {
        assertNull(scrollPos(0, 24, 0))
        val p = scrollPos(100, 24, -10)!!
        assertEquals(ScrollPos(90, 24, 124), p)
        assertEquals(10, p.below)
    }
}
