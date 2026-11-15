package dev.qjoly.hooked.data.lens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DiffTest {
    private val ten = (1..10).joinToString("") { "l$it\n" }

    @Test fun `a change makes one hunk with three lines of context and git's header`() {
        val f = FileDiff.fromTexts("a.txt", ten, ten.replace("l5\n", "five\n"))
        assertEquals(1, f.hunks.size)
        val h = f.hunks[0]
        assertEquals("@@ -2,7 +2,7 @@ l1", h.header())
        assertEquals(listOf(LineKind.CONTEXT, LineKind.CONTEXT, LineKind.CONTEXT, LineKind.REMOVED, LineKind.ADDED, LineKind.CONTEXT, LineKind.CONTEXT, LineKind.CONTEXT), h.lines.map { it.kind })
        assertEquals(5, h.lines[3].old)
        assertEquals(5, h.lines[4].new)
        assertEquals(1, f.additions)
        assertEquals(1, f.deletions)
        assertEquals(3, f.digits)
    }

    @Test fun `distant changes split into hunks and close ones merge`() {
        val far = (1..30).joinToString("") { "l$it\n" }
        val f = FileDiff.fromTexts("a", far, far.replace("l2\n", "x\n").replace("l25\n", "y\n"))
        assertEquals(2, f.hunks.size)
        val near = FileDiff.fromTexts("a", far, far.replace("l2\n", "x\n").replace("l8\n", "y\n"))
        assertEquals(1, near.hunks.size)
    }

    @Test fun `an added file has only its new side`() {
        val f = FileDiff.fromTexts("n", "", "a\nb\n")
        assertEquals(Side.NEW, f.soleSide())
        assertEquals("@@ -0,0 +1,2 @@", f.hunks[0].header())
        assertTrue(f.hunks[0].lines.all { it.kind == LineKind.ADDED })
    }

    @Test fun `a missing final newline is flagged and differs from one with it`() {
        val f = FileDiff.fromTexts("a", "x\ny\n", "x\ny")
        assertEquals(1, f.additions)
        assertTrue(f.hunks[0].lines.last().noNewline)
    }

    @Test fun `paired lines carry their word changes`() {
        val f = FileDiff.fromTexts("a", "let width = card(w, h);\n", "let height = card(w, h);\n")
        val (del, add) = f.hunks[0].lines
        assertEquals(listOf(4..8), del.changes)
        assertEquals(listOf(4..9), add.changes)
        val unrelated = FileDiff.fromTexts("a", "alpha beta\n", "gamma delta\n")
        assertTrue(unrelated.hunks[0].lines.all { it.changes.isEmpty() })
    }

    @Test fun `rows fold the unchanged ranges and expanding opens them`() {
        val far = (1..40).joinToString("") { "l$it\n" }
        val f = FileDiff.fromTexts("a", far, far.replace("l20\n", "x\n"))
        val layout = DiffLayout(listOf(f), DiffMode.UNIFIED, emptySet(), emptyRevealed(listOf(f)))
        assertEquals(DiffRow.File(0), layout.rows[0])
        assertEquals(DiffRow.Fold(0, 0), layout.rows[1])
        assertEquals(16, layout.hidden(0, 0))
        assertEquals(17, layout.hidden(0, 1))
        val up = DiffLayout(listOf(f), DiffMode.UNIFIED, emptySet(), layout.expand(0, 1, Expand.UP))
        assertEquals(0, up.hidden(0, 1))
        val all = DiffLayout(listOf(f), DiffMode.UNIFIED, emptySet(), layout.expand(0, 0, Expand.ALL))
        assertEquals(0, all.hidden(0, 0))
        assertEquals(DiffRow.Ctx(0, 1, 1), all.rows[1])
        assertEquals(3, all.rowOf(0, LineRef(Side.NEW, 3)))
        assertEquals(0, layout.gapHolding(0, LineRef(Side.NEW, 3)))
    }

    @Test fun `split mode pairs removed lines with the added ones beside them`() {
        val f = FileDiff.fromTexts("a", "a\nb\nc\n", "a\nB\nC\nD\nc\n")
        val layout = DiffLayout(listOf(f), DiffMode.SPLIT, emptySet(), emptyRevealed(listOf(f)))
        val kinds = layout.rows.map { it::class.simpleName }
        assertEquals(listOf("File", "Line", "Pair", "Line", "Line", "Line"), kinds)
        val sel = LineRange(0, LineRef(Side.NEW, 2), LineRef(Side.NEW, 4))
        assertTrue(layout.contains(sel, LineRef(Side.NEW, 3)))
        assertFalse(layout.contains(sel, LineRef(Side.NEW, 5)))
    }

    @Test fun `collapsed files keep only their header`() {
        val f = FileDiff.fromTexts("a", "a\n", "b\n")
        val layout = DiffLayout(listOf(f, f), DiffMode.UNIFIED, setOf(0), emptyRevealed(listOf(f, f)))
        assertEquals(DiffRow.File(1), layout.rows[1])
        assertEquals(1, layout.fileRows[1])
    }

    @Test fun `the reviewed fingerprint follows the diff shown`() {
        val a = fingerprint(FileDiff.fromTexts("a", "x\n", "y\n"))
        assertEquals(a, fingerprint(FileDiff.fromTexts("b", "x\n", "y\n")))
        assertNotEquals(a, fingerprint(FileDiff.fromTexts("a", "x\n", "z\n")))
        assertTrue(a.matches(Regex("[0-9a-f]+-[0-9a-f]+")))
        assertNull(FileDiff.fromTexts("a", "x", "x").hunks.firstOrNull())
    }

    @Test fun `myers ops rebuild the new sequence from the old one`() {
        val rnd = java.util.Random(7)
        repeat(300) {
            val a = IntArray(rnd.nextInt(40)) { rnd.nextInt(5) }
            val b = IntArray(rnd.nextInt(40)) { rnd.nextInt(5) }
            val out = ArrayList<Int>()
            for (op in Myers.diff(a, b)) when (op) {
                is Myers.Op.Equal -> {
                    for (k in 0 until op.len) assertEquals(a[op.old + k], b[op.new + k])
                    for (k in 0 until op.len) out += a[op.old + k]
                }
                is Myers.Op.Delete -> {}
                is Myers.Op.Insert -> for (k in 0 until op.len) out += b[op.new + k]
            }
            assertEquals(b.toList(), out)
        }
    }

    @Test fun `the selected lines copy from the selection's side`() {
        val f = FileDiff.fromTexts("a", "a\nb\nc\n", "a\nB\nc\n")
        val layout = DiffLayout(listOf(f), DiffMode.UNIFIED, emptySet(), emptyRevealed(listOf(f)))
        assertEquals("a\nB", layout.selectedText(LineRange(0, LineRef(Side.NEW, 1), LineRef(Side.NEW, 2))))
        assertEquals(listOf(1), layout.hunkRows.toList())
    }
}
