package dev.qjoly.hooked.data.lens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MdDiffTest {
    @Test fun `list items are their own blocks`() {
        assertEquals(listOf("# T", "- a", "- b", "1. x", "2. y", "para"), mdBlocks("# T\n\n- a\n- b\n\n1. x\n2. y\n\npara\n").map { it.text })
    }

    @Test fun `a changed bullet alone is marked`() {
        val d = blockDiff("# T\n\n- a\n- b\n", "# T\n\n- a\n- c\n")
        assertEquals(listOf(MdKind.CTX to "# T", MdKind.CTX to "- a", MdKind.DEL to "- b", MdKind.ADD to "- c"), d.map { it.kind to it.text })
    }

    @Test fun `front matter renders as yaml`() {
        val b = mdBlocks("---\ntitle: x\n---\n# H\n")
        assertEquals("```yaml\ntitle: x\n```", b[0].text)
        assertEquals("# H", b[1].text)
    }

    @Test fun `blocks keep their source lines`() {
        val b = mdBlocks("---\ntitle: x\n---\n# T\n\n- a\n- b\n  more\n\npara\nnext\n")
        assertEquals(listOf(1..3, 4..4, 6..6, 7..8, 10..11), b.map { it.lines })
    }

    @Test fun `pieces carry the lines of each side they are on`() {
        val d = blockDiff("# T\n\nold\n", "# T\n\nintro\n\nnew\n")
        assertEquals(listOf((1..1) to (1..1), (3..3) to null, null to (3..3), null to (5..5)), d.map { it.old to it.new })
        assertEquals(Side.OLD to 3..3, d[1].source())
        assertEquals(Side.NEW to 1..1, d[0].source())
    }

    @Test fun `a line finds the block it belongs to`() {
        val d = blockDiff("\n# T\n\nold\n", "\n# T\n\npara\nline\n\nnew\n")
        assertEquals(0, pieceAt(d, Side.NEW, 2))
        assertEquals(2, pieceAt(d, Side.NEW, 5))
        assertEquals(2, pieceAt(d, Side.NEW, 6))
        assertEquals(3, pieceAt(d, Side.NEW, 7))
        assertNull(pieceAt(d, Side.NEW, 1))
        assertEquals(1, pieceAt(d, Side.OLD, 4))
        assertEquals(1, pieceAt(d, Side.OLD, 9))
    }

    @Test fun `a selection lights up the blocks it spans`() {
        val d = blockDiff("# T\n\na\n\nb\n", "# T\n\na\n\nb\n")
        fun sel(a: Int, b: Int) = LineRange(0, LineRef(Side.NEW, a), LineRef(Side.NEW, b))
        assertEquals(1..1, covered(d, sel(3, 3)))
        assertEquals(0..2, covered(d, sel(5, 1)))
    }

    @Test fun `markdown is told by its extension, edit suffix aside`() {
        assertTrue(isMarkdown("docs/README.md · edit 1/2"))
        assertTrue(!isMarkdown("src/a.rs"))
    }
}
