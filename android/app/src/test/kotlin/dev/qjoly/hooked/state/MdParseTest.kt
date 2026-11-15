package dev.qjoly.hooked.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MdParseTest {
    @Test
    fun blocksSplitTheWayClaudeWritesThem() {
        val md = """
            # Title

            First line
            same paragraph.

            - one
            - two
              - nested

            ```bash
            echo hi
            ```

            > quoted

            ---
        """.trimIndent()
        val b = parseMarkdown(md)
        assertEquals(Md.Heading(1, "Title"), b[0])
        assertEquals(Md.Para("First line\nsame paragraph."), b[1])
        val list = b[2] as Md.ListBlock
        assertEquals(null, list.start)
        assertEquals(2, list.items.size)
        assertEquals(Md.Para("two"), list.items[1].blocks[0])
        assertTrue(list.items[1].blocks[1] is Md.ListBlock)
        assertEquals(Md.Code("bash", "echo hi", open = false), b[3])
        assertEquals(Md.Quote(listOf(Md.Para("quoted"))), b[4])
        assertEquals(Md.Rule, b[5])
    }

    @Test
    fun anUnclosedFenceIsOpenWhileStreaming() {
        val b = parseMarkdown("text\n```kotlin\nval x = 1")
        assertEquals(Md.Code("kotlin", "val x = 1", open = true), b[1])
    }

    @Test
    fun orderedListsKeepTheirStartAndLooseItems() {
        val b = parseMarkdown("3. a\n\n4. b\n\nafter")
        val list = b[0] as Md.ListBlock
        assertEquals(3, list.start)
        assertEquals(2, list.items.size)
        assertEquals(Md.Para("after"), b[1])
    }

    @Test
    fun tasksAndTables() {
        val b = parseMarkdown("- [x] done\n- [ ] todo\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |")
        val list = b[0] as Md.ListBlock
        assertEquals(true, list.items[0].task)
        assertEquals(false, list.items[1].task)
        assertEquals(Md.Table(listOf("a", "b"), listOf(listOf("1", "2"), listOf("3", "")), listOf('l', 'r')), b[1])
    }

    @Test
    fun inlineSpans() {
        val s = parseInline("**bold** and *it* `co*de` [link](https://x.y) ~~gone~~")
        assertEquals(Inl.Strong(listOf(Inl.Text("bold"))), s[0])
        assertEquals(Inl.Em(listOf(Inl.Text("it"))), s[2])
        assertEquals(Inl.Code("co*de"), s[4])
        assertEquals(Inl.Link(listOf(Inl.Text("link")), "https://x.y"), s[6])
        assertEquals(Inl.Strike(listOf(Inl.Text("gone"))), s[8])
    }

    @Test
    fun nestedEmphasisClosesInsideOut() {
        assertEquals(
            listOf(Inl.Strong(listOf(Inl.Text("bold "), Inl.Em(listOf(Inl.Text("it")))))),
            parseInline("**bold *it***"),
        )
    }

    @Test
    fun snakeCaseAndLoneStarsStayText() {
        assertEquals(listOf(Inl.Text("snake_case_name and 2 * 3")), parseInline("snake_case_name and 2 * 3"))
    }

    @Test
    fun bareUrlsLinkWithoutTrailingPunctuation() {
        val s = parseInline("see https://example.com/a_(b), then")
        assertEquals(Inl.Link(listOf(Inl.Text("https://example.com/a_(b)")), "https://example.com/a_(b)"), s[1])
        assertEquals(Inl.Text(", then"), s[2])
    }

    @Test
    fun softBreaksBecomeSpacesHardOnesStay() {
        assertEquals(listOf(Inl.Text("a b")), parseInline("a\nb"))
        assertEquals(listOf(Inl.Text("a"), Inl.Break, Inl.Text("b")), parseInline("a  \nb"))
    }

    @Test
    fun planPassagesFlattenTheBlocks() {
        assertEquals(listOf("Goal", "Step one", "Step two"), planPassages("## Goal\n\n1. Step **one**\n2. Step two"))
    }
}
