package dev.qjoly.hooked.data.lens

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewLogicTest {
    private fun op(vararg kv: Pair<String, Any>) = JsonObject(kv.associate { (k, v) -> k to if (v is Boolean) JsonPrimitive(v) else JsonPrimitive(v.toString()) })

    @Test fun `edits become one diff per op with relative paths`() {
        val c = Change("/repo/src/a.rs", ops = listOf(op("old" to "a\n", "new" to "b\n"), op("old" to "", "new" to "c\n")))
        val d = fileDiffs(listOf(c), "/repo", "full")
        assertEquals(Anchor("/repo/src/a.rs", "full:1"), d.anchors[1])
        assertEquals(2, d.files.size)
        assertEquals("src/a.rs · edit 1/2", d.files[0].path)
        assertEquals(1, d.files[0].additions)
        assertEquals(1, d.files[0].deletions)
    }

    private fun repo(root: String, label: String, files: List<String>) =
        Repo(root, label, false, files.map { Change(it, ops = listOf(op("old" to "", "new" to "x\n"))) })

    @Test fun `working tree spans every repo and names them when several`() {
        val tree = treeDiffs(listOf(repo("/ws/api", "api", listOf("/ws/api/a.rs")), repo("/ws/empty", "empty", emptyList()), repo("/ws/web", "web", listOf("/ws/web/b.ts", "/ws/web/c.ts"))), "/ws")
        assertEquals(listOf("api/a.rs", "web/b.ts", "web/c.ts"), tree.files.map { it.path })
        assertEquals(listOf("api", "web", "web"), tree.repos)
        assertEquals(Anchor("/ws/web/b.ts", "vcs:wt:0"), tree.anchors[1])
        assertTrue(treeDiffs(listOf(repo("/r", "", listOf("/r/a.rs"))), "/r").repos.isEmpty())
        assertEquals("hooked", repo("/ws/hooked", "", emptyList()).name)
    }

    @Test fun `prompt filter replays from the original`() {
        val turns = listOf(ChangeTurn(0, "a", "one"), ChangeTurn(1, "c", "two"))
        val change = Change("/r/x", rawOps = listOf(op("kind" to "edit", "old" to "1", "new" to "2", "ts" to "b"), op("kind" to "edit", "old" to "2", "new" to "3", "ts" to "d")), original = "1\n")
        val d = filteredDiffs(listOf(change), turns, setOf(1), "/r")
        assertEquals(listOf(Anchor("/r/x", "sel:1")), d.anchors)
        assertEquals(1, d.files[0].additions)
        assertEquals("bXb", applyOp("aXa", op("old" to "a", "new" to "b", "all" to true)))
        assertEquals("bXa", applyOp("aXa", op("old" to "a", "new" to "b")))
        assertEquals("sel:10,2", turnsKey(setOf(2, 10)))
    }

    @Test fun `review prompt matches the web brief`() {
        val p = reviewRequestPrompt("abc", "your changes", null, listOf("/r/a.rs"), listOf(ReviewBrief("/r/a.rs", "+L3", "off by one\nmore")), emptyList(), reviewApi("http://tablet.lan:4123"))
        assertTrue(p.startsWith("Review your changes. Files under review:\n- /r/a.rs\n\nLook for real problems"))
        assertTrue(p.contains("mcp__hooked__add_review_comment (id: \"abc\", file: absolute path"))
        assertTrue(p.contains("-d '{\"id\":\"abc\",\"action\":\"claude-comment\",\"file\":\"<path>\""))
        assertTrue(p.contains("curl -sS -X POST http://localhost:4123/api/review "))
        assertTrue(p.endsWith("do not raise them again:\n- /r/a.rs (+L3): off by one"))
        assertEquals("http://localhost:4123/api/review", reviewApi("https://hooked.example.com"))
    }

    @Test fun `sent comments quote their text and code`() {
        val t = ReviewThread("t1", "/r/a.rs", "a.rs", "full:0", "old", 4, 6, "x\ny\n", "open", false, listOf(ReviewMessage("user", "why\nthis")))
        val p = sendReviewPrompt("abc", "your changes", listOf(t), "http://localhost:4123/api/review")
        assertTrue(p.startsWith("I reviewed your changes and left the following inline comments. Address each one, then, for each: Reply in the thread"))
        assertTrue(p.endsWith("1) /r/a.rs (−L4–6) [thread_id: t1]\n   > why\n   > this\n   Relevant code:\n   | x\n   | y"))
        assertEquals("−L4–6", threadAnchor(t))
    }

    @Test fun `scoped threads match every section of their scope`() {
        assertTrue(keyMatches("vcs:wt:*", "vcs:wt:3"))
        assertTrue(keyMatches("full:1", "full:1"))
        assertTrue(!keyMatches("full:1", "full:10"))
    }

    @Test fun `a line names its identifiers once without keywords or strings`() {
        assertEquals(listOf("card_w", "card_width", "width", "x2"), identifiers("    let card_w = card_width(width, \"not_this\", x2);"))
        assertEquals(listOf("view", "Hooked", "El"), identifiers("pub fn view(s: &Hooked) -> El {"))
        assertTrue(isIdent("launchSession") && !isIdent("a b") && !isIdent("9x"))
    }
}
