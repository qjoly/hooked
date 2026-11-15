package dev.qjoly.hooked.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LineDiffTest {
    private fun signs(lines: List<DiffLine>) = lines.joinToString("") {
        when (it.kind) {
            LineKind.CONTEXT -> " "
            LineKind.ADDED -> "+"
            LineKind.REMOVED -> "-"
        }
    }

    @Test
    fun removalsComeBeforeAdditions() {
        val l = diffLines("a\nb\nc", "a\nB\nc")
        assertEquals(" -+ ", signs(l))
        assertEquals(listOf("a", "b", "B", "c"), l.map { it.text })
    }

    @Test
    fun aWriteOfANewFileIsAllAdded() {
        assertEquals("++", signs(diffLines("", "x\ny\n")))
    }

    @Test
    fun hunksKeepThreeLinesOfContext() {
        val old = (1..20).joinToString("\n")
        val new = old.replace("\n5\n", "\nfive\n").replace("\n16\n", "\nsixteen\n")
        val hunks = diffHunks(old, new, 3)
        assertEquals(2, hunks.size)
        assertEquals(listOf("2", "3", "4", "5", "five", "6", "7", "8"), hunks[0].lines.map { it.text })
    }

    @Test
    fun closeChangesMergeIntoOneHunk() {
        val old = (1..10).joinToString("\n")
        val new = old.replace("\n3\n", "\nthree\n").replace("\n8\n", "\neight\n")
        assertEquals(1, diffHunks(old, new, 3).size)
    }

    @Test
    fun noChangeNoHunk() {
        assertTrue(diffHunks("same", "same").isEmpty())
    }
}
